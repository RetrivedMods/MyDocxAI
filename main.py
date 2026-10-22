from __future__ import annotations

import io
import html
import logging
import os
import re
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any
from zipfile import BadZipFile, ZipFile

import chromadb
import httpx
import pytesseract
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
from docx import Document as WordDocument
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pptx import Presentation
from pydantic import BaseModel, Field
from pypdf import PdfReader
from pypdf.errors import FileNotDecryptedError, PdfReadError
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import Response


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
load_dotenv(BASE_DIR / ".env")
DATA_DIR = Path(os.getenv("MYDOCX_DATA_DIR", str(BASE_DIR / "data")))
USER_DB_PATH = Path(os.getenv("MYDOCX_USERS_DB", str(DATA_DIR / "users.sqlite3")))
if not USER_DB_PATH.is_absolute():
    USER_DB_PATH = BASE_DIR / USER_DB_PATH
logger = logging.getLogger("mydocx.auth")
password_hasher = PasswordHasher()
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 180
MAX_RETRIEVAL_DISTANCE = 0.85
MAX_RETRIEVAL_DISTANCE_GAP = 0.04
SUPPORTED_EXTENSIONS = {
    ".pdf", ".txt", ".md", ".csv", ".json", ".html", ".xml",
    ".docx", ".pptx", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp",
}


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    document_ids: list[str] = Field(default_factory=list, max_length=20)


class RegisterRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)


def _session_secret() -> str:
    configured = os.getenv("SESSION_SECRET_KEY", "").strip()
    if configured:
        if len(configured) < 32:
            raise RuntimeError("SESSION_SECRET_KEY must be at least 32 characters.")
        return configured
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    secret_path = DATA_DIR / ".session_secret"
    try:
        stored = secret_path.read_text(encoding="ascii").strip()
        if len(stored) < 32:
            raise RuntimeError("The stored session secret is invalid. Remove data/.session_secret and restart.")
        return stored
    except FileNotFoundError:
        generated = secrets.token_urlsafe(48)
        try:
            with secret_path.open("x", encoding="ascii") as secret_file:
                secret_file.write(generated)
            return generated
        except FileExistsError:
            stored = secret_path.read_text(encoding="ascii").strip()
            if len(stored) < 32:
                raise RuntimeError("The stored session secret is invalid. Remove data/.session_secret and restart.")
            return stored


@contextmanager
def _user_database():
    USER_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(USER_DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _initialize_user_database() -> None:
    schema = (BASE_DIR / "schema.sql").read_text(encoding="utf-8")
    with _user_database() as connection:
        connection.executescript(schema)


def _database_unavailable(exc: sqlite3.Error) -> HTTPException:
    logger.error(
        "SQLite user-management database is unavailable",
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return HTTPException(
        status_code=503,
        detail="User database is unavailable. Check the SQLite database path and schema.sql.",
    )


def get_current_user(request: Request) -> dict[str, Any]:
    user_id = request.session.get("user_id")
    if not isinstance(user_id, int):
        raise HTTPException(status_code=401, detail="Please sign in to continue.")
    try:
        with _user_database() as connection:
            user = connection.execute(
                "SELECT id, display_name, email FROM users WHERE id = ? AND is_active = 1",
                (user_id,),
            ).fetchone()
    except sqlite3.Error as exc:
        raise _database_unavailable(exc) from exc
    if user is None:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Please sign in to continue.")
    return dict(user)


@asynccontextmanager
async def lifespan(_: FastAPI):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _initialize_user_database()
    except sqlite3.Error as exc:
        raise RuntimeError(f"Could not initialize SQLite user database at {USER_DB_PATH}") from exc
    yield


app = FastAPI(title="MyDocx.ai Document Chat", lifespan=lifespan)
app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret(),
    session_cookie="mydocx_session",
    max_age=60 * 60 * 24 * 7,
    same_site="lax",
    https_only=os.getenv("MYDOCX_COOKIE_SECURE", "false").lower() == "true",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

chroma_client = chromadb.PersistentClient(path=str(DATA_DIR / "chroma"))
collection = chroma_client.get_or_create_collection(
    name="orbitai_documents",
    embedding_function=DefaultEmbeddingFunction(),
    metadata={"hnsw:space": "cosine"},
)


def split_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(normalized):
        end = min(start + size, len(normalized))
        if end < len(normalized):
            boundary = normalized.rfind(" ", start + size // 2, end)
            if boundary > start:
                end = boundary
        chunks.append(normalized[start:end].strip())
        if end == len(normalized):
            break
        start = max(end - overlap, start + 1)
    return [chunk for chunk in chunks if chunk]


def _append_chunk_without_overlap(previous_text: str, next_chunk: str) -> str:
    overlap = min(len(previous_text), len(next_chunk))
    while overlap and previous_text[-overlap:] != next_chunk[:overlap]:
        overlap -= 1
    return previous_text + next_chunk[overlap:]


def _requests_full_document(question: str) -> bool:
    return bool(re.search(
        r"\b(?:full|entire|complete|verbatim|whole)\b.{0,32}\b(?:text|contents?|output|document|file|pdf|transcript)\b"
        r"|\b(?:show|give|provide|print|return|display|extract|transcribe)\b.{0,32}\b(?:everything|all|full|entire|complete)\b",
        question,
        re.IGNORECASE,
    ))


def _requests_document_summary(question: str) -> bool:
    return bool(re.search(
        r"\b(?:summari[sz]e|overview|key points?|main points?|important conclusions?|main ideas?)\b",
        question,
        re.IGNORECASE,
    ))


def _ocr_image(image: Image.Image) -> str:
    try:
        return pytesseract.image_to_string(image).strip()
    except pytesseract.pytesseract.TesseractNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail="OCR requires Tesseract. Install it and ensure the tesseract executable is on PATH.",
        ) from exc
    except pytesseract.pytesseract.TesseractError as exc:
        raise HTTPException(status_code=422, detail=f"Tesseract could not read the image: {exc}") from exc


def _extract_office_images(data: bytes, media_folder: str) -> list[str]:
    extracted: list[str] = []
    with ZipFile(io.BytesIO(data)) as archive:
        image_paths = [
            name for name in archive.namelist()
            if name.startswith(media_folder) and Path(name).suffix.lower()
            in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
        ]
        for image_path in image_paths:
            image_text = _ocr_image(Image.open(io.BytesIO(archive.read(image_path))))
            if image_text:
                extracted.append(f"[Embedded image: {Path(image_path).name}]\n{image_text}")
    return extracted


def _extract_pdf(data: bytes) -> tuple[str, list[str]]:
    reader = PdfReader(io.BytesIO(data))
    pages: list[str] = []
    warnings: list[str] = []
    import fitz

    pdf = fitz.open(stream=data, filetype="pdf")
    for page_number, page in enumerate(reader.pages, start=1):
        page_text = page.extract_text() or ""
        image_texts: list[str] = []
        for image_index, image_info in enumerate(pdf[page_number - 1].get_images(full=True), start=1):
            try:
                image_data = pdf.extract_image(image_info[0])["image"]
                image_text = _ocr_image(Image.open(io.BytesIO(image_data)))
                if image_text:
                    image_texts.append(f"[Image {image_index}]\n{image_text}")
            except HTTPException as exc:
                warnings.append(f"Page {page_number}: {exc.detail}")
        if len(page_text.strip()) < 40 and not image_texts:
            try:
                page_image = pdf[page_number - 1].get_pixmap(matrix=fitz.Matrix(2, 2))
                page_ocr = _ocr_image(Image.open(io.BytesIO(page_image.tobytes("png"))))
                if page_ocr:
                    image_texts.append(f"[Page OCR]\n{page_ocr}")
            except HTTPException as exc:
                warnings.append(f"Page {page_number}: {exc.detail}")
        content = "\n".join(part for part in [page_text, *image_texts] if part.strip())
        if content:
            pages.append(f"[Page {page_number}]\n{content}")
    pdf.close()
    return "\n\n".join(pages), warnings


def extract_document(filename: str, data: bytes) -> tuple[str, list[str]]:
    extension = Path(filename).suffix.lower()
    warnings: list[str] = []
    try:
        if extension == ".pdf":
            return _extract_pdf(data)
        if extension in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}:
            return _ocr_image(Image.open(io.BytesIO(data))), warnings
        if extension == ".docx":
            document = WordDocument(io.BytesIO(data))
            paragraphs = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
            for section in document.sections:
                paragraphs.extend(
                    paragraph.text
                    for paragraph in (*section.header.paragraphs, *section.footer.paragraphs)
                    if paragraph.text.strip()
                )
            tables = [
                " | ".join(cell.text.strip() for cell in row.cells)
                for table in document.tables
                for row in table.rows
            ]
            image_texts = _extract_office_images(data, "word/media/")
            return "\n".join(paragraphs + tables + image_texts), warnings
        if extension == ".pptx":
            presentation = Presentation(io.BytesIO(data))
            slides: list[str] = []
            for index, slide in enumerate(presentation.slides, start=1):
                slide_text: list[str] = []
                for shape in slide.shapes:
                    if getattr(shape, "has_text_frame", False) and shape.text.strip():
                        slide_text.append(shape.text)
                    if getattr(shape, "has_table", False):
                        slide_text.extend(
                            " | ".join(cell.text.strip() for cell in row.cells)
                            for row in shape.table.rows
                        )
                slides.append(f"[Slide {index}]\n" + "\n".join(slide_text))
                if slide.has_notes_slide:
                    notes = slide.notes_slide.notes_text_frame.text.strip()
                    if notes:
                        slides.append(f"[Slide {index} speaker notes]\n{notes}")
            image_texts = _extract_office_images(data, "ppt/media/")
            return "\n\n".join(slides + image_texts), warnings
        if extension in {".txt", ".md", ".csv", ".json", ".html", ".xml"}:
            text = data.decode("utf-8-sig")
            if extension == ".html":
                text = html.unescape(re.sub(r"<[^>]+>", " ", text))
            return text, warnings
    except HTTPException:
        raise
    except (
        BadZipFile,
        FileNotDecryptedError,
        OSError,
        UnicodeDecodeError,
        ValueError,
        KeyError,
        IndexError,
        PdfReadError,
    ) as exc:
        raise HTTPException(status_code=422, detail=f"Could not read {filename}: {exc}") from exc
    raise HTTPException(status_code=415, detail=f"Unsupported file type: {extension or 'unknown'}")


@app.get("/")
async def home(request: Request) -> Response:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/app")
async def workspace(request: Request) -> Response:
    if not isinstance(request.session.get("user_id"), int):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(STATIC_DIR / "chat.html")


@app.get("/login")
async def login_page(request: Request) -> Response:
    if isinstance(request.session.get("user_id"), int):
        return RedirectResponse("/app", status_code=303)
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/register")
async def register_page(request: Request) -> Response:
    if isinstance(request.session.get("user_id"), int):
        return RedirectResponse("/app", status_code=303)
    return FileResponse(STATIC_DIR / "register.html")


@app.post("/api/auth/register")
async def register(body: RegisterRequest, request: Request) -> dict[str, Any]:
    display_name = " ".join(body.display_name.split())
    email = body.email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    if len(display_name) < 2:
        raise HTTPException(status_code=422, detail="Name must contain at least 2 characters.")

    password_hash = password_hasher.hash(body.password)
    try:
        with _user_database() as connection:
            cursor = connection.execute(
                "INSERT INTO users (display_name, email, password_hash) VALUES (?, ?, ?)",
                (display_name, email, password_hash),
            )
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="An account with that email already exists.") from exc
    except sqlite3.Error as exc:
        raise _database_unavailable(exc) from exc

    request.session.clear()
    request.session["user_id"] = int(user_id)
    return {"user": {"id": int(user_id), "display_name": display_name, "email": email}}


@app.post("/api/auth/login")
async def login(body: LoginRequest, request: Request) -> dict[str, Any]:
    email = body.email.strip().lower()
    try:
        with _user_database() as connection:
            user = connection.execute(
                "SELECT id, display_name, email, password_hash FROM users "
                "WHERE email = ? AND is_active = 1",
                (email,),
            ).fetchone()
    except sqlite3.Error as exc:
        raise _database_unavailable(exc) from exc

    if user is None:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    try:
        password_hasher.verify(user["password_hash"], body.password)
    except (VerifyMismatchError, VerificationError, InvalidHashError) as exc:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.") from exc

    request.session.clear()
    request.session["user_id"] = int(user["id"])
    return {
        "user": {
            "id": int(user["id"]),
            "display_name": user["display_name"],
            "email": user["email"],
        }
    }


@app.post("/api/auth/logout")
async def logout(request: Request) -> dict[str, str]:
    request.session.clear()
    return {"status": "signed out"}


@app.get("/api/auth/me")
async def current_user(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return {"user": user}


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/documents")
async def list_documents(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, list[dict[str, Any]]]:
    records = collection.get(where={"user_id": user["id"]}, include=["metadatas"])
    documents: dict[str, dict[str, Any]] = {}
    for metadata in records.get("metadatas") or []:
        if not metadata:
            continue
        document_id = metadata["document_id"]
        summary = documents.setdefault(document_id, {
            "id": document_id,
            "filename": metadata["filename"],
            "chunks": 0,
        })
        summary["chunks"] += 1
    return {"documents": list(documents.values())}


@app.post("/api/documents")
async def upload_documents(
    files: list[UploadFile] = File(...),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for upload in files:
        filename = Path(upload.filename or "document").name
        extension = Path(filename).suffix.lower()
        if extension not in SUPPORTED_EXTENSIONS:
            raise HTTPException(status_code=415, detail=f"Unsupported file type: {extension or 'unknown'}")
        data = await upload.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"{filename} exceeds the 20 MB upload limit.")
        text, warnings = extract_document(filename, data)
        chunks = split_text(text)
        if not chunks:
            raise HTTPException(status_code=422, detail=f"No readable text found in {filename}.")
        document_id = str(uuid.uuid4())
        collection.add(
            ids=[f"{document_id}:{index}" for index in range(len(chunks))],
            documents=chunks,
            metadatas=[
                {
                    "document_id": document_id,
                    "filename": filename,
                    "chunk": index,
                    "user_id": user["id"],
                }
                for index in range(len(chunks))
            ],
        )
        results.append({
            "id": document_id,
            "filename": filename,
            "chunks": len(chunks),
            "warnings": warnings,
        })
    return {"documents": results}


@app.delete("/api/documents/{document_id}")
async def delete_document(
    document_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    user_filter = {"$and": [{"document_id": document_id}, {"user_id": user["id"]}]}
    existing = collection.get(where=user_filter, include=[])
    if not existing.get("ids"):
        raise HTTPException(status_code=404, detail="Document not found.")
    collection.delete(where=user_filter)
    return {"status": "deleted"}


async def _generate_gemini_answer(
    question: str,
    passages: list[dict[str, Any]],
    api_key: str,
) -> str:
    primary_model = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest").strip() or "gemini-flash-lite-latest"
    fallback_model = (
        os.getenv("GEMINI_FALLBACK_MODEL", "gemini-flash-latest").strip()
        or "gemini-flash-latest"
    )
    models = list(dict.fromkeys((primary_model, fallback_model)))
    context = "\n\n".join(
        f"Source: {item['filename']}\n{item['text'][:12000]}" for item in passages
    ) or "No relevant document passages were found."
    if _requests_document_summary(question):
        instructions = (
            "Summarize the supplied document in plain, simple English. Rewrite difficult sentences "
            "so they are easy to understand. Start with one short overview, then give 5-8 concise "
            "bullets covering the most important distinct ideas. Keep names, key terms, and facts "
            "accurate. Do not copy long passages, repeat ideas, or include unrelated information. "
            "If the document is too long, prioritize its central themes and important supporting points."
        )
    else:
        instructions = (
            "Answer accurately and concisely using only the supplied document excerpts. Never infer "
            "facts that are not in the excerpts. Ignore excerpts that do not directly help answer the "
            "question. Do not mention unrelated documents or repeat irrelevant titles. If the excerpts "
            "do not contain the answer, say so. Cite source filenames."
        )
    prompt = (
        f"You are MyDocx.ai, a careful document-grounded assistant. {instructions}\n\n"
        f"Document excerpts:\n{context}\n\nQuestion: {question}"
    )
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            interaction: dict[str, Any] | None = None
            for index, model in enumerate(models):
                response = await client.post(
                    "https://generativelanguage.googleapis.com/v1beta/interactions",
                    headers={"x-goog-api-key": api_key},
                    json={
                        "model": model,
                        "input": prompt,
                        "store": False,
                        "generation_config": {
                            "temperature": 0.2,
                            "max_output_tokens": 450,
                        },
                    },
                )
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    retryable_statuses = {400, 404, 408, 429, 500, 502, 503, 504}
                    if index + 1 < len(models) and exc.response.status_code in retryable_statuses:
                        logging.getLogger("mydocx.ai").warning(
                            "Gemini model %s returned HTTP %s; retrying with %s",
                            model,
                            exc.response.status_code,
                            models[index + 1],
                        )
                        continue
                    raise
                interaction = response.json()
                break
            if interaction is None:
                raise HTTPException(status_code=502, detail="Gemini returned no answer for this request.")
            output_steps = [
                step for step in interaction.get("steps", [])
                if step.get("type") == "model_output"
            ]
            if not output_steps:
                raise HTTPException(status_code=502, detail="Gemini returned no answer for this request.")
            answer = "\n".join(
                part["text"]
                for step in output_steps
                for part in step.get("content", [])
                if isinstance(part.get("text"), str)
            ).strip()
            if not answer:
                raise HTTPException(status_code=502, detail="Gemini returned an empty answer.")
            return answer
    except httpx.HTTPStatusError as exc:
        detail = "Gemini API request failed."
        try:
            detail = exc.response.json().get("error", {}).get("message", detail)
        except ValueError:
            pass
        raise HTTPException(status_code=502, detail=detail) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Could not connect to Gemini: {exc}") from exc
    except (KeyError, IndexError, TypeError, ValueError, AttributeError) as exc:
        raise HTTPException(status_code=502, detail=f"Gemini returned an unexpected response: {exc}") from exc


async def _generate_answer(question: str, passages: list[dict[str, Any]]) -> str:
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if gemini_api_key:
        try:
            return await _generate_gemini_answer(question, passages, gemini_api_key)
        except HTTPException as exc:
            if exc.status_code not in {502, 503, 504}:
                raise
            logging.getLogger("mydocx.ai").warning(
                "Gemini was unavailable; returning retrieved document passages instead."
            )

            def format_excerpt(passage: dict[str, Any]) -> str:
                source = passage["filename"]
                if passage.get("page_or_slide"):
                    source += f" · {passage['page_or_slide']}"
                return f"**{source}**\n{passage['text']}"

            excerpts = "\n\n".join(
                format_excerpt(passage) for passage in passages
            )
            if excerpts:
                return (
                    "The AI service is temporarily busy, so here are the relevant passages "
                    "I found in your documents:\n\n"
                    f"{excerpts}"
                )
            return "The AI service is temporarily unavailable, and I couldn't find a relevant passage."

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        if not passages:
            return "I couldn't find a relevant passage. Try rephrasing your question or upload a document that covers the topic."
        count = len(passages)
        return (
            f"I found {count} relevant passage{'s' if count != 1 else ''}. "
            "Add GEMINI_API_KEY to your .env file for a concise, AI-generated answer. "
            "Expand Sources below to read the document excerpts."
        )

    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    context = "\n\n".join(
        f"Source: {item['filename']}\n{item['text']}" for item in passages
    ) or "No relevant document passages were found."
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Answer using only the supplied document excerpts. If they do not "
                                "contain the answer, say so. Cite source filenames in your answer."
                            ),
                        },
                        {"role": "user", "content": f"Document excerpts:\n{context}\n\nQuestion: {question}"},
                    ],
                    "temperature": 0.2,
                },
            )
            response.raise_for_status()
            return response.json()["choices"][0]["message"]["content"]
    except (httpx.HTTPError, KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail=f"Language model request failed: {exc}") from exc


@app.post("/api/chat")
async def chat(
    request: ChatRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if request.document_ids:
        user_filter: dict[str, Any] = {
            "$and": [
                {"user_id": user["id"]},
                {"document_id": {"$in": request.document_ids}},
            ],
        }
    else:
        user_filter = {"user_id": user["id"]}
    user_chunks = collection.get(where=user_filter, include=[])
    if not user_chunks["ids"]:
        if request.document_ids:
            raise HTTPException(status_code=404, detail="The attached document is not available. Upload it again and retry.")
        raise HTTPException(status_code=400, detail="Upload at least one document before chatting.")
    if request.document_ids and _requests_document_summary(request.question):
        records = collection.get(
            where=user_filter,
            include=["documents", "metadatas"],
        )
        documents: dict[str, dict[str, Any]] = {}
        for text, metadata in zip(records["documents"], records["metadatas"]):
            document = documents.setdefault(metadata["document_id"], {
                "filename": metadata["filename"],
                "chunks": [],
            })
            document["chunks"].append((metadata["chunk"], text))
        summary_passages: list[dict[str, Any]] = []
        for document_id, document in documents.items():
            content = ""
            for _, chunk_text in sorted(document["chunks"], key=lambda item: item[0]):
                content = _append_chunk_without_overlap(content, chunk_text)
            if content.strip():
                summary_passages.append({
                    "filename": document["filename"],
                    "text": content.strip(),
                    "document_id": document_id,
                    "page_or_slide": None,
                    "relevance": 1.0,
                })
        if not summary_passages:
            return {"answer": "I couldn't extract readable text from the attached document.", "sources": []}
        answer = await _generate_answer(request.question, summary_passages)
        return {"answer": answer, "sources": summary_passages}
    if _requests_full_document(request.question):
        complete_records = collection.get(
            where=user_filter,
            include=["documents", "metadatas"],
        )
        grouped_documents: dict[str, dict[str, Any]] = {}
        for text, metadata in zip(complete_records["documents"], complete_records["metadatas"]):
            document = grouped_documents.setdefault(metadata["document_id"], {
                "filename": metadata["filename"],
                "chunks": [],
            })
            document["chunks"].append((metadata["chunk"], text))
        unique_documents: list[dict[str, str]] = []
        seen_documents: set[tuple[str, str]] = set()
        for document in grouped_documents.values():
            content = ""
            for _, chunk_text in sorted(document["chunks"], key=lambda item: item[0]):
                content = _append_chunk_without_overlap(content, chunk_text)
            identity = (document["filename"], content)
            if content.strip() and identity not in seen_documents:
                seen_documents.add(identity)
                unique_documents.append({
                    "filename": document["filename"],
                    "text": content.strip(),
                })
        if not unique_documents:
            return {"answer": "I couldn't extract readable text from your documents.", "sources": []}
        question_lower = request.question.casefold()
        if re.search(r"\ball\s+(?:of\s+)?(?:documents?|files?)\b", question_lower):
            selected_documents = unique_documents
        else:
            selected_documents = [
                document for document in unique_documents
                if document["filename"].casefold() in question_lower
            ]
            if not selected_documents and len(unique_documents) == 1:
                selected_documents = unique_documents
        if not selected_documents:
            filenames = ", ".join(document["filename"] for document in unique_documents)
            return {
                "answer": f"I found multiple documents. Which one should I show in full? {filenames}",
                "sources": [],
            }
        answer = "\n\n".join(
            f"## Complete extracted text: {document['filename']}\n\n{document['text']}"
            for document in selected_documents
        )
        return {"answer": answer, "sources": []}
    results = collection.query(
        query_texts=[request.question],
        n_results=min(8, len(user_chunks["ids"])),
        where=user_filter,
        include=["documents", "metadatas", "distances"],
    )
    retrieved: list[dict[str, Any]] = []
    for text, metadata, distance in zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ):
        retrieved.append({
            "text": text,
            "filename": metadata["filename"],
            "document_id": metadata["document_id"],
            "chunk": metadata["chunk"],
            "page_or_slide": None,
            "distance": float(distance),
            "relevance": round(max(0.0, 1.0 - float(distance)), 3),
        })
    if not retrieved:
        return {
            "answer": "I couldn't find a relevant passage for that question in your documents. Try rephrasing it or naming the document.",
            "sources": [],
        }
    best_distance = min(passage["distance"] for passage in retrieved)
    max_distance = best_distance + MAX_RETRIEVAL_DISTANCE_GAP
    if not request.document_ids:
        max_distance = min(MAX_RETRIEVAL_DISTANCE, max_distance)
    relevant: list[dict[str, Any]] = []
    seen_chunks: set[tuple[str, int, str]] = set()
    for passage in retrieved:
        identity = (passage["filename"], passage["chunk"], passage["text"])
        if passage["distance"] <= max_distance and identity not in seen_chunks:
            seen_chunks.add(identity)
            relevant.append(passage)
    if not relevant:
        return {
            "answer": "I couldn't find a relevant passage for that question in your documents. Try rephrasing it or naming the document.",
            "sources": [],
        }
    retrieved = relevant
    retrieved.sort(key=lambda passage: (passage["document_id"], passage["chunk"]))
    passages: list[dict[str, Any]] = []
    for passage in retrieved:
        if (
            passages
            and passages[-1]["document_id"] == passage["document_id"]
            and passage["chunk"] == passages[-1]["last_chunk"] + 1
        ):
            passages[-1]["text"] = _append_chunk_without_overlap(
                passages[-1]["text"],
                passage["text"],
            )
            passages[-1]["last_chunk"] = passage["chunk"]
            passages[-1]["relevance"] = max(passages[-1]["relevance"], passage["relevance"])
        else:
            passages.append({
                **passage,
                "first_chunk": passage["chunk"],
                "last_chunk": passage["chunk"],
            })
    passages.sort(key=lambda passage: passage["relevance"], reverse=True)
    passages = passages[:4]
    for passage in passages:
        page_numbers = list(dict.fromkeys(re.findall(r"\[Page (\d+)\]", passage["text"])))
        if len(page_numbers) == 1:
            passage["page_or_slide"] = f"Page {page_numbers[0]}"
        elif page_numbers:
            passage["page_or_slide"] = f"Pages {', '.join(page_numbers)}"
        passage["text"] = re.sub(r"\[Page \d+\]\s*", "", passage["text"])
        passage["text"] = passage["text"][:1800].strip()
        passage.pop("distance")
        passage.pop("document_id")
        passage.pop("chunk")
        passage.pop("first_chunk")
        passage.pop("last_chunk")
    answer = await _generate_answer(request.question, passages)
    return {"answer": answer, "sources": passages}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
