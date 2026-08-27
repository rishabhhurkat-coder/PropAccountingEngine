-- Prop Trading-owned credentials table.
-- Runtime startup also applies this schema and seeds the initial hashed users.
-- No raw passwords belong in migrations or source control.

CREATE SCHEMA IF NOT EXISTS matalia;

CREATE TABLE IF NOT EXISTS matalia.prop_trading_users (
    id BIGSERIAL PRIMARY KEY,
    user_name VARCHAR(120) NOT NULL,
    password_hash TEXT NOT NULL,
    user_class VARCHAR(32) NOT NULL CHECK (user_class IN ('Admin', 'Staff')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS prop_trading_users_name_idx
    ON matalia.prop_trading_users (LOWER(user_name));

ALTER TABLE matalia.prop_trading_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE matalia.prop_trading_users FROM PUBLIC;
