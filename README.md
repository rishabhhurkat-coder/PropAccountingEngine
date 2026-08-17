# Prop Accounting Engine

> A private, end-to-end trade accounting workspace for importing broker files, normalising executions, building positions, allocating strategy ownership, reconciling live prices, and producing decision-ready reports.

![Status](https://img.shields.io/badge/status-private--workspace-5b61e8)
![Backend](https://img.shields.io/badge/backend-FastAPI%20%7C%20Python-0f766e)
![Frontend](https://img.shields.io/badge/frontend-React%20%7C%20TypeScript-2563eb)
![Data](https://img.shields.io/badge/data-Supabase%20%7C%20GCS-7c3aed)

## What this system does

Prop Accounting Engine turns raw trading activity into an auditable accounting workflow:

```text
Broker TXT / report files
        │
        ▼
Import → Normalise → Merge → Split → Allocate → Reconcile → Report
        │                                      │
        ├── Supabase/PostgreSQL ledger         └── Zerodha live prices
        ├── GCS market-data storage            └── Matalia charges reports
        └── React operations console
```

The application is designed for prop-trading operations where execution-level detail, position lineage, strategy ownership, charges, and live mark-to-market values must remain connected.

## Product areas

| Area | Purpose |
| --- | --- |
| Raw Trade Import | Upload and inspect source TXT files, monitor the import pipeline, and review validation results. |
| Instrument Allocation | Merge executions into logical trades, split quantities, and confirm strategy ownership. |
| Strategy Master | Maintain reusable strategy/account/expiry configuration. |
| Trade Book | Browse all, open, and closed trades with filters, pagination, deletion, and CMP updates. |
| Positions | Review open positions and refresh current market prices through Zerodha. |
| Strategy Report | View P&L, contribution, win/loss, timing, distribution, and monthly analytics. |
| Matalia Charges | Fetch, parse, store, and review daily charges and brokerage reports. |

## Technology

- **Backend:** Python, FastAPI, pandas, psycopg, DuckDB, Playwright, Kite Connect, Google Cloud Storage.
- **Frontend:** React, TypeScript, Vite, Recharts, Framer Motion, Lucide icons.
- **Persistence:** Supabase/PostgreSQL for operational tables and ledgers; GCS for market-data assets.
- **Runtime:** Windows-first PowerShell launcher with local FastAPI and Vite development servers.

## Quick start

### 1. Prepare credentials

Copy the template and fill it locally:

```powershell
Copy-Item Credentials\.env.example Credentials\.env
```

The live `.env` is intentionally excluded from Git. The repository may contain `Credentials/.env.enc`, which is an encrypted backup and is not loaded automatically by the application.

### 2. Install backend dependencies

```powershell
py -m pip install -r Credentials\requirements.txt
py -m playwright install
```

### 3. Install frontend dependencies

```powershell
Set-Location frontend
npm install
```

### 4. Start the backend

From the repository root:

```powershell
py -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8001
```

### 5. Start the frontend

In a second terminal:

```powershell
Set-Location frontend
npm run dev -- --host 127.0.0.1 --port 3489
```

Open `http://localhost:3489`. The frontend uses `VITE_BACKEND_URL` when provided and otherwise targets `http://localhost:8001`.

### Optional launcher

`backend/start_matalia.ps1` contains the Windows splash-screen launcher and runtime orchestration used by the local desktop workflow. Review its local paths and prerequisites before using it on another machine.

## Repository map

```text
PropAccountingEngine/
├── backend/                  FastAPI API and accounting/data workflows
├── frontend/                 React + TypeScript operations console
├── Credentials/              Environment template, requirements, encrypted backup
├── docs/                     Architecture, setup, API, security, and file reference
├── .gitignore                Secret, cache, dependency, and runtime-data policy
└── Matalia.vbs               Windows convenience launcher
```

For the complete folder-by-folder and file-by-file guide, see [`docs/FILE-REFERENCE.md`](docs/FILE-REFERENCE.md).

## Security model

- Never commit `Credentials/.env` or any decrypted credential output.
- Keep encryption passwords outside GitHub and outside source files.
- Rotate any credential that has been exposed or shared in chat, terminals, logs, or screenshots.
- `Credentials/.env.enc` is encrypted at rest with Fernet and PBKDF2-HMAC-SHA256. It is a backup artifact, not a replacement for local runtime configuration.
- Runtime logs, browser profiles, generated CSVs, and local market-data files are ignored.

See [`docs/SECURITY.md`](docs/SECURITY.md) before deploying or sharing the project.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system boundaries and data flow.
- [`docs/SETUP.md`](docs/SETUP.md) — installation, configuration, and operating procedures.
- [`docs/API.md`](docs/API.md) — backend endpoints grouped by capability.
- [`docs/SECURITY.md`](docs/SECURITY.md) — secrets, encryption, and safe handling.
- [`docs/FILE-REFERENCE.md`](docs/FILE-REFERENCE.md) — folder-by-folder and file-by-file reference.
- [`frontend/README_FRONTEND.md`](frontend/README_FRONTEND.md) — frontend-specific development notes.

## Development principles

1. Preserve trade lineage from source execution to final allocation.
2. Keep credentials outside source control and outside logs.
3. Treat database writes as auditable state transitions.
4. Keep frontend API contracts explicit in `frontend/src/lib/api.ts`.
5. Validate the frontend build and scan staged files before publishing.

## Status

This is a private operational workspace. Validate broker, database, GCS, and Matalia integrations in a controlled environment before using it with production trading or accounting data.
