#!/usr/bin/env python3
"""Walk a UC volume, find image files, and INSERT any new paths into the
`graphs` catalog table.

Idempotent: every run diffs against existing rows in `<catalog>.<schema>.graphs`
and only INSERTs paths that aren't already there. Pre-existing rows are left
untouched (status / metadata preserved).

Args (all required):
    --profile           Databricks CLI profile (empty string = ambient auth)
    --warehouse-id      SQL warehouse for the diff + INSERT
    --volume-path       e.g. /Volumes/cat/sch/vol
    --annotations-fq    "<catalog>.<schema>" where `graphs` lives
    --chart-points-fq   "<catalog>.<schema>.chart_points" — written into
                        graphs.metadata.data_table for new rows; empty string
                        skips the metadata write entirely

Prints a one-line summary to stdout: `<discovered>\t<new>\t<skipped>`.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}


def _cli(profile: str) -> list[str]:
    cmd = ["databricks"]
    if profile:
        cmd += ["--profile", profile]
    return cmd


def list_dir(profile: str, path: str) -> list[dict]:
    """List one volume directory via `databricks fs ls dbfs:<path> --output json`.

    Returns the parsed list (each entry has `name`, `is_directory`, `size`).
    """
    proc = subprocess.run(
        _cli(profile) + ["fs", "ls", f"dbfs:{path}", "--output", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return []
    raw = proc.stdout.strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def walk_images(profile: str, root: str) -> list[str]:
    """Depth-first walk; return absolute volume paths of image files.

    `databricks fs ls` returns relative names; we join them with the current
    directory to reconstruct the absolute volume path.
    """
    found: list[str] = []
    stack = [root.rstrip("/")]
    while stack:
        cur = stack.pop()
        for entry in list_dir(profile, cur):
            name = entry.get("name", "")
            if not name:
                continue
            full = f"{cur}/{name}"
            if entry.get("is_directory") or entry.get("is_dir"):
                stack.append(full)
                continue
            lower = name.lower()
            if any(lower.endswith(ext) for ext in IMAGE_EXTS):
                found.append(full)
    return found


def run_sql(profile: str, warehouse_id: str, statement: str) -> dict:
    """Execute one SQL statement via the SQL Statements API."""
    payload = json.dumps({
        "warehouse_id": warehouse_id,
        "statement": statement,
        "wait_timeout": "50s",
    })
    proc = subprocess.run(
        _cli(profile) + ["api", "post", "/api/2.0/sql/statements", "--json", "@/dev/stdin"],
        input=payload, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"SQL call failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def sql_literal(v: str | None) -> str:
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="")
    ap.add_argument("--warehouse-id", required=True)
    ap.add_argument("--volume-path", required=True)
    ap.add_argument("--annotations-fq", required=True,
                    help="catalog.schema (where the graphs table lives)")
    ap.add_argument("--chart-points-fq", default="",
                    help="catalog.schema.table written into graphs.metadata.data_table for new rows")
    args = ap.parse_args()

    graphs_table = f"{args.annotations_fq}.graphs"

    # Step 1: discover image files
    discovered = walk_images(args.profile, args.volume_path)

    # Step 2: read existing paths under this volume root from graphs
    prefix = args.volume_path.rstrip("/") + "/"
    resp = run_sql(
        args.profile, args.warehouse_id,
        f"SELECT graph_path FROM {graphs_table} WHERE graph_path LIKE {sql_literal(prefix + '%')}",
    )
    existing: set[str] = set()
    result = resp.get("result") or {}
    for row in result.get("data_array") or []:
        if row and row[0]:
            existing.add(row[0])

    new_paths = [p for p in discovered if p not in existing]
    if not new_paths:
        print(f"{len(discovered)}\t0\t{len(discovered)}")
        return 0

    # Step 3: build a single multi-VALUES INSERT for the new rows
    md_lit = "map()"
    if args.chart_points_fq:
        md_lit = (
            "map(" + sql_literal("data_table") + ", "
            + sql_literal(args.chart_points_fq) + ")"
        )
    rows_sql = []
    for p in new_paths:
        rows_sql.append(
            "(" + sql_literal(p) + ", "
            + sql_literal("unlabelled") + ", NULL, NULL, NULL, "
            + "current_timestamp(), " + md_lit + ")"
        )
    insert_stmt = (
        f"INSERT INTO {graphs_table} "
        "(graph_path, status, assignee_email, completed_by, completed_at, "
        "created_at, metadata) VALUES " + ", ".join(rows_sql)
    )
    resp = run_sql(args.profile, args.warehouse_id, insert_stmt)
    state = (resp.get("status") or {}).get("state")
    if state != "SUCCEEDED":
        msg = ((resp.get("status") or {}).get("error") or {}).get("message", "")
        raise RuntimeError(f"INSERT failed ({state}): {msg[:200]}")

    print(f"{len(discovered)}\t{len(new_paths)}\t{len(discovered)-len(new_paths)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"# scan_volume error: {e}", file=sys.stderr)
        sys.exit(1)
