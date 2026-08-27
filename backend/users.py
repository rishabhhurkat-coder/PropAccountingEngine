"""Admin-only Prop Trading user management routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from backend.auth import require_user
from backend import user_store
from backend.connections import _external


router = APIRouter(prefix="/api/users", tags=["prop-users"])


class PropUser(BaseModel):
    id: int
    user_name: str
    user_class: str
    user_type: str
    is_active: bool


class PropUserInput(BaseModel):
    user_name: str = Field(min_length=1, max_length=120)
    password: str | None = Field(default=None, min_length=1)
    user_class: str
    is_active: bool = True


def _admin_user(authorization: str) -> dict[str, Any]:
    user = require_user(authorization)
    if str(user.get("user_type", "")).casefold() != "admin":
        raise HTTPException(status_code=403, detail="Administrator access is required.")
    return user


def _connect():
    return _external().connect()


@router.get("", response_model=list[PropUser])
def get_users(authorization: str = Header(default="")) -> list[dict[str, Any]]:
    _admin_user(authorization)
    return user_store.list_users(_connect)


@router.post("", response_model=PropUser, status_code=201)
def add_user(payload: PropUserInput, authorization: str = Header(default="")) -> dict[str, Any]:
    _admin_user(authorization)
    if not payload.password:
        raise HTTPException(status_code=422, detail="Password is required for a new user.")
    try:
        return user_store.create_user(_connect, payload.user_name, payload.password, payload.user_class, payload.is_active)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.patch("/{user_id}", response_model=PropUser)
def edit_user(user_id: int, payload: PropUserInput, authorization: str = Header(default="")) -> dict[str, Any]:
    _admin_user(authorization)
    try:
        return user_store.update_user(_connect, user_id, payload.user_name, payload.password, payload.user_class, payload.is_active)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
