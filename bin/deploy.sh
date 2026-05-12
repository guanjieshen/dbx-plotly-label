#!/usr/bin/env bash
# bin/deploy.sh — interactive deploy wrapper for the eval-labelling Databricks App.
#
# Workflow (after confirmation):
#   1. Ensure schema + volume exist (idempotent)
#   2. Ensure tables exist (idempotent, via SQL Statements API)
#   3. Build the Vite frontend
#   4. Sync source to /Workspace/...
#   5. Create the app if missing, then deploy
#   6. Poll deployment + app status until RUNNING or FAILED (10 min timeout)
#   7. Print the app URL
#
# Config file: .deploy.yaml at repo root (gitignored). Falls back to
# .deploy.yaml.example if no .deploy.yaml exists.
#
# Flags:
#   --non-interactive       Use the config file as-is (no prompts).
#   --seed-samples          Render VFD sample PNGs (headless Chrome from
#                           ~/Desktop/vfd-power-curves/*.html) and upload to
#                           the volume before deploying.
#   --skip-frontend-build   Don't run `npm install` / `npm run build`.
#   --skip-resource-create  Don't try to CREATE IF NOT EXISTS schema/volume/tables.
#   --help                  Print this banner and exit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONFIG_FILE="$REPO_ROOT/.deploy.yaml"
EXAMPLE_FILE="$REPO_ROOT/.deploy.yaml.example"

INTERACTIVE=1
SEED_SAMPLES=0
SKIP_FRONTEND=0
SKIP_RESOURCE_CREATE=0

for arg in "$@"; do
  case "$arg" in
    --non-interactive)      INTERACTIVE=0 ;;
    --seed-samples)         SEED_SAMPLES=1 ;;
    --skip-frontend-build)  SKIP_FRONTEND=1 ;;
    --skip-resource-create) SKIP_RESOURCE_CREATE=1 ;;
    --help|-h)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Tiny YAML reader (key: value only — no nesting, no lists, no quotes).
# ---------------------------------------------------------------------------
yaml_get() {
  local file="$1" key="$2"
  awk -F': *' -v k="$key" '$1 == k {sub(/^[^:]*: */, "", $0); print; exit}' "$file"
}

DEFAULT_SRC="$CONFIG_FILE"
[[ -f "$CONFIG_FILE" ]] || DEFAULT_SRC="$EXAMPLE_FILE"

if [[ ! -f "$DEFAULT_SRC" ]]; then
  echo "FATAL: neither .deploy.yaml nor .deploy.yaml.example found" >&2
  exit 1
fi

DEF_PROFILE="$(yaml_get "$DEFAULT_SRC" profile)"
DEF_HOST="$(yaml_get "$DEFAULT_SRC" workspace_host)"
DEF_CATALOG="$(yaml_get "$DEFAULT_SRC" catalog)"
DEF_SCHEMA="$(yaml_get "$DEFAULT_SRC" schema)"
DEF_VOLUME="$(yaml_get "$DEFAULT_SRC" volume_path)"
DEF_WAREHOUSE="$(yaml_get "$DEFAULT_SRC" warehouse_id)"
DEF_APP_NAME="$(yaml_get "$DEFAULT_SRC" app_name)"
DEF_SCP="$(yaml_get "$DEFAULT_SRC" source_code_path)"

prompt() {
  local label="$1" default="$2" answer=""
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    echo "$default"
    return
  fi
  read -r -p "$label [$default]: " answer </dev/tty || answer=""
  if [[ -z "$answer" ]]; then answer="$default"; fi
  echo "$answer"
}

echo "============================================================"
echo " eval-labelling deploy wrapper"
echo " config source: $DEFAULT_SRC"
echo "============================================================"

PROFILE=$(prompt "Databricks profile"                 "$DEF_PROFILE")
HOST=$(prompt "Workspace host"                        "$DEF_HOST")
CATALOG=$(prompt "Catalog"                            "$DEF_CATALOG")
SCHEMA=$(prompt "Schema"                              "$DEF_SCHEMA")
VOLUME_PATH=$(prompt "Volume containing PNGs"         "$DEF_VOLUME")
WAREHOUSE_ID=$(prompt "SQL warehouse ID"              "$DEF_WAREHOUSE")
APP_NAME=$(prompt "App name"                          "$DEF_APP_NAME")
SOURCE_CODE_PATH=$(prompt "Workspace source path"     "$DEF_SCP")

# Persist back to .deploy.yaml
cat > "$CONFIG_FILE" <<EOF
profile: $PROFILE
workspace_host: $HOST
catalog: $CATALOG
schema: $SCHEMA
volume_path: $VOLUME_PATH
warehouse_id: $WAREHOUSE_ID
app_name: $APP_NAME
source_code_path: $SOURCE_CODE_PATH
EOF

VOLUME_NAME="$(basename "$VOLUME_PATH")"

echo
echo "------------------------------------------------------------"
printf " profile             %s\n" "$PROFILE"
printf " host                %s\n" "$HOST"
printf " catalog.schema      %s.%s\n" "$CATALOG" "$SCHEMA"
printf " volume              %s   (basename %s)\n" "$VOLUME_PATH" "$VOLUME_NAME"
printf " warehouse_id        %s\n" "$WAREHOUSE_ID"
printf " app_name            %s\n" "$APP_NAME"
printf " source_code_path    %s\n" "$SOURCE_CODE_PATH"
printf " interactive         %s\n" "$INTERACTIVE"
printf " seed-samples        %s\n" "$SEED_SAMPLES"
printf " skip-frontend-build %s\n" "$SKIP_FRONTEND"
echo "------------------------------------------------------------"
echo

if [[ "$INTERACTIVE" -eq 1 ]]; then
  read -r -p "Continue? [y/N] " ANS </dev/tty || ANS=""
  case "$ANS" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

DB="databricks --profile $PROFILE"

# ---------------------------------------------------------------------------
# Step 1: Schema + volume (idempotent)
# ---------------------------------------------------------------------------
if [[ "$SKIP_RESOURCE_CREATE" -eq 0 ]]; then
  echo
  echo "==> Ensuring schema $CATALOG.$SCHEMA exists"
  if ! $DB schemas get "$CATALOG.$SCHEMA" >/dev/null 2>&1; then
    $DB schemas create "$SCHEMA" "$CATALOG" >/dev/null
    echo "    created"
  else
    echo "    already exists"
  fi

  echo "==> Ensuring volume $CATALOG.$SCHEMA.$VOLUME_NAME exists"
  if ! $DB volumes read "$CATALOG.$SCHEMA.$VOLUME_NAME" >/dev/null 2>&1; then
    $DB volumes create "$CATALOG" "$SCHEMA" "$VOLUME_NAME" MANAGED >/dev/null
    echo "    created"
  else
    echo "    already exists"
  fi

  # ---------------------------------------------------------------------------
  # Step 2: Tables (idempotent) via SQL Statements API
  # ---------------------------------------------------------------------------
  echo "==> Ensuring tables exist via SQL Statements API"
  DDL_FILE="$REPO_ROOT/sql/ddl.sql"
  if [[ ! -f "$DDL_FILE" ]]; then
    echo "    sql/ddl.sql missing — skipping table creation"
  else
    # Split DDL_FILE on semicolons and run each non-empty statement.
    # Substitute {{CATALOG}} / {{SCHEMA}} tokens.
    while IFS= read -r STMT; do
      STMT_TRIM="$(echo "$STMT" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [[ -z "$STMT_TRIM" ]] && continue
      # Use Python for safe JSON encoding of the statement.
      JSON_PAYLOAD="$(
        STMT="$STMT_TRIM" \
        WH="$WAREHOUSE_ID" \
        CATALOG="$CATALOG" \
        SCHEMA="$SCHEMA" \
        /usr/bin/env python3 - <<'PY'
import json, os
stmt = os.environ["STMT"]
stmt = stmt.replace("{{CATALOG}}", os.environ["CATALOG"]).replace("{{SCHEMA}}", os.environ["SCHEMA"])
print(json.dumps({
    "warehouse_id": os.environ["WH"],
    "statement": stmt,
    "wait_timeout": "30s",
}))
PY
      )"
      # Pipe payload through stdin; databricks api expects --json with literal JSON.
      RESP="$(echo "$JSON_PAYLOAD" | $DB api post /api/2.0/sql/statements --json @/dev/stdin 2>&1 || true)"
      if echo "$RESP" | grep -q '"state":"SUCCEEDED"'; then
        echo "    ok"
      elif echo "$RESP" | grep -q '"state":"PENDING"\|"state":"RUNNING"'; then
        echo "    started (async); continuing"
      elif echo "$RESP" | grep -q 'FIELD_ALREADY_EXISTS\|TABLE_OR_VIEW_ALREADY_EXISTS\|already exists in'; then
        # Databricks lacks `ADD COLUMN IF NOT EXISTS`; we treat duplicate
        # column / table errors as success so re-runs stay idempotent.
        echo "    ok (already present)"
      else
        # Many CREATE IF NOT EXISTS just succeed silently — only flag clear errors.
        if echo "$RESP" | grep -qi 'error'; then
          echo "    WARN: $RESP" | head -c 500
          echo
        else
          echo "    ok"
        fi
      fi
    done < <(awk 'BEGIN{RS=";"} {print $0}' "$DDL_FILE")
  fi
else
  echo "==> Skipping schema/volume/table creation (--skip-resource-create)"
fi

# ---------------------------------------------------------------------------
# Step 3 (optional): Render and upload sample VFD PNGs
# ---------------------------------------------------------------------------
if [[ "$SEED_SAMPLES" -eq 1 ]]; then
  echo
  echo "==> Seeding sample VFD PNGs + chart_points + calibration"
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  SAMPLE_DIR="$HOME/Desktop/vfd-power-curves"
  VFD_PY="$SAMPLE_DIR/.venv/bin/python"
  if [[ ! -d "$SAMPLE_DIR" ]] || ! ls "$SAMPLE_DIR"/example*.html >/dev/null 2>&1; then
    echo "    WARN: $SAMPLE_DIR/example*.html not found; skipping render."
  elif [[ ! -x "$CHROME" ]]; then
    echo "    WARN: headless Chrome not found at: $CHROME; skipping render."
  else
    OUT="$REPO_ROOT/.deploy_tmp_samples"
    mkdir -p "$OUT"
    for HTML in "$SAMPLE_DIR"/example*.html; do
      BASE="$(basename "$HTML" .html).png"
      echo "    rendering $BASE"
      "$CHROME" --headless --disable-gpu --no-sandbox \
        --hide-scrollbars --window-size=1280,720 \
        --screenshot="$OUT/$BASE" "file://$HTML" >/dev/null 2>&1 || true
      if [[ -f "$OUT/$BASE" ]]; then
        DEST="$VOLUME_PATH/vfd_power_curves/$BASE"
        $DB fs cp --overwrite "$OUT/$BASE" "dbfs:$DEST" >/dev/null 2>&1 || \
          $DB workspace import "$OUT/$BASE" "$DEST" 2>/dev/null || \
          echo "    WARN: failed to upload $BASE"
      fi
    done

    # Extract calibration + chart_points using the VFD venv (which has plotly+kaleido).
    if [[ -x "$VFD_PY" && -f "$REPO_ROOT/bin/seed_chart_data.py" ]]; then
      echo "    extracting calibration + chart_points"
      "$VFD_PY" "$REPO_ROOT/bin/seed_chart_data.py" "$OUT" || \
        echo "    WARN: seed_chart_data.py failed; calibration not updated"

      DATA_TABLE="$CATALOG.$SCHEMA.chart_points"
      GRAPHS_TABLE="$CATALOG.$SCHEMA.graphs"
      for CALIB in "$OUT"/*.calibration.json; do
        [[ -f "$CALIB" ]] || continue
        EXAMPLE_BASE="$(basename "$CALIB" .calibration.json)"
        POINTS="$OUT/$EXAMPLE_BASE.points.json"
        [[ -f "$POINTS" ]] || continue
        GRAPH_PATH="$VOLUME_PATH/vfd_power_curves/${EXAMPLE_BASE}.png"
        echo "    seeding chart_points + metadata for $EXAMPLE_BASE"
        # Emit SQL statements (one per line) for this chart.
        SQL_FILE="$OUT/$EXAMPLE_BASE.sql"
        /usr/bin/env python3 "$REPO_ROOT/bin/_seed_emit_sql.py" \
          "$CALIB" "$POINTS" "$GRAPH_PATH" "$DATA_TABLE" "$GRAPHS_TABLE" > "$SQL_FILE" || {
          echo "    WARN: emit SQL failed for $EXAMPLE_BASE; skipping"
          continue
        }
        # Each line in SQL_FILE is one statement.
        while IFS= read -r STMT; do
          [[ -z "$STMT" ]] && continue
          PAYLOAD="$(WH="$WAREHOUSE_ID" STMT="$STMT" /usr/bin/env python3 -c 'import json,os; print(json.dumps({"warehouse_id": os.environ["WH"], "statement": os.environ["STMT"], "wait_timeout": "30s"}))')"
          RESP="$(echo "$PAYLOAD" | $DB api post /api/2.0/sql/statements --json @/dev/stdin 2>&1 || true)"
          if echo "$RESP" | grep -q '"state":"SUCCEEDED"'; then
            : # ok
          else
            echo "      WARN: $RESP" | head -c 400; echo
          fi
        done < "$SQL_FILE"
      done
    else
      echo "    WARN: VFD venv python or seed_chart_data.py missing; chart_points not seeded."
    fi
    rm -rf "$OUT"
  fi
fi

# ---------------------------------------------------------------------------
# Step 4: Build frontend
# ---------------------------------------------------------------------------
if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
  echo
  echo "==> Building frontend (npm install + npm run build)"
  pushd "$REPO_ROOT/frontend" >/dev/null
  npm install --no-audit --no-fund --silent
  npm run build
  popd >/dev/null
else
  echo "==> Skipping frontend build (--skip-frontend-build)"
fi

# ---------------------------------------------------------------------------
# Step 5: Sync source to workspace
# ---------------------------------------------------------------------------
echo
echo "==> Syncing source to $SOURCE_CODE_PATH"
$DB sync . "$SOURCE_CODE_PATH" --full --watch=false || $DB sync . "$SOURCE_CODE_PATH" --watch=false

# ---------------------------------------------------------------------------
# Step 6: Create or deploy app
# ---------------------------------------------------------------------------
echo
echo "==> Checking app $APP_NAME"
if ! $DB apps get "$APP_NAME" >/dev/null 2>&1; then
  echo "    creating $APP_NAME"
  $DB apps create "$APP_NAME" --description "ML eval QA labelling tool" >/dev/null
fi

echo "==> Deploying $APP_NAME from $SOURCE_CODE_PATH"
DEPLOY_RESP="$($DB apps deploy "$APP_NAME" --source-code-path "$SOURCE_CODE_PATH" --mode SNAPSHOT 2>&1)"
echo "$DEPLOY_RESP" | head -c 600
echo

# ---------------------------------------------------------------------------
# Step 7: Wait for RUNNING
# ---------------------------------------------------------------------------
echo
echo "==> Waiting for app to reach RUNNING state (10 min timeout)"
START=$(date +%s)
TIMEOUT=600
while true; do
  INFO="$($DB apps get "$APP_NAME" 2>/dev/null || true)"
  APP_STATE="$(echo "$INFO" | /usr/bin/env python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("app_status",{}).get("state","UNKNOWN"))' 2>/dev/null || echo UNKNOWN)"
  DEP_STATE="$(echo "$INFO" | /usr/bin/env python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("active_deployment") or d.get("pending_deployment") or {}).get("status",{}).get("state","UNKNOWN"))' 2>/dev/null || echo UNKNOWN)"
  printf "    app=%s  deployment=%s\n" "$APP_STATE" "$DEP_STATE"
  if [[ "$APP_STATE" == "RUNNING" && "$DEP_STATE" == "SUCCEEDED" ]]; then
    break
  fi
  if [[ "$DEP_STATE" == "FAILED" || "$APP_STATE" == "ERROR" || "$APP_STATE" == "CRASHED" ]]; then
    echo "FATAL: deployment failed."
    echo "$INFO" | head -c 2000
    exit 1
  fi
  NOW=$(date +%s)
  if (( NOW - START > TIMEOUT )); then
    echo "FATAL: timed out after $TIMEOUT seconds."
    exit 1
  fi
  sleep 8
done

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
APP_URL="$($DB apps get "$APP_NAME" 2>/dev/null | /usr/bin/env python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"
echo
echo "============================================================"
echo " App is RUNNING"
echo " URL: $APP_URL"
echo "============================================================"
