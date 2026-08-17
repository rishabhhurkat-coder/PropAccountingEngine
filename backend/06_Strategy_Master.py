"""Strategy master helpers shared by the strategy API.

This module deliberately contains date logic only.  Reading and writing the
StrategyMaster workbook remains in ``main.py`` so the API keeps its existing
storage behaviour.
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta
import re
from typing import Any

import pandas as pd


_EXPIRY_RE = re.compile(r"^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$")
STRATEGY_MASTER_TABLE = 'matalia.strategy_master'


def ensure_strategy_master_table(conn: Any) -> None:
    conn.execute(
        f'''
        CREATE TABLE IF NOT EXISTS {STRATEGY_MASTER_TABLE} (
            mapping_id INTEGER NOT NULL,
            parent_qty INTEGER NOT NULL,
            expiry VARCHAR(16) NOT NULL,
            instrument VARCHAR(32) NOT NULL,
            seq INTEGER NOT NULL,
            split_method VARCHAR(32) NOT NULL DEFAULT 'Quantity',
            split_percentage NUMERIC(12, 6),
            split_qty INTEGER NOT NULL,
            strategy_name VARCHAR(255) NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            PRIMARY KEY (mapping_id, expiry, seq)
        )
        '''
    )
    conn.execute(f'CREATE INDEX IF NOT EXISTS strategy_master_name_idx ON {STRATEGY_MASTER_TABLE} (strategy_name)')
    conn.execute(f'CREATE INDEX IF NOT EXISTS strategy_master_expiry_idx ON {STRATEGY_MASTER_TABLE} (expiry)')


def _strategy_master_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        'mappingId': int(row['mapping_id']),
        'parentQty': int(row['parent_qty']),
        'expiry': str(row['expiry']).strip(),
        'instrument': str(row['instrument']).strip(),
        'seq': int(row['seq']),
        'splitMethod': str(row['split_method'] or '').strip(),
        'splitPercentage': float(row['split_percentage']) if row['split_percentage'] is not None else None,
        'splitQty': int(row['split_qty']),
        'strategyName': str(row['strategy_name']).strip(),
        'active': bool(row['active']),
    }


def load_strategy_master_rows(conn: Any) -> list[dict[str, Any]]:
    ensure_strategy_master_table(conn)
    cursor = conn.execute(
        f'''
        SELECT mapping_id, parent_qty, expiry, instrument, seq,
               split_method, split_percentage, split_qty, strategy_name, active
        FROM {STRATEGY_MASTER_TABLE}
        ORDER BY parent_qty, expiry, mapping_id, seq
        '''
    )
    columns = [column.name for column in cursor.description]
    return [_strategy_master_record(dict(zip(columns, row))) for row in cursor.fetchall()]


def _payload_value(payload: Any, name: str, default: Any = None) -> Any:
    return getattr(payload, name, default) if not isinstance(payload, dict) else payload.get(name, default)


def save_strategy_setup(conn: Any, payload: Any) -> tuple[list[dict[str, Any]], int]:
    ensure_strategy_master_table(conn)
    strategy_name = str(_payload_value(payload, 'strategyName', '')).strip()
    instrument = str(_payload_value(payload, 'instrument', '')).strip().upper()
    expiries = [normalize_expiry(expiry) for expiry in _payload_value(payload, 'expiries', []) if str(expiry).strip()]
    parent_qty = int(round(float(_payload_value(payload, 'parentQty', 0))))
    if not strategy_name or not instrument or not expiries or parent_qty <= 0:
        raise ValueError('Strategy name, expiry, instrument and quantity are required.')
    for expiry in expiries:
        _expiry_date(expiry)

    mapping_id = _payload_value(payload, 'mappingId')
    original_name = str(_payload_value(payload, 'originalStrategyName') or strategy_name).strip()
    if mapping_id is None:
        duplicate = conn.execute(
            f'''SELECT 1 FROM {STRATEGY_MASTER_TABLE}
                WHERE lower(trim(strategy_name)) = lower(trim(%s))
                  AND upper(trim(instrument)) = upper(trim(%s))
                  AND expiry = ANY(%s) LIMIT 1''',
            (original_name, instrument, expiries),
        ).fetchone()
        if duplicate:
            raise ValueError('A strategy with this name, instrument and expiry already exists.')
        mapping_id = int(conn.execute(f'SELECT COALESCE(MAX(mapping_id), 0) + 1 FROM {STRATEGY_MASTER_TABLE}').fetchone()[0])
    else:
        mapping_id = int(mapping_id)
        exists = conn.execute(f'SELECT 1 FROM {STRATEGY_MASTER_TABLE} WHERE mapping_id = %s LIMIT 1', (mapping_id,)).fetchone()
        if not exists:
            raise ValueError('The strategy to update was not found.')
        conn.execute(f'DELETE FROM {STRATEGY_MASTER_TABLE} WHERE mapping_id = %s', (mapping_id,))

    accounts = [account for account in (_payload_value(payload, 'accounts', []) or []) if str(_payload_value(account, 'name', '')).strip() and float(_payload_value(account, 'qty', 0)) > 0]
    split_required = bool(_payload_value(payload, 'splitRequired', True))
    if not split_required:
        allocations = [('', parent_qty)]
    elif not accounts or abs(sum(float(_payload_value(account, 'qty', 0)) for account in accounts) - parent_qty) > 1e-6:
        raise ValueError('Account allocations must equal the strategy quantity.')
    else:
        allocations = [(str(_payload_value(account, 'name', '')).strip(), int(round(float(_payload_value(account, 'qty', 0))))) for account in accounts]

    split_method = str(_payload_value(payload, 'splitMethod', 'Quantity')).strip() or 'Quantity'
    rows: list[tuple[Any, ...]] = []
    for expiry in expiries:
        for seq, (_, qty) in enumerate(allocations, start=1):
            rows.append((mapping_id, parent_qty, expiry, instrument, seq, split_method, round(qty / parent_qty * 100, 6) if split_method == 'Percentage' else None, qty, strategy_name, True))
    with conn.cursor() as cursor:
        cursor.executemany(
        f'''
        INSERT INTO {STRATEGY_MASTER_TABLE}
          (mapping_id, parent_qty, expiry, instrument, seq, split_method,
           split_percentage, split_qty, strategy_name, active)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ''',
            rows,
        )
    return load_strategy_master_rows(conn), len(rows)


def delete_strategy_master_rows(conn: Any, mapping_id: int | None = None, strategy_name: str = '') -> int:
    ensure_strategy_master_table(conn)
    if mapping_id is not None:
        result = conn.execute(f'DELETE FROM {STRATEGY_MASTER_TABLE} WHERE mapping_id = %s', (int(mapping_id),))
        if not result.rowcount:
            raise ValueError('The strategy mapping was not found.')
        return result.rowcount
    name = strategy_name.strip()
    if not name:
        raise ValueError('Strategy name is required.')
    result = conn.execute(f'DELETE FROM {STRATEGY_MASTER_TABLE} WHERE lower(trim(strategy_name)) = lower(trim(%s))', (name,))
    if not result.rowcount:
        raise ValueError('The strategy was not found.')
    return result.rowcount


def migrate_strategy_master_xlsx(conn: Any, workbook_path: Any) -> int:
    """Import the legacy workbook rows into Supabase once."""
    ensure_strategy_master_table(conn)
    frame = pd.read_excel(workbook_path)
    if frame.empty:
        return 0
    conn.execute(f'DELETE FROM {STRATEGY_MASTER_TABLE}')
    rows = []
    for _, row in frame.iterrows():
        expiry = normalize_expiry(row.get('Expiry'))
        _expiry_date(expiry)
        rows.append((
            int(row['Mapping_ID']), int(row['Parent_Qty']), expiry, str(row['Instrument']).strip(),
            int(row['Seq']), str(row['Split_Method'] or 'Quantity'),
            None if pd.isna(row.get('Split_Percentage')) else float(row['Split_Percentage']),
            int(row['Split_Qty']), str(row['Strategy_Name']).strip(), bool(row.get('Active', True)),
        ))
    with conn.cursor() as cursor:
        cursor.executemany(
        f'''
        INSERT INTO {STRATEGY_MASTER_TABLE}
          (mapping_id, parent_qty, expiry, instrument, seq, split_method,
           split_percentage, split_qty, strategy_name, active)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ''',
            rows,
        )
    return len(rows)


def normalize_expiry(value: Any) -> str:
    """Return an expiry as the canonical ``DDMMMYYYY`` string."""
    compact = re.sub(r"[-\s]", "", str(value or "").strip()).upper()
    numeric_match = re.fullmatch(r"(\d{2})(\d{2})(\d{2}|\d{4})", compact)
    if numeric_match:
        day, month_number, year = numeric_match.groups()
        months = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
        month_index = int(month_number) - 1
        if 0 <= month_index < len(months):
            return f"{day}{months[month_index]}{year if len(year) == 4 else '20' + year}"
    match = _EXPIRY_RE.fullmatch(compact)
    if not match:
        return compact
    day, month, year = match.groups()
    return f"{int(day):02d}{month}{year if len(year) == 4 else '20' + year}"


def _expiry_date(value: Any) -> date:
    compact = normalize_expiry(value)
    match = _EXPIRY_RE.fullmatch(compact)
    if not match:
        raise ValueError(f"Invalid expiry: {value}")
    day, month, year = match.groups()
    month_number = {name: index for index, name in enumerate(
        ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"),
        start=1,
    )}[month]
    return date(int(year if len(year) == 4 else f"20{year}"), month_number, int(day))


def _is_last_weekday_of_month(value: date) -> bool:
    """Treat the last occurrence of a weekday in a month as monthly expiry."""
    days_in_month = monthrange(value.year, value.month)[1]
    remaining = days_in_month - value.day
    return remaining < 7


def expiry_frequency(value: Any) -> str:
    """Classify an expiry as ``weekly`` or ``monthly``."""
    return "monthly" if _is_last_weekday_of_month(_expiry_date(value)) else "weekly"


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last_day = date(year, month, monthrange(year, month)[1])
    return last_day - timedelta(days=(last_day.weekday() - weekday) % 7)


def next_expiry(value: Any) -> str:
    """Calculate the next weekly or monthly expiry while preserving its cadence."""
    current = _expiry_date(value)
    if expiry_frequency(value) == "weekly":
        following = current + timedelta(days=7)
    else:
        following_month = current.month + 1
        following_year = current.year + (1 if following_month == 13 else 0)
        following_month = 1 if following_month == 13 else following_month
        following = _last_weekday(following_year, following_month, current.weekday())
    return following.strftime("%d%b%Y").upper()


def next_expiries(values: list[Any]) -> list[str]:
    """Return unique next expiries in the same order as the source values."""
    result: list[str] = []
    for value in values:
        if not str(value or "").strip():
            continue
        candidate = next_expiry(value)
        if candidate not in result:
            result.append(candidate)
    return result


