# MyDocx.ai Document Chat

A local-first document chatbot with a Python/FastAPI backend, ChromaDB vector search, and a Bootstrap-based web interface. PDFs are read with `pypdf`; scanned PDF pages and uploaded images use Tesseract OCR. Word, PowerPoint, and common text-based formats are also supported.

## Requirements

- Python 3.10+
- Tesseract OCR installed and available on `PATH` to read images or scanned PDF pages and embedded images in Word/PowerPoint files. On Windows, install Tesseract and add its installation folder to `PATH`.
- A Gemini API key is optional. Without one, the app returns retrieved document passages rather than generated answers.

## Run locally

```powershell
$py = "$env:LOCALAPPDATA\Python\pythoncore-3.14-64\python.exe"
& $py -m venv .venv
$py = ".\.venv\Scripts\python.exe"
& $py -m pip install -r requirements.txt
& $py main.py
```

Using the virtual environment's Python directly avoids both the Microsoft Store `python` alias and PowerShell script activation policies. If `.venv` already exists, skip the first two lines and run the remaining commands. Keep using `& $py main.py` to start the app; do not switch back to `python main.py` in a shell where the environment is not activated.

Open <http://127.0.0.1:8000>.

## Deploy on Render

This project includes a Render Blueprint (`render.yaml`) and Dockerfile. The Docker image installs Tesseract OCR, and the Blueprint mounts a persistent disk at `/var/data` for SQLite accounts, ChromaDB vectors, and the session-signing secret. A persistent disk requires a paid Render web-service plan; the Blueprint uses the Starter plan and one instance so local SQLite/ChromaDB writes remain safe.

1. Push this project to a GitHub, GitLab, or Bitbucket repository. Do not commit `.env`, `.venv/`, or `data/`.
2. In the Render Dashboard, choose **New** → **Blueprint** and connect that repository.
3. Review the `mydocx-ai` web service. When prompted for `GEMINI_API_KEY`, enter your Google AI Studio key. Render generates `SESSION_SECRET_KEY` automatically.
4. Apply the Blueprint and wait for the `/api/health` check to pass. Open the service's `onrender.com` URL, register an account, and upload documents.

Keep the persistent disk attached to the service. Removing or replacing it removes the deployed SQLite user database and ChromaDB document index. The local `data/` folder is not automatically migrated; export or re-upload local documents and create accounts on the deployed site. Set `sizeGB` in `render.yaml` to a larger value if your document library needs more space. Keep this deployment at one instance; this app uses local SQLite and ChromaDB storage rather than shared network databases.

## Accounts and SQLite

Login and registration use a local SQLite database for user accounts only. No separate database server is required. On startup the app creates `data/users.sqlite3` and initializes the users table from [schema.sql](./schema.sql). Set `MYDOCX_USERS_DB` in `.env` to choose another database-file path. Documents and vector embeddings remain in ChromaDB, separate from the account database. Every new upload is associated with its account, and the API only lists, searches, or deletes that account's documents. Existing documents created before accounts were added have no owner and are not visible to signed-in users.

The backend creates a persistent random session-signing secret in `data/.session_secret` if `SESSION_SECRET_KEY` is blank; you may instead set a random secret of at least 32 characters in `.env`. For HTTPS deployments, set `MYDOCX_COOKIE_SECURE=true`.

## Gemini setup

The project includes a local `.env` starter file. Get a key from [Google AI Studio](https://aistudio.google.com/app/apikey), then set `GEMINI_API_KEY` in `.env`:

```powershell
notepad .env
```

Set `GEMINI_API_KEY` in `.env`; `GEMINI_MODEL` defaults to `gemini-flash-lite-latest` for fast responses, with `GEMINI_FALLBACK_MODEL` set to `gemini-flash-latest` for recovery from temporary model or availability errors. Document summaries are rewritten in simple English with a short overview and concise key-point bullets. The app uses Google's Interactions API and sends requests with `store: false`. Restart the app after changing `.env`. The `.env` file is ignored by Git; do not share or commit it. When Gemini is configured, retrieved document excerpts are sent to Google's Gemini API to generate answers.

Uploaded document chunks and the ChromaDB index are stored in the local `data/` folder. Set `MYDOCX_DATA_DIR` in `.env` to change that location. The first vector embedding may download ChromaDB's default embedding model.

## Supported files

PDF, PNG, JPG/JPEG, TIFF, BMP, WEBP, DOCX, PPTX, TXT, Markdown, CSV, JSON, HTML, and XML. Uploads are limited to 20 MB per file. Text in document images is indexed with Tesseract OCR; Word/PowerPoint text, tables, and slide notes are also extracted.

## API

- `GET /api/health` - health check
- `POST /api/auth/register` - create an account
- `POST /api/auth/login` - sign in
- `POST /api/auth/logout` - sign out
- `GET /api/auth/me` - get the signed-in account
- `GET /api/documents` - list the signed-in user's indexed documents
- `POST /api/documents` - upload one or more files (`files` multipart field)
- `DELETE /api/documents/{id}` - remove one of the signed-in user's documents
- `POST /api/chat` - ask about the signed-in user's documents (`{"question":"..."}`)
