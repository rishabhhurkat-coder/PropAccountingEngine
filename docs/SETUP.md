# Setup and Operations

## Prerequisites

- Windows PowerShell.
- Python 3.11+ recommended.
- Node.js 18+ and npm.
- Access to the configured Supabase/PostgreSQL database.
- Access to GCS, Zerodha, and Matalia credentials when those features are used.

## Python environment

From the repository root:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
py -m pip install --upgrade pip
py -m pip install -r Credentials\requirements.txt
py -m playwright install
```

If PowerShell blocks activation, use the Python executable directly:

```powershell
.venv\Scripts\python.exe -m pip install -r Credentials\requirements.txt
```

## Environment configuration

```powershell
Copy-Item Credentials\.env.example Credentials\.env
```

Required values depend on the feature being used. The main groups are:

- `SUPABASE_*` — PostgreSQL connection.
- `GCS_*` — service-account JSON and bucket configuration.
- `ZERODHA_*` — Kite API, access token, instruments, and retry settings.
- `JOBBER_*` — Matalia/Jobber report access and exchange configuration.

Do not place secrets in Python defaults, frontend code, screenshots, log messages, or Markdown files.

## Start services manually

Backend:

```powershell
py -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8001
```

Frontend:

```powershell
Set-Location frontend
npm install
npm run dev -- --host 127.0.0.1 --port 3489
```

Frontend build:

```powershell
npm run build
```

## Start services with the Windows launcher

`backend/start_matalia.ps1` is the desktop-oriented launcher. It creates the runtime directory, presents a branded progress window, and coordinates the local environment. It expects the repository layout to remain intact.

`Matalia.vbs` is a convenience entry point for launching the PowerShell experience without opening a visible console first.

## Operating sequence

1. Start the backend.
2. Start the frontend.
3. Open Raw Trade Import.
4. Upload and validate the source TXT file.
5. Review merge and split candidates.
6. Confirm strategy allocation.
7. Review Trade Book and Positions.
8. Refresh Zerodha prices when required.
9. Run Matalia Charges retrieval for missing dates.
10. Review Strategy Report outputs.

## Troubleshooting

### Backend cannot connect

Confirm `Credentials/.env`, PostgreSQL reachability, SSL mode, and that the selected Python environment contains the dependencies.

### Frontend shows network errors

Confirm the backend is listening on port `8001`. To use another port, set `VITE_BACKEND_URL` before starting Vite.

### Zerodha prices are unavailable

Check API credentials, access-token freshness, instrument data, and the `/api/zerodha/status` response.

### Matalia report fetch is waiting

The flow may require CAPTCHA input. Keep the browser automation dependencies installed and complete the CAPTCHA in the frontend when prompted.

### Port conflict

Start Vite on another local port and keep the backend CORS origin local. Example:

```powershell
npm run dev -- --host 127.0.0.1 --port 3490
```
