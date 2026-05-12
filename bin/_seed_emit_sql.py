#!/usr/bin/env python3
"""Emit the SQL needed to seed one chart's points + metadata.

Reads calibration + points JSON sidecars (produced by seed_chart_data.py),
prints one statement per line to stdout. bin/deploy.sh splits on newline and
runs each via the SQL Statements API.

Args:
    1) calibration JSON path
    2) points JSON path
    3) full graph_path (the volume path of the PNG, used as the WHERE key)
    4) data_table (catalog.schema.table) — fully-qualified
    5) graphs_table (catalog.schema.table)
"""
from __future__ import annotations

import json
import sys


def s(v) -> str:
    """SQL string literal (or NULL)."""
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def n(v) -> str:
    """SQL numeric (or NULL)."""
    if v is None:
        return "NULL"
    return str(v)


def map_lit(d) -> str:
    if not d:
        return "map()"
    parts = []
    for k, v in d.items():
        parts.append(s(k))
        parts.append(s(v))
    return "map(" + ", ".join(parts) + ")"


def main() -> None:
    calib_path, points_path, graph_path, data_table, graphs_table = sys.argv[1:6]
    calib = json.loads(open(calib_path).read())
    points = json.loads(open(points_path).read())
    chart_id = calib["chart_id"]

    # 1) Replace chart_points for this chart_id (idempotent on re-runs).
    print(f"DELETE FROM {data_table} WHERE chart_id = {s(chart_id)}")
    if points:
        values = []
        for p in points:
            values.append(
                "(" + s(p["chart_id"]) + ", "
                    + s(p["trace_id"]) + ", "
                    + s(p["point_id"]) + ", "
                    + n(p["x"]) + ", "
                    + n(p["y"]) + ", "
                    + map_lit(p.get("extras")) + ", current_timestamp())"
            )
        print(
            "INSERT INTO " + data_table
            + " (chart_id, trace_id, point_id, x, y, extras, ingested_at) VALUES "
            + ", ".join(values)
        )

    # 2) Calibration -> graphs.metadata MAP. plot_bbox_px must be JSON-encoded
    #    because MAP<STRING,STRING> can't nest.
    md_pairs = {
        "chart_id":     chart_id,
        "data_table":   data_table,
        "axis_x_min":   str(calib["x_min"]),
        "axis_x_max":   str(calib["x_max"]),
        "axis_y_min":   str(calib["y_min"]),
        "axis_y_max":   str(calib["y_max"]),
        "plot_bbox_px": json.dumps(calib["plot_bbox_px"]),
        "image_width":  str(calib["image_width"]),
        "image_height": str(calib["image_height"]),
        "x_label":      calib.get("x_label", ""),
        "y_label":      calib.get("y_label", ""),
        "chart_title":  calib.get("title", ""),
    }
    print(
        "UPDATE " + graphs_table
        + " SET metadata = " + map_lit(md_pairs)
        + " WHERE graph_path = " + s(graph_path)
    )


if __name__ == "__main__":
    main()
