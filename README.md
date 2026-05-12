# eval-labelling-app

Databricks App for ML evaluation QA labelling — Scale AI-style annotation tool over Plotly-generated PNG charts (e.g. VFD pump power curves).

## Stack

- **Frontend** React + Vite + TypeScript + Tailwind CSS + react-konva + lucide-react + zustand + @tanstack/react-query + react-hotkeys-hook
- **Backend** FastAPI + databricks-sql-connector + databricks-sdk + uvicorn (serves `/api/*` and the built frontend at `/`)
- **Auth** App service principal handles UC reads/writes; per-user identity captured from the `X-Forwarded-Email` request header and stamped on every annotation/comment write
- **Storage** Delta tables (`graphs`, `annotations`, `comments`) in `classic_stable_ccu63h.eval_labelling`; PNGs at `/Volumes/classic_stable_ccu63h/eval_labelling/graphs/`

## Prerequisites

- Databricks CLI 0.229+
- npm + Node.js
- An authenticated Databricks profile (`databricks auth login --profile <name>`)

## Quickstart

```bash
git clone <repo-url> eval-labelling-app
cd eval-labelling-app
./bin/deploy.sh                    # interactive deploy with prompts
./bin/deploy.sh --seed-samples     # also render + upload VFD sample PNGs
./bin/deploy.sh --non-interactive  # use .deploy.yaml as-is (CI mode)
```

The deploy script:
1. Prompts for / confirms every config value (catalog, schema, volume, warehouse, app name, ...)
2. Persists answers to `.deploy.yaml` (gitignored)
3. Idempotently creates the schema, volume, and Delta tables
4. Builds the frontend (`npm install && npm run build`)
5. Syncs source to `/Workspace/Users/<you>/eval-labelling-app`
6. Creates the app if missing, then deploys it
7. Tails status until `RUNNING` (10-min timeout) and prints the URL

### Flags

| Flag | Purpose |
|------|---------|
| `--non-interactive` | Skip prompts; use `.deploy.yaml` as-is. |
| `--seed-samples` | Render VFD sample PNGs from `~/Desktop/vfd-power-curves/example*.html` via headless Chrome and upload to the volume. |
| `--skip-frontend-build` | Skip `npm install && npm run build` (back-end iteration). |
| `--skip-resource-create` | Skip schema/volume/table idempotent creation (fast path when everything already exists). |

## Repo layout

```
eval-labelling-app/
├── app.yaml                 # Databricks App spec
├── requirements.txt
├── .deploy.yaml.example     # template (.deploy.yaml is gitignored)
├── bin/
│   └── deploy.sh            # THE entry point — interactive CLI
├── sql/
│   └── ddl.sql              # CREATE TABLE IF NOT EXISTS for the 3 Delta tables
├── backend/
│   ├── main.py              # FastAPI app: mounts /api and /
│   ├── auth.py              # X-Forwarded-Email → user email
│   ├── db.py                # SQL connector + UC Volume helpers
│   ├── settings.py          # env-var-driven config
│   ├── routers/             # me, classes, volume, graphs, annotations, comments, queue
│   └── config/label_classes.json
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api/client.ts
        ├── store/editor.ts
        └── components/{TopBar,LeftToolRail,CanvasStage,RightPanel,
                         StatusBar,VolumeBrowser,ShortcutsModal}.tsx
```

## API surface

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Echo current user (`X-Forwarded-Email`) |
| GET | `/api/label_classes` | Static class config |
| GET | `/api/volume/tree?path=` | Recursive UC volume tree |
| GET | `/api/graphs?status=` | List `graphs` rows |
| GET | `/api/graphs/{path:path}/image` | Stream PNG bytes |
| GET | `/api/graphs/{path:path}/annotations` | Shapes + comments |
| POST | `/api/annotations` | Create shape |
| PATCH | `/api/annotations/{id}` | Update shape |
| DELETE | `/api/annotations/{id}` | Soft-delete shape |
| POST | `/api/annotations/{id}/comments` | Add comment (threadable) |
| POST | `/api/graphs/{path:path}/freeze` | Mark `done`; freeze all shapes |
| POST | `/api/graphs/{path:path}/skip` | Mark `skipped` |
| POST | `/api/queue/claim` | Atomic claim of next unlabelled graph |

## Local development

```bash
# Backend
uvicorn backend.main:app --reload --port 8000

# Frontend (in another shell)
cd frontend && npm run dev   # http://localhost:5173, proxies /api -> :8000
```

In local mode `X-Forwarded-Email` is absent, so writes are stamped as `local-dev@example.com`.
