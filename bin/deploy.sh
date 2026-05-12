#!/usr/bin/env bash
# bin/deploy.sh — interactive installer/deployer for the dbx-plotly-label app.
#
# Designed to be run from either:
#   1. A Databricks workspace web terminal (preferred). Auth is ambient via
#      the cluster identity; no --profile needed. If $PWD is under /Workspace/,
#      the repo is already in the workspace and the source-sync step is skipped.
#   2. A local laptop. Falls back to a Databricks CLI profile (.databrickscfg).
#
# Workflow:
#   - Auto-discover warehouses / catalogs / schemas / volumes and let the user
#     pick by number.
#   - Confirm a summary and provision (idempotent): schema, volume, tables.
#   - Scan the chosen volume for image files (.png/.jpg/.jpeg/.gif/.webp/.bmp/.svg)
#     and INSERT any new ones into the catalog table.
#   - Sync source (if not in-workspace) and deploy the Databricks App.
#   - Optionally grant CAN_USE on the app to a Databricks group.
#
# Flags:
#   --non-interactive       Use .deploy.yaml as-is (CI mode).
#   --rescan                Run only the volume-scan step against the configured
#                           values; no other provisioning, no app redeploy.
#   --skip-frontend-build   Skip `npm install / npm run build` (dist already committed).
#   --skip-resource-create  Skip schema/volume/table creation (fast redeploys).
#   --seed-vfd-samples      Render the VFD example HTMLs to PNGs and upload
#                           (dev-only; needs Chrome + ~/Desktop/vfd-power-curves).
#   --help                  Print this banner and exit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONFIG_FILE="$REPO_ROOT/.deploy.yaml"
EXAMPLE_FILE="$REPO_ROOT/.deploy.yaml.example"
DISCOVER="$REPO_ROOT/bin/_discover.py"
SCAN="$REPO_ROOT/bin/_scan_volume.py"

INTERACTIVE=1
RESCAN_ONLY=0
SKIP_FRONTEND=0
SKIP_RESOURCE_CREATE=0
SEED_VFD_SAMPLES=0

for arg in "$@"; do
  case "$arg" in
    --non-interactive)      INTERACTIVE=0 ;;
    --rescan)               RESCAN_ONLY=1 ; INTERACTIVE=0 ;;
    --skip-frontend-build)  SKIP_FRONTEND=1 ;;
    --skip-resource-create) SKIP_RESOURCE_CREATE=1 ;;
    --seed-vfd-samples)     SEED_VFD_SAMPLES=1 ;;
    --help|-h)
      sed -n '2,32p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# ANSI helpers (TTY only).
# ---------------------------------------------------------------------------
if [[ -t 1 && "$INTERACTIVE" -eq 1 ]]; then
  C_DIM=$'\033[2m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
  C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_BOLD=""; C_RESET=""
fi

ok()    { printf "  ${C_OK}✓${C_RESET} %s\n" "$*"; }
warn()  { printf "  ${C_WARN}!${C_RESET} %s\n" "$*"; }
fail()  { printf "  ${C_ERR}✗${C_RESET} %s\n" "$*"; }
banner() {
  printf "${C_BOLD}════════════════════════════════════════════════════════════${C_RESET}\n"
  printf "${C_BOLD} %s${C_RESET}\n" "$*"
  printf "${C_BOLD}════════════════════════════════════════════════════════════${C_RESET}\n"
}

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

# Defaults (new schema preferred; legacy keys fall through where applicable)
DEF_PROFILE="$(yaml_get "$DEFAULT_SRC" profile)"
DEF_HOST="$(yaml_get "$DEFAULT_SRC" workspace_host)"
DEF_WAREHOUSE="$(yaml_get "$DEFAULT_SRC" warehouse_id)"
DEF_IMAGE_CAT="$(yaml_get "$DEFAULT_SRC" image_catalog)"
DEF_IMAGE_SCH="$(yaml_get "$DEFAULT_SRC" image_schema)"
DEF_IMAGE_VOL="$(yaml_get "$DEFAULT_SRC" image_volume)"
DEF_ANN_CAT="$(yaml_get "$DEFAULT_SRC" annotations_catalog)"
DEF_ANN_SCH="$(yaml_get "$DEFAULT_SRC" annotations_schema)"
DEF_CP_TBL="$(yaml_get "$DEFAULT_SRC" chart_points_table)"
DEF_APP_NAME="$(yaml_get "$DEFAULT_SRC" app_name)"
DEF_APP_GROUP="$(yaml_get "$DEFAULT_SRC" app_access_group)"
DEF_SCP="$(yaml_get "$DEFAULT_SRC" source_code_path)"

# Legacy fallbacks (so older .deploy.yaml files keep working).
LEG_CATALOG="$(yaml_get "$DEFAULT_SRC" catalog)"
LEG_SCHEMA="$(yaml_get "$DEFAULT_SRC" schema)"
LEG_VOLUME_PATH="$(yaml_get "$DEFAULT_SRC" volume_path)"
if [[ -z "$DEF_IMAGE_CAT" && -n "$LEG_CATALOG" ]]; then DEF_IMAGE_CAT="$LEG_CATALOG"; fi
if [[ -z "$DEF_IMAGE_SCH" && -n "$LEG_SCHEMA"  ]]; then DEF_IMAGE_SCH="$LEG_SCHEMA"; fi
if [[ -z "$DEF_IMAGE_VOL" && -n "$LEG_VOLUME_PATH" ]]; then
  DEF_IMAGE_VOL="${LEG_VOLUME_PATH##*/}"
fi
if [[ -z "$DEF_ANN_CAT" ]]; then DEF_ANN_CAT="$DEF_IMAGE_CAT"; fi
if [[ -z "$DEF_ANN_SCH" ]]; then DEF_ANN_SCH="$DEF_IMAGE_SCH"; fi
if [[ -z "$DEF_CP_TBL"  && -n "$DEF_ANN_CAT" && -n "$DEF_ANN_SCH" ]]; then
  DEF_CP_TBL="$DEF_ANN_CAT.$DEF_ANN_SCH.chart_points"
fi

# ---------------------------------------------------------------------------
# Bash helpers for prompts.
# ---------------------------------------------------------------------------
prompt() {
  local label="$1" default="$2" answer=""
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    echo "$default"; return
  fi
  read -r -p "  $label [$default]: " answer </dev/tty || answer=""
  if [[ -z "$answer" ]]; then answer="$default"; fi
  echo "$answer"
}

confirm_yn() {
  local label="$1" default="${2:-N}"
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    [[ "$default" == "Y" ]] && return 0 || return 1
  fi
  local answer=""
  read -r -p "  $label [y/N]: " answer </dev/tty || answer=""
  [[ "$answer" =~ ^[Yy] ]]
}

# Numbered-pick menu. Reads a tab-separated id/label/extra list on stdin,
# prints the menu to stderr, returns the chosen ID on stdout. The caller
# provides the prompt + an optional "(new)" sentinel label as args.
pick_from_list() {
  local title="$1"
  local new_label="${2:-}"      # empty disables the new-name option
  local -a ids=() labels=() extras=()
  while IFS=$'\t' read -r id lab extra; do
    [[ -z "$id" ]] && continue
    ids+=("$id"); labels+=("$lab"); extras+=("$extra")
  done
  if [[ "${#ids[@]}" -eq 0 && -z "$new_label" ]]; then
    echo "" ; return
  fi
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    # Non-interactive: never enters this picker (caller uses defaults).
    echo "${ids[0]:-}"
    return
  fi
  echo "${C_DIM}  $title${C_RESET}" >&2
  local i
  for i in "${!ids[@]}"; do
    if [[ -n "${extras[i]}" ]]; then
      printf "    %2d. %-40s ${C_DIM}%s${C_RESET}\n" $((i+1)) "${labels[i]}" "${extras[i]}" >&2
    else
      printf "    %2d. %s\n" $((i+1)) "${labels[i]}" >&2
    fi
  done
  local new_index=$((${#ids[@]}+1))
  if [[ -n "$new_label" ]]; then
    printf "    %2d. ${C_DIM}%s${C_RESET}\n" $new_index "$new_label" >&2
  fi
  local choice=""
  while :; do
    read -r -p "  > " choice </dev/tty || choice=""
    if [[ "$choice" =~ ^[0-9]+$ && "$choice" -ge 1 && "$choice" -le "${#ids[@]}" ]]; then
      echo "${ids[$((choice-1))]}"
      return
    fi
    if [[ -n "$new_label" && "$choice" -eq "$new_index" ]]; then
      echo "__NEW__"
      return
    fi
    echo "  please enter a number" >&2
  done
}

# ---------------------------------------------------------------------------
# Detect auth: ambient (workspace web terminal) vs --profile (laptop).
# ---------------------------------------------------------------------------
banner "dbx-plotly-label installer"

DB="databricks"
USER_EMAIL=""
AMBIENT=0
if databricks current-user me >/dev/null 2>&1; then
  AMBIENT=1
  USER_EMAIL="$(databricks current-user me 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("emails",[{}])[0].get("value",""))')"
  ok "ambient auth detected — $USER_EMAIL"
elif [[ -n "$DEF_PROFILE" ]] && databricks --profile "$DEF_PROFILE" current-user me >/dev/null 2>&1; then
  DB="databricks --profile $DEF_PROFILE"
  USER_EMAIL="$($DB current-user me 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("emails",[{}])[0].get("value",""))')"
  ok "profile $DEF_PROFILE — $USER_EMAIL"
else
  fail "not authenticated. either run from a workspace web terminal, or:"
  echo "        databricks auth login --host <https://...>"
  echo "      then re-run ./install"
  exit 1
fi

if [[ -f "$REPO_ROOT/frontend/dist/index.html" ]]; then
  ok "frontend/dist pre-built — no npm needed"
else
  warn "frontend/dist missing — will need npm to build"
fi

# Detect in-workspace path
IN_WORKSPACE=0
if [[ "$PWD" == /Workspace/* ]]; then
  IN_WORKSPACE=1
  ok "running in-workspace at $PWD — no source sync needed"
  if [[ -z "$DEF_SCP" ]]; then DEF_SCP="$PWD"; fi
else
  if [[ -z "$DEF_SCP" && -n "$USER_EMAIL" ]]; then
    DEF_SCP="/Workspace/Users/$USER_EMAIL/$(basename "$REPO_ROOT")"
  fi
fi

# Helper to extract just the profile flag (or empty) for spawned children.
PROFILE_FLAG=""
if [[ "$AMBIENT" -eq 0 ]]; then PROFILE_FLAG="--profile $DEF_PROFILE"; fi

echo
# ---------------------------------------------------------------------------
# --rescan path skips most of the flow.
# ---------------------------------------------------------------------------
if [[ "$RESCAN_ONLY" -eq 1 ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    fail "--rescan needs an existing .deploy.yaml (run ./install once first)"
    exit 1
  fi
  echo "==> Rescanning ${DEF_ANN_CAT:-?}.${DEF_ANN_SCH:-?}.graphs"
  VOL_PATH="/Volumes/${DEF_IMAGE_CAT}/${DEF_IMAGE_SCH}/${DEF_IMAGE_VOL}"
  RES=$(python3 "$SCAN" \
    --profile "${DEF_PROFILE}" \
    --warehouse-id "$DEF_WAREHOUSE" \
    --volume-path "$VOL_PATH" \
    --annotations-fq "${DEF_ANN_CAT}.${DEF_ANN_SCH}" \
    --chart-points-fq "$DEF_CP_TBL")
  IFS=$'\t' read -r DISC NEW SKIP <<< "$RES"
  ok "discovered=$DISC  new=$NEW  already-in-catalog=$SKIP"
  exit 0
fi

# ---------------------------------------------------------------------------
# Interactive prompts (numbered-pick discovery)
# ---------------------------------------------------------------------------
if [[ "$INTERACTIVE" -eq 1 ]]; then
  echo
  echo "${C_BOLD}SQL warehouse${C_RESET} ${C_DIM}(used for both reads and the app's Delta writes)${C_RESET}"
  WH_LIST="$($DB warehouses list -o json 2>/dev/null | python3 "$DISCOVER" warehouses)"
  WAREHOUSE_ID="$(printf "%s\n" "$WH_LIST" | pick_from_list "" "(enter ID by hand)")"
  if [[ "$WAREHOUSE_ID" == "__NEW__" ]]; then
    WAREHOUSE_ID="$(prompt "warehouse id" "$DEF_WAREHOUSE")"
  fi

  echo
  echo "${C_BOLD}Image volume${C_RESET} ${C_DIM}— where chart PNG/JPG/etc. files live${C_RESET}"
  echo "${C_DIM}    Pick the catalog, then the schema, then the volume.${C_RESET}"
  CAT_LIST="$($DB catalogs list -o json 2>/dev/null | python3 "$DISCOVER" catalogs)"
  IMAGE_CAT="$(printf "%s\n" "$CAT_LIST" | pick_from_list "Catalog:" "(type a name to create)")"
  if [[ "$IMAGE_CAT" == "__NEW__" ]]; then
    IMAGE_CAT="$(prompt "new catalog name" "$DEF_IMAGE_CAT")"
  fi

  SCH_LIST="$($DB schemas list "$IMAGE_CAT" -o json 2>/dev/null | python3 "$DISCOVER" schemas)"
  IMAGE_SCH="$(printf "%s\n" "$SCH_LIST" | pick_from_list "Schema in $IMAGE_CAT:" "(create new)")"
  if [[ "$IMAGE_SCH" == "__NEW__" ]]; then
    IMAGE_SCH="$(prompt "new schema name" "$DEF_IMAGE_SCH")"
  fi

  VOL_LIST="$($DB volumes list "$IMAGE_CAT" "$IMAGE_SCH" -o json 2>/dev/null | python3 "$DISCOVER" volumes)"
  IMAGE_VOL="$(printf "%s\n" "$VOL_LIST" | pick_from_list "Volume in $IMAGE_CAT.$IMAGE_SCH:" "(create new managed volume)")"
  if [[ "$IMAGE_VOL" == "__NEW__" ]]; then
    IMAGE_VOL="$(prompt "new volume name" "${DEF_IMAGE_VOL:-graphs}")"
  fi

  echo
  echo "${C_BOLD}Annotations & metadata${C_RESET} ${C_DIM}— where the app's Delta tables go${C_RESET}"
  ANN_SAME=0
  if confirm_yn "Use the same catalog.schema ($IMAGE_CAT.$IMAGE_SCH)? (yes recommended)" "Y"; then
    ANN_SAME=1
    ANN_CAT="$IMAGE_CAT"; ANN_SCH="$IMAGE_SCH"
  else
    CAT_LIST="$($DB catalogs list -o json 2>/dev/null | python3 "$DISCOVER" catalogs)"
    ANN_CAT="$(printf "%s\n" "$CAT_LIST" | pick_from_list "Annotations catalog:" "(type a name to create)")"
    if [[ "$ANN_CAT" == "__NEW__" ]]; then
      ANN_CAT="$(prompt "new catalog name" "$DEF_ANN_CAT")"
    fi
    SCH_LIST="$($DB schemas list "$ANN_CAT" -o json 2>/dev/null | python3 "$DISCOVER" schemas)"
    ANN_SCH="$(printf "%s\n" "$SCH_LIST" | pick_from_list "Annotations schema in $ANN_CAT:" "(create new)")"
    if [[ "$ANN_SCH" == "__NEW__" ]]; then
      ANN_SCH="$(prompt "new schema name" "$DEF_ANN_SCH")"
    fi
  fi

  echo
  echo "${C_BOLD}chart_points source${C_RESET} ${C_DIM}— powers box→data snapshots${C_RESET}"
  DEFAULT_CP="$ANN_CAT.$ANN_SCH.chart_points"
  if confirm_yn "Use the local one ($DEFAULT_CP)? (yes recommended)" "Y"; then
    CP_TBL="$DEFAULT_CP"
  else
    CP_TBL="$(prompt "external chart_points table (catalog.schema.table)" "$DEF_CP_TBL")"
  fi

  echo
  APP_NAME="$(prompt "app name" "${DEF_APP_NAME:-eval-labelling}")"

  echo
  echo "${C_BOLD}Who can open the app?${C_RESET}"
  echo "    1. Just me ($USER_EMAIL)"
  echo "    2. ${C_DIM}A Databricks group (you'll enter the group name)${C_RESET}"
  read -r -p "  > " ACCESS_CHOICE </dev/tty || ACCESS_CHOICE=1
  if [[ "$ACCESS_CHOICE" == "2" ]]; then
    APP_GROUP="$(prompt "group name" "$DEF_APP_GROUP")"
  else
    APP_GROUP=""
  fi

  SOURCE_CODE_PATH="$(prompt "workspace source path" "$DEF_SCP")"
else
  # Non-interactive: pull everything from defaults.
  WAREHOUSE_ID="$DEF_WAREHOUSE"
  IMAGE_CAT="$DEF_IMAGE_CAT"; IMAGE_SCH="$DEF_IMAGE_SCH"; IMAGE_VOL="$DEF_IMAGE_VOL"
  ANN_CAT="$DEF_ANN_CAT"; ANN_SCH="$DEF_ANN_SCH"
  CP_TBL="$DEF_CP_TBL"
  APP_NAME="$DEF_APP_NAME"
  APP_GROUP="$DEF_APP_GROUP"
  SOURCE_CODE_PATH="$DEF_SCP"
fi

VOLUME_PATH="/Volumes/$IMAGE_CAT/$IMAGE_SCH/$IMAGE_VOL"

# Write back the chosen values.
cat > "$CONFIG_FILE" <<EOF
profile: ${DEF_PROFILE}
workspace_host: ${DEF_HOST}
warehouse_id: $WAREHOUSE_ID
image_catalog: $IMAGE_CAT
image_schema: $IMAGE_SCH
image_volume: $IMAGE_VOL
annotations_catalog: $ANN_CAT
annotations_schema: $ANN_SCH
chart_points_table: $CP_TBL
app_name: $APP_NAME
app_access_group: $APP_GROUP
source_code_path: $SOURCE_CODE_PATH
EOF

# ---------------------------------------------------------------------------
# Summary + confirm
# ---------------------------------------------------------------------------
echo
banner "Summary"
[[ "$AMBIENT" -eq 1 ]] && WS_LABEL="workspace (ambient auth)" || WS_LABEL="$DEF_PROFILE"
printf "  workspace      %s\n" "$WS_LABEL"
printf "  warehouse      %s\n" "$WAREHOUSE_ID"
printf "  image volume   %s\n" "$VOLUME_PATH"
printf "  annotations    %s.%s\n" "$ANN_CAT" "$ANN_SCH"
printf "  chart_points   %s\n" "$CP_TBL"
printf "  app name       %s\n" "$APP_NAME"
printf "  app access     %s\n" "${APP_GROUP:-just me}"
printf "  source path    %s\n" "$SOURCE_CODE_PATH"
echo

if [[ "$INTERACTIVE" -eq 1 ]]; then
  if ! confirm_yn "Continue?" "N"; then
    echo "aborted." ; exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------
TOTAL_STEPS=6
[[ "$SEED_VFD_SAMPLES" -eq 1 ]] && TOTAL_STEPS=7

step() {
  printf "${C_BOLD}[%d/%d]${C_RESET} %s" "$1" "$TOTAL_STEPS" "$2"
}
step_ok() { printf " ${C_OK}✓${C_RESET} %s\n" "${1:-ok}"; }
step_warn() { printf " ${C_WARN}!${C_RESET} %s\n" "$*"; }

run_sql() {
  local stmt="$1"
  local payload
  payload="$(WH="$WAREHOUSE_ID" STMT="$stmt" python3 -c 'import json,os; print(json.dumps({"warehouse_id": os.environ["WH"], "statement": os.environ["STMT"], "wait_timeout": "50s"}))')"
  echo "$payload" | $DB api post /api/2.0/sql/statements --json @/dev/stdin 2>&1
}

# Returns 0 on SUCCEEDED or expected-duplicate error; 1 on real failure.
run_sql_idem() {
  local resp; resp="$(run_sql "$1")"
  if echo "$resp" | grep -q '"state":"SUCCEEDED"'; then return 0; fi
  if echo "$resp" | grep -q 'FIELD_ALREADY_EXISTS\|TABLE_OR_VIEW_ALREADY_EXISTS\|already exists in\|SCHEMA_ALREADY_EXISTS'; then return 0; fi
  echo "$resp" | head -c 400 ; echo
  return 1
}

# Render app.yaml from the template with the user's chosen values. Apps
# deploy reads app.yaml from $SOURCE_CODE_PATH, so it must be in the synced
# tree (and on disk for the in-workspace path).
TEMPLATE="$REPO_ROOT/app.yaml.template"
if [[ -f "$TEMPLATE" ]]; then
  IMAGE_VOL_FQN="$IMAGE_CAT.$IMAGE_SCH.$IMAGE_VOL"
  sed -e "s|{{WAREHOUSE_ID}}|$WAREHOUSE_ID|g" \
      -e "s|{{UC_CATALOG}}|$ANN_CAT|g" \
      -e "s|{{UC_SCHEMA}}|$ANN_SCH|g" \
      -e "s|{{UC_VOLUME_PATH}}|$VOLUME_PATH|g" \
      -e "s|{{IMAGE_VOLUME_FQN}}|$IMAGE_VOL_FQN|g" \
      -e "s|{{ANN_SCHEMA_FQN}}|$ANN_CAT.$ANN_SCH|g" \
      "$TEMPLATE" > "$REPO_ROOT/app.yaml"
fi

# ---- Step 1: schema + volume (resources) ----------------------------------
echo
if [[ "$SKIP_RESOURCE_CREATE" -eq 0 ]]; then
  step 1 "Ensuring schema + volume"
  # Image-volume schema
  $DB schemas get "$IMAGE_CAT.$IMAGE_SCH" >/dev/null 2>&1 || \
    $DB schemas create "$IMAGE_SCH" "$IMAGE_CAT" --comment "Eval-labelling app" >/dev/null 2>&1 || true
  # Image volume
  $DB volumes get "$IMAGE_CAT.$IMAGE_SCH.$IMAGE_VOL" >/dev/null 2>&1 || \
    $DB volumes create "$IMAGE_CAT" "$IMAGE_SCH" "$IMAGE_VOL" MANAGED --comment "Eval-labelling images" >/dev/null 2>&1 || true
  # Annotations schema (if different from image-volume schema)
  if [[ "$ANN_CAT" != "$IMAGE_CAT" || "$ANN_SCH" != "$IMAGE_SCH" ]]; then
    $DB schemas get "$ANN_CAT.$ANN_SCH" >/dev/null 2>&1 || \
      $DB schemas create "$ANN_SCH" "$ANN_CAT" --comment "Eval-labelling app state" >/dev/null 2>&1 || true
  fi
  step_ok
else
  step 1 "Ensuring schema + volume" ; step_warn "skipped (--skip-resource-create)"
fi

# ---- Step 2: tables (DDL) -------------------------------------------------
step 2 "Ensuring tables"
DDL_FILE="$REPO_ROOT/sql/ddl.sql"
if [[ "$SKIP_RESOURCE_CREATE" -eq 1 ]]; then
  step_warn "skipped (--skip-resource-create)"
elif [[ ! -f "$DDL_FILE" ]]; then
  step_warn "sql/ddl.sql missing"
else
  TABLE_OK=0; TABLE_BAD=0
  # Split the DDL on `;` keeping multi-line statements intact. We use null
  # bytes as the record separator on output so the `read` loop never breaks
  # a CREATE TABLE across lines.
  while IFS= read -r -d '' STMT; do
    # Strip SQL line comments + leading/trailing whitespace.
    STMT_TRIM="$(printf '%s' "$STMT" | sed -e 's/--[^\n]*//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -z "$STMT_TRIM" ]] && continue
    STMT_TRIM="${STMT_TRIM//\{\{CATALOG\}\}/$ANN_CAT}"
    STMT_TRIM="${STMT_TRIM//\{\{SCHEMA\}\}/$ANN_SCH}"
    if run_sql_idem "$STMT_TRIM" >/dev/null 2>&1; then
      TABLE_OK=$((TABLE_OK+1))
    else
      TABLE_BAD=$((TABLE_BAD+1))
    fi
  done < <(awk 'BEGIN{RS=";"; ORS="\0"} {print $0}' "$DDL_FILE")
  if [[ "$TABLE_BAD" -eq 0 ]]; then
    step_ok "$TABLE_OK statements"
  else
    step_warn "$TABLE_OK ok, $TABLE_BAD warnings"
  fi
fi

# ---- Step 3 (optional): VFD sample seed -----------------------------------
NEXT_STEP=3
if [[ "$SEED_VFD_SAMPLES" -eq 1 ]]; then
  step $NEXT_STEP "Rendering & uploading VFD samples"
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  SAMPLE_DIR="$HOME/Desktop/vfd-power-curves"
  VFD_PY="$SAMPLE_DIR/.venv/bin/python"
  if [[ ! -d "$SAMPLE_DIR" || ! -x "$CHROME" ]]; then
    step_warn "Chrome or VFD samples not found locally; skipping"
  else
    OUT="$REPO_ROOT/.deploy_tmp_samples"
    mkdir -p "$OUT"
    for HTML in "$SAMPLE_DIR"/example*.html; do
      BASE="$(basename "$HTML" .html).png"
      "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
        --window-size=1280,720 --screenshot="$OUT/$BASE" "file://$HTML" >/dev/null 2>&1 || true
      [[ -f "$OUT/$BASE" ]] && $DB fs cp --overwrite "$OUT/$BASE" "dbfs:$VOLUME_PATH/vfd_power_curves/$BASE" >/dev/null 2>&1 || true
    done
    if [[ -x "$VFD_PY" && -f "$REPO_ROOT/bin/seed_chart_data.py" ]]; then
      "$VFD_PY" "$REPO_ROOT/bin/seed_chart_data.py" "$OUT" >/dev/null 2>&1 || true
      for CALIB in "$OUT"/*.calibration.json; do
        [[ -f "$CALIB" ]] || continue
        BASE="$(basename "$CALIB" .calibration.json)"
        POINTS="$OUT/$BASE.points.json"
        GP="$VOLUME_PATH/vfd_power_curves/${BASE}.png"
        SQL="$(python3 "$REPO_ROOT/bin/_seed_emit_sql.py" "$CALIB" "$POINTS" "$GP" \
              "$ANN_CAT.$ANN_SCH.chart_points" "$ANN_CAT.$ANN_SCH.graphs")"
        while IFS= read -r LINE; do
          [[ -z "$LINE" ]] && continue
          run_sql "$LINE" >/dev/null 2>&1 || true
        done <<< "$SQL"
      done
    fi
    rm -rf "$OUT"
    step_ok
  fi
  NEXT_STEP=4
fi

# ---- Step N: scan volume --------------------------------------------------
step $NEXT_STEP "Scanning volume for images"
SCAN_OUT="$(python3 "$SCAN" \
  --profile "${DEF_PROFILE}" \
  --warehouse-id "$WAREHOUSE_ID" \
  --volume-path "$VOLUME_PATH" \
  --annotations-fq "$ANN_CAT.$ANN_SCH" \
  --chart-points-fq "$CP_TBL" 2>&1)" || SCAN_OUT="ERROR: $SCAN_OUT"
if [[ "$SCAN_OUT" =~ ^[0-9]+\	[0-9]+\	[0-9]+$ ]]; then
  IFS=$'\t' read -r DISC NEW SKIP <<< "$SCAN_OUT"
  step_ok "$DISC image files (${NEW} new, ${SKIP} already in graphs)"
else
  step_warn "$SCAN_OUT" | head -c 300
fi
NEXT_STEP=$((NEXT_STEP+1))

# ---- Frontend build (skipped if dist exists or --skip-frontend-build) -----
if [[ "$SKIP_FRONTEND" -eq 0 && ! -f "$REPO_ROOT/frontend/dist/index.html" ]]; then
  step $NEXT_STEP "Building frontend"
  pushd "$REPO_ROOT/frontend" >/dev/null
  if npm install --no-audit --no-fund --silent >/dev/null 2>&1 && npm run build >/dev/null 2>&1; then
    step_ok
  else
    step_warn "npm build failed — app will deploy without UI"
  fi
  popd >/dev/null
  NEXT_STEP=$((NEXT_STEP+1))
fi

# ---- Source sync (skipped when in-workspace) ------------------------------
step $NEXT_STEP "Syncing source"
if [[ "$IN_WORKSPACE" -eq 1 ]]; then
  SOURCE_CODE_PATH="$PWD"
  step_ok "in-workspace ($SOURCE_CODE_PATH)"
else
  $DB sync . "$SOURCE_CODE_PATH" --full --watch=false >/dev/null 2>&1 || \
    $DB sync . "$SOURCE_CODE_PATH" --watch=false >/dev/null 2>&1 || true
  step_ok "$SOURCE_CODE_PATH"
fi
NEXT_STEP=$((NEXT_STEP+1))

# ---- App create or update + deploy ----------------------------------------
step $NEXT_STEP "Deploying app"
if ! $DB apps get "$APP_NAME" >/dev/null 2>&1; then
  $DB apps create "$APP_NAME" --description "Eval labelling for Plotly chart images" >/dev/null 2>&1 || true
fi
DEPLOY_RESP="$($DB apps deploy "$APP_NAME" --source-code-path "$SOURCE_CODE_PATH" --mode SNAPSHOT 2>&1 || true)"
if echo "$DEPLOY_RESP" | grep -q '"state":"SUCCEEDED"\|"state":"IN_PROGRESS"\|"state":"PENDING"'; then
  step_ok
else
  step_warn "$(echo "$DEPLOY_RESP" | head -c 300)"
fi
NEXT_STEP=$((NEXT_STEP+1))

# ---- Wait for RUNNING ------------------------------------------------------
step $NEXT_STEP "Waiting for RUNNING (10 min max)"
START=$(date +%s); TIMEOUT=600
while :; do
  INFO="$($DB apps get "$APP_NAME" 2>/dev/null || true)"
  APP_STATE="$(echo "$INFO" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("app_status",{}).get("state","UNKNOWN"))' 2>/dev/null || echo UNKNOWN)"
  DEP_STATE="$(echo "$INFO" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("active_deployment") or d.get("pending_deployment") or {}).get("status",{}).get("state","UNKNOWN"))' 2>/dev/null || echo UNKNOWN)"
  if [[ "$APP_STATE" == "RUNNING" && "$DEP_STATE" == "SUCCEEDED" ]]; then
    step_ok "RUNNING"
    break
  fi
  if [[ "$DEP_STATE" == "FAILED" || "$APP_STATE" == "ERROR" || "$APP_STATE" == "CRASHED" ]]; then
    step_warn "deployment failed"
    echo "$INFO" | head -c 1500
    exit 1
  fi
  NOW=$(date +%s); if (( NOW - START > TIMEOUT )); then
    step_warn "timed out"; exit 1
  fi
  sleep 8
done

# ---- Grant the app's SP what it needs on UC -------------------------------
# UC objects (catalog/schema/volume/table) are not yet first-class resources
# in app.yaml, so the SP starts a fresh deploy with zero UC grants. We grant
# the minimum to read the volume and read+write the annotation tables.
# Idempotent: re-runs grant the same privileges silently.
APP_SP="$($DB apps get "$APP_NAME" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("service_principal_client_id",""))')"
if [[ -n "$APP_SP" ]]; then
  echo
  echo "${C_BOLD}Granting Unity Catalog access to the app's service principal${C_RESET}"
  echo "${C_DIM}  sp=$APP_SP${C_RESET}"
  TABLES=("graphs" "annotations" "comments" "chart_points" "annotation_data_points")
  GRANTS=(
    "GRANT USE CATALOG ON CATALOG \`$IMAGE_CAT\` TO \`$APP_SP\`"
    "GRANT READ VOLUME ON VOLUME \`$IMAGE_CAT\`.\`$IMAGE_SCH\`.\`$IMAGE_VOL\` TO \`$APP_SP\`"
    "GRANT USE CATALOG ON CATALOG \`$ANN_CAT\` TO \`$APP_SP\`"
    "GRANT USE SCHEMA ON SCHEMA \`$ANN_CAT\`.\`$ANN_SCH\` TO \`$APP_SP\`"
  )
  for T in "${TABLES[@]}"; do
    GRANTS+=("GRANT SELECT, MODIFY ON TABLE \`$ANN_CAT\`.\`$ANN_SCH\`.\`$T\` TO \`$APP_SP\`")
  done
  GRANT_FAILS=()
  for G in "${GRANTS[@]}"; do
    RESP="$(run_sql "$G")"
    if echo "$RESP" | grep -q '"state":"SUCCEEDED"'; then
      ok "$(echo "$G" | sed -E 's/GRANT (.+) TO.*/\1/')"
    else
      GRANT_FAILS+=("$G")
      MSG="$(echo "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("status",{}).get("error",{}).get("message","") or "")[:120])' 2>/dev/null || echo "")"
      warn "$(echo "$G" | sed -E 's/GRANT (.+) TO.*/\1/')  -- $MSG"
    fi
  done
  if [[ "${#GRANT_FAILS[@]}" -gt 0 ]]; then
    echo
    warn "Some grants failed (likely because you don't own the catalog/schema)."
    echo "  Ask an owner to run these as the catalog/schema admin:"
    echo
    for G in "${GRANT_FAILS[@]}"; do
      echo "    $G;"
    done
    echo
  fi
fi

# ---- App access (optional) ------------------------------------------------
if [[ -n "$APP_GROUP" ]]; then
  APP_ID="$($DB apps get "$APP_NAME" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id","") or d.get("name",""))')"
  if [[ -n "$APP_ID" ]]; then
    ACL_PAYLOAD="$(GRP="$APP_GROUP" python3 -c 'import json,os; print(json.dumps({"access_control_list":[{"group_name": os.environ["GRP"], "permission_level":"CAN_USE"}]}))')"
    echo "$ACL_PAYLOAD" | $DB api patch "/api/2.0/permissions/apps/$APP_ID" --json @/dev/stdin >/dev/null 2>&1 || \
      warn "could not grant CAN_USE to '$APP_GROUP' — set permissions in the UI"
  fi
fi

# ---- Done -----------------------------------------------------------------
APP_URL="$($DB apps get "$APP_NAME" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"
echo
banner "App is RUNNING"
printf "  ${C_OK}%s${C_RESET}\n\n" "$APP_URL"
echo "Next steps:"
echo "  • Open the URL above"
echo "  • Drop more image files into $VOLUME_PATH and rerun:"
echo "      ./install --rescan"
echo "  • Tear down later with: $DB apps delete $APP_NAME"
echo
