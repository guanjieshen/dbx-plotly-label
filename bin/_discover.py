#!/usr/bin/env python3
"""Parse `databricks <kind> list -o json` output and emit tab-separated rows
bash can consume.

Each output line is `<id>\t<label>\t<extra>` (extra may be empty).

Usage:
    databricks warehouses list -o json | python3 bin/_discover.py warehouses
    databricks catalogs list -o json    | python3 bin/_discover.py catalogs
    databricks schemas list <catalog> -o json | python3 bin/_discover.py schemas
    databricks volumes list <catalog> <schema> -o json | python3 bin/_discover.py volumes

Keeping JSON parsing in Python (not jq) means we don't add a new dependency
and the format is forgiving — newer CLI versions occasionally rename fields,
so we tolerate either common spelling.
"""
from __future__ import annotations

import json
import sys


def _get(obj: dict, *keys: str) -> str:
    """Return the first non-empty value at any of the keys (supports dot paths)."""
    for k in keys:
        cur = obj
        ok = True
        for part in k.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok and cur not in (None, ""):
            return str(cur)
    return ""


def main(kind: str) -> int:
    try:
        raw = sys.stdin.read()
        items = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError as e:
        print(f"# discover: invalid JSON on stdin ({e})", file=sys.stderr)
        return 1

    if not isinstance(items, list):
        # Some CLI commands wrap results: {"warehouses": [...]} etc. Unwrap.
        if isinstance(items, dict):
            for candidate in ("warehouses", "catalogs", "schemas", "volumes",
                              "data", "items", "results"):
                if candidate in items and isinstance(items[candidate], list):
                    items = items[candidate]
                    break
            else:
                items = []
        else:
            items = []

    for it in items:
        if not isinstance(it, dict):
            continue
        if kind == "warehouses":
            wid = _get(it, "id")
            name = _get(it, "name")
            size = _get(it, "cluster_size")
            state = _get(it, "state")
            extra = f"{size}/{state}".strip("/")
            print(f"{wid}\t{name}\t{extra}")
        elif kind == "catalogs":
            name = _get(it, "name", "full_name")
            owner = _get(it, "owner")
            print(f"{name}\t{name}\t{owner}")
        elif kind == "schemas":
            # full_name = "catalog.schema"; we just emit the schema name as id+label
            full = _get(it, "full_name")
            name = _get(it, "name")
            ident = name or (full.rsplit(".", 1)[-1] if full else "")
            if not ident:
                continue
            print(f"{ident}\t{ident}\t{_get(it, 'owner')}")
        elif kind == "volumes":
            full = _get(it, "full_name")
            name = _get(it, "name")
            vtype = _get(it, "volume_type")
            ident = name or (full.rsplit(".", 1)[-1] if full else "")
            if not ident:
                continue
            print(f"{ident}\t{ident}\t{vtype}")
        elif kind == "files":
            # `databricks files list-directory-contents <path> -o json` emits
            # contents-of-folder entries. Used by the volume scanner.
            path = _get(it, "path")
            is_dir = bool(it.get("is_directory") or it.get("is_dir"))
            size = _get(it, "file_size", "size")
            print(f"{path}\t{'dir' if is_dir else 'file'}\t{size}")
        else:
            print(f"# discover: unknown kind {kind!r}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: _discover.py <warehouses|catalogs|schemas|volumes|files>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
