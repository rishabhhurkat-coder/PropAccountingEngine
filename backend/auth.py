"""Self-contained session authentication for the Prop Trading backend."""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any

from fastapi import HTTPException

from .user_store import authenticate as authenticate_from_store


SESSION_TTL_SECONDS = 12 * 60 * 60
_SESSIONS: dict[str, dict[str, Any]] = {}
_SESSION_LOCK = threading.RLock()


def authenticate(username: str, password: str) -> dict[str, Any] | None:
    """Authenticate against the Prop Trading-owned users table."""
    from .connections import _external

    return authenticate_from_store(_external().connect, username, password)


def create_session(user: dict[str, Any]) -> str:
    token = secrets.token_urlsafe(32)
    with _SESSION_LOCK:
        _SESSIONS[token] = {**user, "created_at": time.time()}
    return token


def revoke_session(authorization: str) -> None:
    _, _, token = authorization.partition(" ")
    with _SESSION_LOCK:
        _SESSIONS.pop(token, None)


def require_user(authorization: str = "") -> dict[str, Any]:
    scheme, _, token = authorization.partition(" ")
    with _SESSION_LOCK:
        session = _SESSIONS.get(token)
        expired = session is None or time.time() - float(session.get("created_at", 0)) > SESSION_TTL_SECONDS
        if expired:
            _SESSIONS.pop(token, None)
    if scheme.casefold() != "bearer" or session is None or expired:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return dict(session)
