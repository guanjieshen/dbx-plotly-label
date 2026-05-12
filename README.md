# dbx-plotly-label

Databricks App for labelling Plotly chart images — Scale AI-style annotation tool that lives on top of Unity Catalog. Designed to be installed into any Databricks workspace in a few minutes via a single CLI command.

## Quickstart (Databricks workspace)

The fastest path — works on any cluster with the Web Terminal enabled.

1. **Add this repo as a Git Folder** in your workspace (Workspace → +Add → Git Folder → paste the repo URL).
2. **Open a Web Terminal** on any running cluster and `cd` into the folder:
   ```bash
   cd /Workspace/Users/<you>/dbx-plotly-label
   ```
3. **Run the installer**:
   ```bash
   ./install
   ```

The installer walks an auto-discovering Q&A:

- Pick your **SQL warehouse** from the workspace's list
- Pick (or create) the **catalog + schema + volume** that already holds your chart images
- Pick where to keep the app's **annotations** Delta tables (default: same place as images)
- Pick a **chart_points** source table (default: a fresh local one)
- Pick the **app name**
- Pick the **app access** (just you, or a Databricks group)

It then provisions everything (schema, volume, tables — idempotent), scans the volume for image files and seeds the queue, deploys the app, waits for it to come up, and prints the URL.

Image formats supported: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`.

### Adding more images later

Drop more files into your volume and re-scan:

```bash
./install --rescan
```

### Flags

| Flag | Purpose |
|------|---------|
| (none) | Interactive Q&A — first-time install |
| `--non-interactive` | Skip prompts; use `.deploy.yaml` as-is (CI) |
| `--rescan` | Just walk the configured volume + INSERT any new image files |
| `--skip-resource-create` | Skip schema/volume/table creation (fast redeploy when only code changed) |
| `--skip-frontend-build` | Skip `npm install` / `npm run build` (`frontend/dist/` is pre-built and committed) |
| `--seed-vfd-samples` | Dev-only: render the bundled VFD example charts via headless Chrome and upload them (needs a Mac + `~/Desktop/vfd-power-curves`) |

## What the app does

- Loads images from a UC volume into a labelling queue (`graphs` table)
- Users draw rectangles / circles / pins on each image; pick from a fixed taxonomy (False Positive, Missed Anomaly, Chart Artifact) or a free-text **Custom** class
- Annotations are buffered client-side and committed in **one batched Delta write on Submit** — drawing feels instant
- Each annotation captures **labeller intent** (`applies_to: prediction / actuals / both`)
- If you register upstream **calibration** (axis ranges + plot-area pixel bbox in `graphs.metadata`) and a `chart_points` table, every box auto-snapshots the underlying data rows it covers into `annotation_data_points` — ready for downstream similarity / model-evaluation work
- Threaded **shape comments** + **chart-level comments**
- Right-panel **Task info** surfaces all `graphs.metadata` (friendly + advanced + arbitrary upstream keys)

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind CSS + react-konva + zustand + @tanstack/react-query |
| Backend | FastAPI + databricks-sql-connector + databricks-sdk |
| Auth | App service principal (Databricks Apps); real user from `X-Forwarded-Email` |
| Storage | Delta tables (`graphs`, `annotations`, `comments`, `chart_points`, `annotation_data_points`) + UC Volumes for images |

## API surface

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Current user from `X-Forwarded-Email` |
| GET | `/api/label_classes` | Class taxonomy from `backend/config/label_classes.json` |
| GET | `/api/volume/tree?path=` | Recursive UC volume tree |
| GET | `/api/graphs?status=` | List `graphs` rows |
| GET | `/api/graphs/{path:path}/image` | Stream image bytes (multi-format) |
| GET | `/api/graphs/{path:path}/annotations` | Shapes + per-shape comments + chart comments + axes + graph_info |
| POST | `/api/annotations` / `/batch` | Create (incl. `applies_to`, `custom_label`); batch is the hot path |
| PATCH | `/api/annotations` / `/batch` | Update shape / class |
| DELETE | `/api/annotations` / `/batch` | Soft-delete |
| POST | `/api/comments/batch` | Create comments (annotation- and chart-scoped, mixed) |
| POST | `/api/graphs/{path:path}/comments` | Add chart-level comment |
| POST | `/api/graphs/{path:path}/freeze` | Mark `done`; freeze all shapes |
| POST | `/api/graphs/{path:path}/skip` | Mark `skipped` |
| POST | `/api/queue/claim` | Atomic claim of next unlabelled graph |

## Repo layout

```
dbx-plotly-label/
├── install                         # entry point (wraps bin/deploy.sh)
├── bin/
│   ├── deploy.sh                   # installer/deployer
│   ├── _discover.py                # CLI JSON → tab-separated rows for the picker
│   ├── _scan_volume.py             # walks the volume, INSERTs new graph rows
│   ├── seed_chart_data.py          # dev-only VFD calibration extractor
│   └── _seed_emit_sql.py           # dev-only VFD SQL emitter
├── sql/ddl.sql                     # CREATE TABLE IF NOT EXISTS for all Delta tables
├── app.yaml                        # Databricks Apps spec
├── requirements.txt
├── .deploy.yaml.example            # template (.deploy.yaml is gitignored)
├── backend/
│   ├── main.py                     # FastAPI app — mounts /api and frontend/dist at /
│   ├── auth.py                     # X-Forwarded-Email → user email middleware
│   ├── db.py                       # SQL conn + UC Volume helpers + calibration + snapshot
│   ├── settings.py
│   ├── routers/                    # me, classes, volume, graphs, annotations, comments, queue
│   └── config/label_classes.json
└── frontend/
    ├── dist/                       # pre-built — committed so the workspace install needs no npm
    ├── package.json
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api/client.ts
        ├── store/editor.ts
        ├── hooks/useMergedAnnotations.ts
        └── components/{TopBar,LeftToolRail,CanvasStage,RightPanel,
                         StatusBar,VolumeBrowser,ShortcutsModal}.tsx
```

## Local development (laptop fallback)

```bash
git clone https://github.com/guanjieshen/dbx-plotly-label
cd dbx-plotly-label
databricks auth login --host <https://your-workspace>  # if you don't already have a profile
./install                                # same script; picks up .databrickscfg profile
```

For backend-only iteration:

```bash
uvicorn backend.main:app --reload --port 8000
# in another shell
cd frontend && npm run dev   # http://localhost:5173, proxies /api -> :8000
```

In local dev `X-Forwarded-Email` is absent, so writes are stamped `local-dev@example.com`.
