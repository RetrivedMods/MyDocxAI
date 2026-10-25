# MyDocx.AI

[![Project](https://img.shields.io/badge/MyDocx.AI-827963)](#)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](#quick-setup)
[![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)](#)
[![Supabase](https://img.shields.io/badge/Supabase-pgvector-3FCF8E?logo=supabase&logoColor=white)](#quick-setup)
[![PaddleOCR](https://img.shields.io/badge/OCR-PaddleOCR-blue)](#supported-documents)
[![RAG](https://img.shields.io/badge/AI-RAG-6C5CE7)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

## Making Documents Easy to Understand.

MyDocx.AI uses retrieval-augmented generation (RAG) to help you ask questions about your documents. It extracts text, splits it into searchable passages, stores passages and vectors in Supabase with pgvector, then retrieves relevant context to answer questions. Gemini can generate answers and embeddings; OCR reads scanned pages and images.

## Quick setup

1. Clone the repository and open its folder:

   ```bash
   git clone <repository-url>
   cd MyDocxAI
   ```

2. Create a Supabase project. Run [`supabase/bootstrap.sql`](./supabase/bootstrap.sql) in its SQL Editor.
3. Copy `.env.example` to `.env` and set:
   - `SUPABASE_URL`
   - `SUPABASE_KEY` (server-side service-role key; never expose or commit it)
   - `SUPABASE_DB_URL` (optional; enables automatic database setup)
   - `SESSION_SECRET_KEY` (a random secret, at least 32 characters)
   - `GEMINI_API_KEY` (optional; enables Gemini-generated answers)
4. Install and run locally with Python 3.10–3.12:

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   .\.venv\Scripts\python.exe main.py
   ```

5. Open <http://127.0.0.1:8000>.

## Deploy

This repository is configured for **Render**, not Vercel: its FastAPI backend and local OCR models require a Python/Docker web service. Push the repository to GitHub, then in Render choose **New → Blueprint** and connect it. Set the requested Supabase values and optional `GEMINI_API_KEY`; Render generates `SESSION_SECRET_KEY`. Deploy after the Supabase setup is complete.

## Supported documents

PDF, PNG, JPG/JPEG, TIFF, BMP, WEBP, DOCX, PPTX, TXT, Markdown, CSV, JSON, HTML, and XML. Uploads are limited to 20 MB each. Scanned documents and images are read with local PaddleOCR.
