"""Import raw trade TXT files directly into Supabase.

TXT files are parsed locally, grouped into the same-minute instrument rows
expected by ``matalia.\"01RawTxtData\"``, and upserted directly.  No local
database or CSV staging file is used.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
import importlib.util
from pathlib import Path
import re
import sys
from typing import Any
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / "Credentials" / ".env")
TXT_ROOT = PROJECT_ROOT / "Input" / "Txt"
STAGED_TXT_PATH = PROJECT_ROOT / "Other Logs" / "Runtime" / "selected_txt_import.txt"
DATE_PATTERN = re.compile(r"\b(\d{2}/\d{2}/\d{4})\b")
TARGET_SCHEMA = "matalia"
TARGET_TABLE = '"01RawTxtData"'


def _load_connection_module():
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


connect = _load_connection_module().connect


def get_txt_files() -> list[Path]:
    # The UI stages a copy of the file selected by the user.  Reading this
    # copy keeps the user's original local TXT untouched.
    return [STAGED_TXT_PATH] if STAGED_TXT_PATH.is_file() else []


def extract_trade_date(text: str) -> datetime | None:
    match = DATE_PATTERN.search(text)
    return datetime.strptime(match.group(1), "%d/%m/%Y") if match else None


def get_month_folder(trade_date: datetime) -> Path:
    return TXT_ROOT / f"{trade_date.month} - {trade_date.strftime('%B')} {trade_date.strftime('%y')}"


def parse_trade_line(line: str) -> dict[str, Any] | None:
    parts = [value.strip() for value in line.strip().split(",")]
    if len(parts) != 12:
        return None
    try:
        return {
            "trade_date": datetime.strptime(parts[0], "%d/%m/%Y").date(),
            "order_id": parts[1],
            "scrip": parts[2],
            "expiry": parts[3],
            "strike": float(parts[4]),
            "option_type": parts[5],
            "trade_type": parts[6],
            "quantity": float(parts[7]),
            "price": float(parts[8]),
            "trade_time": parts[9],
            "trade_id": int(parts[10]),
            "account": parts[11],
        }
    except (TypeError, ValueError):
        return None


def _trade_minute(value: str) -> str:
    parsed = datetime.strptime(value.strip(), "%I:%M:%S %p")
    return parsed.strftime("%H.%M")


def _instrument_id(trade: dict[str, Any]) -> str:
    return f"{trade['scrip']}{trade['option_type']}{trade['strike']}{trade['expiry']}"


def collect_rows(files: list[Path]) -> tuple[list[dict[str, Any]], int]:
    grouped: dict[tuple[Any, ...], dict[str, Any]] = defaultdict(dict)
    processed = 0
    for source_file in files:
        text = source_file.read_text(encoding="utf-8", errors="ignore")
        trade_date = extract_trade_date(text)
        if trade_date is None:
            print(f"Skipping {source_file.name}: no trade date found")
            continue
        for line in source_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            trade = parse_trade_line(line)
            if trade is None:
                continue
            minute = _trade_minute(trade["trade_time"])
            key = (
                trade["trade_date"], minute, _instrument_id(trade),
                trade["trade_type"], trade["account"],
            )
            row = grouped.get(key)
            if row is None:
                row = grouped[key] = {
                    "trade_date": trade["trade_date"],
                    "trade_minute": minute,
                    "instrument_id": key[2],
                    "scrip": trade["scrip"],
                    "expiry": trade["expiry"],
                    "strike": trade["strike"],
                    "option_type": trade["option_type"],
                    "trade_type": trade["trade_type"],
                    "quantity": 0.0,
                    "weighted_value": 0.0,
                    "account": trade["account"],
                    "trades_merged": 0,
                }
            row["quantity"] += trade["quantity"]
            row["weighted_value"] += trade["price"] * trade["quantity"]
            row["trades_merged"] += 1
            processed += 1

    rows = []
    for row in grouped.values():
        quantity = row.pop("quantity")
        weighted_value = row.pop("weighted_value")
        row["quantity"] = quantity
        row["average_price"] = round(weighted_value / quantity, 4) if quantity else 0
        rows.append(row)
    rows.sort(key=lambda row: (row["trade_date"], row["trade_minute"], row["instrument_id"]))
    return rows, processed


def ensure_target_table(conn: Any) -> None:
    conn.execute(
        f'''
        CREATE TABLE IF NOT EXISTS {TARGET_SCHEMA}.{TARGET_TABLE} (
            id bigserial PRIMARY KEY,
            trade_date date NOT NULL,
            trade_minute text NOT NULL,
            instrument_id text NOT NULL,
            scrip text,
            expiry text,
            strike double precision,
            option_type text,
            trade_type text,
            quantity double precision,
            average_price double precision,
            account text,
            trades_merged integer NOT NULL DEFAULT 1,
            created_at timestamptz NOT NULL DEFAULT now(),
            merge_trade_id bigint
        )
        '''
    )


def upsert_rows(rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    sql = f'''
        INSERT INTO {TARGET_SCHEMA}.{TARGET_TABLE}
          (trade_date, trade_minute, instrument_id, scrip, expiry, strike,
           option_type, trade_type, quantity, average_price, account, trades_merged)
        VALUES (%(trade_date)s, %(trade_minute)s, %(instrument_id)s, %(scrip)s,
                %(expiry)s, %(strike)s, %(option_type)s, %(trade_type)s,
                %(quantity)s, %(average_price)s, %(account)s, %(trades_merged)s)
        ON CONFLICT (trade_date, trade_minute, instrument_id, trade_type, account)
        DO UPDATE SET
          quantity = EXCLUDED.quantity,
          average_price = EXCLUDED.average_price,
          trades_merged = EXCLUDED.trades_merged
    '''
    with connect() as conn:
        ensure_target_table(conn)
        with conn.cursor() as cursor:
            cursor.executemany(sql, rows)
    return len(rows)


def main() -> None:
    files = get_txt_files()
    if not files:
        print("No TXT files found.")
        return
    print(f"Found {len(files)} TXT file(s). Parsing and upserting directly to Supabase...")
    rows, processed = collect_rows(files)
    upserted = upsert_rows(rows)
    print(f"Parsed trades: {processed:,}")
    print(f"Supabase rows upserted: {upserted:,}")


if __name__ == "__main__":
    main()
