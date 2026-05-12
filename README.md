# dbx-plotly-label

Annotate Plotly chart images in a Databricks workspace. Annotations + their underlying data rows land in Delta tables you can query downstream.

![App screenshot — drop a screenshot at docs/screenshot.png after first install](docs/screenshot.png)

## TL;DR

```bash
# In a Databricks workspace web terminal:
cd /Workspace/Users/<you>/dbx-plotly-label
./install
```

The installer walks an auto-discovering Q&A, provisions Unity Catalog tables, grants the app's service principal what it needs, deploys the app, and prints the URL.

## Prerequisites

| | What | Why it matters |
|---|---|---|
| 1 | A **Databricks workspace with Unity Catalog** | The app reads from UC volumes and writes to UC tables. |
| 2 | A **running cluster with Web Terminal enabled** | Web Terminal is how you launch `./install`. (Compute → your cluster → Apps → Web terminal.) |
| 3 | An **existing UC volume of chart images** | The volume's files become your labelling queue. Supported: `.png .jpg .jpeg .gif .webp .bmp .svg`. |
| 4 | A **SQL warehouse you can use** | Drives every Delta read and write the app does. |
| 5 | **GRANT rights** on the catalog you'll use | The installer grants the app's service principal `USE CATALOG / USE SCHEMA / READ VOLUME / SELECT / MODIFY`. If you aren't an owner, hand the printed SQL block to whoever is. |

## Install (Databricks workspace)

1. **Clone this repo into your workspace** as a Git Folder
   *Workspace → +Add → Git Folder →* paste `https://github.com/guanjieshen/dbx-plotly-label`.
2. **Open a Web Terminal** on any running cluster and `cd` into the folder
   ```bash
   cd /Workspace/Users/<you>/dbx-plotly-label
   ```
3. **Run the installer**
   ```bash
   ./install
   ```

Done. The final line prints your app URL.

## Inputs the installer asks you

| Prompt | What it means | Default |
|---|---|---|
| **SQL warehouse** | The warehouse that runs every read and Delta write. | Lists your workspace's warehouses; pick by number. |
| **Image catalog** | The catalog that holds your images. | Pick from existing, or type a new name. |
| **Image schema** | The schema inside the catalog. | Pick from existing, or create. |
| **Image volume** | The UC volume that holds your chart image files. | Pick from existing, or create a new managed volume. |
| **Annotations & metadata location** | Where the app's 5 Delta tables are created. | *Same as image volume* (1 keystroke). Power users can split. |
| **chart_points source** | Optional source table for the box→data feature. | Auto-creates a local one; skip unless you already have a producer table. |
| **App name** | Your Databricks App's name (also the URL prefix). | `eval-labelling`. |
| **App access** | Who can open the app URL. | Just you. Or supply a Databricks group for shared access. |

All answers persist to `.deploy.yaml` (gitignored); re-running `./install --non-interactive` reuses them.

## What gets deployed

| Artifact | Where | Notes |
|---|---|---|
| **Databricks App** | `https://<app-name>-<workspace>.<region>.azuredatabricks.app` | The URL printed at the end of install. |
| **5 Delta tables** | `<annotations_catalog>.<annotations_schema>.*` (see next section) | Created idempotently. Existing tables in the same schema are left alone. |
| **Catalog seed rows** | One row in `graphs` for every image file the installer found in your volume. | Re-run `./install --rescan` after you add more files. |
| **UC grants on the app's service principal** | `USE CATALOG`, `USE SCHEMA`, `READ VOLUME` on the image volume; `SELECT, MODIFY` on each Delta table. | Idempotent. Skipped silently if you lack GRANT rights — the SQL is printed for an admin to run. |
| **Rendered `app.yaml`** | Repo root (gitignored) | Holds your chosen warehouse ID, catalog/schema, and volume path as env vars baked into the deployment. |

## Tables created

All five live in `<annotations_catalog>.<annotations_schema>`:

| Table | Purpose | Written when |
|---|---|---|
| `graphs` | The labelling queue — one row per image. Tracks `status` (`unlabelled` / `in_progress` / `done` / `skipped`), assignee, and per-image metadata (axis ranges, plot bbox, chart title, etc.). | Volume scan at install + on every freeze/skip/claim. |
| `annotations` | Every shape a labeller draws: pixel + projected data bbox, label class, intent (`applies_to`), creator. | Submitted batch on each Submit click. |
| `comments` | Per-shape **and** chart-level threaded comments (one table; scoped via the `scope` column). | Same Submit batch as annotations. |
| `chart_points` | Optional source-data points underlying each chart. Schema: `chart_id, trace_id, point_id, x, y, extras`. Producers can write to this from upstream pipelines, or let the installer create an empty one. | Written upstream — the app only reads. |
| `annotation_data_points` | Snapshot of the rows from `chart_points` that fall inside each annotation's data bbox — frozen at save time so downstream similarity work has stable inputs. | One row per matching data point on each Submit, **iff** the parent chart has calibration registered in `graphs.metadata`. |

## Supported image formats

`.png` · `.jpg` · `.jpeg` · `.gif` · `.webp` · `.bmp` · `.svg`

The volume scan picks up any file with one of these extensions, at any depth under your chosen volume.

## Using the app

Open the URL. The labeller flow:

1. The app auto-claims the next `unlabelled` graph and shows it on the canvas.
2. Pick a **drawing tool** (or just start drawing):
   - `R` rectangle · `C` circle · `P` pin · `V` select
3. After you finish a shape, the inline picker pops up. Pick a class with `1`–`4`:
   - `1` False Positive · `2` Missed Anomaly · `3` Chart Artifact · `4` Custom (free-text)
   Optionally set **applies to** (`prediction` / `actuals` / `both`).
4. Add **shape comments** or **chart comments** from the right rail. Everything stays in your browser until you click **Submit**.
5. **Submit** (`Enter`) freezes the graph, batches every change to Delta in one round-trip, then auto-advances to the next image.
   **Skip** (`S`) marks the graph `skipped` without freezing — you can come back to it.
6. Press `?` in the app to see the full keyboard cheatsheet (zoom, pan, undo, etc.).

The right rail has a collapsible **Task info** section showing the chart's title, axes, calibration status, and any extra metadata the upstream producer wrote into `graphs.metadata`.

## Adding more images later

Drop new files into your volume (any path under it, any supported format) and:

```bash
./install --rescan
```

The scanner diffs against existing `graphs` rows and only INSERTs new ones.

## Updating / redeploying

```bash
cd /Workspace/Users/<you>/dbx-plotly-label
git pull
./install
```

`./install` is idempotent — only changed code is redeployed; tables / volumes / grants are no-ops if already in place.

## Tearing down

```bash
databricks apps delete <app-name>
```

Tables and the volume are left in place (your data). Drop them by hand if you want a clean slate.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Volume browser inside the app is empty | The app's service principal doesn't have `READ VOLUME` / `USE SCHEMA` on your UC objects (no GRANT rights at install time). | Have a catalog admin run the SQL block the installer printed; or re-run `./install` once permissions are sorted. |
| `DATABRICKS_WAREHOUSE_ID is not set` in app logs | `app.yaml` wasn't rendered for this install (running an old commit or skipped the install step). | Re-run `./install` — it rewrites `app.yaml` from `app.yaml.template`. |
| `permission denied` while running grants in install | You're not the owner of the catalog/schema. | Copy the printed `GRANT …` statements; ask a UC admin to run them, then re-run `./install --skip-resource-create`. |
| Frontend looks frozen after edits | Stale `localStorage` from before a buffer-shape change. | Hard-refresh; the app self-heals on rehydrate. |

---

<details>
<summary><b>For contributors</b> (stack, repo layout, API, local dev)</summary>

### Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind CSS + react-konva + zustand + @tanstack/react-query + react-hotkeys-hook |
| Backend | FastAPI + databricks-sql-connector + databricks-sdk (serves `/api/*` and the built frontend at `/`) |
| Auth | App service principal (Databricks Apps); real user identity from the `X-Forwarded-Email` header, stamped on every annotation/comment write |
| Storage | Delta tables + UC Volumes |

### Repo layout

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
├── app.yaml.template               # rendered per-install with chosen warehouse/UC values
├── requirements.txt
├── .deploy.yaml.example            # template (.deploy.yaml is gitignored)
├── backend/
│   ├── main.py                     # FastAPI — mounts /api and frontend/dist at /
│   ├── auth.py                     # X-Forwarded-Email → user email middleware
│   ├── db.py                       # SQL conn + UC Volume helpers + calibration + snapshot
│   ├── settings.py
│   ├── routers/                    # me, classes, volume, graphs, annotations, comments, queue
│   └── config/label_classes.json
└── frontend/
    ├── dist/                       # pre-built — committed so workspace installs need no npm
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

### API surface

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

### Local development

```bash
git clone https://github.com/guanjieshen/dbx-plotly-label
cd dbx-plotly-label
databricks auth login --host <https://your-workspace>   # if you don't already have a profile
./install                                                # picks up .databrickscfg profile
```

For backend-only iteration:

```bash
uvicorn backend.main:app --reload --port 8000
# in another shell
cd frontend && npm run dev   # http://localhost:5173, proxies /api → :8000
```

In local dev `X-Forwarded-Email` is absent, so writes are stamped `local-dev@example.com`.

### Installer flags

| Flag | Purpose |
|------|---------|
| (none) | Interactive Q&A — first-time install |
| `--non-interactive` | Skip prompts; use `.deploy.yaml` as-is (CI) |
| `--rescan` | Walk the configured volume + INSERT any new image files (no other side effects) |
| `--skip-resource-create` | Skip schema/volume/table creation (fast redeploy when only code changed) |
| `--skip-frontend-build` | Skip `npm install` / `npm run build` (`frontend/dist/` is pre-built and committed) |
| `--seed-vfd-samples` | Dev-only: render the bundled VFD example charts via headless Chrome (needs a Mac + `~/Desktop/vfd-power-curves`) |

</details>
