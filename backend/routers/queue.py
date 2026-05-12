from __future__ import annotations

from fastapi import APIRouter, Request, Response

from backend.auth import get_user_email
from backend.db import execute, fq, query

router = APIRouter()


@router.post("/claim")
def claim(request: Request):
    user = get_user_email(request)
    # Atomic claim: pick next unlabelled in created_at order and set in_progress.
    # Delta supports MERGE for atomic CAS; we use a subquery in UPDATE which also
    # serializes via the table's serializable isolation.
    execute(
        f"""
        UPDATE {fq('graphs')}
        SET status = 'in_progress', assignee_email = :u
        WHERE graph_path = (
            SELECT graph_path FROM {fq('graphs')}
            WHERE status = 'unlabelled'
            ORDER BY created_at
            LIMIT 1
        )
        AND status = 'unlabelled'
        """,
        {"u": user},
    )
    rows = query(
        f"""
        SELECT graph_path, status, assignee_email
        FROM {fq('graphs')}
        WHERE assignee_email = :u AND status = 'in_progress'
        ORDER BY created_at
        LIMIT 1
        """,
        {"u": user},
    )
    if not rows:
        return Response(status_code=204)
    return rows[0]
