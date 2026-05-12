"""Databricks SQL connector + UC volume helpers.

Auth model: service principal in Databricks Apps. We read DATABRICKS_HOST,
DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET from the environment that the
Apps runtime auto-injects, and bind the SQL warehouse via DATABRICKS_WAREHOUSE_ID
(declared in app.yaml).
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterable

from databricks import sql as dbsql
from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config, oauth_service_principal


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

UC_CATALOG = os.environ.get("UC_CATALOG", "classic_stable_ccu63h")
UC_SCHEMA = os.environ.get("UC_SCHEMA", "eval_labelling")
UC_VOLUME_PATH = os.environ.get(
    "UC_VOLUME_PATH", "/Volumes/classic_stable_ccu63h/eval_labelling/graphs"
)
WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")


def _host() -> str:
    host = os.environ.get("DATABRICKS_HOST", "")
    if host and not host.startswith("http"):
        host = f"https://{host}"
    return host


def _http_path() -> str:
    if not WAREHOUSE_ID:
        raise RuntimeError("DATABRICKS_WAREHOUSE_ID is not set")
    return f"/sql/1.0/warehouses/{WAREHOUSE_ID}"


def _sp_credential_provider():
    """OAuth M2M credentials for the App service principal."""
    cfg = Config(
        host=_host(),
        client_id=os.environ.get("DATABRICKS_CLIENT_ID"),
        client_secret=os.environ.get("DATABRICKS_CLIENT_SECRET"),
    )
    return oauth_service_principal(cfg)


# ---------------------------------------------------------------------------
# SQL helpers
# ---------------------------------------------------------------------------

@contextmanager
def sql_conn():
    host = _host().replace("https://", "").replace("http://", "")
    conn = dbsql.connect(
        server_hostname=host,
        http_path=_http_path(),
        credentials_provider=_sp_credential_provider,
    )
    try:
        yield conn
    finally:
        conn.close()


def query(stmt: str, params: dict | None = None) -> list[dict[str, Any]]:
    """Run a SELECT-ish statement, return rows as list[dict]."""
    with sql_conn() as conn:
        cur = conn.cursor()
        cur.execute(stmt, params or {})
        if cur.description is None:
            return []
        cols = [c[0] for c in cur.description]
        rows = cur.fetchall()
        return [dict(zip(cols, _normalize_row(r))) for r in rows]


def execute(stmt: str, params: dict | None = None) -> int:
    """Run a write statement, return affected row count if available."""
    with sql_conn() as conn:
        cur = conn.cursor()
        cur.execute(stmt, params or {})
        try:
            return cur.rowcount
        except Exception:
            return -1


def _normalize_row(row: Iterable) -> list[Any]:
    """Convert any unhashable / unserializable cell values into plain Python."""
    out = []
    for cell in row:
        if hasattr(cell, "isoformat"):  # datetime / date
            out.append(cell.isoformat())
        else:
            out.append(cell)
    return out


def fq(table: str) -> str:
    """Fully qualified table name."""
    return f"`{UC_CATALOG}`.`{UC_SCHEMA}`.`{table}`"


# ---------------------------------------------------------------------------
# Volume helpers — use SDK Files API for byte-level access.
# ---------------------------------------------------------------------------

def workspace_client() -> WorkspaceClient:
    """SDK client for UC Volumes (Files API) operations."""
    # In Databricks Apps the SDK auto-detects creds from the env vars.
    return WorkspaceClient()


def volume_list(path: str) -> list[dict[str, Any]]:
    """List immediate children at a UC volume path.

    Returns list of {name, path, is_dir, size}.
    """
    w = workspace_client()
    out: list[dict[str, Any]] = []
    for entry in w.files.list_directory_contents(path):
        out.append({
            "name": entry.name,
            "path": entry.path,
            "is_dir": bool(entry.is_directory),
            "size": entry.file_size or 0,
        })
    return out


def volume_read(path: str) -> bytes:
    """Read a file from a UC volume as bytes."""
    w = workspace_client()
    resp = w.files.download(path)
    # SDK returns a DownloadResponse with .contents (a BinaryIO).
    return resp.contents.read()


# Image file extensions the app understands. Kept in sync with bin/_scan_volume.py
# and the supported list in the README.
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}


def list_volume_images(volume_root: str) -> list[str]:
    """Recursively list every image-extension file under a UC volume root.

    Used by `/api/graphs` to auto-discover new files at boot, and by
    `/api/volume/search` for the search box in the volume browser.
    """
    found: list[str] = []
    stack = [volume_root.rstrip("/")]
    while stack:
        cur = stack.pop()
        try:
            entries = volume_list(cur)
        except Exception:
            continue
        for e in entries:
            full = e.get("path") or ""
            if not full:
                continue
            if e.get("is_dir"):
                stack.append(full.rstrip("/"))
                continue
            lower = full.lower()
            if any(lower.endswith(ext) for ext in IMAGE_EXTS):
                found.append(full)
    return found


# ---------------------------------------------------------------------------
# Calibration & box → data snapshot helpers.
# A chart's `graphs.metadata` MAP carries axis ranges + plot-area pixel bbox.
# That lets us project a pixel bbox (what the labeller draws) back to data
# coordinates, then snapshot the underlying data rows inside the box from
# whichever `data_table` the producer registered.
# ---------------------------------------------------------------------------

import json as _json
import logging as _logging
import re as _re

_log = _logging.getLogger("eval-labelling.db")

# Keys we read from graphs.metadata MAP<STRING,STRING>.
_CAL_KEYS = (
    "chart_id", "data_table",
    "axis_x_min", "axis_x_max", "axis_y_min", "axis_y_max",
    "plot_bbox_px", "image_width", "image_height",
    "x_label", "y_label", "chart_title",
)

# Three-level UC-qualified table name. Permissive but injection-safe.
_VALID_TABLE = _re.compile(r"^[A-Za-z_][\w]*\.[A-Za-z_][\w]*\.[A-Za-z_][\w]*$")


def _parse_metadata_map(raw) -> dict:
    """Coerce a graphs.metadata MAP value to a plain dict[str, str].

    MAP<STRING,STRING> surfaces in three shapes depending on the path:
      - dict   (some connector versions return this directly)
      - JSON-encoded string (SQL Statements API)
      - list[{'key': ..., 'value': ...}] or list[(k,v)] (Arrow-backed
        databricks-sql-connector, which is what we use here)
    """
    if raw is None:
        return {}
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except _json.JSONDecodeError:
            return {}
    if isinstance(raw, list):
        out: dict = {}
        for item in raw:
            if isinstance(item, dict) and "key" in item and "value" in item:
                out[item["key"]] = item["value"]
            elif isinstance(item, (list, tuple)) and len(item) == 2:
                out[item[0]] = item[1]
        return out
    if isinstance(raw, dict):
        return raw
    return {}


def get_calibration(graph_path: str) -> dict | None:
    """Return calibration block for a graph, or None if not registered.

    Reads from graphs.metadata MAP. Always returns plain floats / dicts so the
    caller can JSON-serialize without further work.
    """
    rows = query(
        f"SELECT metadata FROM {fq('graphs')} WHERE graph_path = :gp",
        {"gp": graph_path},
    )
    if not rows:
        return None
    md = _parse_metadata_map(rows[0].get("metadata"))
    if not md:
        return None
    out: dict = {}
    for k in _CAL_KEYS:
        if k in md and md[k] is not None:
            out[k] = md[k]
    if not out:
        return None
    # Coerce known numeric fields.
    for k in ("axis_x_min", "axis_x_max", "axis_y_min", "axis_y_max"):
        if k in out:
            try:
                out[k] = float(out[k])
            except (TypeError, ValueError):
                out.pop(k, None)
    for k in ("image_width", "image_height"):
        if k in out:
            try:
                out[k] = int(out[k])
            except (TypeError, ValueError):
                out.pop(k, None)
    # plot_bbox_px is stored as JSON because MAP<STRING,STRING> can't nest.
    if "plot_bbox_px" in out and isinstance(out["plot_bbox_px"], str):
        try:
            out["plot_bbox_px"] = _json.loads(out["plot_bbox_px"])
        except _json.JSONDecodeError:
            out.pop("plot_bbox_px", None)
    return out


def get_graph_info(graph_path: str) -> dict | None:
    """Return lifecycle fields + full metadata MAP for a graph, or None.

    Used by the Task-info panel in the UI: caller renders friendly fields,
    advanced fields, and any unknown ("Other") keys directly from the
    metadata dict.
    """
    rows = query(
        f"""
        SELECT graph_path, status, assignee_email, completed_by, completed_at,
               created_at, metadata
        FROM {fq('graphs')}
        WHERE graph_path = :gp
        """,
        {"gp": graph_path},
    )
    if not rows:
        return None
    r = rows[0]
    return {
        "graph_path": r.get("graph_path"),
        "status": r.get("status"),
        "assignee_email": r.get("assignee_email"),
        "completed_by": r.get("completed_by"),
        "completed_at": r.get("completed_at"),
        "created_at": r.get("created_at"),
        "metadata": _parse_metadata_map(r.get("metadata")),
    }


def _pixel_bbox_to_data(
    px: float, py: float, pw: float, ph: float, cal: dict,
) -> tuple[float, float, float, float] | None:
    """Project a pixel bbox (x,y,w,h) to a data bbox (x_min,x_max,y_min,y_max).

    Requires axis ranges + plot_bbox_px in the calibration; returns None if
    they're missing or malformed.
    """
    bbox = cal.get("plot_bbox_px")
    if not isinstance(bbox, dict):
        return None
    needed = ("x", "y", "w", "h")
    if not all(k in bbox for k in needed):
        return None
    if any(k not in cal for k in ("axis_x_min", "axis_x_max", "axis_y_min", "axis_y_max")):
        return None
    bx, by, bw, bh = float(bbox["x"]), float(bbox["y"]), float(bbox["w"]), float(bbox["h"])
    if bw == 0 or bh == 0:
        return None
    x_min, x_max = cal["axis_x_min"], cal["axis_x_max"]
    y_min, y_max = cal["axis_y_min"], cal["axis_y_max"]
    px1, py1 = px + pw, py + ph

    def to_data(p, q):
        fx = (p - bx) / bw
        fy = (q - by) / bh
        return (x_min + fx * (x_max - x_min), y_max - fy * (y_max - y_min))

    dx0, dy_top = to_data(px, py)
    dx1, dy_bot = to_data(px1, py1)
    return (min(dx0, dx1), max(dx0, dx1), min(dy_top, dy_bot), max(dy_top, dy_bot))


def snapshot_box_to_data_points(
    annotation_id: str,
    graph_path: str,
    pixel_bbox: tuple[float, float, float, float],
) -> int:
    """For an annotation, persist its data bbox + snapshot all matching rows
    from the registered `data_table` into annotation_data_points.

    Returns the number of point rows inserted. Returns 0 (silently) if the
    graph has no calibration / no data_table, so unconfigured graphs work.
    """
    cal = get_calibration(graph_path)
    if cal is None:
        return 0
    chart_id = cal.get("chart_id")
    data_table = cal.get("data_table")
    if not chart_id or not data_table:
        return 0
    if not _VALID_TABLE.match(str(data_table)):
        _log.warning("invalid data_table for graph_path=%s: %r", graph_path, data_table)
        return 0
    data_bbox = _pixel_bbox_to_data(*pixel_bbox, cal=cal)
    if data_bbox is None:
        return 0
    xmin, xmax, ymin, ymax = data_bbox
    # 1) Persist data-coord bbox on the annotation itself.
    execute(
        f"UPDATE {fq('annotations')} SET "
        "data_x_min = :xmin, data_x_max = :xmax, "
        "data_y_min = :ymin, data_y_max = :ymax, "
        "updated_at = current_timestamp() "
        "WHERE annotation_id = :aid",
        {"aid": annotation_id, "xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax},
    )
    # 2) Snapshot the data rows inside the data bbox. Auto-include every trace
    #    (the labeller-set `applies_to` records intent, but we keep the full
    #    cross-trace neighbourhood for future similarity work).
    execute(
        f"INSERT INTO {fq('annotation_data_points')} "
        "(annotation_id, chart_id, trace_id, point_id, x, y, extras, captured_at) "
        f"SELECT :aid, chart_id, trace_id, point_id, x, y, extras, current_timestamp() "
        f"FROM `{data_table.split('.')[0]}`.`{data_table.split('.')[1]}`.`{data_table.split('.')[2]}` "
        "WHERE chart_id = :cid AND x BETWEEN :xmin AND :xmax "
        "AND y BETWEEN :ymin AND :ymax",
        {"aid": annotation_id, "cid": chart_id, "xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax},
    )
    # Returning the count would require a second roundtrip; the caller cares
    # only that this succeeded without exception.
    return 1
