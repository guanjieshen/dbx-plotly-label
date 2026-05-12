#!/usr/bin/env python3
"""Extract calibration + per-trace data points for the VFD example charts.

Invoked by bin/deploy.sh --seed-samples via the VFD venv:

    ~/Desktop/vfd-power-curves/.venv/bin/python bin/seed_chart_data.py <outdir>

For each example we write two JSON sidecars next to the rendered PNG:

  <chart>.calibration.json    -> axis ranges + plot-area pixel bbox + labels
  <chart>.points.json         -> [{chart_id, trace_id, point_id, x, y, extras}, ...]

The deploy script then INSERTs the points into UC and UPDATEs the
graphs.metadata MAP for each row so the labelling app can resolve a pixel
box back to data values.
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

VFD = pathlib.Path("/Users/guanjie.shen/Desktop/vfd-power-curves")

# Map: chart_id -> (module file name, png file name placed in the volume)
EXAMPLES = [
    ("vfd_basic",            "example1_basic",            "example1_basic.png"),
    ("vfd_confidence_band",  "example2_confidence_band",  "example2_confidence_band.png"),
    ("vfd_bep_residuals",    "example3_bep_residuals",    "example3_bep_residuals.png"),
]

# We render the HTML in headless Chrome at 1280x720 (see bin/deploy.sh). Match
# that size here so full_figure_for_development returns the same layout the
# screenshot saw.
WIDTH, HEIGHT = 1280, 720

# Map Plotly trace name -> canonical trace_id (used by the app's data-snapshot logic).
TRACE_NAME_MAP = {
    "Predicted (VFD model)": "prediction",
    "Predicted":             "prediction",
    "Predicted curve":       "prediction",
    "Actual readings":       "actuals",
    "Actual":                "actuals",
    "BEP":                   "bep",
    "95% prediction band":   "band",
}


def _load_module(path: pathlib.Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _trace_id(name: str | None, idx: int) -> str:
    if not name:
        return f"trace{idx}"
    return TRACE_NAME_MAP.get(name, name.lower().replace(" ", "_").replace("(", "").replace(")", ""))


def _build_calibration(chart_id: str, fig) -> dict:
    fig.update_layout(width=WIDTH, height=HEIGHT)
    full = fig.full_figure_for_development(warn=False)
    xr = list(full.layout.xaxis.range)
    yr = list(full.layout.yaxis.range)
    m = full.layout.margin
    margin = {
        "l": int(m.l) if m.l is not None else 80,
        "r": int(m.r) if m.r is not None else 80,
        "t": int(m.t) if m.t is not None else 100,
        "b": int(m.b) if m.b is not None else 80,
    }
    plot_bbox_px = {
        "x": margin["l"],
        "y": margin["t"],
        "w": WIDTH - margin["l"] - margin["r"],
        "h": HEIGHT - margin["t"] - margin["b"],
    }
    return {
        "chart_id": chart_id,
        "image_width": WIDTH,
        "image_height": HEIGHT,
        "x_min": float(xr[0]), "x_max": float(xr[1]),
        "y_min": float(yr[0]), "y_max": float(yr[1]),
        "plot_bbox_px": plot_bbox_px,
        "x_label": str(full.layout.xaxis.title.text or ""),
        "y_label": str(full.layout.yaxis.title.text or ""),
        "title":   str(full.layout.title.text or ""),
    }


def _build_points(chart_id: str, fig) -> list[dict]:
    rows: list[dict] = []
    for ti, trace in enumerate(fig.data):
        tname = getattr(trace, "name", None)
        trace_id = _trace_id(tname, ti)
        xs = list(trace.x) if trace.x is not None else []
        ys = list(trace.y) if trace.y is not None else []
        # Optional residual via marker.color for the BEP-residuals example.
        marker = getattr(trace, "marker", None)
        residuals = None
        if marker is not None and getattr(marker, "color", None) is not None:
            mc = marker.color
            # When color is an array of numerics, treat as per-point residual.
            if hasattr(mc, "__iter__") and not isinstance(mc, str):
                try:
                    residuals = [float(v) for v in mc]
                except (TypeError, ValueError):
                    residuals = None
        for i, (xi, yi) in enumerate(zip(xs, ys)):
            extras: dict[str, str] = {"plotly_name": str(tname or "")}
            if residuals is not None and i < len(residuals):
                extras["residual"] = f"{residuals[i]:.6f}"
            rows.append({
                "chart_id":  chart_id,
                "trace_id":  trace_id,
                "point_id":  str(i),
                "x":         float(xi),
                "y":         float(yi),
                "extras":    extras,
            })
    return rows


def main(outdir: pathlib.Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    for chart_id, modname, pngname in EXAMPLES:
        mod = _load_module(VFD / f"{modname}.py", modname)
        fig = mod.fig
        cal = _build_calibration(chart_id, fig)
        pts = _build_points(chart_id, fig)
        cal["png_basename"] = pngname
        (outdir / f"{modname}.calibration.json").write_text(json.dumps(cal, indent=2))
        (outdir / f"{modname}.points.json").write_text(json.dumps(pts, indent=2))
        print(f"  {chart_id}: x={cal['x_min']:.2f}..{cal['x_max']:.2f}  y={cal['y_min']:.2f}..{cal['y_max']:.2f}  traces={len({p['trace_id'] for p in pts})}  points={len(pts)}")


if __name__ == "__main__":
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/vfd_chart_data")
    main(out)
