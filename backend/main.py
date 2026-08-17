from __future__ import annotations

from datetime import date, datetime
import importlib
import re
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pandas as pd

from fastapi import FastAPI, File, Query, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

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
load_strategy_master_rows = _strategy_master_module.load_strategy_master_rows
next_expiries = _strategy_master_module.next_expiries
save_strategy_setup = _strategy_master_module.save_strategy_setup


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / "Credentials" / ".env")
PIPELINE_LOG_PATH = PROJECT_ROOT / "Other Logs" / "Runtime" / "import_pipeline.log"
SELECTED_TXT_PATH = PROJECT_ROOT / "Other Logs" / "Runtime" / "selected_txt_import.txt"
PIPELINE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

PIPELINE_STATE: dict[str, Any] = {
    "running": False,
    "stage": "idle",
    "message": "Ready",
    "started_at": None,
    "finished_at": None,
    "last_run_at": None,
    "return_code": None,
    "failed_step": None,
    "error": None,
}
PIPELINE_LOCK = threading.Lock()


app = FastAPI(title="Matalia SL Backend")

app.add_middleware(
    CORSMiddleware,
    # The launcher selects an available Vite port when 3489 is already busy.
    # Permit only local development origins so that selected frontend can use the API.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(_live_positions_module.router)
app.include_router(_matalia_reports_module.router)


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
POSITION_SEQUENCE = "matalia.strategy_allocation_position_seq"


class StrategyAllocationConfirmationRow(BaseModel):
    tradeId: str
    source: str
    sourceId: str
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


@app.post("/api/raw-trades/import")
async def upload_raw_trade_file(file: UploadFile = File(...)) -> JSONResponse:
    """Stage a copy of the user-selected TXT for the import pipeline.

    The browser uploads a copy, so the original file on the user's computer
    is never renamed, moved, or modified by the backend.
    """
    filename = Path(file.filename or "").name
    if not filename.lower().endswith(".txt"):
        return JSONResponse(status_code=400, content={"message": "Please select a .txt file."})

    content = await file.read()
    if not content.strip():
        return JSONResponse(status_code=400, content={"message": "The selected TXT file is empty."})

    SELECTED_TXT_PATH.parent.mkdir(parents=True, exist_ok=True)
    SELECTED_TXT_PATH.write_bytes(content)
    line_count = max(0, len(content.decode("utf-8", errors="ignore").splitlines()) - 1)
    imported_file = {
        "id": str(datetime.now().timestamp()),
        "name": filename,
        "tradeDate": "",
        "broker": "",
        "records": line_count,
        "importedAt": datetime.now().strftime("%I:%M %p"),
        "status": "ready",
    }
    return JSONResponse(
        status_code=200,
        content={"files": [imported_file], "message": "TXT file selected successfully."},
    )


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


def get_next_position_id(conn: Any) -> int:
    row = conn.execute(f"SELECT nextval('{POSITION_SEQUENCE}')").fetchone()
    return int(row[0])


def _load_strategy_allocation_ledger(conn: Any) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT *
        FROM matalia.strategy_allocation
        ORDER BY trade_date, trade_minute, allocation_id
        """,
        conn,
    )


def _build_open_positions(allocation_df: pd.DataFrame) -> dict[str, list[dict[str, Any]]]:
    if allocation_df is None or allocation_df.empty:
        return {}

    entry_rows = allocation_df[allocation_df["trade_action"] == "Entry"].copy()
    exited_position_ids = set(
        allocation_df.loc[allocation_df["trade_action"] == "Exit", "position_id"].astype(str)
    )

    positions: dict[str, list[dict[str, Any]]] = {}
    for position_id, rows in entry_rows.groupby("position_id", sort=False):
        position_key = str(position_id)
        if position_key in exited_position_ids:
            continue
        positions[position_key] = rows.sort_values("split_sequence").to_dict("records")

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
        self._positions[position_id] = list(entry_records)

    def close_position(self, position_id: Any):
        return self._positions.pop(str(position_id), None)


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
    quantity = _format_trade_amount(row.get("entry_qty"))
    price = _format_trade_amount(row.get("exit_price"))
    trade_id = row.get("position_id") or f"{row.get('entry_id')}-{row.get('exit_id')}"
    return {
        "id": str(trade_id),
        "date": _format_trade_date(row.get("exit_date") or row.get("entry_date")),
        "time": _normalize_time(row.get("exit_time") or row.get("entry_time")),
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


def _load_trade_rows(conn: Any, table_name: str, view: str) -> list[dict[str, Any]]:
    cursor = conn.execute(f"SELECT * FROM matalia.{table_name}")
    columns = [column.name for column in cursor.description]
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]

    return [_normalize_trade_record(row, view) for row in rows]


def _load_trade_count(conn: Any, table_name: str) -> int:
    return int(conn.execute(f"SELECT count(*) FROM matalia.{table_name}").fetchone()[0])


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
    open_cursor = conn.execute("SELECT * FROM matalia.strategy_open")
    open_columns = [column.name for column in open_cursor.description]
    open_rows = [
        {**dict(zip(open_columns, row)), "_source": "strategy_open"}
        for row in open_cursor.fetchall()
    ]

    raw_cursor = conn.execute('SELECT * FROM matalia."01RawTxtData"')
    raw_columns = [column.name for column in raw_cursor.description]
    raw_rows = [
        {**dict(zip(raw_columns, row)), "_source": '01RawTxtData'}
        for row in raw_cursor.fetchall()
        if _merge_trade_id_is_blank(dict(zip(raw_columns, row)).get("merge_trade_id"))
    ]

    combined_rows = open_rows + raw_rows
    normalized_rows: list[dict[str, Any]] = []

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

        quantity = _format_trade_amount(row.get("quantity"))
        price = _format_trade_amount(row.get("average_price"))
        side = _trade_side_from_type(row.get("trade_type"))
        normalized_rows.append(
            {
                "id": str(row.get("id") or row.get("merge_trade_id") or row.get("instrument_id")),
                "date": _format_trade_date(row.get("trade_date")),
                "time": _normalize_time(row.get("trade_minute")),
                "tradeId": str(row.get("instrument_id") or row.get("id")),
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
                "bucket": _allocation_bucket_from_row(row),
                "source": "01RawTxtData",
            }
        )

    return normalized_rows


def _load_strategy_allocation_counts(conn: Any) -> dict[str, int]:
    raw_cursor = conn.execute('SELECT merge_trade_id FROM matalia."01RawTxtData"')
    raw_blank_count = sum(1 for (merge_trade_id,) in raw_cursor.fetchall() if _merge_trade_id_is_blank(merge_trade_id))
    open_count = _load_trade_count(conn, "strategy_open")
    strategies_cursor = conn.execute("SELECT DISTINCT strategy FROM matalia.strategy_open WHERE strategy IS NOT NULL AND trim(strategy) <> ''")
    strategy_count = len({str(strategy).strip() for (strategy,) in strategies_cursor.fetchall() if str(strategy).strip()})
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


def _load_raw_trade_by_id(conn: Any, raw_id: int) -> dict[str, Any] | None:
    raw_columns = _table_column_names(conn, "matalia", "01RawTxtData")
    cursor = conn.execute(
        'SELECT * FROM matalia."01RawTxtData" WHERE id = %s FOR UPDATE',
        (raw_id,),
    )
    raw_record = cursor.fetchone()
    if raw_record is None:
        return None
    return dict(zip(raw_columns, raw_record))


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


def _update_existing_strategy_allocation(conn: Any, row: StrategyAllocationConfirmationRow) -> tuple[bool, str | None]:
    allocation_columns = _table_column_names(conn, "matalia", "strategy_allocation")
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
        return False, f"No open strategy allocation row matched trade {row.tradeId}"

    return True, f"Updated strategy allocation for trade {row.tradeId}"


def _insert_strategy_allocation_row(
    conn: Any,
    split_trade_id: int,
    split_row: dict[str, Any],
    strategy_name: str,
    position_id: str,
    trade_action: str,
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
            "parent_quantity": split_row.get("quantity"),
            "split_sequence": 1,
            "quantity": split_row.get("quantity"),
            "average_price": split_row.get("average_price"),
            "account": split_row.get("account"),
            "strategy": strategy_name,
            "trade_action": trade_action,
            "status": "Open" if trade_action == "Entry" else "Closed",
            "is_split": False,
        },
    )
    if trade_action == "Exit":
        conn.execute(
            "UPDATE matalia.strategy_allocation SET status = 'Closed' WHERE position_id::text = %s",
            (position_id,),
        )
    return int(cursor.fetchone()[0])


def _resolve_allocation_context(
    conn: Any,
    available_positions: PositionManager,
    split_row: dict[str, Any],
    strategy_name: str,
) -> tuple[str, str]:
    open_positions = available_positions.get_open_positions(
        account=split_row.get("account"),
        instrument_id=split_row.get("instrument_id"),
    )

    for position_id, position_rows in open_positions.items():
        if any(str(entry.get("strategy") or "").strip() == strategy_name for entry in position_rows):
            return "Exit", str(position_id)

    return "Entry", str(get_next_position_id(conn))


def _process_raw_batch_split(
    conn: Any,
    row: StrategyAllocationConfirmationRow,
    available_positions: PositionManager,
) -> tuple[bool, str | None]:
    if row.source.strip() != STRATEGY_ALLOCATION_SOURCE_ROWS:
        return False, f"Trade {row.sourceId} is not a raw trade"

    try:
        raw_id = int(row.sourceId)
    except ValueError:
        return False, f"Trade {row.sourceId} has an invalid raw ID"

    raw_row = _load_raw_trade_by_id(conn, raw_id)
    if raw_row is None:
        return False, f"Trade {raw_id} was not found"

    if raw_row.get("merge_trade_id") not in (None, ""):
        return False, f"Trade {raw_id} has already been processed"

    merge_trade_id = _insert_merge_trade(conn, raw_row)

    conn.execute(
        """
        UPDATE matalia."01RawTxtData"
        SET merge_trade_id = %s
        WHERE id = %s
          AND merge_trade_id IS NULL
        """,
        (merge_trade_id, raw_id),
    )

    split_trade_id = _insert_split_trade(conn, merge_trade_id, raw_row)
    trade_action, position_id = _resolve_allocation_context(
        conn,
        available_positions,
        raw_row,
        row.strategyName,
    )
    allocation_id = _insert_strategy_allocation_row(
        conn,
        split_trade_id,
        raw_row,
        row.strategyName,
        position_id,
        trade_action,
    )

    if trade_action == "Entry":
        available_positions.add_entry([
            {
                "position_id": position_id,
                "account": raw_row.get("account"),
                "instrument_id": raw_row.get("instrument_id"),
                "strategy": row.strategyName,
                "split_sequence": 1,
                "trade_action": "Entry",
                "quantity": raw_row.get("quantity"),
                "parent_quantity": raw_row.get("quantity"),
                "trade_date": raw_row.get("trade_date"),
                "trade_minute": raw_row.get("trade_minute"),
                "scrip": raw_row.get("scrip"),
            }
        ])
    else:
        available_positions.close_position(position_id)

    return True, (
        f"Processed raw trade {raw_id} into MergeTrades {merge_trade_id}, "
        f"SplitTrades {split_trade_id}, and StrategyAllocation {allocation_id}"
    )


def confirm_strategy_allocations(conn: Any, rows: list[StrategyAllocationConfirmationRow]) -> dict[str, Any]:
    processed = 0
    skipped = 0
    merge_count = 0
    split_count = 0
    allocation_count = 0
    errors: list[str] = []
    details: list[str] = []

    seen_source_ids: set[str] = set()
    allocation_df = _load_strategy_allocation_ledger(conn)
    available_positions = PositionManager.from_allocation_table(allocation_df)

    try:
        for row in rows:
            source_id = row.sourceId.strip()
            if not source_id:
                skipped += 1
                errors.append("Skipped a row with no raw trade ID")
                continue

            if source_id in seen_source_ids:
                skipped += 1
                errors.append(f"Skipped duplicate raw trade ID {source_id} in the same request")
                continue
            seen_source_ids.add(source_id)

            if row.source.strip() == STRATEGY_ALLOCATION_SOURCE_ROWS:
                success, message = _process_raw_batch_split(conn, row, available_positions)
            else:
                success, message = _update_existing_strategy_allocation(conn, row)
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

        conn.commit()
        return {
            "processed_count": processed,
            "merge_count": merge_count,
            "split_count": split_count,
            "allocation_count": allocation_count,
            "skipped_count": skipped,
            "errors": errors,
            "details": details,
        }
    except Exception:
        conn.rollback()
        raise


def _set_pipeline_state(**updates: Any) -> dict[str, Any]:
    with PIPELINE_LOCK:
        PIPELINE_STATE.update(updates)
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
    if not SELECTED_TXT_PATH.is_file():
        return JSONResponse(
            status_code=400,
            content={"success": False, "message": "Select a TXT file before running the import pipeline."},
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
    )
    _write_log_line(f"[{_timestamp()}] Pipeline started")

    first_return_code = _run_step("01_Txt_DB.py", "01_Txt_DB.py")
    if first_return_code != 0:
        _write_log_line(f"[{_timestamp()}] Pipeline failed in 01_Txt_DB.py")
        _set_pipeline_state(
            running=False,
            stage="error",
            message="Pipeline failed in 01_Txt_DB.py",
            finished_at=datetime.now().isoformat(timespec="seconds"),
            return_code=first_return_code,
            failed_step="01_Txt_DB.py",
            error="01_Txt_DB.py failed",
        )
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "failed_step": "01_Txt_DB.py",
                "return_code": first_return_code,
                "message": "Pipeline failed in 01_Txt_DB.py",
                "log": _read_log_tail(),
                **_get_pipeline_state(),
            },
        )

    _write_log_line(f"[{_timestamp()}] Pipeline completed successfully")
    _set_pipeline_state(
        running=False,
        stage="ready",
        message="Pipeline completed successfully",
        finished_at=datetime.now().isoformat(timespec="seconds"),
        return_code=0,
        failed_step=None,
        error=None,
    )
    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            "message": "Pipeline completed successfully",
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
        with connect() as conn:
            cursor = conn.execute('SELECT * FROM matalia."01RawTxtData"')
            columns = [column.name for column in cursor.description]
            rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
        return JSONResponse(
            status_code=200,
            content={"success": True, "rows": jsonable_encoder(rows), "total_rows": len(rows)},
        )
    except Exception as error:
        return JSONResponse(
            status_code=502,
            content={"success": False, "message": f'Unable to load matalia."01RawTxtData": {error}'},
        )


@app.get("/api/trade-book")
def trade_book(view: str = "all") -> JSONResponse:
    try:
        selected_view = _normalize_trade_tab(view)
        with connect() as conn:
            counts = {
                tab: _load_trade_count(conn, table_name)
                for tab, table_name in TRADE_BOOK_TABLES.items()
            }
            selected_table = TRADE_BOOK_TABLES[selected_view]
            rows = _load_trade_rows(conn, selected_table, selected_view)

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "view": selected_view,
                "rows": jsonable_encoder(rows),
                "counts": counts,
                "total_rows": len(rows),
            },
        )
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
def strategy_allocation() -> JSONResponse:
    try:
        with connect() as conn:
            rows = _load_strategy_allocation_rows(conn)
            counts = _load_strategy_allocation_counts(conn)

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "rows": jsonable_encoder(rows),
                "counts": counts,
                "total_rows": len(rows),
            },
        )


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
                  AND merge_trade_id IS NULL
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
                'UPDATE matalia."01RawTxtData" SET merge_trade_id = %s WHERE id = ANY(%s) AND merge_trade_id IS NULL',
                (merge_id, raw_ids),
            )
            if (raw_update.rowcount or 0) != len(raw_ids):
                raise ValueError("One or more selected trades changed while merging. Refresh and try again.")

            split_trade_id = _insert_split_trade(conn, merge_id, merged_row)
            allocation_df = _load_strategy_allocation_ledger(conn)
            available_positions = PositionManager.from_allocation_table(allocation_df)
            strategy_name = _strategy_name_for_merged_trade(conn, merged_row)
            trade_action, position_id = _resolve_allocation_context(conn, available_positions, merged_row, strategy_name)
            allocation_id = _insert_strategy_allocation_row(
                conn,
                split_trade_id,
                merged_row,
                strategy_name,
                position_id,
                trade_action,
            )
            conn.commit()

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "message": f"Merged {len(raw_ids)} trades and created the linked split and strategy allocation.",
                "merge_trade_id": merge_id,
                "split_trade_id": split_trade_id,
                "allocation_id": allocation_id,
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
    if not _merge_trade_id_is_blank(raw_row.get("merge_trade_id")):
        raise ValueError("Trade already processed. Refresh and try again.")

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
    merge_id = _insert_merge_trade(conn, merged_row)
    raw_update = conn.execute(
        'UPDATE matalia."01RawTxtData" SET merge_trade_id = %s WHERE id = %s AND merge_trade_id IS NULL',
        (merge_id, payload.raw_trade_id),
    )
    if (raw_update.rowcount or 0) != 1:
        raise ValueError("The selected trade changed while splitting. Refresh and try again.")

    if len(quantities) > 1:
        split_module = _load_split_trade_module()
        split_rows = split_module.split_trade_by_quantities(pd.Series(merged_row), quantities).to_dict("records")
    else:
        split_rows = [merged_row]

    allocation_df = _load_strategy_allocation_ledger(conn)
    available_positions = PositionManager.from_allocation_table(allocation_df)
    split_trade_ids: list[int] = []
    allocation_ids: list[int] = []

    for split_row in split_rows:
        split_trade_id = _insert_split_trade(conn, merge_id, split_row)
        strategy_name = _strategy_name_for_merged_trade(conn, split_row)
        trade_action, position_id = _resolve_allocation_context(conn, available_positions, split_row, strategy_name)
        allocation_id = _insert_strategy_allocation_row(
            conn,
            split_trade_id,
            split_row,
            strategy_name,
            position_id,
            trade_action,
        )
        split_trade_ids.append(split_trade_id)
        allocation_ids.append(allocation_id)

    return {
        "raw_trade_id": payload.raw_trade_id,
        "merge_trade_id": merge_id,
        "split_trade_ids": split_trade_ids,
        "allocation_ids": allocation_ids,
    }


@app.post("/api/instrument-allocation/split")
def split_instrument_trade(payload: SplitTradeRequest) -> JSONResponse:
    try:
        if payload.raw_trade_id is not None:
            with connect() as conn:
                result = _split_raw_trade_through_pipeline(conn, payload)
                conn.commit()
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

        return JSONResponse(status_code=200, content={"success": True, "message": f"Split trade into {len(payload.quantities)} parts."})
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to split trade: {error}"})


@app.post("/api/instrument-allocation/confirm")
def instrument_allocation_confirm(payload: StrategyAllocationConfirmationRequest) -> JSONResponse:
    try:
        with connect() as conn:
            result = confirm_strategy_allocations(conn, payload.rows)

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
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
                ),
            },
        )
    except Exception as error:
        return JSONResponse(
            status_code=502,
            content={"success": False, "message": f"Unable to confirm strategy allocations: {error}"},
        )
