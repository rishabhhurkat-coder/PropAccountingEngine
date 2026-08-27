# Complete File Reference

This document explains the repository folder by folder and file by file. Generated runtime data and dependencies are intentionally excluded from the published tree.

## Root

| File | Responsibility |
| --- | --- |
| `README.md` | Product overview, quick start, repository map, security summary, and documentation index. |
| `.gitignore` | Excludes credentials, decrypted outputs, logs, browser data, dependencies, build output, caches, and local data. |
| `Dockerfile` | Dedicated Prop backend container and start command. |

## `backend/`

| File | Responsibility |
| --- | --- |
| `__init__.py` | Marks `backend` as a Python package. |
| `00_Txtconverter.py` | Converts broker order-book text into user/date-scoped files for downstream ingestion. |
| `01_Txt_DB.py` | Parses TXT trade files, normalises fields, creates the raw-trade table, and upserts rows. |
| `02_RawTxtData.py` | Orchestrates raw TXT ingestion through the external database connection. |
| `03_MergeTrades.py` | Reviews and merges compatible executions into logical trades using weighted-average pricing. |
| `04_Split_Trades.py` | Splits logical trades by quantity and writes the resulting child records. |
| `05_Strategy_Allocation.py` | Provides the accounting workflow for strategy setup, merge/split processing, positions, and allocation persistence. |
| `06_Strategy_Master.py` | Maintains strategy master data, account configuration, and expiry calculations. |
| `07_DashBoard.py` | Builds dashboard aggregates such as P&L, drawdown, win rate, and strategy statistics. |
| `08_Matalia_Reports.py` | Fetches and parses Matalia/Jobber charge reports, exposes charge endpoints, and persists daily rows. |
| `09_External_Connections.py` | Centralises Supabase, GCS, Zerodha, instrument resolution, price refresh, and streaming connections. |
| `10_LivePositions.py` | Exposes live-price and open-position endpoints and coordinates CMP updates. |
| `main.py` | FastAPI application entry point, route registration, pipeline orchestration, trade-book endpoints, allocation endpoints, and response shaping. |
| `start_matalia.ps1` | Windows desktop launcher with branded progress UI and local service startup logic. |
| `requirements.txt` | Prop backend dependencies for integrations, parsing, browser automation, and data processing. |
| `.env.example` | Blank configuration template documenting Supabase, GCS, Zerodha, and Jobber variables. |

### Backend naming convention

The numbered modules reflect the original accounting workflow order. `main.py` dynamically imports them because Python cannot use a normal import statement for module names beginning with digits.

## `frontend/`

| File | Responsibility |
| --- | --- |
| `index.html` | Vite HTML shell. |
| `package.json` | Frontend scripts and dependency manifest. |
| `package-lock.json` | Locked npm dependency graph. |
| `tsconfig.json` | TypeScript project/build configuration. |
| `vite.config.ts` | Vite and React plugin configuration. |
| `README_FRONTEND.md` | Frontend development and troubleshooting guide. |

### `frontend/src/`

| File | Responsibility |
| --- | --- |
| `main.tsx` | React bootstrap, global style imports, page selection, and application shell mounting. |
| `types.ts` | Shared frontend types for imported files, raw trades, validation, and workflow stages. |
| `styles.css` | Global workspace layout, typography, navigation, tables, cards, workflow blocks, and responsive styling. |
| `layout-overrides.css` | Layout-specific visual refinements. |
| `allocation.css` | Base instrument-allocation styling. |
| `allocation-overrides.css` | Instrument-allocation overrides and polish. |
| `trade-book.css` | Base trade-book styling. |
| `trade-book-overrides.css` | Trade-book visual overrides. |
| `trade-book-sort.css` | Sorting and table-state styling. |
| `trade-book-feedback.css` | Trade-book feedback and status styling. |
| `raw-trade-import-overrides.css` | Raw-import page overrides. |
| `strategy-report.css` | Strategy-report page styling. |
| `positions.css` | Positions-page styling. |
| `positions-allocation-match.css` | Cross-page position/allocation match styling. |
| `vite-env.d.ts` | Vite environment type declarations. |

### `frontend/src/assets/`

| File | Responsibility |
| --- | --- |
| `hl-logo.png` | Product/brand artwork used by the workflow UI. |

### `frontend/src/layouts/`

| File | Responsibility |
| --- | --- |
| `AppLayout.tsx` | Shared application frame and page layout. |

### `frontend/src/lib/`

| File | Responsibility |
| --- | --- |
| `api.ts` | Typed API base URL, request helper, endpoint functions, and response types. |
| `router.tsx` | Lightweight pathname navigation and `NavLink` helpers. |
| `tradeBook.ts` | Trade-book tabs, views, and shared trade-book domain types. |

### `frontend/src/components/`

| File | Responsibility |
| --- | --- |
| `Calendar.tsx` | Reusable date selection control. |
| `PipelineUI.tsx` | Sidebar, workflow timeline, file cards, buttons, and pipeline status UI. |
| `RawTradesTable.tsx` | Raw trade table with filtering and operator-facing row display. |
| `TradeBookHeader.tsx` | Trade-book heading, date context, and header actions. |
| `TradeBookTabs.tsx` | All/open/closed trade-book navigation. |
| `TradeBookFilters.tsx` | Trade-book search and filter controls. |
| `TradeBookTable.tsx` | Sortable trade-book table and row actions. |
| `TradeBookPagination.tsx` | Page navigation and page-size control. |
| `TradeBookKpiCards.tsx` | Trade-book summary KPI cards. |
| `TradeBookBottomSummary.tsx` | Trade-book totals and bottom summary metrics. |

### `frontend/src/components/strategy-report/`

| File | Responsibility |
| --- | --- |
| `report-data.ts` | Report data types, context, formatting, and empty-state data. |
| `report-card.tsx` | Shared report card container. |
| `report-header.tsx` | Report date/filter header and loading controls. |
| `stat-cards.tsx` | Headline report statistics. |
| `pnl-trend-chart.tsx` | P&L trend visualisation. |
| `pnl-contribution-chart.tsx` | Strategy contribution visualisation. |
| `winning-losing-gauge.tsx` | Win/loss gauge. |
| `distribution-charts.tsx` | Distribution and profit-factor charts. |
| `monthly-heatmap.tsx` | Monthly performance heatmap. |
| `timing-charts.tsx` | Day-of-week and time-of-day analysis. |
| `strategy-table.tsx` | Strategy-level report table. |

### `frontend/src/pages/`

| File | Responsibility |
| --- | --- |
| `01_RawTxtData.tsx` | Raw import workflow page. |
| `InstrumentAllocation.tsx` | Merge, split, and allocation workspace. |
| `StrategyAllocation.tsx` | Strategy setup and allocation workflow. |
| `Strategy.tsx` | Strategy master management page. |
| `TradeBook.tsx` | Trade-book page. |
| `Positions.tsx` | Open positions and live CMP page. |
| `StrategyReport.tsx` | Strategy analytics page composed from report components. |
| `MataliaCharges.tsx` | Matalia charge retrieval and review page. |
| `matalia-charges.css` | Base charges-page styling. |
| `matalia-charges-overrides.css` | Charges-page visual overrides. |

### `frontend/src/data/`

| File | Responsibility |
| --- | --- |
| `tradeBookDummyData.ts` | Local UI fallback/demo data for trade-book presentation states. |

## Ignored runtime directories

These directories may exist locally but are not part of the published source tree:

- `backend/__pycache__/` — Python bytecode.
- `frontend/node_modules/` — installed npm dependencies.
- `frontend/dist/` and `.vite/` — frontend build/cache output.
- `Other Logs/` — runtime logs, browser profiles, CSV exports, and selected input files.
