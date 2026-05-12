from fastapi import APIRouter, HTTPException, Query

from backend.db import (
    UC_VOLUME_PATH,
    fq,
    list_volume_images,
    query,
    volume_list,
)

router = APIRouter()


def _status_map(paths: list[str]) -> dict[str, str]:
    """Look up `graphs.status` for each path in a single query."""
    if not paths:
        return {}
    # Inline IN list — the SQL connector's IN-array binding is finicky.
    quoted = ",".join("'" + p.replace("'", "''") + "'" for p in paths)
    rows = query(
        f"SELECT graph_path, status FROM {fq('graphs')} WHERE graph_path IN ({quoted})"
    )
    return {r["graph_path"]: r.get("status") for r in rows if r.get("graph_path")}


@router.get("/tree")
def tree(path: str = Query(default="")):
    """Return immediate children of a UC volume path, with per-file status.

    `path` may be:
      - empty / "/"  -> list root of UC_VOLUME_PATH
      - "anomaly"    -> list UC_VOLUME_PATH/anomaly
      - absolute "/Volumes/.../graphs/anomaly" -> use directly
    """
    if not path or path in ("/", "."):
        target = UC_VOLUME_PATH
    elif path.startswith("/Volumes/"):
        target = path
    else:
        target = f"{UC_VOLUME_PATH.rstrip('/')}/{path.lstrip('/')}"
    try:
        entries = volume_list(target)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"volume list failed: {e}")
    # Attach `status` from the graphs table for each file entry. Folders
    # remain status: None.
    file_paths = [e["path"] for e in entries if not e["is_dir"] and e.get("path")]
    statuses = _status_map(file_paths) if file_paths else {}
    for e in entries:
        e["status"] = None if e["is_dir"] else statuses.get(e["path"])
    return {"path": target, "entries": entries}


@router.get("/search")
def search(q: str = Query(default=""), limit: int = Query(default=200)):
    """Flat search across every image file in the configured volume.

    Walks the volume recursively (image extensions only) and returns files
    whose name OR path contains the (case-insensitive) substring `q`. Each
    result is annotated with its `graphs.status`. Empty `q` returns the
    first `limit` files unfiltered.
    """
    q_lower = q.lower().strip()
    images = list_volume_images(UC_VOLUME_PATH)
    if q_lower:
        images = [p for p in images if q_lower in p.lower()]
    images = images[:limit]
    statuses = _status_map(images)
    out = []
    for p in images:
        # Display name = path relative to UC_VOLUME_PATH for tidiness.
        rel = p
        if p.startswith(UC_VOLUME_PATH.rstrip("/") + "/"):
            rel = p[len(UC_VOLUME_PATH.rstrip("/")) + 1 :]
        out.append({
            "path": p,
            "name": rel,
            "is_dir": False,
            "size": 0,
            "status": statuses.get(p),
        })
    return {"query": q, "count": len(out), "entries": out}
