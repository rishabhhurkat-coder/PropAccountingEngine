"""Live positions and Zerodha market-price API routes.

This module owns the live-position API surface.  ``main.py`` only loads this
router and coordinates the application; Zerodha authentication, instrument
resolution, and WebSocket handling remain in ``09_External_Connections.py``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

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


class ZerodhaPriceRefreshRequest(BaseModel):
    positions: list[dict[str, Any]]


class ZerodhaTokenRequest(BaseModel):
    redirectUrl: str


def _ensure_open_trade_cmp_storage(conn: Any) -> None:
    """Ensure the open-trade view exposes the persisted CMP column."""
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
          )
        """
    )


@router.post("/api/zerodha/refresh-prices")
def refresh_zerodha_prices(payload: ZerodhaPriceRefreshRequest) -> JSONResponse:
    try:
        result = external.refresh_prices(payload.positions)
        return JSONResponse(status_code=200, content={"success": True, "prices": result["prices"]})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "prices": {}, "message": str(error)})


@router.post("/api/zerodha/start-live-prices")
def start_live_zerodha_prices(payload: ZerodhaPriceRefreshRequest) -> JSONResponse:
    try:
        return JSONResponse(status_code=200, content={"success": True, **external.prepare_live_prices(payload.positions)})
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "prices": {}, "message": str(error)})


@router.post("/api/positions/update-cmp")
def update_open_trade_cmps() -> JSONResponse:
    """Fetch current prices and persist them on open strategy allocations."""
    try:
        with connect() as conn:
            _ensure_open_trade_cmp_storage(conn)
            cursor = conn.execute(
                "SELECT position_id, scrip, expiry, strike, option_type FROM matalia.strategy_open"
            )
            columns = [column.name for column in cursor.description]
            source_rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
            positions = [
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
            result = external.refresh_prices(positions)
            updated = 0
            for position_id, price in result["prices"].items():
                update = conn.execute(
                    "UPDATE matalia.strategy_allocation SET cmp = %s "
                    "WHERE position_id::text = %s AND trade_action = 'Entry'",
                    (price, str(position_id)),
                )
                updated += update.rowcount or 0

        return JSONResponse(status_code=200, content={
            "success": True,
            "requested": len(positions),
            "fetched": len(result["prices"]),
            "updated": updated,
            "message": f"Updated CMP for {updated} open trade(s).",
        })
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "updated": 0, "message": str(error)})


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
        return JSONResponse(status_code=502, content={"success": False, "prices": {}, "message": str(error)})
