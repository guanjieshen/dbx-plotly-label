from __future__ import annotations

import logging
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.auth import get_user_email
from backend.db import execute, fq, query, snapshot_box_to_data_points

log = logging.getLogger("eval-labelling.annotations")

router = APIRouter()


AppliesTo = Literal["prediction", "actuals", "both"]


class AnnotationCreate(BaseModel):
    graph_path: str
    shape_type: str
    x: float
    y: float
    width: float
    height: float
    image_width: int
    image_height: int
    label_class: str
    applies_to: AppliesTo | None = None
    custom_label: str | None = None


class AnnotationUpdate(BaseModel):
    shape_type: str | None = None
    x: float | None = None
    y: float | None = None
    width: float | None = None
    height: float | None = None
    label_class: str | None = None
    applies_to: AppliesTo | None = None
    custom_label: str | None = None


def _normalize_custom(label_class: str, custom_label: str | None) -> str | None:
    """Custom-class rows must have non-empty custom_label; other classes ignore it.

    Raises 400 if a custom class arrives with empty/whitespace text.
    """
    if label_class == "custom":
        text = (custom_label or "").strip()
        if not text:
            raise HTTPException(
                status_code=400,
                detail="custom_label is required when label_class='custom'",
            )
        return text
    # Non-custom: drop any text the client accidentally sent.
    return None


class AnnotationBatchCreateItem(AnnotationCreate):
    client_id: str  # caller-provided tmp id; we echo it back with the real annotation_id


class AnnotationBatchCreate(BaseModel):
    items: list[AnnotationBatchCreateItem]


class AnnotationBatchPatchItem(AnnotationUpdate):
    annotation_id: str


class AnnotationBatchPatch(BaseModel):
    items: list[AnnotationBatchPatchItem]


class AnnotationBatchDelete(BaseModel):
    annotation_ids: list[str]


# ---------------------------------------------------------------------------
# Batch endpoints — one Delta commit per call instead of N round-trips.
# Declared BEFORE the single-row /{annotation_id} routes so FastAPI matches
# `/batch` exactly instead of treating "batch" as a path parameter.
# ---------------------------------------------------------------------------


@router.post("/batch")
def create_batch(body: AnnotationBatchCreate, request: Request):
    """Insert many annotations in a single multi-VALUES statement.

    Returns `[{client_id, annotation_id}]` so the caller can map its temp ids
    back to the real ones (for example, to resolve buffered comments' parents).
    After the multi-VALUES insert we walk each item and snapshot its
    box-to-data points (one extra Delta commit per annotation, only at Submit
    time — acceptable since we already deferred latency off the draw path).
    """
    if not body.items:
        return {"items": []}
    user = get_user_email(request)
    mappings: list[dict[str, str]] = []
    rows_sql: list[str] = []
    params: dict = {}
    for i, item in enumerate(body.items):
        aid = str(uuid.uuid4())
        mappings.append({"client_id": item.client_id, "annotation_id": aid})
        prefix = f"r{i}_"
        rows_sql.append(
            f"(:{prefix}aid, :{prefix}gp, :{prefix}st, :{prefix}x, :{prefix}y, "
            f":{prefix}w, :{prefix}h, :{prefix}iw, :{prefix}ih, :{prefix}lc, "
            f":{prefix}u, current_timestamp(), current_timestamp(), false, false, "
            f":{prefix}at, :{prefix}cl)"
        )
        params[f"{prefix}aid"] = aid
        params[f"{prefix}gp"] = item.graph_path
        params[f"{prefix}st"] = item.shape_type
        params[f"{prefix}x"] = item.x
        params[f"{prefix}y"] = item.y
        params[f"{prefix}w"] = item.width
        params[f"{prefix}h"] = item.height
        params[f"{prefix}iw"] = item.image_width
        params[f"{prefix}ih"] = item.image_height
        params[f"{prefix}lc"] = item.label_class
        params[f"{prefix}u"] = user
        params[f"{prefix}at"] = item.applies_to
        params[f"{prefix}cl"] = _normalize_custom(item.label_class, item.custom_label)
    stmt = (
        f"INSERT INTO {fq('annotations')} "
        "(annotation_id, graph_path, shape_type, x, y, width, height, "
        "image_width, image_height, label_class, created_by, "
        "created_at, updated_at, frozen, deleted, applies_to, custom_label) VALUES "
        + ", ".join(rows_sql)
    )
    execute(stmt, params)
    # Snapshot data inside each box where calibration is available. Quietly
    # skips graphs without calibration — labelling still works.
    for item, m in zip(body.items, mappings):
        try:
            snapshot_box_to_data_points(
                m["annotation_id"],
                item.graph_path,
                (item.x, item.y, item.width, item.height),
            )
        except Exception:
            log.exception(
                "snapshot_box_to_data_points failed for annotation_id=%s graph_path=%s",
                m["annotation_id"], item.graph_path,
            )
    return {"items": mappings}


@router.patch("/batch")
def patch_batch(body: AnnotationBatchPatch):
    """Apply many independent patches in a single statement per field.

    Implementation: for each updateable column, build a CASE WHEN keyed on
    annotation_id, then run one UPDATE that only touches rows whose ids appear
    in the batch and that aren't frozen. One Delta commit total.
    """
    if not body.items:
        return {"updated": 0}
    fields = ("shape_type", "x", "y", "width", "height", "label_class")
    # collect per-field updates
    per_field: dict[str, dict[str, object]] = {f: {} for f in fields}
    for item in body.items:
        for f in fields:
            v = getattr(item, f)
            if v is not None:
                per_field[f][item.annotation_id] = v

    set_clauses: list[str] = []
    params: dict = {}
    ids = [item.annotation_id for item in body.items]
    for f, mapping in per_field.items():
        if not mapping:
            continue
        case_parts: list[str] = []
        for j, (aid, val) in enumerate(mapping.items()):
            key = f"{f}_{j}"
            case_parts.append(f"WHEN annotation_id = :{key}_id THEN :{key}_v")
            params[f"{key}_id"] = aid
            params[f"{key}_v"] = val
        set_clauses.append(f"{f} = CASE {' '.join(case_parts)} ELSE {f} END")
    if not set_clauses:
        return {"updated": 0}
    set_clauses.append("updated_at = current_timestamp()")
    id_params = {f"id_{i}": v for i, v in enumerate(ids)}
    params.update(id_params)
    id_list = ", ".join(f":{k}" for k in id_params.keys())
    stmt = (
        f"UPDATE {fq('annotations')} SET {', '.join(set_clauses)} "
        f"WHERE annotation_id IN ({id_list}) AND COALESCE(frozen, false) = false"
    )
    execute(stmt, params)
    return {"updated": len(body.items)}


@router.delete("/batch")
def delete_batch(body: AnnotationBatchDelete):
    if not body.annotation_ids:
        return {"deleted": 0}
    params = {f"id_{i}": v for i, v in enumerate(body.annotation_ids)}
    id_list = ", ".join(f":{k}" for k in params.keys())
    execute(
        f"UPDATE {fq('annotations')} "
        "SET deleted = true, updated_at = current_timestamp() "
        f"WHERE annotation_id IN ({id_list}) "
        "AND COALESCE(frozen, false) = false",
        params,
    )
    return {"deleted": len(body.annotation_ids)}


# ---------------------------------------------------------------------------
# Single-row endpoints (kept for any optimistic UI paths; declared AFTER batch
# so /batch wins exact-match resolution).
# ---------------------------------------------------------------------------


@router.post("")
def create(body: AnnotationCreate, request: Request):
    user = get_user_email(request)
    aid = str(uuid.uuid4())
    cl = _normalize_custom(body.label_class, body.custom_label)
    execute(
        f"""
        INSERT INTO {fq('annotations')}
            (annotation_id, graph_path, shape_type, x, y, width, height,
             image_width, image_height, label_class, created_by,
             created_at, updated_at, frozen, deleted, applies_to, custom_label)
        VALUES
            (:aid, :gp, :st, :x, :y, :w, :h, :iw, :ih, :lc, :u,
             current_timestamp(), current_timestamp(), false, false, :at, :cl)
        """,
        {
            "aid": aid, "gp": body.graph_path, "st": body.shape_type,
            "x": body.x, "y": body.y, "w": body.width, "h": body.height,
            "iw": body.image_width, "ih": body.image_height,
            "lc": body.label_class, "u": user, "at": body.applies_to,
            "cl": cl,
        },
    )
    try:
        snapshot_box_to_data_points(
            aid, body.graph_path, (body.x, body.y, body.width, body.height),
        )
    except Exception:
        log.exception(
            "snapshot_box_to_data_points failed for annotation_id=%s graph_path=%s",
            aid, body.graph_path,
        )
    rows = query(
        f"SELECT * FROM {fq('annotations')} WHERE annotation_id = :aid",
        {"aid": aid},
    )
    return rows[0] if rows else {"annotation_id": aid}


@router.patch("/{annotation_id}")
def update(annotation_id: str, body: AnnotationUpdate):
    sets: list[str] = []
    params: dict = {"aid": annotation_id}
    for field in ("shape_type", "x", "y", "width", "height", "label_class"):
        val = getattr(body, field)
        if val is not None:
            sets.append(f"{field} = :{field}")
            params[field] = val
    if not sets:
        raise HTTPException(status_code=400, detail="no fields to update")
    sets.append("updated_at = current_timestamp()")
    execute(
        f"UPDATE {fq('annotations')} SET {', '.join(sets)} "
        "WHERE annotation_id = :aid AND COALESCE(frozen, false) = false",
        params,
    )
    rows = query(
        f"SELECT * FROM {fq('annotations')} WHERE annotation_id = :aid",
        {"aid": annotation_id},
    )
    if not rows:
        raise HTTPException(status_code=404, detail="annotation not found")
    return rows[0]


@router.delete("/{annotation_id}")
def delete(annotation_id: str):
    execute(
        f"""
        UPDATE {fq('annotations')}
        SET deleted = true, updated_at = current_timestamp()
        WHERE annotation_id = :aid AND COALESCE(frozen, false) = false
        """,
        {"aid": annotation_id},
    )
    return {"ok": True, "annotation_id": annotation_id}
