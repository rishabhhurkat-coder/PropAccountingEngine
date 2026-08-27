"""Prop Trading user storage and password verification.

This module is intentionally independent from Email Automation.  The Prop
backend owns its users, credentials, and role assignments in the
``matalia.prop_trading_users`` table.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Any

from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row


USER_TABLE = "matalia.prop_trading_users"
PASSWORD_SCHEME = "scrypt"
PASSWORD_N = 16_384
PASSWORD_R = 8
PASSWORD_P = 1
PASSWORD_SALT_BYTES = 16
PASSWORD_KEY_BYTES = 64
ALLOWED_CLASSES = {"Admin", "Staff"}

# These are one-way password hashes for the initial Prop sign-ins.  The
# original passwords are deliberately not retained in the repository.
INITIAL_USERS = (
    {
        "user_name": "Rishabh",
        "password_hash": "scrypt$16384$8$1$qL-d4o3YljNnlWqctC_Kxw$9uIVv6L0oZC0iwWz9EwkflLSUyj4jupLFmOq4zZZvZ03dfmaGL0bl7OXtuxivTZW5jQjjldEFjfsngqtbQ1IJA",
        "user_class": "Admin",
    },
    {
        "user_name": "Saloni",
        "password_hash": "scrypt$16384$8$1$ObOgHRG1IVJhiMVJXwgngA$jftiCyTaVOK51Ni8ad7pEdIYJtz2A2LUgKD_9VAs7tHyDgd2GDs8hHmoz8GA6d24xcL1jr88BoExJNpuNJUNuw",
        "user_class": "Admin",
    },
    {
        "user_name": "Neha",
        "password_hash": "scrypt$16384$8$1$Dz-qWwMC4VBk6C70cM-e9A$I_9en9cyphtb8sHbSbgadmQ3LHWW-sRnZaJCHTYL8l-c-SKaUhhpwc1rpB2scRpNzOLr2nCea8p2AuVPyKwgZw",
        "user_class": "Staff",
    },
)


def _clean_username(value: str) -> str:
    username = str(value or "").strip()
    if not username:
        raise ValueError("Username is required.")
    if len(username) > 120:
        raise ValueError("Username must be 120 characters or fewer.")
    return username


def _clean_class(value: str) -> str:
    normalized = str(value or "").strip().casefold()
    if normalized == "admin":
        return "Admin"
    if normalized == "staff":
        return "Staff"
    raise ValueError("User class must be Admin or Staff.")


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str) -> str:
    if not password:
        raise ValueError("Password is required.")
    salt = os.urandom(PASSWORD_SALT_BYTES)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=PASSWORD_N,
        r=PASSWORD_R,
        p=PASSWORD_P,
        dklen=PASSWORD_KEY_BYTES,
    )
    return "$".join((PASSWORD_SCHEME, str(PASSWORD_N), str(PASSWORD_R), str(PASSWORD_P), _encode(salt), _encode(derived)))


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n_value, r_value, p_value, salt_value, hash_value = str(encoded).split("$", 5)
        if scheme != PASSWORD_SCHEME:
            return False
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_decode(salt_value),
            n=int(n_value),
            r=int(r_value),
            p=int(p_value),
            dklen=len(_decode(hash_value)),
        )
        return hmac.compare_digest(derived, _decode(hash_value))
    except (TypeError, ValueError, UnicodeError):
        return False


def ensure_user_schema(connection: Any) -> None:
    """Create the Prop user table and idempotently seed its initial users."""
    connection.execute("CREATE SCHEMA IF NOT EXISTS matalia")
    connection.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {USER_TABLE} (
            id BIGSERIAL PRIMARY KEY,
            user_name VARCHAR(120) NOT NULL,
            password_hash TEXT NOT NULL,
            user_class VARCHAR(32) NOT NULL CHECK (user_class IN ('Admin', 'Staff')),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    connection.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS prop_trading_users_name_idx ON {USER_TABLE} (LOWER(user_name))")
    connection.execute(f"ALTER TABLE {USER_TABLE} ENABLE ROW LEVEL SECURITY")
    connection.execute(f"REVOKE ALL ON TABLE {USER_TABLE} FROM PUBLIC")
    connection.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                EXECUTE 'REVOKE ALL ON TABLE {USER_TABLE} FROM anon';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                EXECUTE 'REVOKE ALL ON TABLE {USER_TABLE} FROM authenticated';
            END IF;
        END
        $$
        """
    )
    for seed in INITIAL_USERS:
        connection.execute(
            f"""
            INSERT INTO {USER_TABLE} (user_name, password_hash, user_class)
            SELECT %s, %s, %s
            WHERE NOT EXISTS (
                SELECT 1 FROM {USER_TABLE} WHERE LOWER(user_name) = LOWER(%s)
            )
            """,
            (seed["user_name"], seed["password_hash"], seed["user_class"], seed["user_name"]),
        )


def authenticate(connection_factory: Any, username: str, password: str) -> dict[str, Any] | None:
    """Return a safe session user when credentials match an active Prop user."""
    try:
        with connection_factory() as connection, connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                f"""
                SELECT id, user_name, user_class, is_active, password_hash
                FROM {USER_TABLE}
                WHERE LOWER(user_name) = LOWER(%s) AND is_active = TRUE
                """,
                (_clean_username(username),),
            )
            user = cursor.fetchone()
    except (KeyError, ValueError):
        return None
    if not user or not verify_password(password, user.get("password_hash", "")):
        return None
    return {
        "id": int(user["id"]),
        "user_name": user["user_name"],
        "user_type": user["user_class"],
        "user_class": user["user_class"],
        "is_active": bool(user["is_active"]),
    }


def list_users(connection_factory: Any) -> list[dict[str, Any]]:
    with connection_factory() as connection, connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(f"SELECT id, user_name, user_class, is_active FROM {USER_TABLE} ORDER BY LOWER(user_name)")
        return [
            {
                "id": int(row["id"]),
                "user_name": row["user_name"],
                "user_class": row["user_class"],
                "user_type": row["user_class"],
                "is_active": bool(row["is_active"]),
            }
            for row in cursor.fetchall()
        ]


def create_user(connection_factory: Any, user_name: str, password: str, user_class: str, is_active: bool) -> dict[str, Any]:
    username = _clean_username(user_name)
    role = _clean_class(user_class)
    password_hash = hash_password(password)
    try:
        with connection_factory() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                INSERT INTO {USER_TABLE} (user_name, password_hash, user_class, is_active)
                VALUES (%s, %s, %s, %s)
                RETURNING id, user_name, user_class, is_active
                """,
                (username, password_hash, role, bool(is_active)),
            )
            row = cursor.fetchone()
    except UniqueViolation as error:
        raise ValueError("That username already exists.") from error
    return _safe_row(row)


def update_user(
    connection_factory: Any,
    user_id: int,
    user_name: str,
    password: str | None,
    user_class: str,
    is_active: bool,
) -> dict[str, Any]:
    username = _clean_username(user_name)
    role = _clean_class(user_class)
    password_hash = hash_password(password) if password else None
    try:
        with connection_factory() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                UPDATE {USER_TABLE}
                SET user_name = %s,
                    password_hash = COALESCE(%s, password_hash),
                    user_class = %s,
                    is_active = %s,
                    updated_at = NOW()
                WHERE id = %s
                RETURNING id, user_name, user_class, is_active
                """,
                (username, password_hash, role, bool(is_active), int(user_id)),
            )
            row = cursor.fetchone()
    except UniqueViolation as error:
        raise ValueError("That username already exists.") from error
    if row is None:
        raise LookupError("Prop Trading user not found.")
    return _safe_row(row)


def _safe_row(row: Any) -> dict[str, Any]:
    return {
        "id": int(row[0]),
        "user_name": row[1],
        "user_class": row[2],
        "user_type": row[2],
        "is_active": bool(row[3]),
    }
