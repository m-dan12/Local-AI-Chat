import re
import os
import json
import httpx
import fitz  # PyMuPDF
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
from typing import AsyncGenerator

UPLOADS_DIR = Path("uploads")
UPLOADS_DIR.mkdir(exist_ok=True)

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "mistral:latest"  # можно поменять на llama3, gemma2 и т.д.

app = FastAPI(title="Local AI Chat")

# ── Хранилище документов (в памяти) ──────────────────────────────────────────
docs: dict[str, str] = {}  # filename -> full text


def extract_text_pdf(path: Path) -> str:
    doc = fitz.open(path)
    return "\n\n".join(page.get_text() for page in doc)


def extract_text_md(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def chunk_text(text: str, size: int = 1500, overlap: int = 200) -> list[str]:
    """Простая нарезка текста на чанки с перекрытием."""
    chunks, start = [], 0
    while start < len(text):
        end = min(start + size, len(text))
        chunks.append(text[start:end])
        start += size - overlap
    return chunks


def find_relevant_chunks(query: str, text: str, top_n: int = 5) -> str:
    """Keyword-поиск по чанкам — без внешних зависимостей."""
    chunks = chunk_text(text)
    query_words = set(re.findall(r"\w+", query.lower()))

    def score(chunk: str) -> int:
        chunk_words = re.findall(r"\w+", chunk.lower())
        return sum(1 for w in chunk_words if w in query_words)

    ranked = sorted(chunks, key=score, reverse=True)
    return "\n\n---\n\n".join(ranked[:top_n])


# ── API ───────────────────────────────────────────────────────────────────────

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".pdf", ".md", ".txt"}:
        raise HTTPException(400, "Поддерживаются только PDF, Markdown и TXT")

    dest = UPLOADS_DIR / file.filename
    dest.write_bytes(await file.read())

    if suffix == ".pdf":
        text = extract_text_pdf(dest)
    else:
        text = extract_text_md(dest)

    docs[file.filename] = text
    words = len(text.split())
    return {"filename": file.filename, "words": words, "status": "ok"}


@app.get("/documents")
def list_documents():
    return [
        {"filename": name, "words": len(text.split())}
        for name, text in docs.items()
    ]


@app.delete("/documents/{filename}")
def delete_document(filename: str):
    if filename not in docs:
        raise HTTPException(404, "Файл не найден")
    docs.pop(filename)
    path = UPLOADS_DIR / filename
    if path.exists():
        path.unlink()
    return {"status": "deleted"}


class ChatRequest(BaseModel):
    question: str
    filenames: list[str] = []  # пустой = все документы


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    # Собираем контекст
    selected = req.filenames if req.filenames else list(docs.keys())
    if not selected:
        context = "(документы не загружены)"
    else:
        parts = []
        for name in selected:
            if name in docs:
                chunk = find_relevant_chunks(req.question, docs[name])
                parts.append(f"=== {name} ===\n{chunk}")
        context = "\n\n".join(parts) if parts else "(ничего не найдено)"

    system = (
        "Ты умный ассистент. Отвечай ТОЛЬКО на основе предоставленных документов. "
        "Если ответа в документах нет — честно скажи об этом. "
        "Отвечай на том же языке, на котором задан вопрос."
    )
    prompt = f"Контекст из документов:\n\n{context}\n\n---\nВопрос: {req.question}"

    async def generate() -> AsyncGenerator[bytes, None]:
        try:
            # connect=60s — время на загрузку модели в память при первом запросе
            timeout = httpx.Timeout(connect=60.0, read=300.0, write=60.0, pool=60.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                        "POST",
                        f"{OLLAMA_URL}/api/chat",
                        json={
                            "model": OLLAMA_MODEL,
                            "stream": True,
                            "keep_alive": "10m",
                            "messages": [
                                {"role": "system", "content": system},
                                {"role": "user", "content": prompt},
                            ],
                        },
                ) as resp:
                    print(f"Ollama status: {resp.status_code}")
                    if resp.status_code != 200:
                        body = await resp.aread()
                        print(f"Ollama error: {body}")
                        yield b"data: " + json.dumps({"error": f"Ollama вернула {resp.status_code}: {body.decode()}"}).encode() + b"\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                            token = obj.get("message", {}).get("content", "")
                            if token:
                                yield b"data: " + json.dumps({"token": token}).encode() + b"\n\n"
                            if obj.get("done"):
                                yield b"data: " + json.dumps({"done": True}).encode() + b"\n\n"
                        except json.JSONDecodeError:
                            pass
        except httpx.ConnectError:
            yield b"data: " + json.dumps({"error": "Не удалось подключиться к Ollama."}).encode() + b"\n\n"
        except httpx.ReadTimeout:
            yield b"data: " + json.dumps({"error": "Ollama думает слишком долго. Попробуй более короткий вопрос."}).encode() + b"\n\n"
        except Exception as e:
            print(f"ERROR: {type(e).__name__}: {e}")
            yield b"data: " + json.dumps({"error": str(e)}).encode() + b"\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.get("/ollama/status")
async def ollama_status():
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            models = [m["name"] for m in r.json().get("models", [])]
            return {"running": True, "models": models}
    except Exception:
        return {"running": False, "models": []}


# ── Фронтенд ─────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    return Path("static/index.html").read_text(encoding="utf-8")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
