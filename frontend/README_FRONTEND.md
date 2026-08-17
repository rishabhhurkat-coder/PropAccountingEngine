# Frontend Guide

The frontend is a React + TypeScript operations console built with Vite. It talks to the FastAPI backend and never reads credentials or databases directly.

## Run locally

From the `frontend` directory:

```powershell
npm install
npm run dev -- --host 127.0.0.1 --port 3489
```

Open `http://localhost:3489`.

The API base URL defaults to `http://localhost:8001`. Override it before starting Vite when necessary:

```powershell
$env:VITE_BACKEND_URL = 'http://localhost:8001'
npm run dev -- --host 127.0.0.1 --port 3489
```

## Build and preview

```powershell
npm run build
npm run preview
```

The build runs TypeScript project checks followed by the Vite production build.

## Application areas

- Raw Trade Import — file upload, validation, and pipeline monitoring.
- Instrument Allocation — merge, split, and confirm trade ownership.
- Strategy Master — maintain reusable strategy definitions.
- Trade Book — inspect all, open, and closed trades.
- Positions — refresh current market prices and review open positions.
- Strategy Report — inspect P&L and performance analytics.
- Matalia Charges — fetch and review daily charges.

## Frontend conventions

- Keep API calls in `src/lib/api.ts`.
- Keep shared domain types in `src/types.ts` or the relevant domain module.
- Keep page-level composition in `src/pages/`.
- Keep reusable controls in `src/components/`.
- Keep report-only visuals in `src/components/strategy-report/`.
- Keep global styling in the root CSS files and page-specific styling beside the page.

## Troubleshooting

### The page cannot load data

Confirm the backend is running and that `VITE_BACKEND_URL` points to the correct local API.

### A build fails after dependency changes

Remove and reinstall local dependencies, then rebuild:

```powershell
Remove-Item -Recurse -Force node_modules
npm ci
npm run build
```

### The browser does not open

Navigate manually to the URL printed by Vite. Keep the frontend and backend running in separate terminals.
