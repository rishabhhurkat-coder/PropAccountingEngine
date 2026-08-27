"""Public broker connection callbacks owned by the Prop Trading backend."""

from __future__ import annotations

import logging
import importlib.util
import os
import sys
from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, BackgroundTasks, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

router = APIRouter(prefix="/api/connections/zerodha", tags=["connections"])
logger = logging.getLogger(__name__)


def _external() -> object:
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


def _sync_zerodha_instruments_in_background() -> None:
    try:
        result = _external().sync_instruments()
        logger.info(
            "Zerodha instrument sync completed: %s rows published to %s",
            result["row_count"],
            result["gcs_object"],
        )
    except Exception:
        logger.exception("Zerodha instrument sync failed after successful token callback")


def _landing_origin() -> str:
    configured = os.getenv("PUBLIC_APP_ORIGIN", "https://hnlsoftware.in").strip().rstrip("/")
    return configured or "https://hnlsoftware.in"


def _connection_redirect(**params: str) -> RedirectResponse:
    query = urlencode(params)
    suffix = f"?{query}" if query else ""
    return RedirectResponse(f"{_landing_origin()}/connections{suffix}", status_code=303)


def _safe_status(result: dict[str, object]) -> dict[str, object]:
    connected = bool(result.get("connected"))
    return {
        "connected": connected,
        "broker": "zerodha",
        "status": "connected" if connected else "disconnected",
        "message": "Zerodha is connected." if connected else "Zerodha is not connected.",
    }


@router.get("/status")
def zerodha_status() -> JSONResponse:
    try:
        return JSONResponse(status_code=200, content=_safe_status(_external().validate_zerodha()))
    except Exception:
        return JSONResponse(
            status_code=200,
            content={
                "connected": False,
                "broker": "zerodha",
                "status": "error",
                "message": "We could not check the Zerodha connection right now.",
            },
        )


@router.get("/login")
def start_zerodha_login() -> Response:
    try:
        return RedirectResponse(_external().zerodha_login_url(), status_code=307)
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"connected": False, "broker": "zerodha", "message": "Zerodha login is not configured."},
        )


@router.get("/callback")
def zerodha_callback(
    request: Request,
    background_tasks: BackgroundTasks,
    request_token: str | None = None,
    status: str | None = None,
) -> RedirectResponse:
    if status and status.casefold() != "success":
        return _connection_redirect(zerodha="disconnected")
    if not request_token:
        return _connection_redirect(zerodha="error")

    try:
        result = _external().complete_zerodha_token(str(request.url))
    except Exception:
        return _connection_redirect(zerodha="error")

    background_tasks.add_task(_sync_zerodha_instruments_in_background)
    return _connection_redirect(zerodha="connected" if result.get("connected") else "error")
