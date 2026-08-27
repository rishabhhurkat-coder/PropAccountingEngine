"""Live positions and Zerodha market-price API routes.

This module owns the live-position API surface.  ``main.py`` only loads this
router and coordinates the application; Zerodha authentication, instrument
resolution, and WebSocket handling remain in ``09_External_Connections.py``.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel


def _load_external_connections():
    existing = sys.modules.get("matalia_external_connections")
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(
        "matalia_external_connections",
        Path(__file__).with_name("09_External_Connections.py"),
    )
    if spec is None or spec.loader is None:
        raise ImportError("Unable to load backend/09_External_Connections.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["matalia_external_connections"] = module
    spec.loader.exec_module(module)
    return module


external = _load_external_connections()
connect = external.connect
router = APIRouter()
_CMP_SCHEMA_LOCK = threading.Lock()
_CMP_SCHEMA_READY = False
_ACTUAL_SCHEMA_LOCK = threading.Lock()
_ACTUAL_SCHEMA_READY = False
_CMP_UPDATE_LOCK = threading.Lock()
_BACKGROUND_WORKER: "BackgroundLivePriceWorker | None" = None
logger = logging.getLogger(__name__)
ACTUAL_IMPORT_SCOPE = "active_expiry_v2"


def _main_actual_strategy(strategy: Any) -> str:
    """Return the persisted parent strategy for a leg-level strategy name."""
    normalized = " ".join(str(strategy or "").strip().split()).upper()
    if normalized.startswith("R "):
        normalized = normalized[2:].strip()
    if normalized.startswith("BANKNIFTY AVWAP"):
        return "Banknifty AVWAP"
    if normalized.startswith("BANKNIFTY FING"):
        return "Banknifty FING"
    if normalized.startswith("NIFTY AVWAP"):
        return "Nifty AVWAP"
    if normalized.startswith("NIFTY FING"):
        return "Nifty FING"
    if normalized.startswith("ATM EMA INTRADAY"):
        return "ATM EMA Intraday"
    if normalized.startswith("NIFTY OPT BUY"):
        return "Nifty Opt Buy"
    return str(strategy or "Unassigned").strip() or "Unassigned"


class ZerodhaPriceRefreshRequest(BaseModel):
    positions: list[dict[str, Any]]


class ZerodhaTokenRequest(BaseModel):
    redirectUrl: str


class ActualPositionCreateRequest(BaseModel):
    strategyName: str
    date: str
    time: str
    instrument: str
    expiry: str
    strike: float
    option: str
    qty: float
    entryPrice: float
    side: str = "BUY"


class ActualPositionRowsCreateRequest(BaseModel):
    rows: list[ActualPositionCreateRequest]


class ActualPositionStrategyQuoteRequest(BaseModel):
    strategy: str
    expiry: str | None = None
    option: str | None = None
    side: str | None = None
    underlyingPrice: float | None = None
    strike: float | None = None
    strategyName: str | None = None


ACTUAL_STRATEGY_CONFIG: dict[str, dict[str, Any]] = {
    "Nifty FING": {
        "instrument": "NIFTY", "expiry_mode": "monthly", "side": "SELL",
        "offsets": [300, 400, 500], "quantities": [325, 520, 260],
        "names": ["Nifty FING 300", "Nifty FING 400", "Nifty FING 500"],
    },
    "Nifty AVWAP": {
        "instrument": "NIFTY", "expiry_mode": "monthly", "side": "SELL",
        "offsets": [300, 400, 500], "quantities": [325, 520, 260],
        "names": ["Nifty AVWAP 300", "Nifty AVWAP 400", "Nifty AVWAP 500"],
    },
    "Banknifty FING": {
        "instrument": "BANKNIFTY", "expiry_mode": "monthly", "side": "SELL",
        "offsets": [600, 800], "quantities": [60, 120],
        "names": ["Banknifty FING 600", "Banknifty FING 800"],
    },
    "Banknifty AVWAP": {
        "instrument": "BANKNIFTY", "expiry_mode": "monthly", "side": "SELL",
        "offsets": [600, 800], "quantities": [60, 120],
        "names": ["Banknifty AVWAP 600", "Banknifty AVWAP 800"],
    },
    "ATM EMA Intraday": {
        "instrument": "NIFTY", "expiry_mode": "weekly", "side": "SELL",
        "quantities": [650], "names": ["ATM EMA Intraday"], "premium_target": 200,
        "premium_strictly_greater": True,
    },
    "Nifty Opt Buy": {
        "instrument": "NIFTY", "expiry_mode": "weekly", "quantities": [195],
        "names": ["Nifty Opt Buy"], "premium_target": 500,
    },
}


def _ensure_actual_positions_storage(conn: Any) -> None:
    """Create the manually maintained Actual Positions snapshot tables."""
    global _ACTUAL_SCHEMA_READY
    if _ACTUAL_SCHEMA_READY:
        return
    with _ACTUAL_SCHEMA_LOCK:
        if _ACTUAL_SCHEMA_READY:
            return
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS matalia.actual_positions (
                position_id TEXT PRIMARY KEY,
                trade_date DATE,
                trade_minute TEXT,
                instrument_id TEXT,
                scrip TEXT NOT NULL,
                expiry DATE,
                strike NUMERIC,
                option_type TEXT,
                trade_type TEXT,
                quantity NUMERIC,
                average_price NUMERIC,
                account TEXT,
                strategy TEXT,
                main_strategy TEXT,
                cmp DOUBLE PRECISION,
                imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS matalia.actual_positions_import_state (
                singleton_id SMALLINT PRIMARY KEY CHECK (singleton_id = 1),
                imported_at TIMESTAMPTZ,
                import_scope TEXT
            )
            """
        )
        conn.execute(
            "ALTER TABLE matalia.actual_positions_import_state "
            "ADD COLUMN IF NOT EXISTS import_scope TEXT"
        )
        conn.execute(
            "ALTER TABLE matalia.actual_positions "
            "ADD COLUMN IF NOT EXISTS main_strategy TEXT"
        )
        conn.execute(
            """
            UPDATE matalia.actual_positions
            SET main_strategy = CASE
                WHEN UPPER(BTRIM(strategy)) LIKE 'BANKNIFTY AVWAP%%' OR UPPER(BTRIM(strategy)) LIKE 'R BANKNIFTY AVWAP%%' THEN 'Banknifty AVWAP'
                WHEN UPPER(BTRIM(strategy)) LIKE 'BANKNIFTY FING%%' OR UPPER(BTRIM(strategy)) LIKE 'R BANKNIFTY FING%%' THEN 'Banknifty FING'
                WHEN UPPER(BTRIM(strategy)) LIKE 'NIFTY AVWAP%%' OR UPPER(BTRIM(strategy)) LIKE 'R NIFTY AVWAP%%' THEN 'Nifty AVWAP'
                WHEN UPPER(BTRIM(strategy)) LIKE 'NIFTY FING%%' OR UPPER(BTRIM(strategy)) LIKE 'R NIFTY FING%%' THEN 'Nifty FING'
                WHEN UPPER(BTRIM(strategy)) LIKE 'ATM EMA INTRADAY%%' OR UPPER(BTRIM(strategy)) LIKE 'R ATM EMA INTRADAY%%' THEN 'ATM EMA Intraday'
                WHEN UPPER(BTRIM(strategy)) LIKE 'NIFTY OPT BUY%%' OR UPPER(BTRIM(strategy)) LIKE 'R NIFTY OPT BUY%%' THEN 'Nifty Opt Buy'
                ELSE COALESCE(NULLIF(BTRIM(strategy), ''), 'Unassigned')
            END
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS actual_positions_expiry_idx
            ON matalia.actual_positions (expiry)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS actual_positions_main_strategy_idx
            ON matalia.actual_positions (main_strategy)
            """
        )
        _ACTUAL_SCHEMA_READY = True


def _actual_position_positions(conn: Any) -> list[dict[str, Any]]:
    _ensure_actual_positions_storage(conn)
    cursor = conn.execute(
        """
        SELECT position_id, scrip, expiry, strike, option_type
        FROM matalia.actual_positions
        ORDER BY trade_date, trade_minute, position_id
        """
    )
    columns = [column.name for column in cursor.description]
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
    return [
        {
            "id": str(row["position_id"]),
            "scrip": row["scrip"],
            "expiry": row["expiry"],
            "strike": row["strike"],
            "optType": row["option_type"],
        }
        for row in rows
        if row.get("position_id") is not None
    ]


def _persist_actual_cmp_prices(conn: Any, prices: dict[str, float]) -> int:
    price_rows = list(prices.items())
    if not price_rows:
        return 0
    update = conn.execute(
        """
        UPDATE matalia.actual_positions AS actual
        SET cmp = prices.cmp, updated_at = NOW()
        FROM unnest(%s::text[], %s::numeric[]) AS prices(position_id, cmp)
        WHERE actual.position_id = prices.position_id
        """,
        (
            [str(position_id) for position_id, _price in price_rows],
            [price for _position_id, price in price_rows],
        ),
    )
    return update.rowcount or 0


def _actual_position_row(conn: Any, row: tuple[Any, ...], columns: list[str]) -> dict[str, Any]:
    source = dict(zip(columns, row))
    trade_date = source.get("trade_date")
    expiry = source.get("expiry")
    return {
        "id": str(source.get("position_id") or ""),
        "date": trade_date.strftime("%d %b %Y") if hasattr(trade_date, "strftime") else str(trade_date or ""),
        "time": str(source.get("trade_minute") or ""),
        "tradeId": str(source.get("position_id") or ""),
        "side": "BUY" if str(source.get("trade_type") or "").upper() in {"BUY", "LONG"} else "SELL",
        "scrip": str(source.get("scrip") or ""),
        "expiry": expiry.strftime("%d-%b-%y") if hasattr(expiry, "strftime") else str(expiry or ""),
        "strike": str(source.get("strike") or ""),
        "optType": str(source.get("option_type") or ""),
        "qty": int(round(float(source.get("quantity") or 0))),
        "price": round(float(source.get("average_price") or 0), 2),
        "cmp": round(float(source["cmp"]), 2) if source.get("cmp") is not None else None,
        "mtm": 0,
        "strategy": str(source.get("strategy") or "Unassigned"),
        "mainStrategy": str(source.get("main_strategy") or _main_actual_strategy(source.get("strategy"))),
        "status": "Open",
    }


def _load_actual_position_rows(conn: Any) -> list[dict[str, Any]]:
    _ensure_actual_positions_storage(conn)
    cursor = conn.execute(
        """
        SELECT position_id, trade_date, trade_minute, scrip, expiry, strike,
               option_type, trade_type, quantity, average_price, cmp, strategy, main_strategy
        FROM matalia.actual_positions
        ORDER BY trade_date, trade_minute, position_id
        """
    )
    columns = [column.name for column in cursor.description]
    return [_actual_position_row(conn, row, columns) for row in cursor.fetchall()]


def _actual_positions_import_state(conn: Any) -> tuple[Any, str | None]:
    _ensure_actual_positions_storage(conn)
    result = conn.execute(
        "SELECT imported_at, import_scope FROM matalia.actual_positions_import_state WHERE singleton_id = 1"
    ).fetchone()
    return (result[0], result[1]) if result else (None, None)


def _parse_expiry_date(value: Any) -> date | None:
    if value is None or isinstance(value, date):
        return value.date() if isinstance(value, datetime) else value
    text = str(value).strip()
    for fmt in ("%d-%b-%y", "%d-%b-%Y", "%d%b%y", "%d%b%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text.title(), fmt).date()
        except ValueError:
            continue
    return None


def _actual_strategy_config(strategy: str) -> dict[str, Any] | None:
    requested = str(strategy or "").strip().casefold()
    for name, config in ACTUAL_STRATEGY_CONFIG.items():
        if name.casefold() == requested:
            return {"name": name, **config}
    return None


def _actual_strategy_expiry_choices(instrument: str, mode: str) -> list[dict[str, str]]:
    """Return actual listed weekly or monthly expiry dates from Zerodha's catalogue."""
    _index, catalog_rows = external._instrument_catalog()
    today = date.today()
    all_expiries = sorted({
        parsed
        for row in catalog_rows
        if str(row.get("name") or "").upper().strip() == instrument.upper().strip()
        and (parsed := _parse_expiry_date(row.get("expiry"))) is not None
    })
    active = [expiry for expiry in all_expiries if expiry >= today]
    if mode == "weekly":
        selected = active[:2]
    else:
        selected = []
        year_month = (today.year, today.month)
        next_month = today.month + 1
        next_year = today.year
        if next_month == 13:
            next_month = 1
            next_year += 1
        for period in (year_month, (next_year, next_month)):
            month_dates = [expiry for expiry in active if (expiry.year, expiry.month) == period]
            if month_dates:
                selected.append(max(month_dates))
        if len(selected) < 2:
            monthly_dates: dict[tuple[int, int], date] = {}
            for expiry in active:
                monthly_dates[(expiry.year, expiry.month)] = max(expiry, monthly_dates.get((expiry.year, expiry.month), expiry))
            selected = sorted(monthly_dates.values())[:2]

    return [
        {
            "value": expiry.isoformat(),
            "label": expiry.strftime("%d %b %Y"),
            "dte": str((expiry - today).days),
        }
        for expiry in selected
    ]


def _actual_underlying_price(instrument: str) -> float:
    symbol = "NSE:NIFTY 50" if instrument.upper() == "NIFTY" else "NSE:NIFTY BANK"
    quotes = external.create_kite().ltp([symbol])
    quote = quotes.get(symbol) or {}
    if quote.get("last_price") is None:
        raise RuntimeError(f"Zerodha returned no current {instrument} price")
    return float(quote["last_price"])


def _actual_quote_catalog_rows(instrument: str, expiry: date, option: str) -> list[dict[str, Any]]:
    _index, catalog_rows = external._instrument_catalog()
    return [
        row for row in catalog_rows
        if str(row.get("name") or "").upper().strip() == instrument.upper().strip()
        and _parse_expiry_date(row.get("expiry")) == expiry
        and str(row.get("instrument_type") or "").upper().strip() == option
    ]


def _actual_live_quotes(rows: list[dict[str, Any]]) -> tuple[dict[str, float], str | None]:
    if not rows:
        return {}, "No Zerodha option contracts matched the selected instrument, expiry, and option."
    try:
        positions = [
            {
                "id": str(row.get("tradingsymbol")),
                "scrip": str(row.get("name") or ""),
                "expiry": row.get("expiry"),
                "strike": row.get("strike"),
                "optType": row.get("instrument_type"),
            }
            for row in rows
        ]
        live = external.refresh_prices(positions, prefer_stream=True)
        live_prices = live.get("prices") or {}
        prices = {
            str(row.get("tradingsymbol")): float(live_prices[str(row.get("tradingsymbol"))])
            for row in rows
            if str(row.get("tradingsymbol")) in live_prices
        }
        return prices, live.get("last_error") if not prices else None
    except Exception as error:
        return {}, external.zerodha_error_message(error)


def _strategy_quote_payload(payload: ActualPositionStrategyQuoteRequest) -> dict[str, Any]:
    config = _actual_strategy_config(payload.strategy)
    if config is None:
        raise ValueError("Unknown Actual Positions strategy")
    instrument = str(config["instrument"])
    expiry_choices = _actual_strategy_expiry_choices(instrument, str(config["expiry_mode"]))
    response: dict[str, Any] = {
        "strategy": config["name"],
        "instrument": instrument,
        "side": config.get("side"),
        "expiry_choices": expiry_choices,
        "rows": [],
        "strike_choices": [],
        "underlying_price": payload.underlyingPrice,
        "atm": None,
        "quote_error": None,
        "manual_required": False,
    }
    if config["name"] in {"Nifty FING", "Nifty AVWAP", "Banknifty FING", "Banknifty AVWAP"}:
        try:
            underlying = float(payload.underlyingPrice) if payload.underlyingPrice is not None else _actual_underlying_price(instrument)
            response["underlying_price"] = underlying
            response["atm"] = int((underlying / 100) + 0.5) * 100
        except Exception as error:
            response["quote_error"] = str(error)
    if not payload.expiry:
        return response
    expiry = _parse_expiry_date(payload.expiry)
    if expiry is None:
        raise ValueError("Expiry must be a valid date")
    option = str(payload.option or "").upper().strip()
    if config["name"] == "Nifty Opt Buy":
        side = str(payload.side or "BUY").upper().strip()
        if side not in {"BUY", "SELL"}:
            raise ValueError("Trade Side must be BUY or SELL")
        option = "CE" if side == "BUY" else "PE"
        response["side"] = side
    if option not in {"CE", "PE"}:
        return response
    if config["name"] in {"Nifty FING", "Nifty AVWAP", "Banknifty FING", "Banknifty AVWAP"}:
        try:
            underlying = float(payload.underlyingPrice) if payload.underlyingPrice is not None else _actual_underlying_price(instrument)
            atm = int((underlying / 100) + 0.5) * 100
            response["underlying_price"] = underlying
            response["atm"] = atm
        except Exception as error:
            response["quote_error"] = str(error)
            response["manual_required"] = True
            response["rows"] = [
                {"strategyName": name, "qty": qty, "option": option, "strike": "", "entryPrice": None}
                for name, qty in zip(config["names"], config["quantities"])
            ]
            return response
        strikes = [atm + offset if option == "CE" else atm - offset for offset in config["offsets"]]
        contracts = _actual_quote_catalog_rows(instrument, expiry, option)
        by_strike = {str(int(float(row.get("strike")))): row for row in contracts if row.get("strike") not in {None, ""}}
        selected = [by_strike.get(str(strike)) for strike in strikes]
        missing = [str(strike) for strike, row in zip(strikes, selected) if row is None]
        selected_rows = [row for row in selected if row is not None]
        prices, quote_error = _actual_live_quotes(selected_rows)
        response["quote_error"] = quote_error or (f"No Zerodha contracts found for strike(s): {', '.join(missing)}" if missing else None)
        response["manual_required"] = bool(missing)
        response["rows"] = [
            {
                "strategyName": name,
                "qty": qty,
                "option": option,
                "strike": str(strike),
                "entryPrice": prices.get(str(row.get("tradingsymbol"))) if row else None,
                "livePrice": prices.get(str(row.get("tradingsymbol"))) if row else None,
            }
            for name, qty, strike, row in zip(config["names"], config["quantities"], strikes, selected)
        ]
        return response

    contracts = _actual_quote_catalog_rows(instrument, expiry, option)
    response["strike_choices"] = sorted({
        int(float(row["strike"]))
        for row in contracts
        if row.get("strike") not in {None, ""}
    })
    if payload.strike is not None:
        requested_strike = int(round(float(payload.strike)))
        selected_contract = next(
            (row for row in contracts if row.get("strike") not in {None, ""} and int(float(row["strike"])) == requested_strike),
            None,
        )
        prices, quote_error = _actual_live_quotes([selected_contract] if selected_contract else [])
        selected_price = prices.get(str(selected_contract.get("tradingsymbol"))) if selected_contract else None
        response["quote_error"] = quote_error or (f"No Zerodha contract found for {instrument} strike {requested_strike}. Enter the strike and price manually." if selected_contract is None else None)
        response["manual_required"] = selected_contract is None or selected_price is None
        requested_name = str(payload.strategyName or "").strip().casefold()
        strategy_index = next((index for index, name in enumerate(config["names"]) if name.casefold() == requested_name), 0)
        response["rows"] = [{
            "strategyName": config["names"][strategy_index], "qty": config["quantities"][strategy_index], "option": option,
            "strike": str(requested_strike), "entryPrice": selected_price, "livePrice": selected_price,
        }]
        return response
    prices, quote_error = _actual_live_quotes(contracts)
    priced = [
        (row, prices.get(str(row.get("tradingsymbol"))))
        for row in contracts
        if prices.get(str(row.get("tradingsymbol"))) is not None
    ]
    target = float(config["premium_target"])
    if config.get("premium_strictly_greater"):
        priced = [(row, price) for row, price in priced if price > target]
    selected = min(priced, key=lambda item: abs(item[1] - target), default=None)
    if selected is None:
        response["quote_error"] = quote_error or f"No premium greater than ₹{target:g} was found for the selected option. Enter the strike and price manually."
        response["manual_required"] = True
        response["rows"] = [{"strategyName": config["names"][0], "qty": config["quantities"][0], "option": option, "strike": "", "entryPrice": None}]
    else:
        row, price = selected
        response["rows"] = [{
            "strategyName": config["names"][0], "qty": config["quantities"][0], "option": option,
            "strike": str(int(float(row.get("strike")))), "entryPrice": price, "livePrice": price,
        }]
        response["quote_error"] = quote_error
    return response


def _import_actual_positions(conn: Any) -> tuple[int, int]:
    _ensure_actual_positions_storage(conn)
    # strategy_open.expiry is a legacy TEXT column. Read it first and parse it
    # explicitly instead of comparing text to CURRENT_DATE in PostgreSQL.
    _ensure_open_trade_cmp_storage(conn)
    source_cursor = conn.execute(
        """
        SELECT position_id, entry_date, entry_time, instrument_id, scrip, expiry,
               strike, option_type, trade_type, entry_qty, entry_price, account,
               strategy, cmp
        FROM matalia.strategy_open
        """
    )
    columns = [column.name for column in source_cursor.description]
    source_rows = []
    source_expiries: dict[int, date] = {}
    for row in source_cursor.fetchall():
        source = dict(zip(columns, row))
        expiry_date = _parse_expiry_date(source.get("expiry"))
        if source.get("expiry") is not None and expiry_date is None:
            logger.warning("Skipping Actual Position %s with unrecognized expiry %r", source.get("position_id"), source.get("expiry"))
            continue
        if expiry_date is not None:
            source_expiries[len(source_rows)] = expiry_date
        source_rows.append((
            str(source.get("position_id")),
            source.get("entry_date"),
            str(source.get("entry_time") or ""),
            source.get("instrument_id"),
            source.get("scrip") or "",
            expiry_date,
            source.get("strike"),
            source.get("option_type"),
            source.get("trade_type"),
            source.get("entry_qty"),
            source.get("entry_price"),
            source.get("account"),
            source.get("strategy"),
            _main_actual_strategy(source.get("strategy")),
            source.get("cmp"),
        ))
    active_expiries = sorted({expiry for expiry in source_expiries.values() if expiry >= date.today()})[:4]
    selected_expiries = set(active_expiries)
    filtered_rows = [row for index, row in enumerate(source_rows) if source_expiries.get(index) in selected_expiries]

    # Each import is a complete replacement snapshot. Because this is one
    # database transaction, a failed insert rolls back and preserves the
    # previous snapshot instead of leaving the table partially populated.
    conn.execute("DELETE FROM matalia.actual_positions")
    conn.execute("DELETE FROM matalia.actual_positions_import_state WHERE singleton_id = 1")
    if filtered_rows:
        with conn.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO matalia.actual_positions (
                    position_id, trade_date, trade_minute, instrument_id, scrip, expiry,
                    strike, option_type, trade_type, quantity, average_price, account,
                    strategy, main_strategy, cmp, imported_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (position_id) DO NOTHING
                """,
                filtered_rows,
            )
    conn.execute(
        """
        INSERT INTO matalia.actual_positions_import_state (singleton_id, imported_at, import_scope)
        VALUES (1, NOW(), %s)
        """
        , (ACTUAL_IMPORT_SCOPE,)
    )
    return len(filtered_rows), len(selected_expiries)


def _ensure_open_trade_cmp_storage(conn: Any) -> None:
    """Ensure the open-trade view exposes the persisted CMP column."""
    global _CMP_SCHEMA_READY
    if _CMP_SCHEMA_READY:
        return
    with _CMP_SCHEMA_LOCK:
        if _CMP_SCHEMA_READY:
            return
        conn.execute(
            "ALTER TABLE matalia.strategy_allocation "
            "ADD COLUMN IF NOT EXISTS cmp double precision"
        )
        conn.execute(
            """
        CREATE OR REPLACE VIEW matalia.strategy_open AS
        SELECT
            row_number() OVER (ORDER BY trade_date, trade_minute, position_id) AS id,
            position_id,
            allocation_id AS entry_id,
            strategy,
            account,
            scrip,
            instrument_id,
            expiry,
            strike,
            option_type,
            trade_type,
            trade_date AS entry_date,
            trade_minute AS entry_time,
            quantity AS entry_qty,
            average_price AS entry_price,
            cmp,
            'Open'::text AS status
        FROM matalia.strategy_allocation e
        WHERE trade_action = 'Entry'
          AND NOT EXISTS (
              SELECT 1
              FROM matalia.strategy_allocation x
              WHERE x.position_id = e.position_id
                AND x.trade_action = 'Exit'
                AND x.strategy = e.strategy
                AND x.trade_type <> e.trade_type
                AND x.quantity = e.quantity
          )
            """
        )
        _CMP_SCHEMA_READY = True


def _open_trade_positions(conn: Any) -> list[dict[str, Any]]:
    _ensure_open_trade_cmp_storage(conn)
    cursor = conn.execute(
        "SELECT position_id, scrip, expiry, strike, option_type FROM matalia.strategy_open"
    )
    columns = [column.name for column in cursor.description]
    source_rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
    return [
        {
            "id": str(row["position_id"]),
            "scrip": row["scrip"],
            "expiry": row["expiry"],
            "strike": row["strike"],
            "optType": row["option_type"],
        }
        for row in source_rows
        if row.get("position_id") is not None
    ]


def _persist_cmp_prices(conn: Any, prices: dict[str, float]) -> int:
    price_rows = list(prices.items())
    if not price_rows:
        return 0
    update = conn.execute(
        """
        UPDATE matalia.strategy_allocation AS allocation
        SET cmp = prices.cmp
        FROM unnest(%s::text[], %s::numeric[]) AS prices(position_id, cmp)
        WHERE allocation.position_id::text = prices.position_id
          AND allocation.trade_action = 'Entry'
        """,
        (
            [str(position_id) for position_id, _price in price_rows],
            [price for _position_id, price in price_rows],
        ),
    )
    return update.rowcount or 0


def _background_update_once() -> dict[str, Any]:
    """Poll and persist open-position CMP values without a browser request."""
    with _CMP_UPDATE_LOCK:
        with connect() as conn:
            strategy_positions = _open_trade_positions(conn)
            actual_positions = _actual_position_positions(conn)
        positions_by_id = {str(position["id"]): position for position in strategy_positions}
        positions_by_id.update({str(position["id"]): position for position in actual_positions})
        positions = list(positions_by_id.values())
        if not positions:
            external.get_market_stream().set_position_tokens({})
            return {"requested": 0, "fetched": 0, "updated": 0, "last_error": None}

        # REST LTP polling is deliberate here. It is independent of browser
        # lifetime and also provides a fallback when the optional WebSocket is
        # unavailable. Kite's LTP endpoint accepts up to 1000 instruments.
        result = external.refresh_prices(positions, prefer_stream=False)
        with connect() as conn:
            strategy_updated = _persist_cmp_prices(conn, result["prices"])
            actual_updated = _persist_actual_cmp_prices(conn, result["prices"])
        return {
            "requested": len(positions),
            "fetched": len(result["prices"]),
            "updated": strategy_updated + actual_updated,
            "strategy_updated": strategy_updated,
            "actual_updated": actual_updated,
            "last_error": result.get("last_error"),
        }


class BackgroundLivePriceWorker:
    """Keep the broker poller alive for the API process lifetime."""

    def __init__(self, interval_seconds: float):
        self.interval_seconds = max(1.0, interval_seconds)
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self._last_error: str | None = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="zerodha-cmp-worker", daemon=True)
        self.thread.start()
        logger.info("Started background Zerodha CMP worker (%.1fs interval)", self.interval_seconds)

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=min(self.interval_seconds + 1, 10))
        self.thread = None

    def _run(self) -> None:
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                result = _background_update_once()
                error = result.get("last_error")
                if error and error != self._last_error:
                    logger.warning("Background Zerodha CMP update issue: %s", error)
                self._last_error = error
            except Exception as error:
                message = f"{type(error).__name__}: {error}"
                if message != self._last_error:
                    logger.warning("Background Zerodha CMP worker paused: %s", message)
                self._last_error = message
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.1, self.interval_seconds - elapsed))


def start_background_live_price_worker() -> None:
    """Start browser-independent CMP updates when the API service starts."""
    global _BACKGROUND_WORKER
    if os.getenv("ZERODHA_BACKGROUND_UPDATES", "true").strip().lower() == "false":
        logger.info("Background Zerodha CMP worker disabled by ZERODHA_BACKGROUND_UPDATES")
        return
    try:
        interval = float(os.getenv("ZERODHA_BACKGROUND_UPDATE_INTERVAL_SECONDS", "5"))
    except ValueError:
        interval = 5.0
    if _BACKGROUND_WORKER is None:
        _BACKGROUND_WORKER = BackgroundLivePriceWorker(interval)
    _BACKGROUND_WORKER.start()


def stop_background_live_price_worker() -> None:
    global _BACKGROUND_WORKER
    if _BACKGROUND_WORKER is not None:
        _BACKGROUND_WORKER.stop()
        _BACKGROUND_WORKER = None


@router.post("/api/zerodha/refresh-prices")
def refresh_zerodha_prices(payload: ZerodhaPriceRefreshRequest) -> JSONResponse:
    try:
        result = external.refresh_prices(payload.positions, prefer_stream=False)
        return JSONResponse(status_code=200, content={"success": True, **result})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "prices": {}, "message": f"CMP refresh failed: {error}"})


@router.post("/api/zerodha/start-live-prices")
def start_live_zerodha_prices(payload: ZerodhaPriceRefreshRequest) -> JSONResponse:
    try:
        result = external.refresh_prices(payload.positions, prefer_stream=False)
        return JSONResponse(status_code=200, content={"success": True, **result, "message": result.get("last_error") or "Backend CMP polling is active."})
    except Exception as error:
        return JSONResponse(status_code=200, content={"success": False, "prices": {}, "connected": False, "last_error": f"Live CMP startup failed: {error}", "message": f"Live CMP startup failed: {error}"})


@router.post("/api/positions/update-cmp")
def update_open_trade_cmps() -> JSONResponse:
    """Fetch current prices and persist them on open strategy allocations."""
    try:
        with _CMP_UPDATE_LOCK:
            with connect() as conn:
                positions = _open_trade_positions(conn)
            result = external.refresh_prices(positions, prefer_stream=False)
            with connect() as conn:
                updated = _persist_cmp_prices(conn, result["prices"])

        return JSONResponse(status_code=200, content={
            "success": True,
            "requested": len(positions),
            "fetched": len(result["prices"]),
            "updated": updated,
            "prices": result["prices"],
            "mapped": result.get("mapped", 0),
            "last_error": result.get("last_error"),
            "timings": result.get("timings", {}),
            "message": f"Updated CMP for {updated} open trade(s).",
        })
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "updated": 0, "message": f"CMP update failed: {error}"})


@router.get("/api/actual-positions")
def actual_positions() -> JSONResponse:
    """Read the manually maintained Actual Positions snapshot."""
    try:
        with connect() as conn:
            rows = _load_actual_position_rows(conn)
            imported_at, import_scope = _actual_positions_import_state(conn)
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "imported": imported_at is not None,
                "needs_reimport": imported_at is not None and import_scope != ACTUAL_IMPORT_SCOPE,
                "imported_at": imported_at.isoformat() if hasattr(imported_at, "isoformat") else imported_at,
                "rows": rows,
                "total_rows": len(rows),
            },
        )
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "rows": [], "message": f"Unable to load Actual Positions: {error}"})


@router.post("/api/actual-positions/import")
def import_actual_positions() -> JSONResponse:
    """Take the one-time snapshot from the current open positions."""
    try:
        with connect() as conn:
            imported_count, expiry_count = _import_actual_positions(conn)
            rows = _load_actual_position_rows(conn)
            imported_at, _import_scope = _actual_positions_import_state(conn)
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "imported": True,
                "imported_count": imported_count,
                "expiry_count": expiry_count,
                "imported_at": imported_at.isoformat() if hasattr(imported_at, "isoformat") else imported_at,
                "rows": rows,
                "total_rows": len(rows),
                "message": f"Imported {imported_count} position(s) from {expiry_count} active expiry date(s). Actual Positions is now a manual snapshot.",
            },
        )
    except RuntimeError as error:
        return JSONResponse(status_code=409, content={"success": False, "message": str(error)})
    except Exception as error:
        logger.exception("Actual Positions one-time import failed")
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to import Actual Positions: {error}"})


@router.post("/api/actual-positions/strategy-quotes")
def actual_position_strategy_quotes(payload: ActualPositionStrategyQuoteRequest) -> JSONResponse:
    """Return strategy defaults, active expiry choices, and Zerodha option quotes."""
    try:
        return JSONResponse(status_code=200, content={"success": True, **_strategy_quote_payload(payload)})
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        logger.exception("Actual Positions strategy quote lookup failed")
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to load strategy options: {error}"})


def _validated_actual_position_values(payload: ActualPositionCreateRequest) -> tuple[Any, ...]:
    strategy = payload.strategyName.strip()
    instrument = payload.instrument.strip().upper()
    option = payload.option.strip().upper()
    side = payload.side.strip().upper()
    if not strategy or not instrument or not payload.time.strip():
        raise ValueError("Strategy Name, Instrument, and Time are required")
    if side not in {"BUY", "SELL"}:
        raise ValueError("Trade Side must be BUY or SELL")
    if option not in {"CE", "PE"}:
        raise ValueError("Option must be CE or PE")
    trade_date = date.fromisoformat(payload.date)
    expiry_date = _parse_expiry_date(payload.expiry)
    if expiry_date is None:
        raise ValueError("Expiry must be a valid date")
    if payload.qty <= 0:
        raise ValueError("Quantity must be greater than zero")
    if payload.entryPrice < 0:
        raise ValueError("Entry Price cannot be negative")
    if payload.strike <= 0:
        raise ValueError("Strike must be greater than zero")
    position_id = f"manual-{uuid4().hex}"
    return (
        position_id, trade_date, payload.time.strip(), instrument, expiry_date, payload.strike,
        option, side, payload.qty, payload.entryPrice, strategy,
    )


def _actual_positions_response(conn: Any, message: str) -> dict[str, Any]:
    rows = _load_actual_position_rows(conn)
    imported_at, import_scope = _actual_positions_import_state(conn)
    return {
        "success": True,
        "imported": imported_at is not None,
        "needs_reimport": imported_at is not None and import_scope != ACTUAL_IMPORT_SCOPE,
        "imported_at": imported_at.isoformat() if hasattr(imported_at, "isoformat") else imported_at,
        "rows": rows,
        "total_rows": len(rows),
        "message": message,
    }


@router.post("/api/actual-positions/rows/bulk")
def add_actual_positions_bulk(payload: ActualPositionRowsCreateRequest) -> JSONResponse:
    """Insert a wizard group atomically so all strategy legs save together."""
    try:
        if not payload.rows:
            raise ValueError("At least one position is required")
        values = [_validated_actual_position_values(row) for row in payload.rows]
        with connect() as conn:
            _ensure_actual_positions_storage(conn)
            with conn.cursor() as cursor:
                cursor.executemany(
                    """
                    INSERT INTO matalia.actual_positions (
                        position_id, trade_date, trade_minute, instrument_id, scrip, expiry,
                        strike, option_type, trade_type, quantity, average_price, account,
                        strategy, main_strategy, cmp, imported_at, updated_at
                    )
                    VALUES (%s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, 'Manual', %s, %s, %s, NOW(), NOW())
                    """,
                    [(*row, _main_actual_strategy(row[10]), row[9]) for row in values],
                )
            response = _actual_positions_response(conn, f"Saved {len(values)} Actual Position(s) together.")
        return JSONResponse(status_code=200, content=response)
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        logger.exception("Grouped Actual Position insert failed")
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to save Actual Positions: {error}"})


@router.post("/api/actual-positions/rows")
def add_actual_position(payload: ActualPositionCreateRequest) -> JSONResponse:
    """Add one manually entered position to the Actual Positions snapshot."""
    try:
        strategy = payload.strategyName.strip()
        instrument = payload.instrument.strip().upper()
        option = payload.option.strip().upper()
        side = payload.side.strip().upper()
        if not strategy or not instrument or not payload.time.strip():
            raise ValueError("Strategy Name, Instrument, and Time are required")
        if side not in {"BUY", "SELL"}:
            raise ValueError("Trade Side must be BUY or SELL")
        if option not in {"CE", "PE"}:
            raise ValueError("Option must be CE or PE")
        trade_date = date.fromisoformat(payload.date)
        expiry_date = _parse_expiry_date(payload.expiry)
        if expiry_date is None:
            raise ValueError("Expiry must be a valid date")
        if payload.qty <= 0:
            raise ValueError("Quantity must be greater than zero")
        if payload.entryPrice < 0:
            raise ValueError("Entry Price cannot be negative")

        position_id = f"manual-{uuid4().hex}"
        with connect() as conn:
            _ensure_actual_positions_storage(conn)
            conn.execute(
                """
                INSERT INTO matalia.actual_positions (
                    position_id, trade_date, trade_minute, instrument_id, scrip, expiry,
                    strike, option_type, trade_type, quantity, average_price, account,
                    strategy, main_strategy, cmp, imported_at, updated_at
                )
                VALUES (%s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, 'Manual', %s, %s, %s, NOW(), NOW())
                """,
                (
                    position_id,
                    trade_date,
                    payload.time.strip(),
                    instrument,
                    expiry_date,
                    payload.strike,
                    option,
                    side,
                    payload.qty,
                    payload.entryPrice,
                    strategy,
                    _main_actual_strategy(strategy),
                    payload.entryPrice,
                ),
            )
            rows = _load_actual_position_rows(conn)
            imported_at, import_scope = _actual_positions_import_state(conn)
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "imported": imported_at is not None,
                "needs_reimport": imported_at is not None and import_scope != ACTUAL_IMPORT_SCOPE,
                "imported_at": imported_at.isoformat() if hasattr(imported_at, "isoformat") else imported_at,
                "rows": rows,
                "total_rows": len(rows),
                "message": "Position added to Actual Positions.",
            },
        )
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        logger.exception("Manual Actual Position insert failed")
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to add Actual Position: {error}"})


@router.put("/api/actual-positions/rows/{position_id}")
def update_actual_position(position_id: str, payload: ActualPositionCreateRequest) -> JSONResponse:
    """Update one manually maintained Actual Position row."""
    try:
        values = _validated_actual_position_values(payload)
        with connect() as conn:
            _ensure_actual_positions_storage(conn)
            updated = conn.execute(
                """
                UPDATE matalia.actual_positions
                SET trade_date = %s, trade_minute = %s, scrip = %s, expiry = %s,
                    strike = %s, option_type = %s, trade_type = %s, quantity = %s,
                    average_price = %s, strategy = %s, main_strategy = %s, cmp = %s, updated_at = NOW()
                WHERE position_id = %s
                """,
                (values[1], values[2], values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10], _main_actual_strategy(values[10]), values[9], position_id),
            )
            if not updated.rowcount:
                return JSONResponse(status_code=404, content={"success": False, "message": "Actual Position was not found"})
            response = _actual_positions_response(conn, "Actual Position updated.")
        return JSONResponse(status_code=200, content=response)
    except ValueError as error:
        return JSONResponse(status_code=400, content={"success": False, "message": str(error)})
    except Exception as error:
        logger.exception("Actual Position update failed")
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to update Actual Position: {error}"})


@router.delete("/api/actual-positions/rows/{position_id}")
def delete_actual_position(position_id: str) -> JSONResponse:
    """Delete one Actual Position row after the UI confirmation."""
    try:
        with connect() as conn:
            _ensure_actual_positions_storage(conn)
            deleted = conn.execute("DELETE FROM matalia.actual_positions WHERE position_id = %s", (position_id,))
            if not deleted.rowcount:
                return JSONResponse(status_code=404, content={"success": False, "message": "Actual Position was not found"})
            response = _actual_positions_response(conn, "Actual Position deleted.")
        return JSONResponse(status_code=200, content=response)
    except Exception as error:
        logger.exception("Actual Position delete failed")
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to delete Actual Position: {error}"})


@router.post("/api/actual-positions/update-cmp")
def update_actual_position_cmps() -> JSONResponse:
    """Fetch current prices and persist CMP only on the actual snapshot."""
    try:
        with _CMP_UPDATE_LOCK:
            with connect() as conn:
                positions = _actual_position_positions(conn)
            result = external.refresh_prices(positions, prefer_stream=False)
            with connect() as conn:
                updated = _persist_actual_cmp_prices(conn, result["prices"])
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "requested": len(positions),
                "fetched": len(result["prices"]),
                "updated": updated,
                "prices": result["prices"],
                "mapped": result.get("mapped", 0),
                "last_error": result.get("last_error"),
                "timings": result.get("timings", {}),
                "message": f"Updated CMP for {updated} Actual Position(s).",
            },
        )
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "updated": 0, "message": f"Actual Positions CMP update failed: {error}"})


@router.get("/api/zerodha/status")
def zerodha_connection_status() -> JSONResponse:
    try:
        return JSONResponse(status_code=200, content=external.zerodha_status())
    except Exception as error:
        return JSONResponse(status_code=502, content={"connected": False, "message": str(error)})


@router.get("/api/zerodha/login-url")
def zerodha_login_url() -> JSONResponse:
    try:
        return JSONResponse(status_code=200, content={"loginUrl": external.zerodha_login_url()})
    except Exception as error:
        return JSONResponse(status_code=502, content={"message": str(error)})


@router.post("/api/zerodha/token")
def save_zerodha_token(payload: ZerodhaTokenRequest) -> JSONResponse:
    try:
        return JSONResponse(status_code=200, content=external.complete_zerodha_token(payload.redirectUrl))
    except Exception as error:
        return JSONResponse(status_code=502, content={"connected": False, "message": str(error)})


@router.get("/api/zerodha/live-prices")
def live_zerodha_prices() -> JSONResponse:
    try:
        return JSONResponse(status_code=200, content={"success": True, **external.live_prices()})
    except Exception as error:
        return JSONResponse(status_code=200, content={"success": False, "connected": False, "prices": {}, "last_error": f"Live CMP read failed: {error}", "message": f"Live CMP read failed: {error}"})
