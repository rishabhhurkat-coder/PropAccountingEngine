from __future__ import annotations

from datetime import date, datetime
import importlib
import logging
import os
import re
import subprocess
import sys
import threading
from time import perf_counter
from pathlib import Path
from typing import Any

import pandas as pd

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from backend.auth import authenticate, create_session, require_user, revoke_session
from backend.connections import router as connections_router
from backend.users import router as users_router
from backend.user_store import ensure_user_schema


logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parent.parent

CONFIRMATION_PROGRESS_LOCK = threading.Lock()
CONFIRMATION_PROGRESS: dict[str, dict[str, Any]] = {}
CONFIRMATION_PROGRESS_MAX_AGE_SECONDS = 15 * 60

CONFIRMATION_TRADE_PROCESS_STEPS = (
    ("source", "Read source trade"),
    ("merge", "Prepare MergeTrades record"),
    ("split", "Prepare SplitTrades record"),
    ("strategy", "Assign Strategy Allocation"),
    ("matching", "Match Entry / Exit"),
    ("recalculate", "Recalculate positions"),
    ("queued", "Queue changes for save"),
)


def _confirmation_progress_update(progress_id: str | None, **updates: Any) -> None:
    if not progress_id:
        return
    with CONFIRMATION_PROGRESS_LOCK:
        state = CONFIRMATION_PROGRESS.get(progress_id)
        if state is None:
            return
        state.update(updates)
        state["updated_at"] = datetime.now().timestamp()


def _confirmation_progress_start(progress_id: str | None, rows: list[StrategyAllocationConfirmationRow]) -> None:
    if not progress_id:
        return
    now = datetime.now().timestamp()
    with CONFIRMATION_PROGRESS_LOCK:
        expired = [
            key for key, state in CONFIRMATION_PROGRESS.items()
            if now - float(state.get("updated_at", now)) > CONFIRMATION_PROGRESS_MAX_AGE_SECONDS
        ]
        for key in expired:
            CONFIRMATION_PROGRESS.pop(key, None)
        CONFIRMATION_PROGRESS[progress_id] = {
            "progress_id": progress_id,
            "status": "running",
            "stage": "preparing",
            "total_rows": len(rows),
            "completed_rows": 0,
            "processed_count": 0,
            "skipped_count": 0,
            "current_index": -1,
            "current_trade": None,
            "row_statuses": ["waiting"] * len(rows),
            "trade_processes": [
                [
                    {"key": key, "label": label, "status": "waiting", "detail": "Waiting to start", "duration_ms": None}
                    for key, label in CONFIRMATION_TRADE_PROCESS_STEPS
                ]
                for _ in rows
            ],
            "current_process": None,
            "message": "Preparing confirmation",
            "error": None,
            "updated_at": now,
        }


def _confirmation_progress_snapshot(progress_id: str) -> dict[str, Any] | None:
    with CONFIRMATION_PROGRESS_LOCK:
        state = CONFIRMATION_PROGRESS.get(progress_id)
        if state is None:
            return None
        snapshot = dict(state)
        snapshot["trade_processes"] = []
        for process_steps in state.get("trade_processes") or []:
            snapshot_steps = []
            for step in process_steps:
                snapshot_step = dict(step)
                started_at = snapshot_step.pop("_started_at", None)
                if snapshot_step.get("status") == "processing" and started_at is not None:
                    snapshot_step["duration_ms"] = round((perf_counter() - float(started_at)) * 1000)
                snapshot_steps.append(snapshot_step)
            snapshot["trade_processes"].append(snapshot_steps)
        return snapshot


def _confirmation_trade_process_update(
    progress_id: str | None,
    trade_index: int,
    step_key: str,
    status: str,
    detail: str,
) -> None:
    if not progress_id:
        return
    with CONFIRMATION_PROGRESS_LOCK:
        state = CONFIRMATION_PROGRESS.get(progress_id)
        if state is None:
            return
        trade_processes = state.get("trade_processes") or []
        if trade_index < 0 or trade_index >= len(trade_processes):
            return
        for step in trade_processes[trade_index]:
            if step.get("key") == step_key:
                if status == "processing" and step.get("_started_at") is None:
                    step["_started_at"] = perf_counter()
                if status == "processing" and step.get("_started_at") is not None:
                    step["duration_ms"] = round((perf_counter() - float(step["_started_at"])) * 1000)
                elif status in {"completed", "skipped", "failed"}:
                    started_at = step.get("_started_at")
                    step["duration_ms"] = round((perf_counter() - float(started_at)) * 1000) if started_at is not None else 0
                step["status"] = status
                step["detail"] = detail
                break
        state["current_process"] = {
            "trade_index": trade_index,
            "step_key": step_key,
            "label": next(
                (label for key, label in CONFIRMATION_TRADE_PROCESS_STEPS if key == step_key),
                step_key,
            ),
            "detail": detail,
        } if status == "processing" else state.get("current_process")
        state["updated_at"] = datetime.now().timestamp()


def _confirmation_trade_label(row: StrategyAllocationConfirmationRow) -> str:
    return (
        f"{row.instrument} {row.expiry} {row.strike}{row.option} · "
        f"{row.side} {row.qty:g} · {row.strategyName}"
    )


load_dotenv(os.getenv("PROP_TRADING_ENGINE_ENV_FILE", "/etc/secrets/prop-trading-engine.env"))
load_dotenv(PROJECT_ROOT / "backend" / ".env")

_external_connections_spec = importlib.util.spec_from_file_location(
    "matalia_external_connections", Path(__file__).with_name("09_External_Connections.py")
)
if _external_connections_spec is None or _external_connections_spec.loader is None:
    raise ImportError("Unable to load backend/09_External_Connections.py")
_external_connections_module = importlib.util.module_from_spec(_external_connections_spec)
sys.modules["matalia_external_connections"] = _external_connections_module
_external_connections_spec.loader.exec_module(_external_connections_module)
connect = _external_connections_module.connect
def _load_numbered_backend_module(filename: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(filename))
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load backend/{filename}")
    module = importlib.util.module_from_spec(spec)
    # Register dynamically loaded modules so Pydantic/FastAPI can resolve
    # postponed annotations when building the OpenAPI schema.
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_matalia_reports_module = _load_numbered_backend_module("08_Matalia_Reports.py", "matalia_reports")
_dashboard_module = _load_numbered_backend_module("07_DashBoard.py", "matalia_dashboard")
_strategy_master_module = _load_numbered_backend_module("06_Strategy_Master.py", "matalia_strategy_master")
_live_positions_module = _load_numbered_backend_module("10_LivePositions.py", "matalia_live_positions")
build_dashboard = _dashboard_module.build_dashboard
delete_strategy_master_rows = _strategy_master_module.delete_strategy_master_rows
ensure_strategy_master_table = _strategy_master_module.ensure_strategy_master_table
invalidate_strategy_master_cache = _strategy_master_module.invalidate_strategy_master_cache
load_strategy_master_rows = _strategy_master_module.load_strategy_master_rows
next_expiries = _strategy_master_module.next_expiries
save_strategy_setup = _strategy_master_module.save_strategy_setup


PIPELINE_LOG_PATH = PROJECT_ROOT / "Other Logs" / "Runtime" / "import_pipeline.log"
SELECTED_TXT_PATH = PROJECT_ROOT / "Other Logs" / "Runtime" / "selected_txt_import.txt"
STAGED_TXT_DIR = PROJECT_ROOT / "Other Logs" / "Runtime" / "selected_txt_import"
PIPELINE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

PIPELINE_STATE: dict[str, Any] = {
    "running": False,
    "stage": "idle",
    "message": "No pipeline run yet. Select one or more TXT files to begin.",
    "started_at": None,
    "finished_at": None,
    "last_run_at": None,
    "return_code": None,
    "failed_step": None,
    "error": None,
    "files": [],
    "failed_files": [],
}
PIPELINE_LOCK = threading.Lock()
# Allocation writes invalidate this cache, so a slightly longer TTL avoids
# rebuilding the full allocation view during normal navigation/reloads.
DATA_CACHE_TTL_SECONDS = 30.0
DATA_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
DATA_VERSION_TABLE = "matalia.data_versions"
DATA_VERSION_LOCK = threading.Lock()
DATA_VERSION_FALLBACK: dict[str, dict[str, Any]] = {
    "allocation": {"version": 1, "updatedAt": datetime.now().astimezone().isoformat(timespec="milliseconds")},
    "strategy_master": {"version": 1, "updatedAt": datetime.now().astimezone().isoformat(timespec="milliseconds")},
}


def _ensure_data_versions_table(conn: Any) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {DATA_VERSION_TABLE} (
            data_key VARCHAR(64) PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    conn.execute(
        f"""
        INSERT INTO {DATA_VERSION_TABLE} (data_key)
        VALUES ('allocation'), ('strategy_master')
        ON CONFLICT (data_key) DO NOTHING
        """
    )


def _touch_data_version(data_key: str) -> None:
    now = datetime.now().astimezone().isoformat(timespec="milliseconds")
    with DATA_VERSION_LOCK:
        current = DATA_VERSION_FALLBACK.setdefault(data_key, {"version": 0, "updatedAt": now})
        current["version"] = int(current["version"]) + 1
        current["updatedAt"] = now
    try:
        with connect() as conn:
            _ensure_data_versions_table(conn)
            conn.execute(
                f"""
                INSERT INTO {DATA_VERSION_TABLE} (data_key, revision, updated_at)
                VALUES (%s, 1, NOW())
                ON CONFLICT (data_key) DO UPDATE
                SET revision = {DATA_VERSION_TABLE}.revision + 1,
                    updated_at = NOW()
                """,
                (data_key,),
            )
    except Exception:
        # The in-process version still protects the active UI if metadata
        # maintenance is temporarily unavailable; the next request retries it.
        return


def _touch_data_version_in_transaction(conn: Any, data_key: str) -> None:
    """Advance a data version using the already-open request transaction.

    Confirmation already owns a database connection and transaction. Keeping
    the version write on that connection avoids opening a second connection
    after the allocation commit while preserving the same invalidation point.
    """
    conn.execute(
        f"""
        INSERT INTO {DATA_VERSION_TABLE} (data_key, revision, updated_at)
        VALUES (%s, 1, NOW())
        ON CONFLICT (data_key) DO UPDATE
        SET revision = {DATA_VERSION_TABLE}.revision + 1,
            updated_at = NOW()
        """,
        (data_key,),
    )


def _record_data_version_fallback(data_key: str) -> None:
    now = datetime.now().astimezone().isoformat(timespec="milliseconds")
    with DATA_VERSION_LOCK:
        current = DATA_VERSION_FALLBACK.setdefault(data_key, {"version": 0, "updatedAt": now})
        current["version"] = int(current["version"]) + 1
        current["updatedAt"] = now


def _read_data_versions(conn: Any) -> dict[str, dict[str, Any]]:
    _ensure_data_versions_table(conn)
    cursor = conn.execute(
        f"SELECT data_key, revision, updated_at FROM {DATA_VERSION_TABLE} ORDER BY data_key"
    )
    versions = {
        str(data_key): {
            "version": int(revision),
            "updatedAt": updated_at.isoformat() if hasattr(updated_at, "isoformat") else str(updated_at),
        }
        for data_key, revision, updated_at in cursor.fetchall()
    }
    with DATA_VERSION_LOCK:
        for key, fallback in DATA_VERSION_FALLBACK.items():
            versions.setdefault(key, dict(fallback))
    return versions


def _invalidate_data_cache() -> None:
    DATA_CACHE.clear()
    _touch_data_version("allocation")


def _cached_data(key: str, loader: Any) -> dict[str, Any]:
    now = datetime.now().timestamp()
    cached = DATA_CACHE.get(key)
    if cached and now - cached[0] < DATA_CACHE_TTL_SECONDS:
        return cached[1]
    value = loader()
    DATA_CACHE[key] = (now, value)
    return value


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginUser(BaseModel):
    id: int
    user_name: str
    user_type: str
    user_class: str | None = None


class LoginResponse(BaseModel):
    token: str
    user: LoginUser


app = FastAPI(title="H&L Prop Trading Engine")


@app.middleware("http")
async def authenticate_api_requests(request: Request, call_next: Any) -> Any:
    """Protect trading APIs while leaving health, login, and Zerodha OAuth public."""
    path = request.url.path
    public = (
        request.method == "OPTIONS"
        or path in {"/health", "/health/ready", "/api/login", "/api/logout"}
        or path.startswith("/api/connections/zerodha/")
    )
    if not public:
        try:
            require_user(request.headers.get("authorization", ""))
        except Exception as error:
            status_code = getattr(error, "status_code", 401)
            detail = getattr(error, "detail", "Please sign in again.")
            return JSONResponse(status_code=status_code, content={"detail": detail})
    return await call_next(request)


@app.on_event("startup")
def initialize_strategy_master_schema() -> None:
    """Create strategy-master schema once when the API process starts."""
    with connect() as conn:
        ensure_user_schema(conn)
        ensure_strategy_master_table(conn)
        _ensure_data_versions_table(conn)
    invalidate_strategy_master_cache()
    _live_positions_module.start_background_live_price_worker()


@app.on_event("shutdown")
def stop_background_workers() -> None:
    _live_positions_module.stop_background_live_price_worker()

_cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:3489,http://127.0.0.1:3489").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    # Production requests use the same H&L origin through the Worker.  The
    # explicit list also supports local Vite development without wildcard CORS.
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(_live_positions_module.router)
app.include_router(_matalia_reports_module.router)
app.include_router(connections_router)
app.include_router(users_router)


@app.post("/api/login", response_model=LoginResponse)
def login(payload: LoginRequest) -> LoginResponse:
    user = authenticate(payload.username, payload.password)
    if user is None:
        return JSONResponse(status_code=401, content={"detail": "Invalid username or password."})
    token = create_session(user)
    return LoginResponse(token=token, user=LoginUser(**user))


@app.post("/api/logout")
def logout(request: Request) -> dict[str, str]:
    revoke_session(request.headers.get("authorization", ""))
    return {"status": "logged_out"}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
def readiness() -> dict[str, str]:
    """Verify the Prop backend process and its database connection are ready."""
    try:
        with connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
    except Exception as error:
        raise HTTPException(status_code=503, detail="Database is not ready.") from error
    return {"status": "ready", "database": "ok"}


TRADE_BOOK_TABLES: dict[str, str] = {
    "All Trades": "strategy_allocation",
    "Open Trades": "strategy_open",
    "Closed Trades": "strategy_closed",
}

TRADE_BOOK_VIEW_ALIASES: dict[str, str] = {
    "all": "All Trades",
    "open": "Open Trades",
    "closed": "Closed Trades",
}

STRATEGY_ALLOCATION_SOURCE_ROWS = "01RawTxtData"
STRATEGY_ALLOCATION_LEDGER_COLUMNS = [
    "allocation_id",
    "position_id",
    "trade_date",
    "trade_minute",
    "instrument_id",
    "scrip",
    "expiry",
    "strike",
    "option_type",
    "trade_type",
    "split_sequence",
    "quantity",
    "account",
    "strategy",
    "trade_action",
]
POSITION_SEQUENCE = "matalia.strategy_allocation_position_seq"


class StrategyAllocationConfirmationRow(BaseModel):
    tradeId: str
    source: str
    sourceId: str
    splitTradeId: str | None = None
    instrument: str
    expiry: str
    strike: str
    option: str
    side: str
    qty: float
    price: float
    strategyName: str


class StrategyAllocationConfirmationRequest(BaseModel):
    rows: list[StrategyAllocationConfirmationRow]
    progressId: str | None = None


class StrategySetupAccount(BaseModel):
    name: str
    qty: float


class StrategySetupRequest(BaseModel):
    mappingId: int | None = None
    originalStrategyName: str | None = None
    strategyName: str
    expiries: list[str]
    instrument: str
    parentQty: float
    splitRequired: bool
    splitMethod: str = "Quantity"
    accounts: list[StrategySetupAccount] = []


class StrategyDeleteRequest(BaseModel):
    mappingId: int | None = None
    strategyName: str = ""


class StrategyNextExpiryRequest(BaseModel):
    expiries: list[str]


class SplitTradeRequest(BaseModel):
    raw_trade_id: int | None = None
    split_trade_id: int | None = None
    original_qty: float | None = None
    quantities: list[float] = []
    # Kept temporarily for already-processed split records that use the
    # existing re-split endpoint path.
    source: str = ""
    sourceId: str = ""
    tradeId: str = ""
    originalQty: float | None = None


class MergeCandidatesRequest(BaseModel):
    source: str
    sourceId: str
    tradeId: str


class MergeTradesRequest(BaseModel):
    raw_trade_ids: list[int]


def _load_split_trade_module():
    backend_path = str(PROJECT_ROOT / "backend")
    if backend_path not in sys.path:
        sys.path.insert(0, backend_path)
    return importlib.import_module("04_Split_Trades")


def _load_merge_trade_module():
    backend_path = str(PROJECT_ROOT / "backend")
    if backend_path not in sys.path:
        sys.path.insert(0, backend_path)
    return importlib.import_module("03_MergeTrades")


def _timestamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _write_log_line(message: str) -> None:
    PIPELINE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with PIPELINE_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{message}\n")


def _reset_log() -> None:
    PIPELINE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    PIPELINE_LOG_PATH.write_text("", encoding="utf-8")


def _read_log_tail(limit: int = 120) -> list[str]:
    if not PIPELINE_LOG_PATH.exists():
        return []
    lines = PIPELINE_LOG_PATH.read_text(encoding="utf-8").splitlines()
    return lines[-limit:]


def _parse_import_file_results(log: list[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for line in log:
        marker = "IMPORT_FILE|"
        if marker not in line:
            continue
        fields: dict[str, Any] = {}
        for part in line.split(marker, 1)[1].split("|"):
            key, separator, value = part.partition("=")
            if not separator:
                continue
            fields[key] = value
        if not fields.get("name"):
            continue
        try:
            fields["records"] = int(fields.get("records") or 0)
        except (TypeError, ValueError):
            fields["records"] = 0
        results.append(fields)
    return results


def _format_import_failure(results: list[dict[str, Any]], fallback: str) -> str:
    failed = [result for result in results if result.get("status") == "failed"]
    if not failed:
        return fallback
    details = "; ".join(
        f"{result.get('name')} — date: {result.get('date') or 'not found'} — {result.get('reason') or 'unknown reason'}"
        for result in failed
    )
    return f"Import failed for {len(failed)} file(s): {details}"


def _staged_txt_files() -> list[Path]:
    """Return the TXT files currently staged for the next pipeline run.

    New uploads are stored in ``selected_txt_import`` so multiple files can
    be processed together.  The legacy single-file path is retained as a
    fallback for older local workflows.
    """
    staged = sorted(STAGED_TXT_DIR.glob("*.txt")) if STAGED_TXT_DIR.is_dir() else []
    return staged or ([SELECTED_TXT_PATH] if SELECTED_TXT_PATH.is_file() else [])


@app.post("/api/raw-trades/import")
async def upload_raw_trade_file(files: list[UploadFile] = File(..., alias="file")) -> JSONResponse:
    """Stage a copy of the user-selected TXT for the import pipeline.

    The browser uploads a copy, so the original file on the user's computer
    is never renamed, moved, or modified by the backend.
    """
    if not files:
        return JSONResponse(status_code=400, content={"message": "Select at least one .txt file."})

    staged_files: list[dict[str, Any]] = []
    STAGED_TXT_DIR.mkdir(parents=True, exist_ok=True)
    for old_file in STAGED_TXT_DIR.glob("*.txt"):
        old_file.unlink(missing_ok=True)
    SELECTED_TXT_PATH.unlink(missing_ok=True)

    for index, file in enumerate(files):
        filename = Path(file.filename or "").name
        if not filename.lower().endswith(".txt"):
            return JSONResponse(status_code=400, content={"message": f"{filename or 'A selected file'} is not a .txt file."})
        content = await file.read()
        if not content.strip():
            return JSONResponse(status_code=400, content={"message": f"{filename} is empty."})
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", filename).strip("._") or f"trade_{index + 1}.txt"
        if not safe_name.lower().endswith(".txt"):
            safe_name += ".txt"
        (STAGED_TXT_DIR / f"{index:04d}_{safe_name}").write_bytes(content)
        line_count = max(0, len(content.decode("utf-8", errors="ignore").splitlines()) - 1)
        staged_files.append({
            "id": f"{datetime.now().timestamp()}-{index}",
            "name": filename,
            "tradeDate": "",
            "broker": "",
            "records": line_count,
            "importedAt": datetime.now().strftime("%I:%M %p"),
            "status": "ready",
        })
    _set_pipeline_state(
        running=False,
        stage="files",
        message=f"{len(staged_files)} TXT file(s) uploaded and ready to run.",
        started_at=None,
        finished_at=None,
        return_code=None,
        failed_step=None,
        error=None,
        files=staged_files,
        failed_files=[],
    )
    return JSONResponse(
        status_code=200,
        content={"files": staged_files, "message": f"{len(staged_files)} TXT file(s) uploaded and ready for processing."},
    )


@app.get("/api/raw-trades/import")
def list_staged_trade_files() -> JSONResponse:
    files: list[dict[str, Any]] = []
    if STAGED_TXT_DIR.is_dir():
        for path in sorted(STAGED_TXT_DIR.glob("*.txt")):
            files.append({
                "id": path.name,
                "name": re.sub(r"^\d{4}_", "", path.name),
                "tradeDate": "",
                "broker": "",
                "records": max(0, len(path.read_text(encoding="utf-8", errors="ignore").splitlines()) - 1),
                "importedAt": datetime.fromtimestamp(path.stat().st_mtime).strftime("%I:%M %p"),
                "status": "ready",
            })
    return JSONResponse(status_code=200, content={"files": files})


def _normalize_trade_tab(value: str | None) -> str:
    if not value:
        return "All Trades"
    return TRADE_BOOK_VIEW_ALIASES.get(value.strip().lower(), value)


def _normalize_time(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if "." in text and ":" not in text:
        return text.replace(".", ":", 1)
    return text


def _format_trade_date(value: Any) -> str:
    if isinstance(value, date):
        return value.strftime("%d %b %Y")
    if value is None:
        return ""
    return str(value)


def _format_trade_expiry(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if re.fullmatch(r"\d{2}[A-Za-z]{3}\d{4}", text):
        try:
            parsed = datetime.strptime(text.title(), "%d%b%Y")
            return parsed.strftime("%d-%b-%y")
        except ValueError:
            return text
    if re.fullmatch(r"\d{2}-[A-Za-z]{3}-\d{2}", text):
        try:
            parsed = datetime.strptime(text.title(), "%d-%b-%y")
            return parsed.strftime("%d-%b-%y")
        except ValueError:
            return text
    return text


def _normalize_compact_expiry_text(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"[-\s]", "", text).upper()
    return text


def _normalize_strategy_expiry(value: Any) -> str:
    """Return strategy and trade expiries in one comparable canonical form."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()

    text = str(value).strip()
    if not text:
        return ""
    for fmt in ("%d-%b-%y", "%d-%b-%Y", "%d%b%y", "%d%b%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text.title(), fmt).date().isoformat()
        except ValueError:
            continue
    return _normalize_compact_expiry_text(text)


def get_next_position_id(conn: Any) -> int:
    row = conn.execute(f"SELECT nextval('{POSITION_SEQUENCE}')").fetchone()
    return int(row[0])


def _load_strategy_allocation_ledger(conn: Any) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT
            allocation_id,
            position_id,
            trade_date,
            trade_minute,
            instrument_id,
            scrip,
            expiry,
            strike,
            option_type,
            trade_type,
            split_sequence,
            quantity,
            account,
            strategy,
            trade_action
        FROM matalia.strategy_allocation
        ORDER BY trade_date, trade_minute, allocation_id
        """,
        conn,
    )


def _confirmation_expiry_variants(value: Any) -> list[str]:
    normalized = _normalize_strategy_expiry(value)
    variants = {re.sub(r"[-\s]", "", str(value or "")).upper()}
    if normalized:
        try:
            parsed = date.fromisoformat(normalized)
            variants.update({
                parsed.strftime("%d%b%y").upper(),
                parsed.strftime("%d%b%Y").upper(),
                parsed.strftime("%Y%m%d").upper(),
            })
        except ValueError:
            pass
    return sorted(variant for variant in variants if variant)


def _load_confirmation_position_ledger(
    conn: Any,
    rows: list[StrategyAllocationConfirmationRow],
) -> pd.DataFrame:
    raw_rows = [row for row in rows if row.source.strip() == STRATEGY_ALLOCATION_SOURCE_ROWS]
    if not raw_rows:
        return pd.DataFrame(columns=STRATEGY_ALLOCATION_LEDGER_COLUMNS)

    strategies = sorted({row.strategyName.strip() for row in raw_rows if row.strategyName.strip()})
    contract_clauses: list[str] = []
    contract_params: list[Any] = []
    for row in raw_rows:
        strike_value = str(row.strike or "").strip()
        if not row.instrument.strip() or not row.option.strip() or not row.expiry.strip() or not strike_value:
            continue
        strike_variants = sorted({strike_value, _format_trade_number(row.strike), f"{_format_trade_amount(row.strike):g}"})
        contract_clauses.append(
            "(BTRIM(UPPER(scrip::text)) = %s "
            "AND BTRIM(UPPER(option_type::text)) = %s "
            "AND BTRIM(strike::text) = ANY(%s) "
            "AND REPLACE(UPPER(expiry::text), '-', '') = ANY(%s))"
        )
        contract_params.extend([
            row.instrument.strip().upper(),
            row.option.strip().upper(),
            strike_variants,
            _confirmation_expiry_variants(row.expiry),
        ])

    if not strategies or not contract_clauses:
        return pd.DataFrame(columns=STRATEGY_ALLOCATION_LEDGER_COLUMNS)

    cursor = conn.execute(
        f"""
        SELECT
            allocation_id,
            position_id,
            trade_date,
            trade_minute,
            instrument_id,
            scrip,
            expiry,
            strike,
            option_type,
            trade_type,
            split_sequence,
            quantity,
            account,
            strategy,
            trade_action
        FROM matalia.strategy_allocation
        WHERE trade_action IN ('Entry', 'Exit')
          AND BTRIM(strategy) = ANY(%s)
          AND ({' OR '.join(contract_clauses)})
        ORDER BY trade_date, trade_minute, allocation_id
        """,
        [strategies, *contract_params],
    )
    records = cursor.fetchall()
    return pd.DataFrame.from_records(records, columns=STRATEGY_ALLOCATION_LEDGER_COLUMNS)


def _build_open_positions(allocation_df: pd.DataFrame) -> dict[str, list[dict[str, Any]]]:
    if allocation_df is None or allocation_df.empty:
        return {}

    entry_rows = allocation_df[allocation_df["trade_action"] == "Entry"].copy()
    exit_rows = allocation_df[allocation_df["trade_action"] == "Exit"].copy()
    exits_by_position = {
        str(position_id): rows
        for position_id, rows in exit_rows.groupby("position_id", sort=False)
    }

    positions: dict[str, list[dict[str, Any]]] = {}
    for position_id, rows in entry_rows.groupby("position_id", sort=False):
        position_key = str(position_id)
        remaining = rows.sort_values("split_sequence").to_dict("records")
        matching_exits = exits_by_position.get(position_key)
        if matching_exits is None:
            matching_exits = exit_rows.iloc[0:0]
        for _, exit_row in matching_exits.iterrows():
            exit_qty = _format_trade_amount(exit_row.get("quantity"))
            for entry in remaining:
                if exit_qty <= 0:
                    break
                if str(entry.get("strategy") or "").strip() != str(exit_row.get("strategy") or "").strip():
                    continue
                if not _same_trade_contract(entry, exit_row):
                    continue
                if _trade_side_from_type(entry.get("trade_type")) == _trade_side_from_type(exit_row.get("trade_type")):
                    continue
                entry_qty = _format_trade_amount(entry.get("quantity"))
                if abs(entry_qty - exit_qty) > 1e-6:
                    continue
                exit_qty -= entry_qty
                entry["quantity"] = 0
            remaining = [entry for entry in remaining if _format_trade_amount(entry.get("quantity")) > 1e-6]
        if remaining:
            positions[position_key] = remaining

    return positions


class PositionManager:
    def __init__(self, positions: dict[str, list[dict[str, Any]]] | None = None):
        self._positions = positions or {}

    @classmethod
    def from_allocation_table(cls, allocation_df: pd.DataFrame):
        return cls(_build_open_positions(allocation_df))

    def get_open_positions(self, account: Any = None, instrument_id: Any = None):
        available: dict[str, list[dict[str, Any]]] = {}
        for position_id, rows in self._positions.items():
            filtered_rows = rows
            if account is not None:
                filtered_rows = [row for row in filtered_rows if row.get("account") == account]
            if instrument_id is not None:
                filtered_rows = [row for row in filtered_rows if row.get("instrument_id") == instrument_id]
            if filtered_rows:
                available[position_id] = filtered_rows
        return available

    def get_position(self, position_id: Any):
        return self._positions.get(str(position_id))

    def add_entry(self, entry_records: list[dict[str, Any]]):
        if not entry_records:
            return
        position_id = str(entry_records[0]["position_id"])
        self._positions.setdefault(position_id, []).extend(entry_records)

    def close_position(self, position_id: Any, allocation_id: Any = None):
        position_key = str(position_id)
        rows = self._positions.get(position_key, [])
        if allocation_id is None:
            return self._positions.pop(position_key, None)
        remaining = [row for row in rows if str(row.get("allocation_id")) != str(allocation_id)]
        if remaining:
            self._positions[position_key] = remaining
        else:
            self._positions.pop(position_key, None)
        return rows

    def replace_contract_rows(self, rows: list[dict[str, Any]]) -> None:
        """Refresh one strategy/contract in memory without reloading the ledger."""
        if not rows:
            return

        strategy_names = {
            str(row.get("strategy") or "").strip().casefold()
            for row in rows
        }

        for position_id in list(self._positions):
            remaining = [
                entry
                for entry in self._positions[position_id]
                if not (
                    str(entry.get("strategy") or "").strip().casefold() in strategy_names
                    and any(_same_trade_contract(entry, row) for row in rows)
                )
            ]
            if remaining:
                self._positions[position_id] = remaining
            else:
                self._positions.pop(position_id, None)

        for row in rows:
            if str(row.get("trade_action") or "").strip().casefold() != "entry":
                continue
            self.add_entry([row])

    def find_matching_position(self, split_row: dict[str, Any], strategy_name: str):
        requested_side = _trade_side_from_type(split_row.get("trade_type"))
        requested_qty = _format_trade_amount(split_row.get("quantity"))
        requested_expiry = _normalize_strategy_expiry(split_row.get("expiry"))
        for position_id, rows in self._positions.items():
            for entry in rows:
                if str(entry.get("strategy") or "").strip() != str(strategy_name or "").strip():
                    continue
                if entry.get("account") != split_row.get("account"):
                    continue
                if entry.get("instrument_id") != split_row.get("instrument_id"):
                    continue
                if str(entry.get("scrip") or "").strip().upper() != str(split_row.get("scrip") or "").strip().upper():
                    continue
                if _normalize_strategy_expiry(entry.get("expiry")) != requested_expiry:
                    continue
                if str(entry.get("strike") or "") != str(split_row.get("strike") or ""):
                    continue
                if str(entry.get("option_type") or "").strip().upper() != str(split_row.get("option_type") or "").strip().upper():
                    continue
                if _trade_side_from_type(entry.get("trade_type")) == requested_side:
                    continue
                if abs(_format_trade_amount(entry.get("quantity")) - requested_qty) > 1e-6:
                    continue
                return str(position_id), entry
        return None


def _format_trade_number(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (int, float)):
        return f"{value:g}"
    return str(value)


def _format_trade_amount(value: Any) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _trade_side_from_type(trade_type: Any) -> str:
    return "BUY" if str(trade_type).strip().upper() == "B" else "SELL"


def _same_confirmation_number(left: Any, right: Any, tolerance: float = 0.02) -> bool:
    try:
        return abs(float(left or 0) - float(right or 0)) <= tolerance
    except (TypeError, ValueError):
        return False


def _confirmation_row_matches_contract(
    row: StrategyAllocationConfirmationRow,
    trade_row: dict[str, Any],
    check_quantity: bool = True,
) -> bool:
    """Ensure an ID from the browser still refers to the displayed trade."""
    contract_matches = (
        str(trade_row.get("scrip") or "").strip().upper() == str(row.instrument or "").strip().upper()
        and _normalize_strategy_expiry(trade_row.get("expiry")) == _normalize_strategy_expiry(row.expiry)
        and _same_confirmation_number(trade_row.get("strike"), row.strike)
        and str(trade_row.get("option_type") or "").strip().upper() == str(row.option or "").strip().upper()
        and _trade_side_from_type(trade_row.get("trade_type")) == str(row.side or "").strip().upper()
        and _same_confirmation_number(trade_row.get("average_price"), row.price)
    )
    return contract_matches and (
        not check_quantity or _same_confirmation_number(trade_row.get("quantity"), row.qty, 0.0001)
    )


def _same_trade_contract(left: dict[str, Any], right: dict[str, Any]) -> bool:
    for key in ("account", "instrument_id"):
        if left.get(key) != right.get(key):
            return False
    if str(left.get("scrip") or "").strip().upper() != str(right.get("scrip") or "").strip().upper():
        return False
    if _normalize_strategy_expiry(left.get("expiry")) != _normalize_strategy_expiry(right.get("expiry")):
        return False
    if str(left.get("strike") or "") != str(right.get("strike") or ""):
        return False
    return str(left.get("option_type") or "").strip().upper() == str(right.get("option_type") or "").strip().upper()


def _confirmation_contract_group_key(contract_row: dict[str, Any], strategy_name: str) -> tuple[str, ...]:
    """Build the stable key used to recalculate one strategy/contract ledger once."""
    return (
        str(strategy_name or "").strip().casefold(),
        str(contract_row.get("account") or ""),
        str(contract_row.get("instrument_id") or ""),
        str(contract_row.get("scrip") or "").strip().upper(),
        _normalize_strategy_expiry(contract_row.get("expiry")),
        str(contract_row.get("strike") or ""),
        str(contract_row.get("option_type") or "").strip().upper(),
    )


def _recompute_strategy_contract_allocations(
    conn: Any,
    contract_row: dict[str, Any],
    strategy_name: str,
) -> list[dict[str, Any]]:
    """Rebuild Entry/Exit labels in date order using exact quantities only.

    Allocation order is not trade order. A later trade can be allocated first,
    so the ledger must be recalculated when an earlier trade is added. Opposite
    sides close only when their quantities are exactly equal; no partial close
    is created.
    """
    normalized_strategy = str(strategy_name or "").strip()
    if not normalized_strategy:
        return []

    contract_scrip = str(contract_row.get("scrip") or "").strip().upper()
    contract_option = str(contract_row.get("option_type") or "").strip().upper()
    contract_expiry = str(contract_row.get("expiry") or "").strip()
    contract_strike = str(contract_row.get("strike") or "").strip()
    strike_variants = sorted({
        contract_strike,
        _format_trade_number(contract_row.get("strike")),
        f"{_format_trade_amount(contract_row.get('strike')):g}",
    })
    expiry_variants = _confirmation_expiry_variants(contract_expiry)
    cursor = conn.execute(
        """
        SELECT *
        FROM matalia.strategy_allocation
        WHERE strategy IS NOT NULL
          AND LOWER(BTRIM(strategy)) = LOWER(BTRIM(%s))
          AND BTRIM(UPPER(scrip::text)) = %s
          AND BTRIM(UPPER(option_type::text)) = %s
          AND strike::text = ANY(%s)
          AND REPLACE(UPPER(expiry::text), '-', '') = ANY(%s)
        ORDER BY trade_date, trade_minute, allocation_id
        """,
        (normalized_strategy, contract_scrip, contract_option, strike_variants, expiry_variants),
    )
    columns = [column.name for column in cursor.description]
    rows = [dict(zip(columns, record)) for record in cursor.fetchall()]
    rows = [row for row in rows if _same_trade_contract(row, contract_row)]
    if not rows:
        return []

    legacy_position_ids: list[str] = []
    for row in rows:
        if str(row.get("trade_action") or "").strip().lower() != "entry":
            continue
        position_id = row.get("position_id")
        if position_id is not None and str(position_id) not in legacy_position_ids:
            legacy_position_ids.append(str(position_id))

    used_position_ids: set[str] = set()
    open_entries: dict[str, list[dict[str, Any]]] = {"BUY": [], "SELL": []}
    updates: list[tuple[str, str, Any, int]] = []

    for row in rows:
        side = _trade_side_from_type(row.get("trade_type"))
        opposite = "SELL" if side == "BUY" else "BUY"
        quantity = _format_trade_amount(row.get("quantity"))
        match_index = next(
            (
                index
                for index, entry in enumerate(open_entries[opposite])
                if abs(_format_trade_amount(entry.get("quantity")) - quantity) <= 1e-6
            ),
            None,
        )

        if match_index is not None:
            matched_entry = open_entries[opposite].pop(match_index)
            position_id = matched_entry["position_id"]
            action = "Exit"
            status = "Closed"
        else:
            old_position_id = row.get("position_id")
            old_position_key = str(old_position_id) if old_position_id is not None else ""
            if old_position_key and old_position_key not in used_position_ids:
                position_id = old_position_id
            else:
                position_id = next(
                    (candidate for candidate in legacy_position_ids if candidate not in used_position_ids),
                    None,
                )
                if position_id is None:
                    position_id = get_next_position_id(conn)
            used_position_ids.add(str(position_id))
            open_entries[side].append(
                {
                    "allocation_id": row.get("allocation_id"),
                    "position_id": position_id,
                    "quantity": quantity,
                }
            )
            action = "Entry"
            status = "Open"

        updates.append((action, status, position_id, int(row["allocation_id"])))

    updated_rows: list[dict[str, Any]] = []
    rows_by_allocation_id = {
        int(row["allocation_id"]): row
        for row in rows
    }
    if updates:
        value_placeholders = ", ".join(["(%s, %s, %s, %s)"] * len(updates))
        update_params: list[Any] = []
        for action, status, position_id, allocation_id in updates:
            update_params.extend([action, status, position_id, allocation_id])
        conn.execute(
            f"""
            UPDATE matalia.strategy_allocation AS allocation
            SET trade_action = updates.trade_action,
                status = updates.status,
                position_id = updates.position_id
            FROM (VALUES {value_placeholders}) AS updates(trade_action, status, position_id, allocation_id)
            WHERE allocation.allocation_id = updates.allocation_id
            """,
            update_params,
        )
    for action, status, position_id, allocation_id in updates:
        updated_rows.append({
            **rows_by_allocation_id[allocation_id],
            "trade_action": action,
            "status": status,
            "position_id": position_id,
        })

    return updated_rows


def _trade_status_from_action(action: Any) -> str:
    normalized = str(action).strip().lower()
    if normalized == "exit":
        return "CLOSED"
    return "OPEN"


def _trade_status_from_source(value: Any, fallback: str) -> str:
    status = str(value or "").strip()
    return status or fallback


def _trade_mtm_from_row(row: dict[str, Any], side: str, quantity: float, price: float) -> float:
    cmp_value = row.get("cmp")
    if cmp_value is not None:
        direction = 1.0 if side == "BUY" else -1.0
        return round((float(cmp_value) - price) * quantity * direction, 2)

    pnl_amount = row.get("pnl_amount")
    if pnl_amount is not None:
        return round(float(pnl_amount), 2)

    return round(quantity if side == "BUY" else -quantity, 2)


def _merge_trade_id_is_blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    return False


def _allocation_bucket_from_row(row: dict[str, Any]) -> str:
    if row.get("_source") == "strategy_open":
        return "Open"
    return "Unassigned"


def _normalize_trade_record(row: dict[str, Any], view: str) -> dict[str, Any]:
    if view == "All Trades":
        side = _trade_side_from_type(row.get("trade_type"))
        quantity = _format_trade_amount(row.get("quantity"))
        price = _format_trade_amount(row.get("average_price"))
        status = _trade_status_from_source(row.get("status"), "")
        trade_id = row.get("position_id") or row.get("split_trade_id") or row.get("allocation_id")
        return {
            "id": str(trade_id),
            "date": _format_trade_date(row.get("trade_date")),
            "time": _normalize_time(row.get("trade_minute")),
            "tradeId": str(trade_id),
            "side": side,
            "scrip": str(row.get("scrip") or ""),
            "expiry": _format_trade_expiry(row.get("expiry")),
            "strike": _format_trade_number(row.get("strike")),
            "optType": str(row.get("option_type") or ""),
            "qty": int(round(quantity)),
            "price": round(price, 2),
            "cmp": round(_format_trade_amount(row.get("cmp")), 2) if row.get("cmp") is not None else None,
            "mtm": _trade_mtm_from_row(row, side, quantity, price),
            "strategy": str(row.get("strategy") or "Unassigned"),
            "status": status,
        }

    if view == "Open Trades":
        side = _trade_side_from_type(row.get("trade_type"))
        quantity = _format_trade_amount(row.get("entry_qty"))
        price = _format_trade_amount(row.get("entry_price"))
        trade_id = row.get("position_id") or row.get("entry_id") or row.get("id")
        return {
            "id": str(trade_id),
            "date": _format_trade_date(row.get("entry_date")),
            "time": _normalize_time(row.get("entry_time")),
            "tradeId": str(trade_id),
            "side": side,
            "scrip": str(row.get("scrip") or ""),
            "expiry": _format_trade_expiry(row.get("expiry")),
            "strike": _format_trade_number(row.get("strike")),
            "optType": str(row.get("option_type") or ""),
            "qty": int(round(quantity)),
            "price": round(price, 2),
            "cmp": round(_format_trade_amount(row.get("cmp")), 2) if row.get("cmp") is not None else None,
            "mtm": _trade_mtm_from_row(row, side, quantity, price),
            "strategy": str(row.get("strategy") or "Unassigned"),
            "status": _trade_status_from_source(row.get("status"), ""),
        }

    side = _trade_side_from_type(row.get("trade_type"))
    quantity = _format_trade_amount(row.get("entry_qty") or row.get("quantity"))
    entry_price = _format_trade_amount(row.get("entry_price"))
    exit_price = _format_trade_amount(row.get("exit_price"))
    trade_id = row.get("position_id") or f"{row.get('entry_id')}-{row.get('exit_id')}"
    return {
        "id": str(trade_id),
        "date": _format_trade_date(row.get("entry_date")),
        "time": _normalize_time(row.get("entry_time")),
        "tradeId": str(trade_id),
        "side": side,
        "scrip": str(row.get("scrip") or ""),
        "expiry": _format_trade_expiry(row.get("expiry")),
        "strike": _format_trade_number(row.get("strike")),
        "optType": str(row.get("option_type") or ""),
        "qty": int(round(quantity)),
        "price": round(entry_price, 2),
        "entryDate": _format_trade_date(row.get("entry_date")),
        "entryTime": _normalize_time(row.get("entry_time")),
        "entryPrice": round(entry_price, 2),
        "exitDate": _format_trade_date(row.get("exit_date")),
        "exitTime": _normalize_time(row.get("exit_time")),
        "exitPrice": round(exit_price, 2),
        "cmp": round(_format_trade_amount(row.get("cmp")), 2) if row.get("cmp") is not None else None,
        "mtm": round(float(row.get("pnl_amount") or 0), 2),
        "strategy": str(row.get("strategy") or "Unassigned"),
        "status": _trade_status_from_source(row.get("status"), ""),
    }


def _load_trade_rows(conn: Any, table_name: str, view: str) -> list[dict[str, Any]]:
    cursor = conn.execute(f"SELECT * FROM matalia.{table_name}")
    columns = [column.name for column in cursor.description]
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]

    return [_normalize_trade_record(row, view) for row in rows]


def _load_trade_count(conn: Any, table_name: str) -> int:
    return int(conn.execute(f"SELECT count(*) FROM matalia.{table_name}").fetchone()[0])


def _trade_book_match_key(row: dict[str, Any]) -> tuple[str, str, str, str, str, str, str, str]:
    return (
        str(row.get("position_id") or ""),
        str(row.get("strategy") or "").strip(),
        str(row.get("account") or "").strip(),
        str(row.get("instrument_id") or "").strip(),
        str(row.get("scrip") or "").strip().upper(),
        _normalize_strategy_expiry(row.get("expiry")),
        str(row.get("strike") or "").strip(),
        str(row.get("option_type") or "").strip().upper(),
    )


def _load_effective_trade_book_rows(conn: Any) -> dict[str, list[dict[str, Any]]]:
    # Trade Book deployment marker: Open/Closed are read from Supabase strategy views.
    started_at = perf_counter()
    stage_started_at = perf_counter()
    cursor = conn.execute(
        "SELECT * FROM matalia.strategy_allocation ORDER BY trade_date, trade_minute, allocation_id"
    )
    columns = [column.name for column in cursor.description]
    allocation_rows = [dict(zip(columns, record)) for record in cursor.fetchall()]
    allocation_ms = (perf_counter() - stage_started_at) * 1000

    split_ids = [int(row["split_trade_id"]) for row in allocation_rows if row.get("split_trade_id") is not None]
    split_ms = 0.0
    if split_ids:
        stage_started_at = perf_counter()
        split_cursor = conn.execute(
            'SELECT * FROM matalia."SplitTrades" WHERE id = ANY(%s)',
            (split_ids,),
        )
        split_columns = [column.name for column in split_cursor.description]
        split_id_index = split_columns.index("id")
        split_rows = {
            int(record[split_id_index]): dict(zip(split_columns, record))
            for record in split_cursor.fetchall()
        }
        effective_fields = (
            "trade_date", "trade_minute", "instrument_id", "scrip", "expiry",
            "strike", "option_type", "trade_type", "quantity", "average_price", "account",
        )
        for allocation in allocation_rows:
            split_row = split_rows.get(int(allocation["split_trade_id"]))
            if split_row:
                for field in effective_fields:
                    if split_row.get(field) is not None:
                        allocation[field] = split_row[field]
        split_ms = (perf_counter() - stage_started_at) * 1000

    def load_view(table_name: str, view: str) -> list[dict[str, Any]]:
        cursor = conn.execute(f"SELECT * FROM matalia.{table_name}")
        columns = [column.name for column in cursor.description]
        return [_normalize_trade_record(dict(zip(columns, record)), view) for record in cursor.fetchall()]

    matching_ms = 0.0
    result = {
        "All Trades": [_normalize_trade_record(row, "All Trades") for row in allocation_rows],
        "Open Trades": load_view("strategy_open", "Open Trades"),
        "Closed Trades": load_view("strategy_closed", "Closed Trades"),
    }
    logger.info(
        "trade_book_rows allocations=%d split_ids=%d all=%d open=%d closed=%d "
        "allocation_ms=%.1f split_ms=%.1f matching_ms=%.1f total_ms=%.1f",
        len(allocation_rows), len(split_ids), len(result["All Trades"]),
        len(result["Open Trades"]), len(result["Closed Trades"]), allocation_ms,
        split_ms, matching_ms, (perf_counter() - started_at) * 1000,
    )
    return result


def _delete_trade_family(conn: Any, trade_id: str) -> dict[str, int]:
    """Delete one position and its source rows as one transaction."""
    allocation_cursor = conn.execute(
        """
        SELECT split_trade_id
        FROM matalia.strategy_allocation
        WHERE position_id::text = %s
        FOR UPDATE
        """,
        (str(trade_id),),
    )
    split_trade_ids = [int(value) for (value,) in allocation_cursor.fetchall() if value is not None]
    if not split_trade_ids:
        return {"allocation_count": 0, "split_count": 0, "merge_count": 0, "raw_updated_count": 0}

    split_cursor = conn.execute(
        'SELECT "MergeID" FROM matalia."SplitTrades" WHERE id = ANY(%s)',
        (split_trade_ids,),
    )
    merge_trade_ids = [int(value) for (value,) in split_cursor.fetchall() if value is not None]

    allocation_result = conn.execute(
        "DELETE FROM matalia.strategy_allocation WHERE position_id::text = %s",
        (str(trade_id),),
    )
    split_result = conn.execute(
        'DELETE FROM matalia."SplitTrades" WHERE id = ANY(%s)',
        (split_trade_ids,),
    )
    merge_result = conn.execute(
        'DELETE FROM matalia."MergeTrades" WHERE id = ANY(%s)',
        (merge_trade_ids,),
    ) if merge_trade_ids else None
    raw_result = conn.execute(
        'UPDATE matalia."01RawTxtData" SET merge_trade_id = NULL WHERE merge_trade_id = ANY(%s)',
        (merge_trade_ids,),
    ) if merge_trade_ids else None

    return {
        "allocation_count": allocation_result.rowcount or 0,
        "split_count": split_result.rowcount or 0,
        "merge_count": merge_result.rowcount if merge_result is not None else 0,
        "raw_updated_count": raw_result.rowcount if raw_result is not None else 0,
    }


def _load_strategy_allocation_rows(conn: Any) -> list[dict[str, Any]]:
    started_at = perf_counter()
    stage_started_at = perf_counter()
    # The view contains a CMP column used by the Positions screen, but the
    # allocation screen does not need it. Avoid transferring unused columns
    # while retaining the view's existing open-position logic.
    open_cursor = conn.execute(
        """
        SELECT id, position_id, entry_id, strategy, account, scrip,
               instrument_id, expiry, strike, option_type, trade_type,
               entry_date, entry_time, entry_qty, entry_price, status
        FROM matalia.strategy_open
        """
    )
    open_columns = [column.name for column in open_cursor.description]
    open_rows = [
        {**dict(zip(open_columns, row)), "_source": "strategy_open"}
        for row in open_cursor.fetchall()
    ]
    open_ms = (perf_counter() - stage_started_at) * 1000

    stage_started_at = perf_counter()
    raw_cursor = conn.execute(
        """
        SELECT id, trade_date, trade_minute, instrument_id, scrip, expiry,
               strike, option_type, trade_type, quantity, average_price,
               account, merge_trade_id
        FROM matalia."01RawTxtData"
        """
    )
    raw_columns = [column.name for column in raw_cursor.description]
    raw_rows = [
        {**dict(zip(raw_columns, row)), "_source": '01RawTxtData'}
        for row in raw_cursor.fetchall()
    ]
    raw_ms = (perf_counter() - stage_started_at) * 1000

    allocated_split_ids: set[int] = set()
    allocated_merge_ids: set[int] = set()
    raw_merge_ids: list[int] = []
    for raw_row in raw_rows:
        try:
            merge_id = int(raw_row.get("merge_trade_id"))
        except (TypeError, ValueError):
            continue
        raw_merge_ids.append(merge_id)
    split_rows_by_merge: dict[int, list[dict[str, Any]]] = {}
    split_ms = 0.0
    if raw_merge_ids:
        stage_started_at = perf_counter()
        split_cursor = conn.execute(
            """
            SELECT split_row.id, split_row."MergeID", split_row.trade_date,
                   split_row.trade_minute, split_row.instrument_id,
                   split_row.scrip, split_row.expiry, split_row.strike,
                   split_row.option_type, split_row.trade_type,
                   split_row.quantity, split_row.average_price,
                   split_row.account, split_row.trades_merged,
                   EXISTS (
                       SELECT 1
                       FROM matalia.strategy_allocation AS allocation
                       WHERE allocation.split_trade_id = split_row.id
                         AND allocation.strategy IS NOT NULL
                         AND LOWER(BTRIM(allocation.strategy)) <> 'unassigned'
                   ) AS is_allocated
            FROM matalia."SplitTrades" AS split_row
            WHERE split_row."MergeID" = ANY(%s)
            ORDER BY split_row."MergeID", split_row.id
            """,
            (list(dict.fromkeys(raw_merge_ids)),),
        )
        split_columns = [column.name for column in split_cursor.description]
        for record in split_cursor.fetchall():
            split_row = dict(zip(split_columns, record))
            is_allocated = bool(split_row.pop("is_allocated", False))
            split_id = split_row.get("id")
            merge_id = split_row.get("MergeID")
            if is_allocated and split_id is not None:
                allocated_split_ids.add(int(split_id))
            if is_allocated and merge_id is not None:
                allocated_merge_ids.add(int(merge_id))
            if merge_id is not None:
                split_rows_by_merge.setdefault(int(merge_id), []).append(split_row)
        split_ms = (perf_counter() - stage_started_at) * 1000
    combined_rows = open_rows + raw_rows
    normalized_rows: list[dict[str, Any]] = []
    shown_pending_merges: set[int] = set()
    transform_started_at = perf_counter()

    def append_raw_or_split_row(row: dict[str, Any], raw_id: Any = None, split_trade_id: Any = None) -> None:
        """Display unallocated split children in place of their raw parent."""
        quantity = _format_trade_amount(row.get("quantity"))
        price = _format_trade_amount(row.get("average_price"))
        side = _trade_side_from_type(row.get("trade_type"))
        parent_id = str(raw_id if raw_id is not None else row.get("id"))
        child_id = str(split_trade_id) if split_trade_id is not None else None
        normalized_rows.append(
            {
                "id": f"split:{child_id}" if child_id else parent_id,
                "sourceId": parent_id,
                "tradeId": child_id or str(row.get("instrument_id") or row.get("id")),
                "splitTradeId": child_id,
                "date": _format_trade_date(row.get("trade_date")),
                "time": _normalize_time(row.get("trade_minute")),
                "side": side,
                "scrip": str(row.get("scrip") or ""),
                "expiry": _format_trade_expiry(row.get("expiry")),
                "strike": _format_trade_number(row.get("strike")),
                "optType": str(row.get("option_type") or ""),
                "qty": int(round(quantity)),
                "price": round(price, 2),
                "account": str(row.get("account") or ""),
                "mtm": _trade_mtm_from_row(row, side, quantity, price),
                "strategy": str(row.get("strategy") or "Unassigned"),
                "status": "UNASSIGNED",
                "bucket": "Unassigned",
                "source": "01RawTxtData",
            }
        )

    for row in combined_rows:
        source = row.get("_source")
        if source == "strategy_open":
            quantity = _format_trade_amount(row.get("entry_qty"))
            price = _format_trade_amount(row.get("entry_price"))
            normalized_rows.append(
                {
                    "id": str(row.get("id") or row.get("entry_id") or row.get("position_id")),
                    "date": _format_trade_date(row.get("entry_date")),
                    "time": _normalize_time(row.get("entry_time")),
                    "tradeId": str(row.get("position_id") or row.get("entry_id") or row.get("id")),
                    "side": _trade_side_from_type(row.get("trade_type")),
                    "scrip": str(row.get("scrip") or ""),
                    "expiry": _format_trade_expiry(row.get("expiry")),
                    "strike": _format_trade_number(row.get("strike")),
                    "optType": str(row.get("option_type") or ""),
                    "qty": int(round(quantity)),
                    "price": round(price, 2),
                    "account": str(row.get("account") or ""),
                    "mtm": _trade_mtm_from_row(row, _trade_side_from_type(row.get("trade_type")), quantity, price),
                    "strategy": str(row.get("strategy") or "Unassigned"),
                    "status": str(row.get("status") or "OPEN").upper(),
                    "bucket": _allocation_bucket_from_row(row),
                    "source": "strategy_open",
                }
            )
            continue

        raw_id = row.get("id")
        try:
            raw_merge_id = int(row.get("merge_trade_id"))
        except (TypeError, ValueError):
            raw_merge_id = None
        pending_split_rows = [
            split_row
            for split_row in split_rows_by_merge.get(raw_merge_id, [])
            if int(split_row.get("id")) not in allocated_split_ids
        ]
        if pending_split_rows:
            merge_ids = {
                int(split_row.get("MergeID"))
                for split_row in pending_split_rows
                if split_row.get("MergeID") is not None
            }
            if merge_ids & shown_pending_merges:
                continue
            shown_pending_merges.update(merge_ids)
            for split_row in pending_split_rows:
                append_raw_or_split_row(split_row, raw_id=raw_id, split_trade_id=split_row.get("id"))
        elif not _merge_trade_id_is_blank(row.get("merge_trade_id")):
            # A merge/split link alone does not allocate the raw trade. Keep it
            # visible until its own merge group has a real strategy allocation.
            try:
                merge_id = int(row.get("merge_trade_id"))
            except (TypeError, ValueError):
                merge_id = None
            if merge_id is not None and merge_id in allocated_merge_ids:
                continue
            append_raw_or_split_row(row, raw_id=raw_id)
        else:
            # A blank raw merge link is definitively unassigned. Do not infer
            # allocation from another row with the same quantity/price/time.
            append_raw_or_split_row(row, raw_id=raw_id)

    transform_ms = (perf_counter() - transform_started_at) * 1000
    logger.info(
        "strategy_allocation_rows open=%d raw=%d output=%d open_ms=%.1f raw_ms=%.1f "
        "split_ms=%.1f transform_ms=%.1f total_ms=%.1f",
        len(open_rows), len(raw_rows), len(normalized_rows), open_ms, raw_ms,
        split_ms, transform_ms, (perf_counter() - started_at) * 1000,
    )
    return normalized_rows


def _load_pending_split_rows_by_raw_id(conn: Any, raw_ids: list[int] | None = None) -> dict[Any, list[dict[str, Any]]]:
    """Load all pending split children in one query instead of one query per raw trade."""
    query = """
        WITH pending_merges AS (
            SELECT
                merge_row.id AS merge_id,
                merge_row.trade_date,
                merge_row.trade_minute,
                merge_row.instrument_id,
                merge_row.scrip,
                merge_row.expiry,
                merge_row.strike,
                merge_row.option_type,
                merge_row.trade_type,
                merge_row.quantity,
                merge_row.average_price,
                merge_row.account,
                split_totals.split_quantity
            FROM matalia."MergeTrades" AS merge_row
            JOIN (
                SELECT "MergeID", SUM(quantity) AS split_quantity
                FROM matalia."SplitTrades"
                GROUP BY "MergeID"
            ) AS split_totals ON split_totals."MergeID" = merge_row.id
            WHERE NOT EXISTS (
                SELECT 1
                FROM matalia.strategy_allocation AS allocation
                JOIN matalia."SplitTrades" AS allocated_split
                  ON allocation.split_trade_id = allocated_split.id
                WHERE allocated_split."MergeID" = merge_row.id
                  AND allocation.strategy IS NOT NULL
                  AND LOWER(BTRIM(allocation.strategy)) <> 'unassigned'
            )
        ), ranked_matches AS (
            SELECT
                raw_row.id AS raw_id,
                pending_merge.merge_id,
                ROW_NUMBER() OVER (
                    PARTITION BY raw_row.id
                    ORDER BY
                        CASE WHEN pending_merge.trade_date IS NOT DISTINCT FROM raw_row.trade_date THEN 1 ELSE 0 END DESC,
                        CASE WHEN pending_merge.trade_minute IS NOT DISTINCT FROM raw_row.trade_minute THEN 1 ELSE 0 END DESC,
                        CASE WHEN pending_merge.quantity IS NOT DISTINCT FROM raw_row.quantity THEN 1 ELSE 0 END DESC,
                        CASE WHEN pending_merge.average_price IS NOT DISTINCT FROM raw_row.average_price THEN 1 ELSE 0 END DESC,
                        CASE WHEN pending_merge.instrument_id IS NOT DISTINCT FROM raw_row.instrument_id THEN 1 ELSE 0 END DESC,
                        CASE WHEN pending_merge.account IS NOT DISTINCT FROM raw_row.account THEN 1 ELSE 0 END DESC,
                        CASE WHEN pending_merge.split_quantity = raw_row.quantity THEN 1 ELSE 0 END DESC,
                        pending_merge.merge_id DESC
                ) AS match_rank
            FROM matalia."01RawTxtData" AS raw_row
            JOIN pending_merges AS pending_merge
              ON pending_merge.scrip IS NOT DISTINCT FROM raw_row.scrip
             AND pending_merge.expiry IS NOT DISTINCT FROM raw_row.expiry
             AND pending_merge.strike IS NOT DISTINCT FROM raw_row.strike
             AND pending_merge.option_type IS NOT DISTINCT FROM raw_row.option_type
             AND pending_merge.trade_type IS NOT DISTINCT FROM raw_row.trade_type
             AND (
                    NULLIF(BTRIM(raw_row.merge_trade_id::text), '')::bigint = pending_merge.merge_id
                    OR (
                        (raw_row.merge_trade_id IS NULL OR BTRIM(raw_row.merge_trade_id::text) = '')
                        AND NOT EXISTS (
                            SELECT 1
                            FROM matalia."01RawTxtData" AS linked_raw
                            WHERE NULLIF(BTRIM(linked_raw.merge_trade_id::text), '')::bigint = pending_merge.merge_id
                        )
                    )
                 )
            WHERE (%s IS NULL OR raw_row.id = ANY(%s))
        )
        SELECT ranked.raw_id, split_row.*
        FROM ranked_matches AS ranked
        JOIN matalia."SplitTrades" AS split_row
          ON split_row."MergeID" = ranked.merge_id
        WHERE ranked.match_rank = 1
        ORDER BY ranked.raw_id, split_row.id
        """
    params = (None, None) if not raw_ids else (raw_ids, raw_ids)
    cursor = conn.execute(query, params)
    columns = [column.name for column in cursor.description]
    rows_by_raw_id: dict[Any, list[dict[str, Any]]] = {}
    for record in cursor.fetchall():
        row = dict(zip(columns, record))
        raw_id = row.pop("raw_id")
        rows_by_raw_id.setdefault(raw_id, []).append(row)
    return rows_by_raw_id


def _batch_assign_pending_strategy_allocations(
    conn: Any,
    rows: list[StrategyAllocationConfirmationRow],
    raw_rows_by_id: dict[int, dict[str, Any]],
    pending_split_rows_by_raw_id: dict[Any, list[dict[str, Any]]],
) -> dict[int, int]:
    """Assign strategies to already-created pending rows in one database update."""
    assignments: dict[int, str] = {}
    for row in rows:
        if row.source.strip() != STRATEGY_ALLOCATION_SOURCE_ROWS:
            continue
        try:
            raw_id = int(row.sourceId)
        except (TypeError, ValueError):
            continue
        raw_row = raw_rows_by_id.get(raw_id)
        if raw_row is None:
            continue
        pending_rows = pending_split_rows_by_raw_id.get(raw_id, [])
        if not pending_rows:
            continue
        if row.splitTradeId:
            selected_rows = [
                split_row for split_row in pending_rows
                if str(split_row.get("id")) == str(row.splitTradeId)
            ]
        elif len(pending_rows) == 1:
            selected_rows = pending_rows
        else:
            def same_number(left: Any, right: Any) -> bool:
                try:
                    return abs(float(left or 0) - float(right or 0)) < 0.0001
                except (TypeError, ValueError):
                    return False

            selected_rows = [
                split_row for split_row in pending_rows
                if same_number(split_row.get("quantity"), row.qty)
                and same_number(split_row.get("average_price"), row.price)
                and _trade_side_from_type(split_row.get("trade_type")) == row.side.upper()
            ]
        if len(selected_rows) == 1:
            split_trade_id = int(selected_rows[0]["id"])
            assignments.setdefault(split_trade_id, row.strategyName)

    if not assignments:
        return {}

    value_placeholders = ", ".join(["(%s, %s)"] * len(assignments))
    params: list[Any] = []
    for split_trade_id, strategy_name in assignments.items():
        params.extend([strategy_name, split_trade_id])
    cursor = conn.execute(
        f"""
        UPDATE matalia.strategy_allocation AS allocation
        SET strategy = updates.strategy,
            status = 'Open'
        FROM (VALUES {value_placeholders}) AS updates(strategy, split_trade_id)
        WHERE allocation.split_trade_id = updates.split_trade_id
          AND allocation.trade_action = 'Entry'
          AND (allocation.strategy IS NULL OR LOWER(BTRIM(allocation.strategy)) = 'unassigned')
        RETURNING allocation.allocation_id, allocation.split_trade_id
        """,
        params,
    )
    return {
        int(split_trade_id): int(allocation_id)
        for allocation_id, split_trade_id in cursor.fetchall()
    }


def _next_sequence_values(conn: Any, table_name: str, column_name: str, count: int) -> list[int] | None:
    if count <= 0:
        return []
    sequence_row = conn.execute(
        "SELECT pg_get_serial_sequence(%s, %s)",
        (table_name, column_name),
    ).fetchone()
    sequence_name = sequence_row[0] if sequence_row else None
    if not sequence_name:
        return None
    return [
        int(row[0])
        for row in conn.execute(
            "SELECT nextval(%s) FROM generate_series(1, %s)",
            (sequence_name, count),
        ).fetchall()
    ]


def _next_named_sequence_values(conn: Any, sequence_name: str, count: int) -> list[int]:
    if count <= 0:
        return []
    return [
        int(row[0])
        for row in conn.execute(
            "SELECT nextval(%s) FROM generate_series(1, %s)",
            (sequence_name, count),
        ).fetchall()
    ]


def _bulk_confirm_pending_raw_rows(
    conn: Any,
    rows: list[StrategyAllocationConfirmationRow],
    raw_rows_by_id: dict[int, dict[str, Any]],
    pending_split_rows_by_raw_id: dict[Any, list[dict[str, Any]]],
    preassigned_allocations: dict[int, int],
    available_positions: PositionManager,
    progress_id: str | None,
    recompute_groups: dict[tuple[str, ...], dict[str, Any]],
) -> dict[int, dict[str, Any]] | None:
    """Bulk-create the ordinary pending raw-trade path.

    Returns None when the request needs the legacy row-by-row path and that
    path is explicitly enabled. Otherwise it raises before any batch write.
    """
    def fallback(reason: str) -> dict[int, dict[str, Any]] | None:
        logger.warning(
            "instrument_allocation_bulk_fallback rows=%d reason=%s",
            len(rows),
            reason,
        )
        if os.getenv("PROP_TRADING_ALLOW_CONFIRMATION_FALLBACK", "false").strip().lower() != "true":
            raise RuntimeError(
                "Batch confirmation rejected; sequential fallback is disabled. "
                f"Reason: {reason}"
            )
        return None

    if not rows or any(row.source.strip() != STRATEGY_ALLOCATION_SOURCE_ROWS for row in rows):
        return fallback("unsupported_source")

    selections: list[dict[str, Any]] = []
    seen_split_ids: set[int] = set()
    for index, row in enumerate(rows):
        try:
            raw_id = int(row.sourceId)
        except (TypeError, ValueError):
            return fallback(f"invalid_raw_id:index={index}")
        raw_row = raw_rows_by_id.get(raw_id)
        if raw_row is None:
            return fallback(f"raw_row_missing:index={index},raw_id={raw_id}")
        if not _confirmation_row_matches_contract(row, raw_row, check_quantity=False):
            return fallback(f"raw_trade_mismatch:index={index},raw_id={raw_id}")

        pending_rows = list(pending_split_rows_by_raw_id.get(raw_id, []))
        selected_rows = pending_rows
        if row.splitTradeId:
            selected_rows = [
                split_row for split_row in pending_rows
                if str(split_row.get("id")) == str(row.splitTradeId)
            ]
        elif len(pending_rows) > 1:
            def same_number(left: Any, right: Any) -> bool:
                try:
                    return abs(float(left or 0) - float(right or 0)) < 0.0001
                except (TypeError, ValueError):
                    return False

            selected_rows = [
                split_row for split_row in pending_rows
                if same_number(split_row.get("quantity"), row.qty)
                and same_number(split_row.get("average_price"), row.price)
                and _trade_side_from_type(split_row.get("trade_type")) == row.side.upper()
            ]
        if len(selected_rows) > 1 or (not selected_rows and not _merge_trade_id_is_blank(raw_row.get("merge_trade_id"))):
            return fallback(f"ambiguous_or_already_merged:index={index},raw_id={raw_id}")

        is_new_merge = _merge_trade_id_is_blank(raw_row.get("merge_trade_id")) and not selected_rows
        if selected_rows:
            split_row = dict(selected_rows[0])
            if not _confirmation_row_matches_contract(row, split_row):
                return fallback(f"split_trade_mismatch:index={index},split_id={split_row.get('id')}")
            merge_trade_id = int(split_row["MergeID"])
            is_new_split = False
        elif is_new_merge:
            if not _confirmation_row_matches_contract(row, raw_row):
                return fallback(f"raw_quantity_mismatch:index={index},raw_id={raw_id}")
            split_row = {**raw_row, "trades_merged": 1}
            merge_trade_id = None
            is_new_split = True
        else:
            return fallback(f"split_not_resolvable:index={index},raw_id={raw_id}")

        split_trade_id = int(split_row["id"]) if split_row.get("id") is not None else None
        if split_trade_id is not None:
            if split_trade_id in seen_split_ids:
                return fallback(f"duplicate_split:index={index},split_id={split_trade_id}")
            seen_split_ids.add(split_trade_id)
        selections.append({
            "index": index,
            "row": row,
            "raw_id": raw_id,
            "raw_row": raw_row,
            "split_row": split_row,
            "merge_trade_id": merge_trade_id,
            "is_new_merge": is_new_merge,
            "is_new_split": is_new_split,
        })

    existing_split_ids = [
        int(selection["split_row"]["id"])
        for selection in selections
        if selection["split_row"].get("id") is not None
    ]
    existing_allocations: dict[int, tuple[int, str | None]] = {}
    if existing_split_ids:
        cursor = conn.execute(
            """
            SELECT allocation_id, split_trade_id, strategy
            FROM matalia.strategy_allocation
            WHERE split_trade_id = ANY(%s)
              AND trade_action = 'Entry'
            """,
            (existing_split_ids,),
        )
        existing_allocations = {
            int(split_trade_id): (int(allocation_id), strategy)
            for allocation_id, split_trade_id, strategy in cursor.fetchall()
        }
        for split_trade_id, (allocation_id, strategy) in existing_allocations.items():
            if preassigned_allocations.get(split_trade_id) != allocation_id:
                return fallback(f"allocation_not_preassigned:split_id={split_trade_id}")

    new_merge_selections = [selection for selection in selections if selection["is_new_merge"]]
    new_merge_ids = _next_sequence_values(
        conn,
        'matalia."MergeTrades"',
        "id",
        len(new_merge_selections),
    )
    if new_merge_ids is None:
        return fallback("merge_sequence_missing")
    for selection, merge_trade_id in zip(new_merge_selections, new_merge_ids):
        selection["merge_trade_id"] = merge_trade_id
        selection["split_row"]["MergeID"] = merge_trade_id

    new_split_selections = [selection for selection in selections if selection["is_new_split"]]
    new_split_ids = _next_sequence_values(
        conn,
        'matalia."SplitTrades"',
        "id",
        len(new_split_selections),
    )
    if new_split_ids is None:
        return fallback("split_sequence_missing")
    for selection, split_trade_id in zip(new_split_selections, new_split_ids):
        selection["split_row"]["id"] = split_trade_id

    if new_merge_selections:
        values = ", ".join(["(" + ", ".join(["%s"] * 13) + ")"] * len(new_merge_selections))
        params: list[Any] = []
        for selection in new_merge_selections:
            raw_row = selection["raw_row"]
            params.extend([
                selection["merge_trade_id"], raw_row.get("trade_date"), raw_row.get("trade_minute"),
                raw_row.get("instrument_id"), raw_row.get("scrip"), raw_row.get("expiry"),
                raw_row.get("strike"), raw_row.get("option_type"), raw_row.get("trade_type"),
                raw_row.get("quantity"), raw_row.get("average_price"), raw_row.get("account"),
                raw_row.get("trades_merged") or 1,
            ])
        conn.execute(
            f"""
            INSERT INTO matalia."MergeTrades"
            (id, trade_date, trade_minute, instrument_id, scrip, expiry, strike,
             option_type, trade_type, quantity, average_price, account, trades_merged)
            VALUES {values}
            """,
            params,
        )

    if new_split_selections:
        values = ", ".join(["(" + ", ".join(["%s"] * 14) + ")"] * len(new_split_selections))
        params = []
        for selection in new_split_selections:
            split_row = selection["split_row"]
            params.extend([
                split_row["id"], selection["merge_trade_id"], split_row.get("trade_date"),
                split_row.get("trade_minute"), split_row.get("instrument_id"), split_row.get("scrip"),
                split_row.get("expiry"), split_row.get("strike"), split_row.get("option_type"),
                split_row.get("trade_type"), split_row.get("quantity"), split_row.get("average_price"),
                split_row.get("account"), 1,
            ])
        conn.execute(
            f"""
            INSERT INTO matalia."SplitTrades"
            (id, "MergeID", trade_date, trade_minute, instrument_id, scrip, expiry, strike,
             option_type, trade_type, quantity, average_price, account, trades_merged)
            VALUES {values}
            """,
            params,
        )

    link_values = ", ".join(["(%s, %s)"] * len(selections))
    link_params: list[Any] = []
    for selection in selections:
        link_params.extend([selection["raw_id"], selection["merge_trade_id"]])
    conn.execute(
        f"""
        UPDATE matalia."01RawTxtData" AS raw_row
        SET merge_trade_id = links.merge_trade_id
        FROM (VALUES {link_values}) AS links(raw_id, merge_trade_id)
        WHERE raw_row.id = links.raw_id
          AND (raw_row.merge_trade_id IS NULL OR BTRIM(raw_row.merge_trade_id::text) = '')
        """,
        link_params,
    )

    new_allocations = [
        selection for selection in selections
        if int(selection["split_row"]["id"]) not in preassigned_allocations
    ]
    position_ids = _next_named_sequence_values(conn, POSITION_SEQUENCE, len(new_allocations))
    for selection, position_id in zip(new_allocations, position_ids):
        selection["provisional_position_id"] = position_id

    if new_allocations:
        values = ", ".join(["(" + ", ".join(["%s"] * 19) + ")"] * len(new_allocations))
        params = []
        for selection in new_allocations:
            row = selection["row"]
            raw_row = selection["raw_row"]
            split_row = selection["split_row"]
            params.extend([
                split_row["id"], selection["provisional_position_id"], split_row.get("trade_date"),
                split_row.get("trade_minute"), split_row.get("instrument_id"), split_row.get("scrip"),
                split_row.get("expiry"), split_row.get("strike"), split_row.get("option_type"),
                split_row.get("trade_type"), raw_row.get("quantity"), 1, split_row.get("quantity"),
                split_row.get("average_price"), split_row.get("account"), row.strategyName,
                "Entry", "Open", False,
            ])
        cursor = conn.execute(
            f"""
            INSERT INTO matalia.strategy_allocation
            (split_trade_id, position_id, trade_date, trade_minute, instrument_id, scrip, expiry,
             strike, option_type, trade_type, parent_quantity, split_sequence, quantity,
             average_price, account, strategy, trade_action, status, is_split)
            VALUES {values}
            RETURNING allocation_id, split_trade_id
            """,
            params,
        )
        inserted_allocations = {
            int(split_trade_id): int(allocation_id)
            for allocation_id, split_trade_id in cursor.fetchall()
        }
    else:
        inserted_allocations = {}

    results: dict[int, dict[str, Any]] = {}
    for selection in selections:
        index = selection["index"]
        row = selection["row"]
        split_row = selection["split_row"]
        split_trade_id = int(split_row["id"])
        allocation_id = preassigned_allocations.get(split_trade_id) or inserted_allocations.get(split_trade_id)
        if allocation_id is None:
            return fallback(f"allocation_insert_missing:split_id={split_trade_id}")
        _confirmation_trade_process_update(progress_id, index, "source", "completed", f"Loaded raw trade {selection['raw_id']}")
        _confirmation_trade_process_update(
            progress_id,
            index,
            "merge",
            "completed",
            f"{'Created' if selection['is_new_merge'] else 'Using existing'} MergeTrades record {selection['merge_trade_id']}",
        )
        _confirmation_trade_process_update(
            progress_id,
            index,
            "split",
            "completed",
            f"{'Created' if selection['is_new_split'] else 'Using existing'} SplitTrades record",
        )
        _confirmation_trade_process_update(progress_id, index, "strategy", "completed", f"Updated allocation {allocation_id} in batch")
        _confirmation_trade_process_update(progress_id, index, "matching", "processing", "Queued for batch Entry / Exit matching")
        _confirmation_trade_process_update(progress_id, index, "recalculate", "processing", "Queued for batch position recalculation")
        _confirmation_trade_process_update(progress_id, index, "queued", "completed", "Changes queued for final database save")
        group_key = _confirmation_contract_group_key(split_row, row.strategyName)
        group = recompute_groups.setdefault(
            group_key,
            {"contract_row": dict(split_row), "strategy_name": row.strategyName, "row_indexes": set()},
        )
        group["row_indexes"].add(index)
        results[index] = {
            "processed": True,
            "merge_created": selection["is_new_merge"],
            "split_created": selection["is_new_split"],
            "allocation_created": split_trade_id not in preassigned_allocations,
            "message": f"Bulk processed raw trade {selection['raw_id']} into MergeTrades {selection['merge_trade_id']} and SplitTrades {split_trade_id}",
        }
    return results


def _find_unallocated_merge_trade(conn: Any, raw_row: dict[str, Any]) -> int | None:
    """Find the pending split group belonging to a raw trade."""
    cursor = conn.execute(
        """
        SELECT merge_row.id
        FROM matalia."MergeTrades" AS merge_row
        JOIN matalia."SplitTrades" AS split_row
          ON split_row."MergeID" = merge_row.id
        WHERE merge_row.scrip IS NOT DISTINCT FROM %(scrip)s
          AND merge_row.expiry IS NOT DISTINCT FROM %(expiry)s
          AND merge_row.strike IS NOT DISTINCT FROM %(strike)s
          AND merge_row.option_type IS NOT DISTINCT FROM %(option_type)s
          AND merge_row.trade_type IS NOT DISTINCT FROM %(trade_type)s
          AND NOT EXISTS (
              SELECT 1
              FROM matalia.strategy_allocation AS allocation
              JOIN matalia."SplitTrades" AS allocated_split
                ON allocation.split_trade_id = allocated_split.id
              WHERE allocated_split."MergeID" = merge_row.id
                AND allocation.strategy IS NOT NULL
                AND LOWER(BTRIM(allocation.strategy)) <> 'unassigned'
          )
        GROUP BY merge_row.id
        ORDER BY
          CASE WHEN merge_row.trade_date IS NOT DISTINCT FROM %(trade_date)s THEN 1 ELSE 0 END DESC,
          CASE WHEN merge_row.trade_minute IS NOT DISTINCT FROM %(trade_minute)s THEN 1 ELSE 0 END DESC,
          CASE WHEN merge_row.quantity IS NOT DISTINCT FROM %(quantity)s THEN 1 ELSE 0 END DESC,
          CASE WHEN merge_row.average_price IS NOT DISTINCT FROM %(average_price)s THEN 1 ELSE 0 END DESC,
          CASE WHEN merge_row.instrument_id IS NOT DISTINCT FROM %(instrument_id)s THEN 1 ELSE 0 END DESC,
          CASE WHEN merge_row.account IS NOT DISTINCT FROM %(account)s THEN 1 ELSE 0 END DESC,
          CASE WHEN SUM(split_row.quantity) = %(quantity)s THEN 1 ELSE 0 END DESC,
          merge_row.id DESC
        LIMIT 1
        """,
        {
            "trade_date": raw_row.get("trade_date"),
            "trade_minute": raw_row.get("trade_minute"),
            "instrument_id": raw_row.get("instrument_id"),
            "scrip": raw_row.get("scrip"),
            "expiry": raw_row.get("expiry"),
            "strike": raw_row.get("strike"),
            "option_type": raw_row.get("option_type"),
            "trade_type": raw_row.get("trade_type"),
            "quantity": raw_row.get("quantity"),
            "average_price": raw_row.get("average_price"),
            "account": raw_row.get("account"),
        },
    )
    record = cursor.fetchone()
    return int(record[0]) if record else None


def _load_split_rows_for_merge(conn: Any, merge_trade_id: int) -> list[dict[str, Any]]:
    cursor = conn.execute(
        'SELECT * FROM matalia."SplitTrades" WHERE "MergeID" = %s ORDER BY id',
        (merge_trade_id,),
    )
    columns = [column.name for column in cursor.description]
    return [dict(zip(columns, record)) for record in cursor.fetchall()]


def _merge_has_strategy_allocations(conn: Any, merge_trade_id: int) -> bool:
    record = conn.execute(
        """
        SELECT 1
        FROM matalia.strategy_allocation AS allocation
        JOIN matalia."SplitTrades" AS split_row
          ON split_row.id = allocation.split_trade_id
        WHERE split_row."MergeID" = %s
          AND allocation.strategy IS NOT NULL
          AND LOWER(BTRIM(allocation.strategy)) <> 'unassigned'
        LIMIT 1
        """,
        (merge_trade_id,),
    ).fetchone()
    return record is not None


def _split_trade_has_strategy_allocations(conn: Any, split_trade_id: int) -> bool:
    record = conn.execute(
        """
        SELECT 1
        FROM matalia.strategy_allocation
        WHERE split_trade_id = %s
          AND trade_action = 'Entry'
          AND strategy IS NOT NULL
          AND LOWER(BTRIM(strategy)) <> 'unassigned'
        LIMIT 1
        """,
        (split_trade_id,),
    ).fetchone()
    return record is not None


def _load_strategy_allocation_counts(conn: Any) -> dict[str, int]:
    cursor = conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM matalia.strategy_open) AS open_count,
            (SELECT COUNT(*)
             FROM matalia."01RawTxtData"
             WHERE merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = '') AS raw_blank_count,
            (SELECT COUNT(DISTINCT NULLIF(BTRIM(strategy), ''))
             FROM matalia.strategy_open) AS strategy_count
        """
    )
    open_count, raw_blank_count, strategy_count = cursor.fetchone()
    return {
        "Open Trades": open_count,
        "Unassigned Trades": raw_blank_count,
        "Allocated Trades": open_count,
        "Strategies": strategy_count,
    }


def _table_column_names(conn: Any, schema: str, table: str) -> list[str]:
    cursor = conn.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (schema, table),
    )
    return [str(column_name) for (column_name,) in cursor.fetchall()]


def _load_raw_trade_by_id(conn: Any, raw_id: int, raw_columns: list[str] | None = None) -> dict[str, Any] | None:
    raw_columns = raw_columns or _table_column_names(conn, "matalia", "01RawTxtData")
    cursor = conn.execute(
        'SELECT * FROM matalia."01RawTxtData" WHERE id = %s FOR UPDATE',
        (raw_id,),
    )
    raw_record = cursor.fetchone()
    if raw_record is None:
        return None
    return dict(zip(raw_columns, raw_record))


def _load_raw_trades_by_ids(conn: Any, raw_ids: list[int], raw_columns: list[str]) -> dict[int, dict[str, Any]]:
    if not raw_ids:
        return {}
    id_index = raw_columns.index("id")
    cursor = conn.execute(
        'SELECT * FROM matalia."01RawTxtData" WHERE id = ANY(%s) FOR UPDATE',
        (raw_ids,),
    )
    return {
        int(record[id_index]): dict(zip(raw_columns, record))
        for record in cursor.fetchall()
    }


def _find_existing_allocation_for_raw(conn: Any, raw_row: dict[str, Any]) -> tuple[int, int | None, str] | None:
    """Find an already allocated split row when the raw merge link is blank.

    Raw imports and SplitTrades can represent the same time/number with
    different PostgreSQL types (for example ``14.26`` vs ``14:26`` or
    ``1300`` vs ``1300.0``).  Match the effective trade using normalized
    Python values after narrowing by its stable contract fields.
    """
    records = conn.execute(
        """
        SELECT allocation.allocation_id, split_row."MergeID", allocation.strategy,
               COALESCE(split_row.trade_date, allocation.trade_date),
               COALESCE(split_row.trade_minute, allocation.trade_minute),
               COALESCE(split_row.expiry, allocation.expiry),
               COALESCE(split_row.strike, allocation.strike),
               COALESCE(split_row.quantity, allocation.quantity),
               COALESCE(split_row.average_price, allocation.average_price),
               COALESCE(split_row.account, allocation.account),
               COALESCE(split_row.scrip, allocation.scrip),
               COALESCE(split_row.option_type, allocation.option_type),
               COALESCE(split_row.trade_type, allocation.trade_type)
        FROM matalia.strategy_allocation AS allocation
        LEFT JOIN matalia."SplitTrades" AS split_row
          ON split_row.id = allocation.split_trade_id
        WHERE allocation.strategy IS NOT NULL
          AND LOWER(BTRIM(allocation.strategy)) <> 'unassigned'
        ORDER BY allocation.allocation_id
        """,
    ).fetchall()
    def date_key(value: Any) -> str:
        if isinstance(value, datetime):
            return value.date().isoformat()
        if isinstance(value, date):
            return value.isoformat()
        text = str(value or "").strip()
        for pattern in ("%Y-%m-%d", "%d-%b-%y", "%d-%b-%Y", "%d%b%Y", "%d/%m/%Y"):
            try:
                return datetime.strptime(text.title(), pattern).date().isoformat()
            except ValueError:
                continue
        return text.casefold()

    raw_date = date_key(raw_row.get("trade_date"))
    raw_time = _normalize_time(raw_row.get("trade_minute"))
    raw_expiry = _normalize_strategy_expiry(raw_row.get("expiry"))
    raw_strike = _format_trade_amount(raw_row.get("strike"))
    raw_account = str(raw_row.get("account") or "").strip().upper()
    raw_quantity = _format_trade_amount(raw_row.get("quantity"))
    raw_price = _format_trade_amount(raw_row.get("average_price"))
    raw_scrip = str(raw_row.get("scrip") or "").strip().upper()
    raw_option = str(raw_row.get("option_type") or "").strip().upper()
    raw_side = _trade_side_from_type(raw_row.get("trade_type"))
    for record in records:
        if str(record[10] or "").strip().upper() != raw_scrip:
            continue
        if str(record[11] or "").strip().upper() != raw_option:
            continue
        if _trade_side_from_type(record[12]) != raw_side:
            continue
        if date_key(record[3]) != raw_date or _normalize_time(record[4]) != raw_time:
            continue
        if _normalize_strategy_expiry(record[5]) != raw_expiry:
            continue
        if abs(_format_trade_amount(record[6]) - raw_strike) > 1e-6:
            continue
        if abs(_format_trade_amount(record[7]) - raw_quantity) > 1e-6:
            continue
        if abs(_format_trade_amount(record[8]) - raw_price) > 1e-6:
            continue
        candidate_account = str(record[9] or "").strip().upper()
        if raw_account and candidate_account and raw_account != candidate_account:
            continue
        merge_id = int(record[1]) if record[1] is not None else None
        return int(record[0]), merge_id, str(record[2] or "")
    return None


def _insert_merge_trade(conn: Any, raw_row: dict[str, Any]) -> int:
    cursor = conn.execute(
        """
        INSERT INTO matalia."MergeTrades"
        (
            trade_date,
            trade_minute,
            instrument_id,
            scrip,
            expiry,
            strike,
            option_type,
            trade_type,
            quantity,
            average_price,
            account,
            trades_merged
        )
        VALUES
        (
            %(trade_date)s,
            %(trade_minute)s,
            %(instrument_id)s,
            %(scrip)s,
            %(expiry)s,
            %(strike)s,
            %(option_type)s,
            %(trade_type)s,
            %(quantity)s,
            %(average_price)s,
            %(account)s,
            %(trades_merged)s
        )
        RETURNING id
        """,
        {
            "trade_date": raw_row.get("trade_date"),
            "trade_minute": raw_row.get("trade_minute"),
            "instrument_id": raw_row.get("instrument_id"),
            "scrip": raw_row.get("scrip"),
            "expiry": raw_row.get("expiry"),
            "strike": raw_row.get("strike"),
            "option_type": raw_row.get("option_type"),
            "trade_type": raw_row.get("trade_type"),
            "quantity": raw_row.get("quantity"),
            "average_price": raw_row.get("average_price"),
            "account": raw_row.get("account"),
            "trades_merged": raw_row.get("trades_merged") or 1,
        },
    )
    return int(cursor.fetchone()[0])


def _insert_split_trade(conn: Any, merge_trade_id: int, raw_row: dict[str, Any]) -> int:
    cursor = conn.execute(
        """
        INSERT INTO matalia."SplitTrades"
        (
            "MergeID",
            trade_date,
            trade_minute,
            instrument_id,
            scrip,
            expiry,
            strike,
            option_type,
            trade_type,
            quantity,
            average_price,
            account,
            trades_merged
        )
        VALUES
        (
            %(MergeID)s,
            %(trade_date)s,
            %(trade_minute)s,
            %(instrument_id)s,
            %(scrip)s,
            %(expiry)s,
            %(strike)s,
            %(option_type)s,
            %(trade_type)s,
            %(quantity)s,
            %(average_price)s,
            %(account)s,
            %(trades_merged)s
        )
        RETURNING id
        """,
        {
            "MergeID": merge_trade_id,
            "trade_date": raw_row.get("trade_date"),
            "trade_minute": raw_row.get("trade_minute"),
            "instrument_id": raw_row.get("instrument_id"),
            "scrip": raw_row.get("scrip"),
            "expiry": raw_row.get("expiry"),
            "strike": raw_row.get("strike"),
            "option_type": raw_row.get("option_type"),
            "trade_type": raw_row.get("trade_type"),
            "quantity": raw_row.get("quantity"),
            "average_price": raw_row.get("average_price"),
            "account": raw_row.get("account"),
            "trades_merged": 1,
        },
    )
    return int(cursor.fetchone()[0])


def _update_existing_strategy_allocation(
    conn: Any,
    row: StrategyAllocationConfirmationRow,
    allocation_columns: list[str] | None = None,
) -> tuple[bool, str | None]:
    allocation_columns = allocation_columns or _table_column_names(conn, "matalia", "strategy_allocation")
    if "strategy" not in allocation_columns:
        return False, "strategy_allocation table is missing strategy column"

    id_columns = [column for column in ["position_id", "allocation_id", "split_trade_id"] if column in allocation_columns]
    if not id_columns:
        return False, "strategy_allocation table has no matching id column"

    where_parts = [
        "trade_action = 'Entry'",
        f"({' OR '.join(f'{column}::text = %s' for column in id_columns)})",
    ]
    params: list[Any] = [row.tradeId] * len(id_columns)

    for column_name, value in (
        ("scrip", row.instrument),
        ("option_type", row.option),
        ("trade_type", "B" if row.side.strip().upper() == "BUY" else "S"),
    ):
        if column_name in allocation_columns and value != "":
            where_parts.append(f"{column_name} = %s")
            params.append(value)

    if "expiry" in allocation_columns:
        where_parts.append("REPLACE(UPPER(expiry), '-', '') = %s")
        params.append(_normalize_compact_expiry_text(row.expiry))

    cursor = conn.execute(
        f"""
        UPDATE matalia.strategy_allocation
        SET strategy = %s
        WHERE {" AND ".join(where_parts)}
        """,
        [row.strategyName, *params],
    )

    if (cursor.rowcount or 0) <= 0:
        for column_name in id_columns:
            fallback_cursor = conn.execute(
                f"""
                UPDATE matalia.strategy_allocation
                SET strategy = %s
                WHERE {column_name}::text = %s
                  AND trade_action = 'Entry'
                  AND (strategy IS NULL OR LOWER(BTRIM(strategy)) = 'unassigned')
                """,
                (row.strategyName, row.tradeId),
            )
            if (fallback_cursor.rowcount or 0) > 0:
                return True, f"Updated strategy allocation for trade {row.tradeId}"
        return False, f"No open strategy allocation row matched trade {row.tradeId}"

    return True, f"Updated strategy allocation for trade {row.tradeId}"


def _insert_strategy_allocation_row(
    conn: Any,
    split_trade_id: int,
    split_row: dict[str, Any],
    strategy_name: str,
    position_id: str,
    trade_action: str,
    parent_quantity: Any | None = None,
    split_sequence: int = 1,
    matched_entry_id: Any = None,
) -> int:
    cursor = conn.execute(
        """
        INSERT INTO matalia.strategy_allocation
        (
            split_trade_id,
            position_id,
            trade_date,
            trade_minute,
            instrument_id,
            scrip,
            expiry,
            strike,
            option_type,
            trade_type,
            parent_quantity,
            split_sequence,
            quantity,
            average_price,
            account,
            strategy,
            trade_action,
            status,
            is_split
        )
        VALUES
        (
            %(split_trade_id)s,
            %(position_id)s,
            %(trade_date)s,
            %(trade_minute)s,
            %(instrument_id)s,
            %(scrip)s,
            %(expiry)s,
            %(strike)s,
            %(option_type)s,
            %(trade_type)s,
            %(parent_quantity)s,
            %(split_sequence)s,
            %(quantity)s,
            %(average_price)s,
            %(account)s,
            %(strategy)s,
            %(trade_action)s,
            %(status)s,
            %(is_split)s
        )
        RETURNING allocation_id
        """,
        {
            "split_trade_id": split_trade_id,
            "position_id": position_id,
            "trade_date": split_row.get("trade_date"),
            "trade_minute": split_row.get("trade_minute"),
            "instrument_id": split_row.get("instrument_id"),
            "scrip": split_row.get("scrip"),
            "expiry": split_row.get("expiry"),
            "strike": split_row.get("strike"),
            "option_type": split_row.get("option_type"),
            "trade_type": split_row.get("trade_type"),
            "parent_quantity": parent_quantity if parent_quantity is not None else split_row.get("quantity"),
            "split_sequence": split_sequence,
            "quantity": split_row.get("quantity"),
            "average_price": split_row.get("average_price"),
            "account": split_row.get("account"),
            "strategy": strategy_name,
            "trade_action": trade_action,
            "status": "Open" if trade_action == "Entry" else "Closed",
            "is_split": False,
        },
    )
    if trade_action == "Exit" and matched_entry_id is not None:
        conn.execute(
            "UPDATE matalia.strategy_allocation SET status = 'Closed' WHERE allocation_id = %s AND trade_action = 'Entry'",
            (matched_entry_id,),
        )
    return int(cursor.fetchone()[0])


def _resolve_allocation_context(
    conn: Any,
    available_positions: PositionManager,
    split_row: dict[str, Any],
    strategy_name: str,
) -> tuple[str, str, dict[str, Any] | None]:
    match = available_positions.find_matching_position(split_row, strategy_name)
    if match is not None:
        position_id, entry = match
        return "Exit", str(position_id), entry
    return "Entry", str(get_next_position_id(conn)), None


def _promote_split_lineage_confirmation(conn: Any, row: StrategyAllocationConfirmationRow) -> bool:
    """Recover raw-parent lineage when an older UI sends a merge/split row as open."""
    candidate_ids: list[int] = []
    for value in (row.splitTradeId, row.tradeId, row.sourceId):
        try:
            candidate = int(value)
        except (TypeError, ValueError):
            continue
        if candidate not in candidate_ids:
            candidate_ids.append(candidate)

    for candidate in candidate_ids:
        split_record = conn.execute(
            '''
            SELECT id, "MergeID", scrip, expiry, strike, option_type,
                   trade_type, quantity, average_price, account
            FROM matalia."SplitTrades"
            WHERE id = %s
            ''',
            (candidate,),
        ).fetchone()
        if split_record is None:
            split_record = conn.execute(
                '''
                SELECT id, "MergeID", scrip, expiry, strike, option_type,
                       trade_type, quantity, average_price, account
                FROM matalia."SplitTrades"
                WHERE "MergeID" = %s
                ORDER BY id
                LIMIT 1
                ''',
                (candidate,),
            ).fetchone()
        if split_record is None:
            continue
        split_contract = {
            "scrip": split_record[2],
            "expiry": split_record[3],
            "strike": split_record[4],
            "option_type": split_record[5],
            "trade_type": split_record[6],
            "quantity": split_record[7],
            "average_price": split_record[8],
        }
        if not _confirmation_row_matches_contract(row, split_contract):
            logger.warning(
                "instrument_allocation_lineage_mismatch candidate=%s requested=%s %s @ %s %s %s",
                candidate, row.instrument, row.expiry, row.strike, row.option, row.side,
            )
            continue
        merge_record = conn.execute(
            '''
            SELECT trade_date, trade_minute, scrip, expiry, strike,
                   option_type, trade_type, account
            FROM matalia."MergeTrades"
            WHERE id = %s
            ''',
            (split_record[1],),
        ).fetchone()
        raw_record = conn.execute(
            'SELECT id FROM matalia."01RawTxtData" WHERE merge_trade_id = %s ORDER BY id LIMIT 1',
            (split_record[1],),
        ).fetchone()
        if raw_record is None and merge_record is not None:
            raw_record = conn.execute(
                '''
                SELECT id
                FROM matalia."01RawTxtData"
                WHERE (merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = '')
                  AND trade_date IS NOT DISTINCT FROM %s
                  AND trade_minute IS NOT DISTINCT FROM %s
                  AND scrip IS NOT DISTINCT FROM %s
                  AND expiry IS NOT DISTINCT FROM %s
                  AND strike IS NOT DISTINCT FROM %s
                  AND option_type IS NOT DISTINCT FROM %s
                  AND trade_type IS NOT DISTINCT FROM %s
                  AND account IS NOT DISTINCT FROM %s
                ORDER BY id
                LIMIT 1
                ''',
                merge_record,
            ).fetchone()
        if raw_record is None and merge_record is not None:
            raw_record = conn.execute(
                '''
                SELECT id
                FROM matalia."01RawTxtData"
                WHERE (merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = '')
                  AND scrip IS NOT DISTINCT FROM %s
                  AND expiry IS NOT DISTINCT FROM %s
                  AND strike IS NOT DISTINCT FROM %s
                  AND option_type IS NOT DISTINCT FROM %s
                  AND trade_type IS NOT DISTINCT FROM %s
                  AND account IS NOT DISTINCT FROM %s
                ORDER BY id
                LIMIT 1
                ''',
                merge_record[2:]
            ).fetchone()
        if raw_record is None:
            continue
        conn.execute(
            'UPDATE matalia."01RawTxtData" SET merge_trade_id = %s WHERE id = %s AND (merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = \'\')',
            (split_record[1], raw_record[0]),
        )
        row.source = STRATEGY_ALLOCATION_SOURCE_ROWS
        row.sourceId = str(raw_record[0])
        row.splitTradeId = str(split_record[0])
        return True
    return False


def _process_raw_batch_split(
    conn: Any,
    row: StrategyAllocationConfirmationRow,
    available_positions: PositionManager,
    raw_columns: list[str] | None = None,
    raw_rows_by_id: dict[int, dict[str, Any]] | None = None,
    pending_split_rows_by_raw_id: dict[Any, list[dict[str, Any]]] | None = None,
    progress_id: str | None = None,
    progress_index: int | None = None,
    recompute_groups: dict[tuple[str, ...], dict[str, Any]] | None = None,
    preassigned_allocations: dict[int, int] | None = None,
) -> tuple[bool, str | None]:
    if row.source.strip() != STRATEGY_ALLOCATION_SOURCE_ROWS:
        return False, f"Trade {row.sourceId} is not a raw trade"

    try:
        raw_id = int(row.sourceId)
    except ValueError:
        return False, f"Trade {row.sourceId} has an invalid raw ID"

    def process_step(step_key: str, status: str, detail: str) -> None:
        if progress_index is not None:
            _confirmation_trade_process_update(progress_id, progress_index, step_key, status, detail)

    def queue_recompute(contract_row: dict[str, Any]) -> None:
        if recompute_groups is None:
            recomputed_rows = _recompute_strategy_contract_allocations(conn, contract_row, row.strategyName)
            available_positions.replace_contract_rows(recomputed_rows)
            process_step("matching", "completed", "Entry / Exit match recalculated")
            process_step("recalculate", "completed", f"Updated {len(recomputed_rows)} matching position row(s)")
            return
        group_key = _confirmation_contract_group_key(contract_row, row.strategyName)
        group = recompute_groups.setdefault(
            group_key,
            {
                "contract_row": dict(contract_row),
                "strategy_name": row.strategyName,
                "row_indexes": set(),
            },
        )
        if progress_index is not None:
            group["row_indexes"].add(progress_index)

    process_step("source", "processing", f"Reading raw trade {raw_id}")
    raw_row = raw_rows_by_id.get(raw_id) if raw_rows_by_id is not None else _load_raw_trade_by_id(conn, raw_id, raw_columns)
    if raw_row is None:
        process_step("source", "failed", f"Raw trade {raw_id} was not found")
        return False, f"Trade {raw_id} was not found"
    process_step("source", "completed", f"Loaded raw trade {raw_id}")

    process_step("merge", "processing", "Checking MergeTrades record")
    raw_merge_id = raw_row.get("merge_trade_id")
    pending_split_rows = (pending_split_rows_by_raw_id or {}).get(raw_id, [])
    if not _merge_trade_id_is_blank(raw_merge_id):
        merge_trade_id = int(raw_merge_id)
        if not row.splitTradeId and _merge_has_strategy_allocations(conn, merge_trade_id):
            return False, f"Trade {raw_id} has already been allocated"
    else:
        merge_trade_id = int(pending_split_rows[0]["MergeID"]) if pending_split_rows else None
    existing_split_rows = pending_split_rows or (_load_split_rows_for_merge(conn, merge_trade_id) if merge_trade_id is not None else [])
    merge_was_created = merge_trade_id is None
    if merge_trade_id is None:
        merge_trade_id = _insert_merge_trade(conn, raw_row)

    if _merge_trade_id_is_blank(raw_merge_id):
        conn.execute(
            "UPDATE matalia.\"01RawTxtData\" SET merge_trade_id = %s WHERE id = %s AND (merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = '')",
            (merge_trade_id, raw_id),
        )
    process_step(
        "merge",
        "completed",
        f"{'Created' if merge_was_created else 'Using existing'} MergeTrades record {merge_trade_id}",
    )

    process_step("split", "processing", "Checking SplitTrades record")
    if existing_split_rows:
        split_rows = existing_split_rows
    else:
        split_rows = [{**raw_row, "trades_merged": 1}]
        split_rows[0]["id"] = _insert_split_trade(conn, merge_trade_id, split_rows[0])
    process_step(
        "split",
        "completed",
        f"{'Created' if not existing_split_rows else 'Using existing'} SplitTrades record(s)",
    )

    if row.splitTradeId:
        split_rows = [split_row for split_row in split_rows if str(split_row.get("id")) == str(row.splitTradeId)]
        if not split_rows:
            return False, f"Split trade {row.splitTradeId} was not found for raw trade {raw_id}"
    elif len(split_rows) > 1:
        # Never allocate every child merely because they share one MergeID.
        # A split child is an independent quantity. If an older client omitted
        # its child id, only continue when the row values identify exactly one
        # child; otherwise fail safely instead of closing/allocating siblings.
        def _same_number(left: Any, right: Any) -> bool:
            try:
                return abs(float(left or 0) - float(right or 0)) < 0.0001
            except (TypeError, ValueError):
                return False

        candidates = [
            split_row for split_row in split_rows
            if _same_number(split_row.get("quantity"), row.qty)
            and _same_number(split_row.get("average_price"), row.price)
            and _trade_side_from_type(split_row.get("trade_type")) == row.side.upper()
        ]
        if len(candidates) != 1:
            return False, (
                f"Split trade ID is required for raw trade {raw_id}; "
                "the selected quantity could not be matched to exactly one split child"
            )
        split_rows = candidates

    allocation_ids: list[int] = []
    for sequence, split_row in enumerate(split_rows, start=1):
        split_trade_id = int(split_row["id"])
        process_step("strategy", "processing", f"Assigning strategy '{row.strategyName}' to split trade {split_trade_id}")
        preassigned_allocation_id = (preassigned_allocations or {}).get(split_trade_id)
        if preassigned_allocation_id is not None:
            allocation_ids.append(preassigned_allocation_id)
            process_step("strategy", "completed", f"Updated allocation {preassigned_allocation_id} in batch")
            process_step("matching", "processing", "Queued for batch Entry / Exit matching")
            process_step("recalculate", "processing", "Queued for batch position recalculation")
            queue_recompute(split_row)
            process_step("queued", "completed", "Changes queued for final database save")
            continue
        placeholder_cursor = conn.execute(
            """
            UPDATE matalia.strategy_allocation
            SET strategy = %s, status = 'Open'
            WHERE split_trade_id = %s
              AND trade_action = 'Entry'
              AND (strategy IS NULL OR LOWER(BTRIM(strategy)) = 'unassigned')
            RETURNING allocation_id
            """,
            (row.strategyName, split_trade_id),
        )
        placeholder = placeholder_cursor.fetchone()
        if placeholder is not None:
            allocation_ids.append(int(placeholder[0]))
            process_step("strategy", "completed", f"Updated allocation {placeholder[0]}")
            process_step("matching", "processing", "Queued for batch Entry / Exit matching")
            process_step("recalculate", "processing", "Queued for batch position recalculation")
            queue_recompute(split_row)
            process_step("queued", "completed", "Changes queued for final database save")
            continue
        existing_cursor = conn.execute(
            """
            SELECT allocation_id, strategy
            FROM matalia.strategy_allocation
            WHERE split_trade_id = %s
              AND trade_action = 'Entry'
            ORDER BY allocation_id
            LIMIT 1
            """,
            (split_trade_id,),
        )
        existing = existing_cursor.fetchone()
        if existing is not None and str(existing[1] or '').strip().casefold() == row.strategyName.strip().casefold():
            allocation_ids.append(int(existing[0]))
            process_step("strategy", "completed", f"Using existing allocation {existing[0]}")
            process_step("matching", "processing", "Queued for batch Entry / Exit matching")
            process_step("recalculate", "processing", "Queued for batch position recalculation")
            queue_recompute(split_row)
            process_step("queued", "completed", "Changes queued for final database save")
            continue
        if _split_trade_has_strategy_allocations(conn, split_trade_id):
            process_step("strategy", "failed", f"Split trade {split_trade_id} is already allocated")
            return False, f"Split trade {split_trade_id} has already been allocated"
        process_step("strategy", "completed", "Strategy allocation row is ready")
        process_step("matching", "processing", "Looking for an opposite-side open position")
        trade_action, position_id, matched_entry = _resolve_allocation_context(conn, available_positions, split_row, row.strategyName)
        process_step(
            "matching",
            "completed",
            f"Provisional {trade_action} using position {position_id}; final batch check pending",
        )
        allocation_id = _insert_strategy_allocation_row(
            conn,
            split_trade_id,
            split_row,
            row.strategyName,
            position_id,
            trade_action,
            parent_quantity=raw_row.get("quantity"),
            split_sequence=sequence,
            matched_entry_id=matched_entry.get("allocation_id") if matched_entry else None,
        )
        allocation_ids.append(allocation_id)
        if trade_action == "Entry":
            available_positions.add_entry([{
                "position_id": position_id,
                "account": split_row.get("account"),
                "instrument_id": split_row.get("instrument_id"),
                "strategy": row.strategyName,
                "split_sequence": sequence,
                "trade_action": "Entry",
                "quantity": split_row.get("quantity"),
                "parent_quantity": raw_row.get("quantity"),
                "trade_date": split_row.get("trade_date"),
                "trade_minute": split_row.get("trade_minute"),
                "scrip": split_row.get("scrip"),
                "expiry": split_row.get("expiry"),
                "strike": split_row.get("strike"),
                "option_type": split_row.get("option_type"),
                "trade_type": split_row.get("trade_type"),
                "average_price": split_row.get("average_price"),
                "allocation_id": allocation_id,
            }])
        else:
            available_positions.close_position(position_id, matched_entry.get("allocation_id") if matched_entry else None)

        process_step("recalculate", "processing", "Queued for batch position recalculation")
        queue_recompute(split_row)
        process_step("queued", "completed", "Changes queued for final database save")

    return True, (
        f"Processed raw trade {raw_id} into MergeTrades {merge_trade_id}, "
        f"{len(split_rows)} SplitTrades, and {len(allocation_ids)} StrategyAllocation rows"
    )


def confirm_strategy_allocations(
    conn: Any,
    rows: list[StrategyAllocationConfirmationRow],
    progress_id: str | None = None,
) -> dict[str, Any]:
    started_at = perf_counter()
    processed = 0
    skipped = 0
    merge_count = 0
    split_count = 0
    allocation_count = 0
    errors: list[str] = []
    details: list[str] = []
    row_statuses = ["waiting"] * len(rows)
    current_index = -1
    recompute_groups: dict[tuple[str, ...], dict[str, Any]] = {}
    _confirmation_progress_update(
        progress_id,
        stage="loading",
        message="Loading current positions",
    )

    # Split-source suggestions still need to be converted to their raw parent
    # before the sequential confirmation path can process them.
    for row in rows:
        if row.source.strip() != STRATEGY_ALLOCATION_SOURCE_ROWS:
            _promote_split_lineage_confirmation(conn, row)

    seen_source_ids: set[str] = set()
    ledger_started_at = perf_counter()
    allocation_df = _load_confirmation_position_ledger(conn, rows)
    ledger_ms = (perf_counter() - ledger_started_at) * 1000
    position_started_at = perf_counter()
    available_positions = PositionManager.from_allocation_table(allocation_df)
    position_ms = (perf_counter() - position_started_at) * 1000
    schema_started_at = perf_counter()
    raw_columns = _table_column_names(conn, "matalia", "01RawTxtData")
    allocation_columns = _table_column_names(conn, "matalia", "strategy_allocation")
    schema_ms = (perf_counter() - schema_started_at) * 1000
    raw_ids: list[int] = []
    for row in rows:
        if row.source.strip() != STRATEGY_ALLOCATION_SOURCE_ROWS:
            continue
        try:
            raw_ids.append(int(row.sourceId))
        except (TypeError, ValueError):
            continue
    raw_rows_by_id = _load_raw_trades_by_ids(conn, sorted(set(raw_ids)), raw_columns)
    pending_split_rows_by_raw_id = (
        _load_pending_split_rows_by_raw_id(conn, sorted(set(raw_ids)))
        if raw_ids else {}
    )
    _confirmation_progress_update(
        progress_id,
        stage="loading",
        message="Preparing selected trades for sequential confirmation",
    )
    # Keep the reliable row-by-row path as the only active confirmation mode.
    # The former bulk path remains in the source for reference, but is no
    # longer called because it rejects valid legacy allocation records.
    preassigned_allocations: dict[int, int] = {}
    processing_started_at = perf_counter()
    _confirmation_progress_update(
        progress_id,
        stage="processing",
        message="Starting row-by-row trade confirmation",
    )

    try:
        _confirmation_progress_update(progress_id, message="Using the sequential confirmation path")
        for index, row in enumerate(rows):
            current_index = index
            row_statuses[index] = "processing"
            _confirmation_progress_update(
                progress_id,
                stage="processing",
                current_index=index,
                current_trade=_confirmation_trade_label(row),
                row_statuses=list(row_statuses),
                message=f"Processing trade {index + 1} of {len(rows)}",
            )
            source_id = row.sourceId.strip()
            if not source_id:
                skipped += 1
                errors.append("Skipped a row with no raw trade ID")
                row_statuses[index] = "skipped"
                _confirmation_progress_update(
                    progress_id,
                    completed_rows=index + 1,
                    skipped_count=skipped,
                    row_statuses=list(row_statuses),
                    message=f"Skipped trade {index + 1} of {len(rows)}",
                )
                continue

            source_key = f"{source_id}:{row.splitTradeId or ''}"
            if source_key in seen_source_ids:
                skipped += 1
                errors.append(f"Skipped duplicate trade {source_key} in the same request")
                row_statuses[index] = "skipped"
                _confirmation_progress_update(
                    progress_id,
                    completed_rows=index + 1,
                    skipped_count=skipped,
                    row_statuses=list(row_statuses),
                    message=f"Skipped duplicate trade {index + 1} of {len(rows)}",
                )
                continue
            seen_source_ids.add(source_key)

            if row.source.strip() == STRATEGY_ALLOCATION_SOURCE_ROWS:
                success, message = _process_raw_batch_split(
                    conn,
                    row,
                    available_positions,
                    raw_columns,
                    raw_rows_by_id,
                    pending_split_rows_by_raw_id,
                    progress_id,
                    index,
                    recompute_groups,
                    preassigned_allocations,
                )
            else:
                _confirmation_trade_process_update(progress_id, index, "source", "completed", "Using existing allocation source row")
                _confirmation_trade_process_update(progress_id, index, "merge", "skipped", "MergeTrades already exists")
                _confirmation_trade_process_update(progress_id, index, "split", "skipped", "SplitTrades already exists")
                _confirmation_trade_process_update(progress_id, index, "strategy", "processing", f"Updating strategy '{row.strategyName}'")
                success, message = _update_existing_strategy_allocation(conn, row, allocation_columns)
                if success:
                    _confirmation_trade_process_update(progress_id, index, "strategy", "completed", "Existing strategy allocation updated")
                    _confirmation_trade_process_update(progress_id, index, "matching", "skipped", "No new Entry / Exit match required")
                    _confirmation_trade_process_update(progress_id, index, "recalculate", "skipped", "No contract rebuild required for this row")
                    _confirmation_trade_process_update(progress_id, index, "queued", "completed", "Changes queued for final database save")
                else:
                    _confirmation_trade_process_update(progress_id, index, "strategy", "failed", message or "Strategy allocation update failed")
            if success:
                processed += 1
                if row.source.strip() == STRATEGY_ALLOCATION_SOURCE_ROWS:
                    merge_count += 1
                    split_count += 1
                    allocation_count += 1
                else:
                    allocation_count += 1
                if message:
                    details.append(message)
            else:
                skipped += 1
                if message:
                    errors.append(message)
            row_statuses[index] = "completed" if success else "skipped"
            _confirmation_progress_update(
                progress_id,
                completed_rows=index + 1,
                processed_count=processed,
                skipped_count=skipped,
                row_statuses=list(row_statuses),
                message=(
                    f"Completed trade {index + 1} of {len(rows)}"
                    if success else f"Skipped trade {index + 1} of {len(rows)}"
                ),
            )

        recompute_started_at = perf_counter()
        recompute_group_count = len(recompute_groups)
        _confirmation_progress_update(
            progress_id,
            stage="finalizing",
            current_index=len(rows),
            current_trade=None,
            row_statuses=list(row_statuses),
            message=(
                f"Recalculating {recompute_group_count} affected position group(s)"
                if recompute_group_count
                else "No position recalculation required"
            ),
        )
        for group_index, group in enumerate(recompute_groups.values(), start=1):
            _confirmation_progress_update(
                progress_id,
                message=f"Recalculating position group {group_index} of {recompute_group_count}",
            )
            recomputed_rows = _recompute_strategy_contract_allocations(
                conn,
                group["contract_row"],
                group["strategy_name"],
            )
            available_positions.replace_contract_rows(recomputed_rows)
            for row_index in group["row_indexes"]:
                _confirmation_trade_process_update(
                    progress_id,
                    row_index,
                    "matching",
                    "completed",
                    "Final Entry / Exit match completed in batch",
                )
                _confirmation_trade_process_update(
                    progress_id,
                    row_index,
                    "recalculate",
                    "completed",
                    f"Batch updated {len(recomputed_rows)} matching position row(s)",
                )
        recompute_ms = (perf_counter() - recompute_started_at) * 1000
        processing_ms = (perf_counter() - processing_started_at) * 1000
        _confirmation_progress_update(
            progress_id,
            stage="finalizing",
            current_index=len(rows),
            current_trade=None,
            row_statuses=list(row_statuses),
            message="Finalizing database changes",
        )
        commit_started_at = perf_counter()
        _touch_data_version_in_transaction(conn, "allocation")
        conn.commit()
        commit_ms = (perf_counter() - commit_started_at) * 1000
        invalidation_started_at = perf_counter()
        _record_data_version_fallback("allocation")
        DATA_CACHE.clear()
        invalidation_ms = (perf_counter() - invalidation_started_at) * 1000
        total_ms = (perf_counter() - started_at) * 1000
        logger.info(
            "instrument_allocation_confirm stages rows=%d processed=%d skipped=%d mode=sequential groups=%d ledger_ms=%.1f position_ms=%.1f schema_ms=%.1f processing_ms=%.1f recompute_ms=%.1f commit_ms=%.1f invalidation_ms=%.1f total_ms=%.1f",
            len(rows), processed, skipped, recompute_group_count, ledger_ms, position_ms, schema_ms, processing_ms, recompute_ms, commit_ms, invalidation_ms, total_ms,
        )
        _confirmation_progress_update(
            progress_id,
            status="completed",
            stage="completed",
            completed_rows=len(rows),
            processed_count=processed,
            skipped_count=skipped,
            current_index=len(rows),
            current_trade=None,
            row_statuses=list(row_statuses),
            message="Confirmation completed",
        )
        return {
            "processed_count": processed,
            "merge_count": merge_count,
            "split_count": split_count,
            "allocation_count": allocation_count,
            "skipped_count": skipped,
            "errors": errors,
            "details": details,
        }
    except Exception as error:
        conn.rollback()
        _confirmation_progress_update(
            progress_id,
            status="failed",
            stage="failed",
            current_index=current_index,
            row_statuses=[
                "failed" if index == current_index and status == "processing" else status
                for index, status in enumerate(row_statuses)
            ],
            error=str(error),
            message="Confirmation failed",
        )
        raise


def _set_pipeline_state(**updates: Any) -> dict[str, Any]:
    with PIPELINE_LOCK:
        PIPELINE_STATE.update(updates)
        if updates.get("stage") in {"ready", "error"}:
            _invalidate_data_cache()
        return dict(PIPELINE_STATE)


def _get_pipeline_state() -> dict[str, Any]:
    with PIPELINE_LOCK:
        return dict(PIPELINE_STATE)


def _run_step(step_name: str, script_name: str) -> int:
    command = [sys.executable, "-u", str(PROJECT_ROOT / "backend" / script_name)]
    _set_pipeline_state(stage=step_name, message=f"Running {script_name}")
    _write_log_line(f"[{_timestamp()}] >>> {step_name} started")

    process = subprocess.Popen(
        command,
        cwd=PROJECT_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
    )

    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip()
        if line:
            _write_log_line(f"[{_timestamp()}] [{script_name}] {line}")

    return_code = process.wait()
    _write_log_line(f"[{_timestamp()}] <<< {step_name} finished (code {return_code})")
    return return_code


@app.post("/api/pipeline/import")
def import_pipeline() -> JSONResponse:
    if not _staged_txt_files():
        message = "No TXT files are staged. Select one or more .txt files before running the import pipeline."
        finished_at = datetime.now().isoformat(timespec="seconds")
        _set_pipeline_state(
            running=False,
            stage="error",
            message=message,
            finished_at=finished_at,
            return_code=400,
            failed_step="Upload",
            error=message,
        )
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "message": message,
                "failed_step": "Upload",
                "return_code": 400,
                **_get_pipeline_state(),
            },
        )
    _reset_log()
    now = datetime.now().isoformat(timespec="seconds")
    _set_pipeline_state(
        running=True,
        stage="01_Txt_DB.py",
        message="Starting raw trade import",
        started_at=now,
        finished_at=None,
        last_run_at=now,
        return_code=None,
        failed_step=None,
        error=None,
        files=[],
        failed_files=[],
    )
    _write_log_line(f"[{_timestamp()}] Pipeline started")

    first_return_code = _run_step("01_Txt_DB.py", "01_Txt_DB.py")
    if first_return_code != 0:
        file_results = _parse_import_file_results(_read_log_tail())
        failed_files = [result for result in file_results if result.get("status") == "failed"]
        failure_message = _format_import_failure(file_results, "Pipeline failed in 01_Txt_DB.py")
        _write_log_line(f"[{_timestamp()}] Pipeline failed in 01_Txt_DB.py")
        _set_pipeline_state(
            running=False,
            stage="error",
            message=failure_message,
            finished_at=datetime.now().isoformat(timespec="seconds"),
            return_code=first_return_code,
            failed_step="01_Txt_DB.py",
            error=failure_message,
            files=file_results,
            failed_files=failed_files,
        )
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "failed_step": "01_Txt_DB.py",
                "return_code": first_return_code,
                "message": failure_message,
                "error": failure_message,
                "files": file_results,
                "failed_files": failed_files,
                "log": _read_log_tail(),
                **_get_pipeline_state(),
            },
        )

    _write_log_line(f"[{_timestamp()}] Pipeline completed successfully")
    file_results = _parse_import_file_results(_read_log_tail())
    _set_pipeline_state(
        running=False,
        stage="ready",
        message="Pipeline completed successfully",
        finished_at=datetime.now().isoformat(timespec="seconds"),
        return_code=0,
        failed_step=None,
        error=None,
        files=file_results,
        failed_files=[],
    )
    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            "message": "Pipeline completed successfully",
            "files": file_results,
            "failed_files": [],
            "log": _read_log_tail(),
            **_get_pipeline_state(),
        },
    )


@app.get("/api/pipeline/import/log")
def import_pipeline_log() -> JSONResponse:
    state = _get_pipeline_state()
    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            **state,
            "log": _read_log_tail(),
            "log_path": str(PIPELINE_LOG_PATH),
        },
    )


@app.get("/api/rawtxtdata")
def rawtxtdata() -> JSONResponse:
    try:
        def load() -> dict[str, Any]:
            with connect() as conn:
                cursor = conn.execute('SELECT * FROM matalia."01RawTxtData"')
                columns = [column.name for column in cursor.description]
                rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
            return {"success": True, "rows": jsonable_encoder(rows), "total_rows": len(rows)}
        return JSONResponse(status_code=200, content=_cached_data("rawtxtdata", load))
    except Exception as error:
        return JSONResponse(
            status_code=502,
            content={"success": False, "message": f'Unable to load matalia."01RawTxtData": {error}'},
        )


@app.get("/api/trade-book")
def trade_book(view: str = "all") -> JSONResponse:
    request_started_at = perf_counter()
    try:
        selected_view = _normalize_trade_tab(view)
        def load() -> dict[str, Any]:
            load_started_at = perf_counter()
            with connect() as conn:
                effective_views = _load_effective_trade_book_rows(conn)
                rows = effective_views[selected_view]
                counts = {tab: len(view_rows) for tab, view_rows in effective_views.items()}
            expected_rows = counts[selected_view]
            verification = {
                "source": "Supabase",
                "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "counts_match": len(rows) == expected_rows,
                "rows_count": len(rows),
                "expected_rows": expected_rows,
            }
            serialization_started_at = perf_counter()
            content = {
                "success": True,
                "view": selected_view,
                "rows": jsonable_encoder(rows),
                "counts": counts,
                "total_rows": len(rows),
                "verification": verification,
            }
            logger.info(
                "trade_book_load view=%s rows=%d serialization_ms=%.1f total_ms=%.1f",
                selected_view, len(rows), (perf_counter() - serialization_started_at) * 1000,
                (perf_counter() - load_started_at) * 1000,
            )
            return content
        cache_key = f"trade-book:{selected_view}"
        cached = DATA_CACHE.get(cache_key)
        if cached and datetime.now().timestamp() - cached[0] < DATA_CACHE_TTL_SECONDS:
            logger.info(
                "trade_book_request view=%s cache_hit=true total_ms=%.1f",
                selected_view, (perf_counter() - request_started_at) * 1000,
            )
            return JSONResponse(status_code=200, content=cached[1])
        content = load()
        DATA_CACHE[cache_key] = (datetime.now().timestamp(), content)
        logger.info(
            "trade_book_request view=%s cache_hit=false total_ms=%.1f",
            selected_view, (perf_counter() - request_started_at) * 1000,
        )
        return JSONResponse(status_code=200, content=content)
    except Exception as error:
        return JSONResponse(
            status_code=502,
            content={"success": False, "message": f"Unable to load trade book data: {error}"},
        )


@app.delete("/api/trade-book/{trade_id}")
def delete_trade_book_trade(trade_id: str) -> JSONResponse:
    try:
        if not trade_id.strip():
            return JSONResponse(status_code=400, content={"success": False, "message": "Trade ID is required"})

        with connect() as conn:
            deleted = _delete_trade_family(conn, trade_id)

        if deleted["allocation_count"] == 0:
            return JSONResponse(
                status_code=404,
                content={"success": False, "message": f"Trade {trade_id} was not found in strategy_allocation"},
            )

        _invalidate_data_cache()

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "trade_id": trade_id,
                **deleted,
                "message": (
                    f"Trade {trade_id} deleted from strategy_allocation, SplitTrades, and MergeTrades; "
                    f"cleared merge_trade_id on {deleted['raw_updated_count']} raw row(s)."
                ),
            },
        )
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to delete trade: {error}"})


@app.get("/api/strategy-allocation")
def strategy_allocation(fresh: bool = Query(default=False)) -> JSONResponse:
    request_started_at = perf_counter()
    try:
        def load() -> dict[str, Any]:
            load_started_at = perf_counter()
            with connect() as conn:
                rows = _load_strategy_allocation_rows(conn)
            database_ms = (perf_counter() - load_started_at) * 1000
            open_rows = sum(1 for row in rows if row.get("bucket") == "Open")
            unassigned_rows = sum(1 for row in rows if row.get("bucket") == "Unassigned")
            strategy_names = {
                str(row.get("strategy") or "").strip()
                for row in rows
                if row.get("source") == "strategy_open" and str(row.get("strategy") or "").strip()
            }
            # Keep the summary counts based on the raw/open rows actually
            # rendered so the verification status matches the user's view.
            counts = {
                "Strategies": len(strategy_names),
                "Open Trades": open_rows,
                "Unassigned Trades": unassigned_rows,
                "Allocated Trades": open_rows,
            }
            expected_rows = counts["Open Trades"] + counts["Unassigned Trades"]
            verification = {
                "source": "Supabase",
                "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "counts_match": (
                    open_rows == counts["Open Trades"]
                    and unassigned_rows == counts["Unassigned Trades"]
                    and len(rows) == expected_rows
                ),
                "open_rows": open_rows,
                "unassigned_rows": unassigned_rows,
                "expected_rows": expected_rows,
            }
            serialization_started_at = perf_counter()
            content = {
                "success": True,
                "rows": jsonable_encoder(rows),
                "counts": counts,
                "total_rows": len(rows),
                "verification": verification,
            }
            serialization_ms = (perf_counter() - serialization_started_at) * 1000
            logger.info(
                "strategy_allocation_load rows=%d database_ms=%.1f serialization_ms=%.1f total_ms=%.1f",
                len(rows), database_ms, serialization_ms, (perf_counter() - load_started_at) * 1000,
            )
            return content

        if fresh:
            DATA_CACHE.pop("strategy-allocation", None)
            content = load()
            logger.info(
                "strategy_allocation_request fresh=true cache_hit=false total_ms=%.1f",
                (perf_counter() - request_started_at) * 1000,
            )
            return JSONResponse(status_code=200, content=content)

        cached = DATA_CACHE.get("strategy-allocation")
        if cached and datetime.now().timestamp() - cached[0] < DATA_CACHE_TTL_SECONDS:
            logger.info(
                "strategy_allocation_request fresh=false cache_hit=true total_ms=%.1f",
                (perf_counter() - request_started_at) * 1000,
            )
            return JSONResponse(status_code=200, content=cached[1])

        content = load()
        DATA_CACHE["strategy-allocation"] = (datetime.now().timestamp(), content)
        logger.info(
            "strategy_allocation_request fresh=false cache_hit=false total_ms=%.1f",
            (perf_counter() - request_started_at) * 1000,
        )
        return JSONResponse(status_code=200, content=content)


    except Exception as error:
        return JSONResponse(
            status_code=502,
            content={"success": False, "message": f"Unable to load strategy allocation data: {error}"},
        )


@app.get("/api/strategy-report")
def strategy_report(
    from_date: str | None = Query(default=None, alias="fromDate"),
    to_date: str | None = Query(default=None, alias="toDate"),
    instrument: str = "All Instruments",
    strategy: str = "All Strategies",
) -> JSONResponse:
    try:
        parsed_from = date.fromisoformat(from_date) if from_date else None
        parsed_to = date.fromisoformat(to_date) if to_date else None
        with connect() as conn:
            report = build_dashboard(conn, parsed_from, parsed_to, instrument, strategy)
        return JSONResponse(status_code=200, content=jsonable_encoder(report))
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to build strategy report: {error}"})


@app.get("/api/strategy-master")
def strategy_master() -> JSONResponse:
    try:
        with connect() as conn:
            rows = load_strategy_master_rows(conn)
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "rows": jsonable_encoder(rows),
                "total_rows": len(rows),
            },
        )
    except Exception as error:
        return JSONResponse(
            status_code=502,
            content={"success": False, "message": f"Unable to load strategy master data: {error}"},
        )


@app.get("/api/data-versions")
def data_versions() -> JSONResponse:
    try:
        with connect() as conn:
            versions = _read_data_versions(conn)
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "versions": {
                    "allocation": versions["allocation"],
                    "strategyMaster": versions["strategy_master"],
                },
            },
        )
    except Exception as error:
        with DATA_VERSION_LOCK:
            fallback = {key: dict(value) for key, value in DATA_VERSION_FALLBACK.items()}
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "versions": {
                    "allocation": fallback["allocation"],
                    "strategyMaster": fallback["strategy_master"],
                },
                "degraded": True,
                "message": f"Data version metadata temporarily unavailable: {error}",
            },
        )


@app.post("/api/strategy-master/next-expiry")
def strategy_master_next_expiry(payload: StrategyNextExpiryRequest) -> JSONResponse:
    try:
        return JSONResponse(
            status_code=200,
            content={"success": True, "expiries": next_expiries(payload.expiries)},
        )
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to calculate next expiry: {error}"})


@app.post("/api/strategy-master")
def save_strategy_master(payload: StrategySetupRequest) -> JSONResponse:
    try:
        with connect() as conn:
            rows, updated_rows = save_strategy_setup(conn, payload)
        _touch_data_version("strategy_master")
        _invalidate_data_cache()
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "message": "Strategy updated successfully." if payload.mappingId is not None else "Strategy created successfully.",
                "rows": jsonable_encoder(rows),
                "updatedRows": updated_rows,
            },
        )
    except ValueError as error:
        status_code = 409 if "already exists" in str(error).lower() else 400
        return JSONResponse(status_code=status_code, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to save strategy master data: {error}"})


@app.delete("/api/strategy-master")
def delete_strategy_master(payload: StrategyDeleteRequest) -> JSONResponse:
    try:
        with connect() as conn:
            deleted_rows = delete_strategy_master_rows(conn, payload.mappingId, payload.strategyName)
            rows = load_strategy_master_rows(conn)
        _touch_data_version("strategy_master")
        _invalidate_data_cache()
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "message": f"Deleted strategy mapping {payload.mappingId}." if payload.mappingId is not None else f"Deleted strategy {payload.strategyName.strip()}.",
                "deletedRows": deleted_rows,
                "rows": jsonable_encoder(rows),
            },
        )
    except ValueError as error:
        status_code = 404 if "not found" in str(error).lower() else 400
        return JSONResponse(status_code=status_code, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to delete strategy: {error}"})


def _merge_raw_row(conn: Any, raw_id: int, for_update: bool = False) -> dict[str, Any] | None:
    suffix = " FOR UPDATE" if for_update else ""
    cursor = conn.execute(f'SELECT * FROM matalia."01RawTxtData" WHERE id = %s{suffix}', (raw_id,))
    record = cursor.fetchone()
    if record is None:
        return None
    columns = [column.name for column in cursor.description]
    return dict(zip(columns, record))


def _merge_candidate_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id")),
        "date": _format_trade_date(row.get("trade_date")),
        "time": _normalize_time(row.get("trade_minute")),
        "side": _trade_side_from_type(row.get("trade_type")),
        "qty": int(round(_format_trade_amount(row.get("quantity")))),
        "price": round(_format_trade_amount(row.get("average_price")), 2),
    }


def _strategy_name_for_merged_trade(conn: Any, row: dict[str, Any]) -> str:
    quantity = int(round(_format_trade_amount(row.get("quantity"))))
    expiry = _normalize_strategy_expiry(row.get("expiry"))
    instrument = str(row.get("scrip") or "").strip().upper()
    candidates = [
        strategy for strategy in load_strategy_master_rows(conn)
        if strategy.get("active")
        and str(strategy.get("instrument") or "").strip().upper() == instrument
        and _normalize_strategy_expiry(strategy.get("expiry")) == expiry
        and quantity in {strategy.get("parentQty"), strategy.get("splitQty")}
    ]
    names = sorted({str(strategy.get("strategyName") or "").strip() for strategy in candidates if str(strategy.get("strategyName") or "").strip()})
    return names[0] if len(names) == 1 else "Unassigned"


@app.post("/api/instrument-allocation/merge-candidates")
def merge_trade_candidates(payload: MergeCandidatesRequest) -> JSONResponse:
    try:
        if payload.source.strip() != STRATEGY_ALLOCATION_SOURCE_ROWS:
            raise ValueError("Only unprocessed raw trades can be merged from Instrument Allocation.")
        raw_id = int(payload.sourceId)
        with connect() as conn:
            selected = _merge_raw_row(conn, raw_id)
            if selected is None:
                raise ValueError(f"Trade {payload.sourceId} was not found.")
            if not _merge_trade_id_is_blank(selected.get("merge_trade_id")):
                raise ValueError("The selected trade has already been merged. Refresh and try again.")

            cursor = conn.execute(
                '''
                SELECT *
                FROM matalia."01RawTxtData"
                WHERE trade_date = %s
                  AND instrument_id = %s
                  AND scrip = %s
                  AND expiry = %s
                  AND strike = %s
                  AND option_type = %s
                  AND trade_type = %s
                  AND account IS NOT DISTINCT FROM %s
                  AND (merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = '')
                ORDER BY trade_minute, id
                ''',
                (
                    selected.get("trade_date"), selected.get("instrument_id"), selected.get("scrip"),
                    selected.get("expiry"), selected.get("strike"), selected.get("option_type"),
                    selected.get("trade_type"), selected.get("account"),
                ),
            )
            columns = [column.name for column in cursor.description]
            rows = [dict(zip(columns, record)) for record in cursor.fetchall()]

        context = {
            "instrument": str(selected.get("scrip") or ""),
            "expiry": _format_trade_expiry(selected.get("expiry")),
            "strike": _format_trade_number(selected.get("strike")),
            "option": str(selected.get("option_type") or ""),
            "tradeType": _trade_side_from_type(selected.get("trade_type")),
            "account": str(selected.get("account") or ""),
        }
        return JSONResponse(status_code=200, content={"success": True, "context": context, "trades": [_merge_candidate_payload(row) for row in rows]})
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to load merge candidates: {error}"})


@app.post("/api/instrument-allocation/merge")
def merge_instrument_trades(payload: MergeTradesRequest) -> JSONResponse:
    try:
        raw_ids = list(dict.fromkeys(payload.raw_trade_ids))
        if len(raw_ids) < 2:
            raise ValueError("Select at least two trades to merge.")

        merge_module = _load_merge_trade_module()
        with connect() as conn:
            rows = [_merge_raw_row(conn, raw_id, for_update=True) for raw_id in raw_ids]
            if any(row is None for row in rows):
                raise ValueError("One or more selected trades no longer exists. Refresh and try again.")
            typed_rows = [row for row in rows if row is not None]
            if any(not _merge_trade_id_is_blank(row.get("merge_trade_id")) for row in typed_rows):
                raise ValueError("One or more selected trades has already been merged. Refresh and try again.")

            match_fields = ["trade_date", "instrument_id", "scrip", "expiry", "strike", "option_type", "trade_type", "account"]
            first_key = tuple(typed_rows[0].get(field) for field in match_fields)
            if any(tuple(row.get(field) for field in match_fields) != first_key for row in typed_rows[1:]):
                raise ValueError("Selected trades must have the same instrument, expiry, strike, option, side, date, and account.")

            stats = merge_module.calculate_wap(pd.DataFrame(typed_rows))
            merged_row = {
                **typed_rows[0],
                "trade_minute": stats["first_time"],
                "quantity": stats["total_qty"],
                "average_price": stats["wap"],
                "trades_merged": len(typed_rows),
            }
            merge_id = _insert_merge_trade(conn, merged_row)
            raw_update = conn.execute(
                'UPDATE matalia."01RawTxtData" SET merge_trade_id = %s WHERE id = ANY(%s) AND (merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = \'\')',
                (merge_id, raw_ids),
            )
            if (raw_update.rowcount or 0) != len(raw_ids):
                raise ValueError("One or more selected trades changed while merging. Refresh and try again.")

            split_trade_id = _insert_split_trade(conn, merge_id, merged_row)
            conn.commit()
            _invalidate_data_cache()

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "message": f"Merged {len(raw_ids)} trades and created the linked SplitTrades row. Ready for strategy allocation.",
                "merge_trade_id": merge_id,
                "split_trade_id": split_trade_id,
                "allocation_id": None,
            },
        )
    except (ValueError, TypeError) as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to merge trades: {error}"})


def _resolve_merge_trade_id(conn: Any, payload: SplitTradeRequest) -> int | None:
    if payload.source.strip() == STRATEGY_ALLOCATION_SOURCE_ROWS:
        raw_cursor = conn.execute(
            'SELECT merge_trade_id FROM matalia."01RawTxtData" WHERE id = %s',
            (payload.sourceId,),
        )
        raw_row = raw_cursor.fetchone()
        if raw_row and raw_row[0] not in (None, ""):
            return int(raw_row[0])

    allocation_cursor = conn.execute(
        """
        SELECT split_trade_id
        FROM matalia.strategy_allocation
        WHERE allocation_id::text = %s OR position_id::text = %s
        ORDER BY allocation_id
        LIMIT 1
        """,
        (payload.sourceId, payload.tradeId),
    )
    allocation_row = allocation_cursor.fetchone()
    if allocation_row and allocation_row[0] is not None:
        split_cursor = conn.execute(
            'SELECT "MergeID" FROM matalia."SplitTrades" WHERE id = %s',
            (int(allocation_row[0]),),
        )
        split_row = split_cursor.fetchone()
        if split_row and split_row[0] is not None:
            return int(split_row[0])

    try:
        return int(payload.tradeId)
    except ValueError:
        return None


def _split_raw_trade_through_pipeline(conn: Any, payload: SplitTradeRequest) -> dict[str, Any]:
    if payload.raw_trade_id is None:
        raise ValueError("A raw_trade_id is required for the direct split workflow.")

    raw_row = _load_raw_trade_by_id(conn, payload.raw_trade_id)
    if raw_row is None:
        raise ValueError(f"Raw trade {payload.raw_trade_id} was not found.")
    existing_raw_merge_id = raw_row.get("merge_trade_id")
    if not _merge_trade_id_is_blank(existing_raw_merge_id) and _merge_has_strategy_allocations(conn, int(existing_raw_merge_id)):
        raise ValueError("Trade already allocated. Refresh and try again.")

    actual_quantity = float(raw_row.get("quantity") or 0)
    requested_quantity = payload.original_qty if payload.original_qty is not None else payload.originalQty
    if requested_quantity is not None and round(float(requested_quantity), 2) != round(actual_quantity, 2):
        raise ValueError("The selected trade quantity has changed. Refresh and try again.")

    quantities = [float(quantity) for quantity in payload.quantities]
    if not quantities:
        quantities = [actual_quantity]
    if any(quantity <= 0 for quantity in quantities):
        raise ValueError("Each split quantity must be greater than zero.")
    if round(sum(quantities), 2) != round(actual_quantity, 2):
        raise ValueError("Split quantities must equal the original trade quantity.")

    merged_row = {**raw_row, "trades_merged": 1}
    merge_id = int(existing_raw_merge_id) if not _merge_trade_id_is_blank(existing_raw_merge_id) else _find_unallocated_merge_trade(conn, merged_row)
    existing_split_rows = _load_split_rows_for_merge(conn, merge_id) if merge_id is not None else []
    if merge_id is None:
        merge_id = _insert_merge_trade(conn, merged_row)
    if _merge_trade_id_is_blank(existing_raw_merge_id):
        conn.execute(
            'UPDATE matalia."01RawTxtData" SET merge_trade_id = %s WHERE id = %s AND (merge_trade_id IS NULL OR BTRIM(merge_trade_id::text) = \'\')',
            (merge_id, payload.raw_trade_id),
        )

    if len(quantities) > 1:
        split_module = _load_split_trade_module()
        split_rows = split_module.split_trade_by_quantities(pd.Series(merged_row), quantities).to_dict("records")
    else:
        split_rows = [merged_row]

    split_trade_ids: list[int] = []
    if existing_split_rows and [round(float(row.get("quantity") or 0), 2) for row in existing_split_rows] == [round(quantity, 2) for quantity in quantities]:
        split_trade_ids = [int(row["id"]) for row in existing_split_rows]
    else:
        if existing_split_rows:
            conn.execute('DELETE FROM matalia."SplitTrades" WHERE "MergeID" = %s', (merge_id,))
        for split_row in split_rows:
            split_trade_ids.append(_insert_split_trade(conn, merge_id, split_row))

    return {
        "raw_trade_id": payload.raw_trade_id,
        "merge_trade_id": merge_id,
        "split_trade_ids": split_trade_ids,
        "allocation_ids": [],
    }


def _split_existing_unallocated_child(conn: Any, payload: SplitTradeRequest) -> dict[str, Any]:
    """Split one pending child without disturbing allocated siblings."""
    if payload.split_trade_id is None:
        raise ValueError("A split_trade_id is required for the pending split workflow.")

    cursor = conn.execute(
        'SELECT * FROM matalia."SplitTrades" WHERE id = %s FOR UPDATE',
        (payload.split_trade_id,),
    )
    record = cursor.fetchone()
    if record is None:
        raise ValueError(f"Split trade {payload.split_trade_id} was not found. Refresh and try again.")
    columns = [column.name for column in cursor.description]
    split_row = dict(zip(columns, record))

    if _split_trade_has_strategy_allocations(conn, payload.split_trade_id):
        raise ValueError("This split trade is already allocated and cannot be split again.")

    actual_quantity = float(split_row.get("quantity") or 0)
    requested_quantity = payload.original_qty if payload.original_qty is not None else payload.originalQty
    if requested_quantity is not None and round(float(requested_quantity), 2) != round(actual_quantity, 2):
        raise ValueError("The selected split quantity has changed. Refresh and try again.")

    quantities = [float(quantity) for quantity in payload.quantities]
    if len(quantities) < 2 or any(quantity <= 0 for quantity in quantities):
        raise ValueError("Each split quantity must be greater than zero.")
    if round(sum(quantities), 2) != round(actual_quantity, 2):
        raise ValueError("Split quantities must equal the selected trade quantity.")

    merge_id = split_row.get("MergeID")
    if merge_id in (None, ""):
        raise ValueError("The selected split trade is not connected to a MergeTrades record.")

    split_module = _load_split_trade_module()
    split_rows = split_module.split_trade_by_quantities(pd.Series(split_row), quantities).to_dict("records")
    conn.execute('DELETE FROM matalia."SplitTrades" WHERE id = %s', (payload.split_trade_id,))
    split_trade_ids = [_insert_split_trade(conn, int(merge_id), split_row) for split_row in split_rows]

    return {
        "split_trade_id": payload.split_trade_id,
        "merge_trade_id": int(merge_id),
        "split_trade_ids": split_trade_ids,
        "allocation_ids": [],
    }


@app.post("/api/instrument-allocation/split")
def split_instrument_trade(payload: SplitTradeRequest) -> JSONResponse:
    try:
        if payload.split_trade_id is not None:
            with connect() as conn:
                result = _split_existing_unallocated_child(conn, payload)
                conn.commit()
            _invalidate_data_cache()
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    **result,
                    "allocation_count": len(result["allocation_ids"]),
                    "message": "Pending split trade updated successfully.",
                },
            )

        if payload.raw_trade_id is not None:
            with connect() as conn:
                result = _split_raw_trade_through_pipeline(conn, payload)
                conn.commit()
            _invalidate_data_cache()
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    **result,
                    "allocation_count": len(result["allocation_ids"]),
                    "message": "Trade moved through the Split workflow successfully.",
                },
            )

        if len(payload.quantities) < 2 or any(quantity <= 0 for quantity in payload.quantities):
            raise ValueError("Each split quantity must be greater than zero.")
        if round(sum(payload.quantities), 2) != round(payload.originalQty, 2):
            raise ValueError("Split quantities must equal the original trade quantity.")

        split_module = _load_split_trade_module()
        with connect() as conn:
            merge_id = _resolve_merge_trade_id(conn, payload)
            if merge_id is None:
                raise ValueError("The selected trade is not connected to an existing MergeTrades record.")

            merge_cursor = conn.execute(
                'SELECT * FROM matalia."MergeTrades" WHERE id = %s FOR UPDATE',
                (merge_id,),
            )
            merge_record = merge_cursor.fetchone()
            if merge_record is None:
                raise ValueError("The selected MergeTrades record was not found.")
            columns = [column.name for column in merge_cursor.description]
            merge_row = dict(zip(columns, merge_record))
            actual_quantity = float(merge_row.get("quantity") or 0)
            if round(actual_quantity, 2) != round(payload.originalQty, 2):
                raise ValueError("The selected trade quantity has changed. Refresh and try again.")

            old_split_cursor = conn.execute(
                'SELECT id FROM matalia."SplitTrades" WHERE "MergeID" = %s',
                (merge_id,),
            )
            old_split_ids = [int(row[0]) for row in old_split_cursor.fetchall()]
            old_allocations_cursor = conn.execute(
                "SELECT * FROM matalia.strategy_allocation WHERE split_trade_id = ANY(%s)",
                (old_split_ids,),
            )
            allocation_columns = [column.name for column in old_allocations_cursor.description]
            old_allocations = [dict(zip(allocation_columns, row)) for row in old_allocations_cursor.fetchall()]

            split_df = split_module.split_trade_by_quantities(pd.Series(merge_row), payload.quantities)
            split_module.upload_split_trades(conn, split_df)

            if old_split_ids:
                conn.execute(
                    "DELETE FROM matalia.strategy_allocation WHERE split_trade_id = ANY(%s)",
                    (old_split_ids,),
                )
            # Reinsert the existing allocation context over the newly-created split rows.
            new_split_cursor = conn.execute(
                'SELECT id, quantity FROM matalia."SplitTrades" WHERE "MergeID" = %s ORDER BY id',
                (merge_id,),
            )
            new_split_rows = new_split_cursor.fetchall()
            for allocation in old_allocations:
                for sequence, (split_trade_id, quantity) in enumerate(new_split_rows, start=1):
                    conn.execute(
                        """
                        INSERT INTO matalia.strategy_allocation
                        (split_trade_id, position_id, trade_date, trade_minute, instrument_id, scrip, expiry, strike, option_type, trade_type, parent_quantity, split_sequence, quantity, average_price, account, strategy, trade_action, status, is_split)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (split_trade_id, position_id, strategy, trade_action) DO UPDATE SET
                          quantity = EXCLUDED.quantity,
                          split_sequence = EXCLUDED.split_sequence,
                          parent_quantity = EXCLUDED.parent_quantity,
                          status = EXCLUDED.status,
                          is_split = EXCLUDED.is_split
                        """,
                        (split_trade_id, allocation.get("position_id"), allocation.get("trade_date"), allocation.get("trade_minute"), allocation.get("instrument_id"), allocation.get("scrip"), allocation.get("expiry"), allocation.get("strike"), allocation.get("option_type"), allocation.get("trade_type"), actual_quantity, sequence, quantity, allocation.get("average_price"), allocation.get("account"), allocation.get("strategy"), allocation.get("trade_action"), allocation.get("status") or ("Open" if allocation.get("trade_action") == "Entry" else "Closed"), True),
                    )
            conn.commit()

        _invalidate_data_cache()
        return JSONResponse(status_code=200, content={"success": True, "message": f"Split trade into {len(payload.quantities)} parts."})
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to split trade: {error}"})


@app.get("/api/instrument-allocation/confirm/progress/{progress_id}")
def instrument_allocation_confirm_progress(progress_id: str) -> JSONResponse:
    state = _confirmation_progress_snapshot(progress_id)
    if state is None:
        return JSONResponse(
            status_code=404,
            content={"success": False, "message": "Confirmation progress was not found"},
        )
    return JSONResponse(status_code=200, content={"success": True, **state})


@app.post("/api/instrument-allocation/confirm")
def instrument_allocation_confirm(payload: StrategyAllocationConfirmationRequest) -> JSONResponse:
    request_started_at = perf_counter()
    _confirmation_progress_start(payload.progressId, payload.rows)
    try:
        with connect() as conn:
            result = confirm_strategy_allocations(conn, payload.rows, payload.progressId)
        logger.info(
            "instrument_allocation_confirm response rows=%d processed=%d skipped=%d total_ms=%.1f",
            len(payload.rows), result["processed_count"], result["skipped_count"],
            (perf_counter() - request_started_at) * 1000,
        )

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "progress_id": payload.progressId,
                "processed_count": result["processed_count"],
                "merge_count": result["merge_count"],
                "split_count": result["split_count"],
                "allocation_count": result["allocation_count"],
                "skipped_count": result["skipped_count"],
                "errors": result["errors"],
                "details": result["details"],
                "merge_trades_created": result["merge_count"],
                "split_trades_created": result["split_count"],
                "allocations_created": result["allocation_count"],
                "message": (
                    f"{result['processed_count']} trade(s) processed successfully. "
                    f"MergeTrades created: {result['merge_count']}. "
                    f"SplitTrades created: {result['split_count']}. "
                    f"Allocations created: {result['allocation_count']}. "
                    f"Skipped: {result['skipped_count']}."
                    + (f" Errors: {' | '.join(result['errors'])}" if result['errors'] else "")
                ),
            },
        )
    except RuntimeError as error:
        _confirmation_progress_update(
            payload.progressId,
            status="failed",
            stage="failed",
            error=str(error),
            message="Confirmation needs a refresh",
        )
        logger.warning(
            "instrument_allocation_confirm rejected rows=%d total_ms=%.1f reason=%s",
            len(payload.rows), (perf_counter() - request_started_at) * 1000, error,
        )
        return JSONResponse(
            status_code=409,
            content={"success": False, "message": f"Confirmation needs a refresh: {error}"},
        )
    except Exception as error:
        _confirmation_progress_update(
            payload.progressId,
            status="failed",
            stage="failed",
            error=str(error),
            message="Confirmation failed",
        )
        logger.exception(
            "instrument_allocation_confirm failed rows=%d total_ms=%.1f",
            len(payload.rows), (perf_counter() - request_started_at) * 1000,
        )
        return JSONResponse(
            status_code=502,
            content={"success": False, "message": f"Unable to confirm strategy allocations: {error}"},
        )
