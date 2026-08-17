from __future__ import annotations

from pathlib import Path
import warnings
import importlib
from decimal import Decimal, ROUND_HALF_UP

import pandas as pd

_external_spec = importlib.util.spec_from_file_location("matalia_external_connections", Path(__file__).with_name("09_External_Connections.py"))
_external_module = importlib.util.module_from_spec(_external_spec)
_external_spec.loader.exec_module(_external_module)
connect = _external_module.connect

warnings.filterwarnings(
    "ignore",
    message="pandas only supports SQLAlchemy connectable.*",
    category=UserWarning
)

# ==========================================================
# CONFIG
# ==========================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

CONFIG_DIR = PROJECT_ROOT / "Config"

CONFIG_DIR.mkdir(exist_ok=True)

STRATEGY_FILE = CONFIG_DIR / "StrategyMaster.xlsx"

SOURCE_SCHEMA = "matalia"
SOURCE_TABLE = "01RawTxtData"

MERGE_TABLE = "MergeTrades"
SPLIT_TABLE = "SplitTrades"

TARGET_SCHEMA = "matalia"
TARGET_TABLE = "strategy_allocation"
POSITION_SEQUENCE = f"{TARGET_SCHEMA}.strategy_allocation_position_seq"

# ==========================================================
# LOAD STRATEGIES
# ==========================================================

def load_strategies():

    columns = [
        "Mapping_ID",
        "Parent_Qty",
        "Expiry",
        "Instrument",
        "Seq",
        "Split_Method",
        "Split_Percentage",
        "Split_Qty",
        "Strategy_Name",
        "Active",
    ]

    if not STRATEGY_FILE.exists():

        df = pd.DataFrame(columns=columns)

        df.to_excel(
            STRATEGY_FILE,
            index=False
        )

        return df

    df = pd.read_excel(STRATEGY_FILE)

    required = columns

    changed = False

    for col in required:

        if col not in df.columns:

            changed = True

            if col == "Active":
                df[col] = True
            elif col == "Split_Method":
                df[col] = "Quantity"
            else:
                df[col] = None

    # Old mappings were quantity-based mappings.
    df["Split_Method"] = df["Split_Method"].fillna("Quantity")
    df.loc[
        df["Split_Method"].astype(str).str.strip().eq(""),
        "Split_Method",
    ] = "Quantity"

    # Keep quantity mappings explicitly marked as quantity mappings.
    quantity_rows = df["Split_Method"].eq("Quantity")
    if df.loc[quantity_rows, "Split_Percentage"].notna().any():
        changed = True
    df.loc[quantity_rows, "Split_Percentage"] = None

    if "Instrument" not in df.columns:
        df["Instrument"] = None
        changed = True

    df["Instrument"] = df["Instrument"].fillna("")
    inferred_instrument = df["Strategy_Name"].astype(str).map(
        lambda value: _infer_strategy_instrument(value)
    )
    blank_instrument_rows = df["Instrument"].astype(str).str.strip().eq("")
    if (
        blank_instrument_rows.any()
        and inferred_instrument.loc[blank_instrument_rows].ne("").any()
    ):
        changed = True
        df.loc[blank_instrument_rows, "Instrument"] = (
            inferred_instrument.loc[blank_instrument_rows]
        )

    if set(df.columns) != set(columns) or list(df.columns) != columns:
        changed = True
        df = df.reindex(columns=columns)

    df["Parent_Qty"] = pd.to_numeric(df["Parent_Qty"], errors="coerce")
    df["Split_Qty"] = pd.to_numeric(df["Split_Qty"], errors="coerce")
    df["Seq"] = pd.to_numeric(df["Seq"], errors="coerce")
    df["Split_Percentage"] = pd.to_numeric(
        df["Split_Percentage"], errors="coerce"
    )

    if changed:
        save_strategies(df)

    return df

# ==========================================================
# SAVE STRATEGIES
# ==========================================================

def save_strategies(df):

    columns = [
        "Mapping_ID",
        "Parent_Qty",
        "Expiry",
        "Instrument",
        "Seq",
        "Split_Method",
        "Split_Percentage",
        "Split_Qty",
        "Strategy_Name",
        "Active",
    ]

    for column in columns:
        if column not in df.columns:
            if column == "Split_Method":
                df[column] = "Quantity"
            else:
                df[column] = None

    df = df.reindex(columns=columns)

    df = df.sort_values(
        by=[
            "Parent_Qty",
            "Expiry",
            "Seq"
        ],
        ignore_index=True
    )

    df.to_excel(
        STRATEGY_FILE,
        index=False
    )


def _select_strategy_name(strategy_names):

    if strategy_names:
        print("Available Strategies")

        for i, name in enumerate(strategy_names, start=1):
            print(f"{i}. {name}")

        print()

    choice = input(
        "Select Strategy Number or Type New Name : "
    ).strip()

    if choice.isdigit():
        idx = int(choice) - 1
        if 0 <= idx < len(strategy_names):
            return strategy_names[idx]
        return input("Strategy Name : ").strip()

    return choice


def _normalize_instrument(value):
    if value is None:
        return ""
    return str(value).strip().upper()


def _infer_strategy_instrument(strategy_name):
    name = _normalize_instrument(strategy_name)

    if "BANKNIFTY" in name:
        return "BANKNIFTY"

    if "NIFTY" in name:
        return "NIFTY"

    if "ATM EMA INTRADAY" in name:
        return "NIFTY"

    return ""


def _percentage_split_quantities(parent_quantity, percentages):
    parent = Decimal(str(parent_quantity))
    precision = 0 if parent == parent.to_integral() else 2
    quantum = Decimal("1") if precision == 0 else Decimal("0.01")
    quantities = []
    assigned = Decimal("0")

    for percentage in percentages[:-1]:
        quantity = (
            parent * Decimal(str(percentage)) / Decimal("100")
        ).quantize(quantum, rounding=ROUND_HALF_UP)
        quantities.append(float(quantity))
        assigned += quantity

    last_quantity = (parent - assigned).quantize(
        quantum,
        rounding=ROUND_HALF_UP,
    )
    quantities.append(float(last_quantity))
    return quantities

# ==========================================================
# ADD SMART MAPPING
# ==========================================================

def add_strategy(strategy_df, trade_qty=None, trade_expiry=None, trade_instrument=None):

    print()
    print("=" * 60)
    print("CREATE SMART MAPPING")
    print("=" * 60)

    # ------------------------------------------------------
    # Parent Quantity
    # ------------------------------------------------------

    if trade_qty is None:

        while True:

            try:
                trade_qty = float(input("Parent Quantity : "))
                break
            except ValueError:
                print("Invalid Quantity.")

    else:

        trade_qty = float(trade_qty)

        print(f"Parent Quantity : {trade_qty:.0f}")

    # ------------------------------------------------------
    # Expiry
    # ------------------------------------------------------

    if trade_expiry is None:

        trade_expiry = input("Expiry : ").strip()

    else:

        print(f"Expiry         : {trade_expiry}")

    # ------------------------------------------------------
    # Instrument
    # ------------------------------------------------------

    trade_instrument = _normalize_instrument(trade_instrument)
    if trade_instrument:
        print(f"Instrument     : {trade_instrument}")

    # ------------------------------------------------------
    # Split Method
    # ------------------------------------------------------

    while True:
        print()
        print("SELECT SPLIT METHOD")
        print("1. Split By Quantity")
        print("2. Split By Percentage")
        print("3. Skip Split")
        method_choice = input("\nChoice : ").strip()

        if method_choice in {"1", "2", "3"}:
            break

        print("Invalid Choice.")

    if method_choice == "3":
        split_method = "Quantity"
        split_count = 1
        split_quantities = [trade_qty]
        percentages = []
    else:
        split_method = "Quantity" if method_choice == "1" else "Percentage"

        while True:

            try:

                split_count = int(input("How many Splits : "))

                if split_count > 0:
                    break

            except ValueError:
                pass

            print("Invalid Number.")

    # ------------------------------------------------------
    # Mapping ID
    # ------------------------------------------------------

    if strategy_df.empty:

        mapping_id = 1

    else:

        mapping_id = int(strategy_df["Mapping_ID"].max()) + 1

    strategy_names = sorted(

        strategy_df["Strategy_Name"]
        .dropna()
        .astype(str)
        .unique()
        .tolist()

    )

    if method_choice != "3":
        percentages = []
        split_quantities = []

    if method_choice != "3" and split_method == "Percentage":
        while True:
            percentages = []
            total_percentage = 0.0

            for seq in range(1, split_count + 1):
                while True:
                    try:
                        percentage = float(
                            input(f"Percentage {seq} : ")
                        )
                        if percentage < 0:
                            raise ValueError
                        percentages.append(percentage)
                        total_percentage += percentage
                        break
                    except ValueError:
                        print("Invalid Percentage.")

            if abs(total_percentage - 100.0) <= 1e-9:
                split_quantities = _percentage_split_quantities(
                    trade_qty,
                    percentages,
                )
                break

            print("Invalid Percentage.")
            print("Total Percentage must equal 100%.")
    elif method_choice != "3":
        for seq in range(1, split_count + 1):
            while True:
                try:
                    split_quantities.append(
                        float(input(f"Split Qty {seq} : "))
                    )
                    break
                except ValueError:
                    print("Invalid Quantity.")

        if abs(sum(split_quantities) - trade_qty) > 1e-9:
            print("Invalid Quantity.")
            print("Total Split Quantity must equal Parent Quantity.")
            return add_strategy(strategy_df, trade_qty, trade_expiry)

    # ------------------------------------------------------
    # Add Split Rows
    # ------------------------------------------------------

    for seq in range(1, split_count + 1):

        print()
        print("-" * 60)

        split_qty = split_quantities[seq - 1]
        strategy_name = _select_strategy_name(strategy_names)

        strategy_df.loc[len(strategy_df)] = {

            "Mapping_ID": mapping_id,
            "Parent_Qty": trade_qty,
            "Expiry": trade_expiry,
            "Instrument": trade_instrument,
            "Seq": seq,
            "Split_Method": split_method,
            "Split_Percentage": (
                percentages[seq - 1]
                if split_method == "Percentage"
                else None
            ),
            "Split_Qty": split_qty,
            "Strategy_Name": strategy_name,
            "Active": True

        }

    save_strategies(strategy_df)

    print()
    print("=" * 60)
    print("SMART MAPPING SAVED")
    print("=" * 60)

    return strategy_df

# ==========================================================
# LOAD PROCESSED TRADES
# ==========================================================

def load_processed_trades(conn=None):

    owns_connection = conn is None

    if owns_connection:
        print()
        print("Connecting to Supabase...")
        conn = connect()

    source_label = f'{SOURCE_SCHEMA}."{SOURCE_TABLE}"'

    try:
        table_exists = conn.execute(
            """
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = %s
                  AND table_name = %s
            )
            """,
            (SOURCE_SCHEMA, SOURCE_TABLE)
        ).fetchone()[0]

        if not table_exists:
            raise RuntimeError(
                f"Table {source_label} does not exist."
            )

        columns = {
            row[0]
            for row in conn.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = %s
                  AND table_name = %s
                """,
                (SOURCE_SCHEMA, SOURCE_TABLE)
            ).fetchall()
        }

        total_rows = conn.execute(
            f'SELECT COUNT(*) FROM {source_label}'
        ).fetchone()[0]

        has_merge_trade_id = "merge_trade_id" in columns

        if has_merge_trade_id:
            pending_rows = conn.execute(
                f'''
                SELECT COUNT(*)
                FROM {source_label}
                WHERE merge_trade_id IS NULL
                '''
            ).fetchone()[0]
            processed_rows = total_rows - pending_rows
            where_clause = "WHERE merge_trade_id IS NULL"
        else:
            pending_rows = total_rows
            processed_rows = 0
            where_clause = ""

        print()
        print(f"Source Table         : {source_label}")
        print(f"Total Rows           : {total_rows:,}")
        print(f"Rows Pending Merge   : {pending_rows:,}")
        print(f"Rows Already Processed: {processed_rows:,}")

        sql = f"""
        SELECT *
        FROM {source_label}
        {where_clause}
        ORDER BY trade_date, trade_minute, id
        """

        df = pd.read_sql(sql, conn)

        if df.empty:
            print()
            print("No pending raw trades.")
            print()
            print("Possible reasons")
            print("- merge_trade_id already populated")
            print("- source table is empty")
            print("- source table contains no rows pending merge")

        if "trade_date" in df.columns:
            df["trade_date"] = pd.to_datetime(
                df["trade_date"]
            ).dt.date

        if "trade_minute" in df.columns:
            df["trade_minute"] = df["trade_minute"].astype(str)

        if "quantity" in df.columns:
            df["quantity"] = df["quantity"].astype(float)

        if "average_price" in df.columns:
            df["average_price"] = df["average_price"].astype(float)

        print()
        return df

    finally:
        if owns_connection:
            conn.close()


# ==========================================================
# MERGE WORKFLOW
# ==========================================================

def ensure_workflow_tables(conn):

    conn.execute(f'''
        ALTER TABLE {SOURCE_SCHEMA}."{SOURCE_TABLE}"
        ADD COLUMN IF NOT EXISTS merge_trade_id BIGINT NULL
    ''')

    conn.execute(f'''
        CREATE TABLE IF NOT EXISTS {SOURCE_SCHEMA}."{MERGE_TABLE}"
        (
            id BIGSERIAL PRIMARY KEY,
            trade_date DATE,
            trade_minute TEXT,
            instrument_id TEXT,
            scrip TEXT,
            expiry TEXT,
            strike DOUBLE PRECISION,
            option_type TEXT,
            trade_type TEXT,
            quantity DOUBLE PRECISION,
            average_price DOUBLE PRECISION,
            account TEXT,
            trades_merged INTEGER
        )
    ''')

    conn.execute(f'''
        CREATE TABLE IF NOT EXISTS {SOURCE_SCHEMA}."{SPLIT_TABLE}"
        (
            id BIGSERIAL PRIMARY KEY,
            "MergeID" BIGINT,
            trade_date DATE,
            trade_minute TEXT,
            instrument_id TEXT,
            scrip TEXT,
            expiry TEXT,
            strike DOUBLE PRECISION,
            option_type TEXT,
            trade_type TEXT,
            quantity DOUBLE PRECISION,
            average_price DOUBLE PRECISION,
            account TEXT,
            trades_merged INTEGER
        )
    ''')

    conn.commit()


def _trade_columns():

    return [
        "trade_date",
        "trade_minute",
        "instrument_id",
        "scrip",
        "expiry",
        "strike",
        "option_type",
        "trade_type",
        "quantity",
        "average_price",
        "account",
        "trades_merged",
    ]


def _insert_merge_trade(conn, row, source_ids):

    columns = _trade_columns()
    values = [row.get(column) for column in columns]
    placeholders = ",".join(["%s"] * len(columns))
    quoted_columns = ",".join(f'"{column}"' for column in columns)

    merge_id = conn.execute(
        f'''
        INSERT INTO {SOURCE_SCHEMA}."{MERGE_TABLE}"
        ({quoted_columns})
        VALUES ({placeholders})
        RETURNING id
        ''',
        values
    ).fetchone()[0]

    conn.execute(
        f'''
        UPDATE {SOURCE_SCHEMA}."{SOURCE_TABLE}"
        SET merge_trade_id = %s
        WHERE id = ANY(%s)
        ''',
        (merge_id, [int(value) for value in source_ids])
    )

    conn.commit()
    return int(merge_id)


def _load_merge_candidates(conn, row, contract_group=None):

    group_clause = ""
    params = [
        row["trade_date"],
        row["instrument_id"],
        row["trade_type"],
        row["account"],
    ]

    if contract_group is not None:
        group_clause = """
          AND scrip = %s
          AND expiry = %s
          AND strike = %s
          AND option_type = %s
        """
        params.extend([
            contract_group["scrip"],
            contract_group["expiry"],
            contract_group["strike"],
            contract_group["option_type"],
        ])

    sql = f'''
        SELECT *
        FROM {SOURCE_SCHEMA}."{SOURCE_TABLE}"
        WHERE merge_trade_id IS NULL
          AND trade_date = %s
          AND instrument_id = %s
          AND trade_type = %s
          AND account = %s
          {group_clause}
        ORDER BY trade_minute, id
    '''

    return pd.read_sql(
        sql,
        conn,
        params=params
    )


def _select_merge_ids(candidates):

    if candidates.empty:
        print("No merge candidates found.")
        return None

    print()
    print("MERGE CANDIDATES")
    print("=" * 70)

    for _, candidate in candidates.iterrows():
        print(
            f"ID {int(candidate['id'])}: "
            f"{candidate['trade_minute']} | "
            f"Qty {float(candidate['quantity']):g} | "
            f"Price {float(candidate['average_price']):.2f}"
        )

    while True:
        choice = input(
            "\nCandidate IDs to merge (comma separated, B to return): "
        ).strip().upper()

        if choice == "B":
            return None

        try:
            ids = [int(value.strip()) for value in choice.split(",")]
        except ValueError:
            print("Invalid candidate IDs.")
            continue

        valid_ids = set(candidates["id"].astype(int).tolist())

        if ids and set(ids).issubset(valid_ids):
            return ids

        print("Select only IDs shown above.")


def process_merge(conn, raw_row, contract_group=None):

    print()
    print("Merge this trade?")
    print("1 Yes")
    print("2 No")

    while True:
        choice = input("\nChoice : ").strip()

        if choice in {"1", "2"}:
            break

        print("Invalid Choice.")

    if choice == "2":
        return _insert_merge_trade(conn, raw_row, [raw_row["id"]])

    candidates = _load_merge_candidates(conn, raw_row, contract_group)

    if len(candidates) <= 1:
        print("No other merge candidates found.")
        return _insert_merge_trade(conn, raw_row, [raw_row["id"]])

    selected_ids = _select_merge_ids(
        candidates[candidates["id"] != raw_row["id"]]
    )

    if not selected_ids:
        print("Returned to merge menu. The trade remains pending.")
        return None

    group = candidates[
        candidates["id"].isin([raw_row["id"]] + selected_ids)
    ].copy()

    stats = calculate_wap(group)
    merged_row = group.iloc[0].copy()
    merged_row["trade_minute"] = stats["first_time"]
    merged_row["quantity"] = stats["total_qty"]
    merged_row["average_price"] = stats["wap"]
    merged_row["trades_merged"] = len(group)

    print(
        f"Merged Qty : {stats['total_qty']:.0f} | "
        f"WAP : {stats['wap']:.2f}"
    )

    return _insert_merge_trade(
        conn,
        merged_row,
        group["id"].tolist()
    )


def read_merge_trade(conn, merge_id):

    return pd.read_sql(
        f'''
        SELECT *
        FROM {SOURCE_SCHEMA}."{MERGE_TABLE}"
        WHERE id = %s
        ''',
        conn,
        params=(merge_id,)
    ).iloc[0]


# ==========================================================
# SPLIT WORKFLOW
# ==========================================================

def split_trade(merge_row):
    """Split one merged trade into validated child trade dictionaries."""

    original_qty = int(merge_row["quantity"])

    while True:
        parts_input = input("\nHow many splits? (C to cancel) : ").strip().upper()

        if parts_input == "C":
            return None

        try:
            parts = int(parts_input)
        except ValueError:
            print("Invalid number.")
            continue

        if parts < 2:
            print("Minimum 2 parts required.")
            continue

        quantities = []
        total = 0

        print()

        for index in range(parts):
            while True:
                try:
                    qty = int(input(f"Qty {index + 1} : "))
                except ValueError:
                    print("Invalid Quantity.")
                    continue

                if qty <= 0:
                    print("Quantity must be greater than zero.")
                    continue

                quantities.append(qty)
                total += qty
                break

        if total != original_qty:
            print("Invalid split quantity.")
            print("Total split quantity must equal parent quantity.")
            continue

        break

    split_rows = []

    for qty in quantities:
        child = merge_row.to_dict() if hasattr(merge_row, "to_dict") else dict(merge_row)
        child["quantity"] = qty
        child["trades_merged"] = 1
        split_rows.append(child)

    return split_rows


def _upsert_split_trades(conn, merge_row, split_rows):

    conn.execute(
        f'DELETE FROM {SOURCE_SCHEMA}."{SPLIT_TABLE}" WHERE "MergeID" = %s',
        (int(merge_row["id"]),)
    )

    columns = _trade_columns()
    quoted_columns = '"MergeID",' + ",".join(
        f'"{column}"' for column in columns
    )
    placeholders = ",".join(["%s"] * (len(columns) + 1))

    sql = f'''
        INSERT INTO {SOURCE_SCHEMA}."{SPLIT_TABLE}"
        ({quoted_columns})
        VALUES ({placeholders})
    '''

    rows = []
    for row in split_rows:
        rows.append(
            [int(merge_row["id"])] + [row.get(column) for column in columns]
        )

    with conn.cursor() as cur:
        cur.executemany(sql, rows)

    conn.commit()


def read_split_trades(conn, merge_id):

    return pd.read_sql(
        f'''
        SELECT *
        FROM {SOURCE_SCHEMA}."{SPLIT_TABLE}"
        WHERE "MergeID" = %s
        ORDER BY id
        ''',
        conn,
        params=(merge_id,)
    )


def process_split(conn, merge_id):

    merge_row = read_merge_trade(conn, merge_id)

    while True:
        choice = input("\nSplit?\n1 Yes\n2 No\n\nChoice : ").strip()

        if choice in {"1", "2"}:
            break

        print("Invalid Choice.")

    if choice == "1":
        split_rows = split_trade(merge_row)
        if split_rows is None:
            print("Invalid split. Returning to split menu.")
            return None
    else:
        split_rows = [merge_row]

    _upsert_split_trades(conn, merge_row, split_rows)
    split_df = read_split_trades(conn, merge_id)

    return merge_id

# ==========================================================
# LOAD STRATEGY ALLOCATION
# ==========================================================

def load_strategy_allocation(conn=None):

    owns_connection = conn is None

    if owns_connection:
        conn = connect()

    sql = f"""
        SELECT *
        FROM {TARGET_SCHEMA}.{TARGET_TABLE}
        ORDER BY
            trade_date,
            trade_minute,
            allocation_id
    """

    df = pd.read_sql(sql, conn)

    if owns_connection:
        conn.close()

    return df


def get_next_position_id(conn):

    row = conn.execute(
        f"SELECT nextval('{POSITION_SEQUENCE}')"
    ).fetchone()

    return int(row[0])

# ==========================================================
# POSITION MANAGEMENT
# ==========================================================

def build_open_positions(allocation_df):
    """Build the initial open-position state from the allocation ledger."""

    if allocation_df is None or allocation_df.empty:
        return {}

    entry_rows = allocation_df[
        allocation_df["trade_action"] == "Entry"
    ].copy()

    exited_position_ids = set(
        allocation_df.loc[
            allocation_df["trade_action"] == "Exit",
            "position_id"
        ].astype(str)
    )

    positions = {}

    for position_id, rows in entry_rows.groupby(
        "position_id",
        sort=False
    ):
        position_key = str(position_id)

        if position_key in exited_position_ids:
            continue

        positions[position_key] = (
            rows.sort_values("split_sequence")
            .to_dict("records")
        )

    return positions


class PositionManager:
    """Own the live open-position state during trade processing."""

    def __init__(self, positions=None):
        self._positions = positions or {}

    @classmethod
    def from_allocation_table(cls, allocation_df):
        return cls(build_open_positions(allocation_df))

    def get_open_positions(
        self,
        account=None,
        instrument_id=None
    ):
        """Return currently open positions matching the optional filters."""

        available = {}

        for position_id, rows in self._positions.items():
            filtered_rows = rows

            if account is not None:
                filtered_rows = [
                    row for row in filtered_rows
                    if row.get("account") == account
                ]

            if instrument_id is not None:
                filtered_rows = [
                    row for row in filtered_rows
                    if row.get("instrument_id") == instrument_id
                ]

            if filtered_rows:
                available[position_id] = filtered_rows

        return available

    def get_position(self, position_id):
        """Return one live position by Position_ID."""

        return self._positions.get(str(position_id))

    def add_entry(self, entry_records):
        """Add all Entry rows for one newly created position."""

        if not entry_records:
            return

        position_id = str(entry_records[0]["position_id"])
        self._positions[position_id] = list(entry_records)

    def close_position(self, position_id):
        """Remove a position after its complete Exit is created."""

        return self._positions.pop(str(position_id), None)

# ==========================================================
# DISPLAY TRADE
# ==========================================================

def display_trade(row):

    print()
    print("=" * 70)

    trade_type = str(row["trade_type"]).upper()
    trade_type = {"B": "BUY", "S": "SELL"}.get(trade_type, trade_type)

    print(f"{row['scrip']}")
    print(f"Expiry       : {row['expiry']}")
    print(f"Strike       : {row['strike']}")
    print(f"Option Type  : {row['option_type']}")
    print(f"Trade Type   : {trade_type}")
    print(f"Quantity     : {row['quantity']}")
    print(f"Price        : {row['average_price']}")

    print("=" * 70)

# ==========================================================
# SELECT SMART STRATEGY
# ==========================================================

def select_strategy(strategy_df, trade_qty, trade_expiry, trade_instrument=None):

    trade_qty = float(trade_qty)
    trade_instrument = _normalize_instrument(trade_instrument)

    while True:

        available = strategy_df[
            (strategy_df["Parent_Qty"] == trade_qty) &
            (strategy_df["Expiry"] == trade_expiry) &
            (strategy_df["Active"] == True)
        ].copy()

        if trade_instrument:
            row_instruments = (
                available["Instrument"]
                .fillna("")
                .astype(str)
                .map(_normalize_instrument)
            )
            inferred_instruments = available["Strategy_Name"].astype(str).map(
                _infer_strategy_instrument
            )
            effective_instruments = row_instruments.where(
                row_instruments.ne(""),
                inferred_instruments,
            )
            available = available[
                effective_instruments.eq(trade_instrument)
            ].copy()

        print()
        print("=" * 70)
        print(f"SMART MAPPINGS (Qty = {trade_qty:.0f})")
        print("=" * 70)

        # --------------------------------------------------
        # NO MAPPING
        # --------------------------------------------------

        if available.empty:

            print("No Smart Mapping Found.")
            print()
            print("A. Create New Mapping")
            print("S. Skip Trade")

            choice = input("\nChoice : ").strip().upper()

            if choice == "A":

                strategy_df = add_strategy(
                    strategy_df,
                    trade_qty,
                    trade_expiry,
                    trade_instrument
                )

                continue

            elif choice == "S":

                return None

            continue

        # --------------------------------------------------
        # SHOW AVAILABLE MAPPINGS
        # --------------------------------------------------

        mapping_ids = sorted(
            available["Mapping_ID"].unique()
        )

        print()

        for i, mapping_id in enumerate(mapping_ids, start=1):

            rows = (
                available[
                    available["Mapping_ID"] == mapping_id
                ]
                .sort_values("Seq")
            )

            strategies = " + ".join(rows["Strategy_Name"])

            qtys = " + ".join(
                rows["Split_Qty"].astype(int).astype(str)
            )

            print(f"{i}. Mapping {mapping_id}")
            print(f"   Qty      : {qtys}")
            print(f"   Strategy : {strategies}")
            print()

        print("A. Create New Mapping")
        print("D. Delete Mapping")
        print("S. Skip Trade")

        choice = input("\nChoice : ").strip().upper()

        if choice == "A":

            strategy_df = add_strategy(
                strategy_df,
                trade_qty,
                trade_expiry,
                trade_instrument
            )

            continue

        elif choice == "D":

            try:

                no = int(input("Mapping No : "))

                mapping_id = mapping_ids[no - 1]

                strategy_df = strategy_df[
                    strategy_df["Mapping_ID"] != mapping_id
                ].copy()

                save_strategies(strategy_df)

            except Exception:

                print("Invalid Mapping.")

            continue

        elif choice == "S":

            return None

        elif choice.isdigit():

            no = int(choice)

            if 1 <= no <= len(mapping_ids):

                mapping_id = mapping_ids[no - 1]

                return (
                    available[
                        available["Mapping_ID"] == mapping_id
                    ]
                    .sort_values("Seq")
                    .reset_index(drop=True)
                )

        print("Invalid Choice.")

# ==========================================================
# SELECT POSITION ACTION
# ==========================================================

def select_position_action(
    available_positions,
    account=None,
    instrument_id=None
):
    """
    Select an open Position_ID for the current instrument
    or create a new Entry.
    """

    open_positions = available_positions.get_open_positions(
        account,
        instrument_id
    )

    # ------------------------------------------------------
    # No Open Positions
    # ------------------------------------------------------

    if not open_positions:

        print()
        print("No Open Position Found.")
        print()
        print("1. Create Entry")

        while input("\nChoice : ").strip() != "1":
            print("Invalid Choice.")

        return {
            "trade_action": "Entry",
            "position_id": None
        }

    # ------------------------------------------------------
    # Group by Position
    # ------------------------------------------------------

    positions = []

    for position_id, rows in open_positions.items():
        positions.append((position_id, rows))

    # ------------------------------------------------------
    # Display Positions
    # ------------------------------------------------------

    print()
    print("=" * 70)
    print("OPEN POSITIONS")
    print("=" * 70)

    for number, (position_id, rows) in enumerate(
        positions,
        start=1
    ):

        print(f"{number}. Position {position_id}")

        print(f"   Instrument : {rows[0]['instrument_id']}")
        print(f"   Qty        : {sum(row['quantity'] for row in rows):g}")
        print(f"   Price      : {rows[0]['average_price']}")

        print("   Strategies")

        for r in rows:

            print(
                f"      {r['quantity']:g} {r['strategy']}"
            )

        print()

    print("E. Create New Entry")

    while True:

        choice = input(
            "\nSelect Position to Close or E : "
        ).strip().upper()

        if choice == "E":

            return {
                "trade_action": "Entry",
                "position_id": None
            }

        try:

            idx = int(choice)

            if 1 <= idx <= len(positions):

                return {
                    "trade_action": "Exit",
                    "position_id": positions[idx - 1][0]
                }

        except ValueError:
            pass

        print("Invalid Position.")

# ==========================================================
# CREATE OUTPUT RECORD
# ==========================================================

def create_record(
    row,
    strategy,
    trade_action,
    position_id,
    quantity,
    parent_quantity=None,
    seq=1,
    is_split=False
):

    return {

        "split_trade_id": row["id"],

        "position_id": position_id,

        "trade_date": row["trade_date"],
        "trade_minute": row["trade_minute"],
        "instrument_id": row["instrument_id"],
        "scrip": row["scrip"],
        "expiry": row["expiry"],
        "strike": row["strike"],
        "option_type": row["option_type"],
        "trade_type": row["trade_type"],

        "parent_quantity": parent_quantity,
        "split_sequence": seq,
        "quantity": quantity,
        "average_price": row["average_price"],

        "account": row["account"],
        "strategy": strategy,
        "trade_action": trade_action,

        "is_split": is_split,

    }
# ==========================================================
# PROCESS TRADES
# ==========================================================

def create_entry(row, mapping, position_id):
    """Create Entry allocation rows for one selected smart mapping."""

    parent_quantity = float(row["quantity"])

    return [
        create_record(
            row=row,
            strategy=map_row["Strategy_Name"],
            trade_action="Entry",
            position_id=position_id,
            quantity=float(map_row["Split_Qty"]),
            parent_quantity=parent_quantity,
            seq=int(map_row["Seq"]),
            is_split=(len(mapping) > 1)
        )
        for _, map_row in mapping.iterrows()
    ]


def create_exit(row, position_id, position_rows):
    """Create Exit allocation rows for every strategy in one position."""

    return [
        create_record(
            row=row,
            strategy=entry_row["strategy"],
            trade_action="Exit",
            position_id=position_id,
            quantity=float(entry_row["quantity"]),
            parent_quantity=entry_row.get("parent_quantity"),
            seq=int(entry_row["split_sequence"]),
            is_split=bool(
                entry_row.get(
                    "is_split",
                    len(position_rows) > 1
                )
            )
        )
        for entry_row in position_rows
    ]


def calculate_wap(group):

    total_qty = group["quantity"].sum()
    wap = 0.0 if total_qty == 0 else (
        (group["quantity"] * group["average_price"]).sum() / total_qty
    )

    return {
        "total_qty": total_qty,
        "wap": round(wap, 2),
        "first_time": group["trade_minute"].min(),
        "last_time": group["trade_minute"].max(),
    }


def process_strategy(conn, merge_id, strategy_df, available_positions):

    records = []
    split_df = read_split_trades(conn, merge_id)

    for _, row in split_df.iterrows():
        action = select_position_action(
            available_positions,
            account=row.get("account"),
            instrument_id=row["instrument_id"]
        )

        if action["trade_action"] == "Entry":
            mapping = select_strategy(
                strategy_df,
                row["quantity"],
                row["expiry"],
                row.get("scrip")
            )

            if mapping is None or mapping.empty:
                print("Strategy mapping skipped for this SplitTrade.")
                continue

            position_id = get_next_position_id(conn)
            transaction_rows = create_entry(row, mapping, position_id)
            available_positions.add_entry(transaction_rows)

            print(
                f"Created Entry Position {position_id} with "
                f"{len(transaction_rows)} strategy record(s)."
            )

        else:
            position_id = str(action["position_id"])
            position_entries = available_positions.get_position(position_id)

            if not position_entries:
                print("Selected position is no longer open.")
                continue

            transaction_rows = create_exit(
                row,
                position_id,
                position_entries
            )
            available_positions.close_position(position_id)

            print(
                f"Created Exit for Position {position_id} with "
                f"{len(transaction_rows)} strategy record(s)."
            )

        records.extend(transaction_rows)

    return records


def process_raw_trade(
    conn,
    raw_row,
    strategy_df,
    available_positions
):

    display_trade(raw_row)

    merge_id = process_merge(conn, raw_row)

    if merge_id is None:
        return []

    # process_split performs a fresh SELECT from MergeTrades and then a fresh
    # SELECT from SplitTrades. Only the database-generated result is passed on.
    split_result = process_split(conn, merge_id)

    if split_result is None:
        return []

    return process_strategy(
        conn,
        split_result,
        strategy_df,
        available_positions
    )


def process_trades():

    conn = connect()
    all_records = []

    try:
        ensure_workflow_tables(conn)
        create_strategy_allocation_table(conn)

        strategy_df = load_strategies()
        raw_df = load_processed_trades(conn)
        allocation_df = load_strategy_allocation(conn)
        available_positions = PositionManager.from_allocation_table(
            allocation_df
        )

        total = len(raw_df)

        print()
        print("=" * 70)
        print("STARTING RAW TRADE WORKFLOW")
        print("=" * 70)

        for processed, (_, raw_row) in enumerate(raw_df.iterrows(), start=1):
            print()
            print("=" * 70)
            print(f"RAW TRADE {processed} OF {total}")
            print("=" * 70)

            trade_records = process_raw_trade(
                conn,
                raw_row,
                strategy_df,
                available_positions
            )

            if trade_records:
                all_records.extend(trade_records)
                upload_to_supabase(
                    pd.DataFrame(trade_records),
                    conn=conn
                )
            else:
                print("No strategy allocation records generated.")

        print()
        print("=" * 70)
        print("PROCESS COMPLETED")
        print("=" * 70)
        print(f"Processed : {total}")
        print(f"Allocated : {len(all_records)}")

        return all_records

    finally:
        conn.close()

# ==========================================================
# CREATE TABLE
# ==========================================================

def create_strategy_allocation_table(conn):

    conn.execute(
        f"CREATE SEQUENCE IF NOT EXISTS {POSITION_SEQUENCE}"
    )

    create_sql = f"""

    CREATE TABLE IF NOT EXISTS {TARGET_SCHEMA}.{TARGET_TABLE}
    (

        allocation_id BIGINT
            GENERATED ALWAYS AS IDENTITY
            PRIMARY KEY,

        split_trade_id BIGINT NOT NULL,

        position_id BIGINT NOT NULL,

        trade_date DATE NOT NULL,

        trade_minute TEXT NOT NULL,

        instrument_id TEXT NOT NULL,

        scrip TEXT NOT NULL,

        expiry TEXT NOT NULL,

        strike DOUBLE PRECISION NOT NULL,

        option_type TEXT NOT NULL,

        trade_type TEXT NOT NULL,

        parent_quantity DOUBLE PRECISION,

        split_sequence INTEGER,

        quantity DOUBLE PRECISION NOT NULL,

        average_price DOUBLE PRECISION NOT NULL,

        account TEXT NOT NULL,

        strategy TEXT NOT NULL,

        trade_action TEXT NOT NULL
            CHECK (trade_action IN ('Entry','Exit')),

        is_split BOOLEAN DEFAULT FALSE,

        created_at TIMESTAMPTZ DEFAULT NOW(),

        CONSTRAINT strategy_allocation_transaction_key
        UNIQUE
        (
            split_trade_id,
            position_id,
            strategy,
            trade_action
        )

    );

    """

    conn.execute(create_sql)

    conn.execute(f"""

        CREATE INDEX IF NOT EXISTS
            strategy_allocation_position_id_idx
        ON {TARGET_SCHEMA}.{TARGET_TABLE}
            (position_id);

        CREATE INDEX IF NOT EXISTS
            strategy_allocation_trade_action_idx
        ON {TARGET_SCHEMA}.{TARGET_TABLE}
            (trade_action);

        CREATE INDEX IF NOT EXISTS
            strategy_allocation_strategy_idx
        ON {TARGET_SCHEMA}.{TARGET_TABLE}
            (strategy);

    """)

    conn.commit()

    print()
    print("Strategy Allocation table ready.")

# ==========================================================
# UPSERT TO SUPABASE
# ==========================================================

def upload_to_supabase(df, conn=None):

    if df.empty:

        print()
        print("Nothing to upload.")
        return

    owns_connection = conn is None

    if owns_connection:
        print()
        print("Connecting to Supabase...")
        conn = connect()

    insert_sql = f"""

    INSERT INTO {TARGET_SCHEMA}.{TARGET_TABLE}
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
        %(is_split)s
    )

    ON CONFLICT
    (
        split_trade_id,
        position_id,
        strategy,
        trade_action
    )

    DO UPDATE SET

        trade_date = EXCLUDED.trade_date,
        trade_minute = EXCLUDED.trade_minute,
        instrument_id = EXCLUDED.instrument_id,
        scrip = EXCLUDED.scrip,
        expiry = EXCLUDED.expiry,
        strike = EXCLUDED.strike,
        option_type = EXCLUDED.option_type,
        trade_type = EXCLUDED.trade_type,
        parent_quantity = EXCLUDED.parent_quantity,
        split_sequence = EXCLUDED.split_sequence,
        quantity = EXCLUDED.quantity,
        average_price = EXCLUDED.average_price,
        account = EXCLUDED.account,
        strategy = EXCLUDED.strategy,
        trade_action = EXCLUDED.trade_action,
        is_split = EXCLUDED.is_split;

    """

    rows = df.to_dict("records")

    with conn.cursor() as cur:

        cur.executemany(insert_sql, rows)

    conn.commit()

    if owns_connection:
        conn.close()

    print()

    print(f"{len(rows):,} rows uploaded successfully.")


# ==========================================================
# WORKFLOW CONTROLLER
# ==========================================================

def _display_pending_trades(df):
    print()
    print("=" * 70)
    print("PENDING TRADES")
    print("=" * 70)

    for number, (_, row) in enumerate(df.iterrows(), start=1):
        expiry = row.get("expiry", "")
        strike = row.get("strike", "")
        print(f"\n{number}.")
        print(f"{row.get('scrip', '')}")
        print(f"Expiry : {expiry}")
        print(f"Strike : {strike:g}" if isinstance(strike, (int, float)) else f"Strike : {strike}")
        print(f"Option : {row.get('option_type', '')}")
        print(f"Qty : {float(row.get('quantity', 0)):g}")
        print(f"Price : {float(row.get('average_price', 0)):g}")
        print(f"Time : {row.get('trade_minute', '')}")


def _select_pending_trade(df):
    _display_pending_trades(df)
    while True:
        try:
            choice = int(input("\nSelect Trade : ").strip())
            if 1 <= choice <= len(df):
                return df.iloc[choice - 1]
        except ValueError:
            pass
        print("Invalid Selection.")


def _insert_unsplit_split_trade(conn, merge_id):
    merge_row = read_merge_trade(conn, merge_id)
    _upsert_split_trades(conn, merge_row, [merge_row])


def _merge_one_raw_trade(conn, raw_row):
    return _insert_merge_trade(conn, raw_row, [raw_row["id"]])


def _run_strategy_for_merge_ids(merge_ids):
    conn = connect()
    all_records = []
    try:
        ensure_workflow_tables(conn)
        create_strategy_allocation_table(conn)
        strategy_df = load_strategies()
        allocation_df = load_strategy_allocation(conn)
        available_positions = PositionManager.from_allocation_table(allocation_df)

        for merge_id in merge_ids:
            trade_records = process_strategy(
                conn, int(merge_id), strategy_df, available_positions
            )
            if trade_records:
                all_records.extend(trade_records)
                upload_to_supabase(pd.DataFrame(trade_records), conn=conn)

        return all_records
    finally:
        conn.close()


def _merge_workflow():
    merge_module = importlib.import_module("03_MergeTrades")
    merge_module.main()


def _split_workflow():
    split_module = importlib.import_module("04_Split_Trades")
    split_module.main()


def _all_merge_ids():
    with connect() as conn:
        rows = conn.execute(
            f'SELECT id FROM {SOURCE_SCHEMA}."{MERGE_TABLE}" ORDER BY id'
        ).fetchall()
    return [int(row[0]) for row in rows]


def _strategy_path():
    conn = connect()
    try:
        ensure_workflow_tables(conn)
        pending = load_processed_trades(conn)
        if pending.empty:
            return
        raw_row = _select_pending_trade(pending)
        merge_id = _merge_one_raw_trade(conn, raw_row)
        _insert_unsplit_split_trade(conn, merge_id)
    finally:
        conn.close()
    _run_strategy_for_merge_ids([merge_id])


def _merge_path():
    _merge_workflow()
    print("\nNEXT STEP\n\n1. Strategy Allocation\n2. Split Trades")
    while True:
        choice = input("\nChoice : ").strip()
        if choice in {"1", "2"}:
            break
        print("Invalid Choice.")

    if choice == "1":
        conn = connect()
        try:
            ensure_workflow_tables(conn)
            merge_ids = _all_merge_ids()
            for merge_id in merge_ids:
                _insert_unsplit_split_trade(conn, merge_id)
        finally:
            conn.close()
    else:
        _split_workflow()

    _run_strategy_for_merge_ids(_all_merge_ids())


def _split_path():
    conn = connect()
    try:
        ensure_workflow_tables(conn)
        pending = load_processed_trades(conn)
        if pending.empty:
            return
        raw_row = _select_pending_trade(pending)
        _merge_one_raw_trade(conn, raw_row)
    finally:
        conn.close()
    _split_workflow()
    _run_strategy_for_merge_ids(_all_merge_ids())


def run_workflow_controller():
    print("\nSELECT WORKFLOW\n\n1. Strategy Allocation\n2. Merge Trades\n3. Split Trades")
    while True:
        choice = input("\nChoice : ").strip()
        if choice in {"1", "2", "3"}:
            break
        print("Invalid Choice.")

    if choice == "1":
        _strategy_path()
    elif choice == "2":
        _merge_path()
    else:
        _split_path()


# ==========================================================
# GROUPED WORKFLOW CONTROLLER
# ==========================================================

CONTRACT_GROUP_COLUMNS = ["scrip", "expiry", "strike", "option_type"]
WORKFLOW_GROUP_COLUMNS = [
    "instrument_id",
    *CONTRACT_GROUP_COLUMNS,
    "trade_type",
]


def _contract_groups(raw_df):
    available = raw_df.copy()
    available["_trade_type_order"] = available["trade_type"].map(
        {"S": 0, "B": 1}
    ).fillna(2)
    available.sort_values(
        ["_trade_type_order", "trade_date", "trade_minute", "id"],
        inplace=True,
    )
    return available.groupby(
        WORKFLOW_GROUP_COLUMNS,
        dropna=False,
        sort=False,
    )


def _display_contract_group(group):
    print()
    print("=" * 70)
    print("CONTRACT GROUP")
    print("=" * 70)

    for number, (_, row) in enumerate(group.iterrows(), start=1):
        strike = row["strike"]
        strike_text = f"{strike:g}" if isinstance(strike, (int, float)) else str(strike)
        print(f"\n{number}. {row['scrip']}")
        print(f"   Expiry : {row['expiry']}")
        print(f"   Strike : {strike_text}")
        print(f"   Option : {row['option_type']}")
        print(f"   Trade : {row.get('trade_type', '')}")
        print(f"   Time : {row['trade_minute']}")
        print(f"   Qty : {float(row['quantity']):g}")
        print(f"   Price : {float(row['average_price']):.2f}")
        print("\n" + "-" * 40)


def _select_group_workflow():
    print("\nSELECT WORKFLOW\n\n1. Strategy Allocation\n2. Merge Trades\n3. Split Trades\n4. Skip Trade")
    while True:
        choice = input("\nChoice : ").strip()
        if choice in {"1", "2", "3", "4"}:
            return choice
        print("Invalid Choice.")


def _select_trade_for_mapping(group):
    print("\nSELECT TRADE TO MAP")
    for number, (_, row) in enumerate(group.iterrows(), start=1):
        print(
            f"{number}. {row['trade_minute']} | "
            f"Qty {float(row['quantity']):g} | "
            f"Price {float(row['average_price']):.2f} | "
            f"Trade {row.get('trade_type', '')}"
        )

    print("S. Skip Trade")

    while True:
        choice = input("\nSelect Trade : ").strip().upper()

        if choice == "S":
            return None

        try:
            choice_no = int(choice)
            if 1 <= choice_no <= len(group):
                return group.iloc[choice_no - 1]
        except ValueError:
            pass
        print("Invalid Trade Selection.")


def _merge_contract_group(conn, group, contract_group):
    source_ids = [int(value) for value in group["id"].tolist()]
    remaining = set(source_ids)
    merge_ids = set()

    while remaining:
        source_id = next(
            int(value) for value in source_ids if int(value) in remaining
        )
        raw_row = group[group["id"] == source_id].iloc[0]
        merge_id = process_merge(conn, raw_row, contract_group)

        if merge_id is None:
            break

        merge_ids.add(int(merge_id))
        assigned = conn.execute(
            f'''
            SELECT id, merge_trade_id
            FROM {SOURCE_SCHEMA}."{SOURCE_TABLE}"
            WHERE id = ANY(%s)
            ''',
            (source_ids,),
        ).fetchall()
        remaining = {
            int(raw_id)
            for raw_id, assigned_merge_id in assigned
            if assigned_merge_id is None
        }

    return sorted(merge_ids)


def _split_contract_group(conn, merge_ids):
    if not merge_ids:
        return

    split_module = importlib.import_module("04_Split_Trades")
    split_df = split_module.load_trades(conn)
    split_df = split_df[split_df["id"].isin(merge_ids)].copy()
    if split_df.empty:
        return

    split_df.sort_values("trade_minute", inplace=True)
    split_df = split_module.review_trades(split_df)
    split_df = split_df.sort_values("trade_minute").reset_index(drop=True)
    split_module.upload_split_trades(conn, split_df)


def _run_grouped_strategy(conn, merge_ids, strategy_df, available_positions):
    records = []
    for merge_id in merge_ids:
        records.extend(
            process_strategy(
                conn,
                int(merge_id),
                strategy_df,
                available_positions,
            )
        )

    if records:
        upload_to_supabase(pd.DataFrame(records), conn=conn)
    return records


def run_grouped_workflow_controller():
    conn = connect()
    all_records = []
    try:
        ensure_workflow_tables(conn)
        create_strategy_allocation_table(conn)
        strategy_df = load_strategies()
        allocation_df = load_strategy_allocation(conn)
        available_positions = PositionManager.from_allocation_table(allocation_df)
        raw_df = load_processed_trades(conn)

        if raw_df.empty:
            return

        for _, group in _contract_groups(raw_df):
            group = group.sort_values(
                ["trade_date", "trade_minute", "id"]
            ).reset_index(drop=True)
            first = group.iloc[0]
            contract_group = {
                column: first[column]
                for column in CONTRACT_GROUP_COLUMNS
            }

            _display_contract_group(group)
            choice = _select_group_workflow()

            if choice == "4":
                continue

            if choice == "1":
                remaining_group = group.copy()
                merge_ids = []
                group_records = []

                while not remaining_group.empty:
                    raw_row = _select_trade_for_mapping(remaining_group)
                    if raw_row is None:
                        print("Trade skipped. It remains pending in RawTxtData.")
                        break
                    merge_id = _merge_one_raw_trade(conn, raw_row)
                    _insert_unsplit_split_trade(conn, merge_id)
                    merge_ids.append(merge_id)
                    group_records.extend(
                        _run_grouped_strategy(
                            conn,
                            [merge_id],
                            strategy_df,
                            available_positions,
                        )
                    )
                    remaining_group = remaining_group[
                        remaining_group["id"] != raw_row["id"]
                    ]

                all_records.extend(group_records)
                continue

            else:
                merge_ids = _merge_contract_group(
                    conn,
                    group,
                    contract_group,
                ) if choice == "2" else [
                    _merge_one_raw_trade(conn, row)
                    for _, row in group.iterrows()
                ]

                if choice == "2":
                    print("\nNEXT STEP\n\n1. Strategy Allocation\n2. Split Trades")
                    while True:
                        next_choice = input("\nChoice : ").strip()
                        if next_choice in {"1", "2"}:
                            break
                        print("Invalid Choice.")
                    if next_choice == "1":
                        for merge_id in merge_ids:
                            _insert_unsplit_split_trade(conn, merge_id)
                    else:
                        _split_contract_group(conn, merge_ids)
                else:
                    _split_contract_group(conn, merge_ids)

            all_records.extend(
                _run_grouped_strategy(
                    conn,
                    merge_ids,
                    strategy_df,
                    available_positions,
                )
            )
    finally:
        conn.close()

# ==========================================================
# MAIN
# ==========================================================

def main():
    run_grouped_workflow_controller()

# ==========================================================
# ENTRY
# ==========================================================

if __name__ == "__main__":

    main()
