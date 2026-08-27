# H&L Prop Trading Engine

This folder contains the Prop Trading Engine frontend and its dedicated
FastAPI backend. The backend owns trade accounting, allocation, reporting,
Matalia, Zerodha, live positions, database connections, and authentication.
It does not import Email Automation source code.

## Product routes

```text
https://hnlsoftware.in/prop-trading-engine/
https://hnlsoftware.in/prop-trading-engine/api/*
```

The root `edge-router/` forwards browser API requests to the dedicated Prop
Render service. The standalone backend can also be run locally:

```powershell
Set-Location backend
py -m pip install -r requirements.txt
py -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8001
```

## Backend ownership

- `backend/main.py` — FastAPI entry point, protected trading routes, login,
  logout, and health endpoints.
- `backend/auth.py` — Prop-owned session authentication.
- `backend/connections.py` — public Zerodha connection and OAuth callback API.
- `backend/09_External_Connections.py` — database, GCS, and Zerodha services.
- `backend/10_LivePositions.py` — live prices, positions, and CMP updates.
- `backend/requirements.txt` — Prop backend dependencies.
- `backend/.env.example` — Prop backend environment template.
- `Dockerfile` — dedicated container and start command.

## Frontend deployment

The frontend uses `/prop-trading-engine/` as its Vite base path. Production
API calls stay on the public domain through the root Worker. The existing
Cloudflare Pages project remains direct-upload based until a safe Git
migration is separately validated.
