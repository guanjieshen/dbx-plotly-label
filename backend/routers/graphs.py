from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Path, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from backend.auth import get_user_email
from backend.db import execute, fq, get_calibration, get_graph_info, query, volume_read

router = APIRouter()


class ChartCommentCreate(BaseModel):
    body: str
    parent_comment_id: str | None = None


@router.get("")
def list_graphs(status: str | None = Query(default=None)):
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
    return "application/octet-stream"
