from __future__ import annotations

import uuid

from fastapi import APIRouter, Request
from pydantic import BaseModel

from backend.auth import get_user_email
from backend.db import execute, fq, query

router = APIRouter()


class CommentCreate(BaseModel):
    body: str
    parent_comment_id: str | None = None


class CommentBatchItem(BaseModel):
    body: str
    parent_comment_id: str | None = None
    # Annotation-scoped: annotation_id is set, scope omitted or 'annotation'.
    # Chart-scoped:      graph_path is set, scope='chart'.
    annotation_id: str | None = None
    graph_path: str | None = None
    scope: str | None = None


class CommentBatchCreate(BaseModel):
    items: list[CommentBatchItem]


@router.post("/annotations/{annotation_id}/comments")
def create(annotation_id: str, payload: CommentCreate, request: Request):
    cid = str(uuid.uuid4())
    user = get_user_email(request)
    execute(
        f"""
        INSERT INTO {fq('comments')}
            (comment_id, annotation_id, parent_comment_id, author_email, body, created_at)
        VALUES (:cid, :aid, :pid, :u, :b, current_timestamp())
        """,
        {
            "cid": cid,
            "aid": annotation_id,
            "pid": payload.parent_comment_id,
            "u": user,
            "b": payload.body,
        },
    )
    rows = query(
        f"SELECT * FROM {fq('comments')} WHERE comment_id = :cid",
        {"cid": cid},
    )
    return rows[0] if rows else {"comment_id": cid}


@router.post("/comments/batch")
def create_batch(body: CommentBatchCreate, request: Request):
    """Insert many comments in a single multi-VALUES statement.

    Each item is either annotation-scoped (`annotation_id` set) or
    chart-scoped (`graph_path` set, `scope='chart'`). The frontend has
    already resolved any tmp annotation parents to real ids before calling.
    """
    if not body.items:
        return {"inserted": 0}
    user = get_user_email(request)
    rows_sql: list[str] = []
    params: dict = {}
    for i, item in enumerate(body.items):
        scope = (item.scope or ("chart" if item.graph_path and not item.annotation_id else "annotation"))
        if scope == "chart" and not item.graph_path:
            continue  # skip malformed chart-scope items rather than fail the batch
        if scope == "annotation" and not item.annotation_id:
            continue
        prefix = f"r{i}_"
        cid = str(uuid.uuid4())
        rows_sql.append(
            f"(:{prefix}cid, :{prefix}aid, :{prefix}pid, :{prefix}u, "
            f":{prefix}b, current_timestamp(), :{prefix}sc, :{prefix}gp)"
        )
        params[f"{prefix}cid"] = cid
        params[f"{prefix}aid"] = item.annotation_id  # None for chart scope
        params[f"{prefix}pid"] = item.parent_comment_id
        params[f"{prefix}u"] = user
        params[f"{prefix}b"] = item.body
        params[f"{prefix}sc"] = scope
        params[f"{prefix}gp"] = item.graph_path  # None for annotation scope
    if not rows_sql:
        return {"inserted": 0}
    stmt = (
        f"INSERT INTO {fq('comments')} "
        "(comment_id, annotation_id, parent_comment_id, author_email, body, "
        "created_at, scope, graph_path) "
        "VALUES " + ", ".join(rows_sql)
    )
    execute(stmt, params)
    return {"inserted": len(rows_sql)}
