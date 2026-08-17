# Backend API Reference

The API is served by `backend.main:app`. Unless configured otherwise, the local base URL is `http://localhost:8001`.

## Import and pipeline

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/raw-trades/import` | Upload a raw trade file. |
| `POST` | `/api/pipeline/import` | Run the import pipeline. |
| `GET` | `/api/pipeline/import/log` | Read the pipeline log tail. |
| `GET` | `/api/rawtxtdata` | Load raw trade data and validation state. |

## Trade book and allocation

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/trade-book?view=all\|open\|closed` | Load trade-book rows. |
| `DELETE` | `/api/trade-book/{trade_id}` | Delete a trade family. |
| `GET` | `/api/strategy-allocation` | Load strategy allocation rows. |
| `POST` | `/api/instrument-allocation/merge-candidates` | Find merge candidates. |
| `POST` | `/api/instrument-allocation/merge` | Confirm a merge. |
| `POST` | `/api/instrument-allocation/split` | Split a merged trade. |
| `POST` | `/api/instrument-allocation/confirm` | Confirm strategy allocations. |

## Strategy master

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/strategy-master` | Load strategy definitions. |
| `POST` | `/api/strategy-master` | Save strategy configuration. |
| `DELETE` | `/api/strategy-master` | Delete strategy configuration. |
| `POST` | `/api/strategy-master/next-expiry` | Calculate the next expiry. |

## Reporting and charges

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/strategy-report` | Load report aggregates. |
| `GET` | `/api/matalia-charges` | Load stored charge rows. |
| `GET` | `/api/matalia-charges/next-date` | Find the next missing charge date. |
| `POST` | `/api/matalia-charges/fetch/start` | Start a report fetch. |
| `GET` | `/api/matalia-charges/fetch/status` | Read fetch status. |
| `GET` | `/api/matalia-charges/fetch/captcha` | Get the current CAPTCHA image. |
| `POST` | `/api/matalia-charges/fetch/captcha` | Submit CAPTCHA input. |
| `POST` | `/api/matalia-charges/fetch/cancel` | Cancel a running fetch. |

## Zerodha and positions

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/zerodha/refresh-prices` | Refresh current prices once. |
| `POST` | `/api/zerodha/start-live-prices` | Start live-price processing. |
| `GET` | `/api/zerodha/status` | Read broker connection status. |
| `GET` | `/api/zerodha/login-url` | Generate the login URL. |
| `POST` | `/api/zerodha/token` | Complete token exchange. |
| `GET` | `/api/zerodha/live-prices` | Read current live-price state. |
| `POST` | `/api/positions/update-cmp` | Persist CMP values for open trades. |

## API conventions

- JSON responses are returned through FastAPI response models or JSON responses.
- Upload endpoints use multipart form data.
- Date filters use ISO-like date strings accepted by the backend parsers.
- Errors should be treated as operator-visible state; inspect the response body and runtime log rather than retrying blindly.
