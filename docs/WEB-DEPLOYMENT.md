# Prop Trading web deployment

The Prop Trading Engine is published at:

```text
https://hnlsoftware.in/prop-trading-engine/
```

## Deployment layout

```text
hnlsoftware.in/prop-trading-engine/*
  → Prop Trading Cloudflare Pages (`proptradingengine/frontend`)
  → root `edge-router/`
  → dedicated Prop Trading Render API (`proptradingengine/backend`)
```

The Prop backend owns its entry point, session boundary, database and broker
connections, API routes, health endpoint, requirements, environment template,
and Dockerfile. It does not import Email Automation source code.

## Cloudflare Pages

The existing Prop Trading Pages project remains direct-upload based. Cloudflare
does not safely convert that existing project to Git in place, so it is kept as
an upload deployment until a separate migration is deliberately validated.
Build from this folder with:

```text
npm ci && npm run build
```

Use `proptradingengine/frontend` as the Pages root and `dist` as the output.

## Release checks

1. Confirm the dedicated Render service uses `proptradingengine` as its root.
2. Confirm `/health/ready` returns a ready response without authentication.
3. Confirm an unauthenticated trading API request returns `401`.
4. Confirm Prop login and authenticated trade data requests work through
   `/prop-trading-engine/api/*`.
5. Confirm the root Worker is the only active public router.
