# H&L Prop Trading Engine

> A focused trading operations workspace for accounting, allocation, reporting, live positions, and broker connectivity.

<p>
  <a href="https://hnlsoftware.in/prop-trading-engine/"><strong>Open the live product</strong></a> ·
  <a href="https://github.com/rishabhhurkat-coder"><strong>Connect with Rishabh</strong></a> ·
  <a href="https://hnlsoftware.in/contact"><strong>Discuss a project</strong></a>
</p>

The H&L Prop Trading Engine is a product-focused system for turning trading activity into a clear, operational view of positions, allocations, performance, and reporting. It is designed as an independent deployable product within the wider H&L Software portfolio.

## Why this project matters

Trading workflows become difficult to operate when execution data, account allocation, live positions, and reporting are spread across disconnected tools. This project brings those workflows together behind a structured frontend and a dedicated FastAPI backend.

## Product capabilities

- Trade accounting, allocation, and strategy reporting
- Live positions, market prices, and CMP updates
- Broker and external-service connection workflows
- Protected user sessions and product-owned authentication
- Dedicated API health checks and deployment configuration
- A responsive React interface built for day-to-day operations

## Architecture

```text
Browser
  └── React + TypeScript frontend
        └── FastAPI backend
              ├── Trading and accounting workflows
              ├── Broker and external connections
              ├── Database and storage integrations
              └── Authentication and health checks
```

The product is intentionally isolated from H&L Email Automation. Shared public routing is handled by the main H&L integration repository, while this repository remains a complete product-level codebase.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| Backend | Python, FastAPI |
| Integrations | Broker APIs, database, object storage |
| Deployment | Cloudflare Pages and Render-compatible services |

## Repository structure

```text
backend/       FastAPI API, integrations, migrations, and tests
frontend/      React application and product interface
docs/          Architecture, security, setup, and deployment notes
Dockerfile     Backend container definition
```

## Run locally

### Backend

```powershell
cd backend
py -m pip install -r requirements.txt
py -m uvicorn main:app --reload --host 127.0.0.1 --port 8001
```

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

Use the environment examples as a starting point. Never commit real credentials, decrypted configuration, API tokens, or private runtime values.

## Project status

The product is actively evolving as part of the H&L Software portfolio. Deployment and operational notes are maintained in [`docs/`](docs/).

## Connect and collaborate

Are you building a trading workflow, internal operations platform, or data-heavy product? I’m open to thoughtful conversations about product engineering, automation, and practical systems design.

- **Founder and builder:** [Rishabh Hurkat](https://github.com/rishabhhurkat-coder)
- **H&L Software:** [hnlsoftware.in](https://hnlsoftware.in)
- **Project inquiries:** [Use the H&L contact page](https://hnlsoftware.in/contact)
- **Technical discussion:** [Open a GitHub issue](https://github.com/rishabhhurkat-coder/PropAccountingEngine/issues)

## License

Copyright © 2026 H&L Software. All rights reserved. This public repository is presented as a product and engineering portfolio; contact the author before reusing production code or assets.
