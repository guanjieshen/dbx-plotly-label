from __future__ import annotations

import logging
import os
import time
import uuid

from fastapi import APIRouter, HTTPException, Path, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from backend.auth import get_user_email
from backend.db import (
    UC_CATALOG,
    UC_SCHEMA,
    UC_VOLUME_PATH,
    execute,
    fq,
    get_calibration,
    get_graph_info,
    list_volume_images,
    query,
    volume_read,
)

log = logging.getLogger("eval-labelling.graphs")

router = APIRouter()

# Module-level cache for the volume walk. Walking a UC volume calls the Files
# API once per directory — fine for ten files, slow for thousands. We cache the
# result for AUTO_SCAN_TTL seconds so rapid back-to-back `/api/graphs` calls
# (boot, then after Submit) don't re-walk every time.
_AUTO_SCAN_TTL_S = float(os.environ.get("EVAL_AUTO_SCAN_TTL", "30"))
_last_scan_at: float = 0.0


class ChartCommentCreate(BaseModel):
    body: str
    parent_comment_id: str | None = None


def _auto_scan_volume() -> int:
    """Best-effort: walk the configured volume, INSERT any new image paths
    into `graphs` with status='unlabelled'. Returns the count of new rows.

    Gated by env `EVAL_AUTO_SCAN` (set to "0" to disable). Caches the walk
    for EVAL_AUTO_SCAN_TTL seconds to avoid hammering the Files API.
    """
    global _last_scan_at
    if os.environ.get("EVAL_AUTO_SCAN", "1") == "0":
        return 0
    now = time.time()
    if now - _last_scan_at < _AUTO_SCAN_TTL_S:
        return 0
    _last_scan_at = now
    try:
        images = list_volume_images(UC_VOLUME_PATH)
    except Exception as e:
        log.warning("auto_scan: volume walk failed: %s", e)
        return 0
    if not images:
        return 0
    prefix = UC_VOLUME_PATH.rstrip("/") + "/"
    try:
        existing_rows = query(
            f"SELECT graph_path FROM {fq('graphs')} WHERE graph_path LIKE :prefix",
            {"prefix": prefix + "%"},
        )
    except Exception as e:
        log.warning("auto_scan: existing query failed: %s", e)
        return 0
    existing = {r["graph_path"] for r in existing_rows if r.get("graph_path")}
    new_paths = [p for p in images if p not in existing]
    if not new_paths:
        return 0
    # New rows get metadata.data_table pointing at the default chart_points
    # location (catalog.schema.chart_points). Upstream pipelines that want
    # a different source can UPDATE later.
    data_table = f"{UC_CATALOG}.{UC_SCHEMA}.chart_points"
    rows_sql: list[str] = []
    params: dict = {"dt": data_table}
    for i, p in enumerate(new_paths):
        params[f"p{i}"] = p
        rows_sql.append(
            f"(:p{i}, 'unlabelled', NULL, NULL, NULL, "
            "current_timestamp(), map('data_table', :dt))"
        )
    try:
        execute(
            f"INSERT INTO {fq('graphs')} "
            "(graph_path, status, assignee_email, completed_by, completed_at, "
            "created_at, metadata) VALUES " + ", ".join(rows_sql),
            params,
        )
    except Exception as e:
        log.warning("auto_scan: insert failed: %s", e)
        return 0
    log.info("auto_scan: inserted %d new graph rows", len(new_paths))
    return len(new_paths)


@router.get("")
def list_graphs(status: str | None = Query(default=None)):
    # Auto-discover new files on every list (cached for ~30s).
    _auto_scan_volume()
    sql = f"SELECT graph_path, status, assignee_email, completed_by, completed_at, created_at FROM {fq('graphs')}"
    params: dict = {}
    if status:
        sql += " WHERE status = :status"
        params["status"] = status
    sql += " ORDER BY created_at"
    return query(sql, params)


@router.get("/{path:path}/image")
def get_image(path: str = Path(..., description="UC volume path")):
    target = _resolve(path)
    try:
        data = volume_read(target)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"image not found: {e}")
    return Response(content=data, media_type=_mime_from(target))


@router.get("/{path:path}/annotations")
def get_annotations(path: str):
    target = _resolve(path)
    shapes = query(
        f"""
        SELECT annotation_id, graph_path, shape_type, x, y, width, height,
               image_width, image_height, label_class, created_by,
               created_at, updated_at, frozen, deleted,
               applies_to, data_x_min, data_x_max, data_y_min, data_y_max,
               custom_label
        FROM {fq('annotations')}
        WHERE graph_path = :p AND COALESCE(deleted, false) = false
        ORDER BY created_at
        """,
        {"p": target},
    )
    by_ann: dict[str, list] = {}
    if shapes:
        ids = [s["annotation_id"] for s in shapes]
        # Inlined IN list because the SQL connector's IN-with-array binding is finicky.
        quoted = ",".join("'" + i.replace("'", "''") + "'" for i in ids)
        cmts = query(
            f"""
            SELECT comment_id, annotation_id, parent_comment_id, author_email, body, created_at
            FROM {fq('comments')}
            WHERE annotation_id IN ({quoted})
              AND COALESCE(scope, 'annotation') = 'annotation'
            ORDER BY created_at
            """
        )
        for c in cmts:
            by_ann.setdefault(c["annotation_id"], []).append(c)
    chart_comments = query(
        f"""
        SELECT comment_id, annotation_id, parent_comment_id, author_email, body, created_at
        FROM {fq('comments')}
        WHERE graph_path = :p AND scope = 'chart'
        ORDER BY created_at
        """,
        {"p": target},
    )
    axes = get_calibration(target)
    graph_info = get_graph_info(target)
    return {
        "annotations": shapes,
        "comments_by_annotation": by_ann,
        "chart_comments": chart_comments,
        "axes": axes,
        "graph_info": graph_info,
    }


@router.post("/{path:path}/comments")
def add_chart_comment(path: str, body: ChartCommentCreate, request: Request):
    """Comment on the whole chart (no shape attached). scope='chart'."""
    target = _resolve(path)
    user = get_user_email(request)
    cid = str(uuid.uuid4())
    execute(
        f"""
        INSERT INTO {fq('comments')}
            (comment_id, annotation_id, parent_comment_id, author_email,
             body, created_at, scope, graph_path)
        VALUES
            (:cid, NULL, :pid, :u, :b, current_timestamp(), 'chart', :gp)
        """,
        {
            "cid": cid,
            "pid": body.parent_comment_id,
            "u": user,
            "b": body.body,
            "gp": target,
        },
    )
    rows = query(
        f"SELECT * FROM {fq('comments')} WHERE comment_id = :cid",
        {"cid": cid},
    )
    return rows[0] if rows else {"comment_id": cid}


@router.post("/{path:path}/freeze")
def freeze(path: str, request: Request):
    user = get_user_email(request)
    target = _resolve(path)
    execute(
        f"""
        UPDATE {fq('annotations')} SET frozen = true, updated_at = current_timestamp()
        WHERE graph_path = :p AND COALESCE(deleted, false) = false
        """,
        {"p": target},
    )
    execute(
        f"""
        UPDATE {fq('graphs')}
        SET status = 'done', completed_by = :u, completed_at = current_timestamp()
        WHERE graph_path = :p
        """,
        {"p": target, "u": user},
    )
    return {"ok": True, "graph_path": target}


@router.post("/{path:path}/skip")
def skip(path: str, request: Request):
    user = get_user_email(request)
    target = _resolve(path)
    execute(
        f"""
        UPDATE {fq('graphs')}
        SET status = 'skipped', completed_by = :u, completed_at = current_timestamp()
        WHERE graph_path = :p
        """,
        {"p": target, "u": user},
    )
    return {"ok": True, "graph_path": target}


# ----- helpers -------------------------------------------------------------

def _resolve(path: str) -> str:
    from backend.db import UC_VOLUME_PATH

    if path.startswith("/Volumes/"):
        return path
    return f"{UC_VOLUME_PATH.rstrip('/')}/{path.lstrip('/')}"


def _mime_from(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".gif"):
        return "image/gif"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".bmp"):
        return "image/bmp"
    if lower.endswith(".svg"):
        return "image/svg+xml"
    return "application/octet-stream"
