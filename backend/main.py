"""FastAPI entry point for the eval-labelling Databricks App."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.routers import (
    annotations,
    classes,
    comments,
    graphs,
    me,
    queue,
    volume,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("eval-labelling")

app = FastAPI(title="eval-labelling", version="0.1.0")

# CORS — only relevant for local dev (Vite on :5173 → API on :8000).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"error": str(exc), "type": type(exc).__name__})


# ---- API routers ---------------------------------------------------------

app.include_router(me.router, prefix="/api/me", tags=["me"])
app.include_router(classes.router, prefix="/api/label_classes", tags=["classes"])
app.include_router(volume.router, prefix="/api/volume", tags=["volume"])
app.include_router(graphs.router, prefix="/api/graphs", tags=["graphs"])
app.include_router(annotations.router, prefix="/api/annotations", tags=["annotations"])
app.include_router(comments.router, prefix="/api", tags=["comments"])
app.include_router(queue.router, prefix="/api/queue", tags=["queue"])


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ---- Static frontend ------------------------------------------------------
# Vite build output is at frontend/dist. We mount it at /.

_HERE = Path(__file__).resolve().parent.parent
_DIST = _HERE / "frontend" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
    log.info("Mounted frontend from %s", _DIST)
else:
    log.warning("frontend/dist not found at %s — UI will not be served", _DIST)

    @app.get("/")
    def _noui():
        return {"status": "ok", "note": "frontend not built — API only"}


# Local-dev entrypoint: `python -m backend.main`
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=False,
    )
