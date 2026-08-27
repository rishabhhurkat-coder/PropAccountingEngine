from __future__ import annotations

import pandas as pd

from pathlib import Path

import importlib.util

_external_spec = importlib.util.spec_from_file_location("matalia_external_connections", Path(__file__).with_name("09_External_Connections.py"))
_external_module = importlib.util.module_from_spec(_external_spec)
_external_spec.loader.exec_module(_external_module)
connect = _external_module.connect
import warnings


# ==========================================================
# CONFIG
# ==========================================================

TABLE_NAME = 'matalia."MergeTrades"'

DISPLAY_COLUMNS = [
    "id",
    "trade_minute",
    "quantity",
    "average_price",
    "account",
]

# ==========================================================
# LOAD TRADES
# ==========================================================

def load_trades(conn) -> pd.DataFrame:
    """
    Load MergeTrades table.
    """

    pass

    sql = f"""
        SELECT
            *
        FROM {TABLE_NAME}
        ORDER BY
            trade_date,
            instrument_id,
            account,
            trade_type,
            trade_minute;
    """

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="pandas only supports SQLAlchemy connectable.*"
        )
        df = pd.read_sql(sql, conn)

    if df.empty:

        print("No trades found.")
        raise SystemExit()

    df["trade_date"] = pd.to_datetime(
        df["trade_date"]
    ).dt.date

    df["trade_minute"] = (
        df["trade_minute"]
        .astype(str)
    )

    df["quantity"] = (
        df["quantity"]
        .astype(float)
    )

    df["average_price"] = (
        df["average_price"]
        .astype(float)
    )

    pass

    return df


# ==========================================================
# LIST AVAILABLE DATES
# ==========================================================

def list_available_dates(df):

    print()
    print("=" * 70)
    print("AVAILABLE TRADE DATES")
    print("=" * 70)
    print()

    summary = (
        df.groupby("trade_date")
        .size()
        .reset_index(name="trade_count")
        .sort_values("trade_date")
        .reset_index(drop=True)
    )

    for i, row in summary.iterrows():

        print(
            f"{i+1:2d}. "
            f"{row['trade_date'].strftime('%d-%b-%Y'):<15}"
            f"({row['trade_count']:,} Trades)"
        )

    print()

    return summary


# ==========================================================
# SELECT DATE
# ==========================================================

def select_trade_date(summary):

    while True:

        try:

            choice = int(
                input("Select Date : ")
            )

            if 1 <= choice <= len(summary):

                return summary.iloc[
                    choice - 1
                ]["trade_date"]

        except ValueError:
            pass

        print("Invalid Selection.")


# ==========================================================
# UPLOAD TO SUPABASE
# ==========================================================

def upload_split_trades(conn, df):

    print()
    print("Updating SplitTrades...")

    cur = conn.cursor()

    # Create table only once
    cur.execute("""
    CREATE TABLE IF NOT EXISTS matalia."SplitTrades"
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
    );
    """)

    # Prevent duplicate MergeID rows
    cur.execute("""
        DELETE FROM matalia."SplitTrades"
        WHERE "MergeID" = ANY(%s);
    """, (df["id"].tolist(),))

    upload_df = df.copy()

    upload_df.rename(
        columns={"id": "MergeID"},
        inplace=True
    )

    cols = list(upload_df.columns)

    placeholders = ",".join(["%s"] * len(cols))

    columns = ",".join(f'"{c}"' for c in cols)

    sql = f"""
        INSERT INTO matalia."SplitTrades"
        ({columns})
        VALUES ({placeholders})
    """

    cur.executemany(
        sql,
        upload_df.values.tolist()
    )

    conn.commit()

    cur.close()

    print(f"Updated {len(upload_df):,} rows.")

# ==========================================================
# DISPLAY TRADE
# ==========================================================

def display_trade(row, trade_no, total):

    print()
    print("=" * 100)
    print(
        f"Trade {trade_no} of {total}"
    )
    print("=" * 100)

    print(f"Trade ID     : {row['id']}")
    print(f"Scrip        : {row['scrip']}")
    print(f"Trade Type   : {row['trade_type']}")
    print(f"Account      : {row['account']}")
    print(f"Time         : {row['trade_minute']}")
    print(f"Quantity     : {row['quantity']:.0f}")
    print(f"Avg Price    : {row['average_price']:.2f}")


# ==========================================================
# SPLIT TRADE
# ==========================================================

def split_trade_by_quantities(row, quantities):
    """Apply validated quantity parts using the same child-row logic as the interactive split flow."""
    original_qty = float(row["quantity"])
    normalized = [float(quantity) for quantity in quantities]
    if len(normalized) < 2 or any(quantity <= 0 for quantity in normalized):
        raise ValueError("At least two positive split quantities are required.")
    if round(sum(normalized), 2) != round(original_qty, 2):
        raise ValueError("Split quantities must equal the original trade quantity.")

    rows = []
    for quantity in normalized:
        child = row.copy()
        child["quantity"] = quantity
        child["trades_merged"] = 1
        rows.append(child)
    return pd.DataFrame(rows).reset_index(drop=True)

def split_trade(row):

    original_qty = float(row["quantity"])

    print()
    print("1. Split by Qty")
    print("2. Split by Percentage")

    while True:

        method = input("\nChoice : ").strip()

        if method in ("1", "2"):
            break

        print("Invalid Choice.")

    # ======================================================
    # SPLIT BY QUANTITY
    # ======================================================

    if method == "1":

        while True:

            try:

                parts = int(
                    input("\nNumber of Parts : ")
                )

                if parts < 2:

                    print("Minimum 2 parts required.")
                    continue

                break

            except ValueError:

                print("Invalid Number.")

        quantities = []

        total = 0

        print()

        for i in range(parts):

            while True:

                try:

                    qty = float(
                        input(
                            f"Quantity Part {i+1} : "
                        )
                    )

                    if qty <= 0:

                        print("Invalid Quantity.")
                        continue

                    quantities.append(qty)

                    total += qty

                    break

                except ValueError:

                    print("Invalid Quantity.")

        if round(total, 2) != round(original_qty, 2):

            print()
            print("=" * 60)
            print("INVALID SPLIT")
            print("=" * 60)
            print(f"Original Qty : {original_qty}")
            print(f"Entered Qty  : {total}")

            return None

    # ======================================================
    # SPLIT BY PERCENTAGE
    # ======================================================

    else:

        while True:

            try:

                parts = int(
                    input("\nNumber of Parts : ")
                )

                if parts < 2:

                    print("Minimum 2 parts required.")
                    continue

                break

            except ValueError:

                print("Invalid Number.")

        percentages = []

        total = 0

        print()

        for i in range(parts):

            while True:

                try:

                    pct = float(
                        input(
                            f"Percentage Part {i+1} : "
                        )
                    )

                    if pct <= 0:

                        print("Invalid Percentage.")
                        continue

                    percentages.append(pct)

                    total += pct

                    break

                except ValueError:

                    print("Invalid Percentage.")

        if round(total, 2) != 100:

            print()
            print("=" * 60)
            print("TOTAL PERCENTAGE MUST BE 100")
            print("=" * 60)

            return None

        quantities = []

        remaining = original_qty

        for pct in percentages[:-1]:

            qty = round(original_qty * pct / 100, 2)

            quantities.append(qty)

            remaining -= qty

        quantities.append(round(remaining, 2))

    # ======================================================
    # CREATE CHILD ROWS
    # ======================================================

    return split_trade_by_quantities(row, quantities).to_dict("records")

# ==========================================================
# REVIEW TRADES
# ==========================================================

def review_trades(df):

    result = []

    total = len(df)

    for idx, (_, row) in enumerate(
        df.iterrows(),
        start=1
    ):

        display_trade(
            row,
            idx,
            total
        )

        while True:

            choice = input(
                "\n[Y] Split  [N] Keep  [Q] Quit : "
            ).strip().upper()

            # ---------------------------------------
            # KEEP ORIGINAL
            # ---------------------------------------
            if choice == "N":

                result.append(row.copy())

                break

            # ---------------------------------------
            # SPLIT TRADE
            # ---------------------------------------
            elif choice == "Y":

                rows = split_trade(row)

                if rows is None:
                    continue

                result.extend(rows)

                print("Trade Split.")

                break

            # ---------------------------------------
            # QUIT
            # ---------------------------------------
            elif choice == "Q":

                print()

                print("Saving remaining trades...")

                # Add every remaining unprocessed trade
                remaining = df.iloc[idx:]

                for _, r in remaining.iterrows():

                    result.append(r.copy())

                print("Progress Saved.")

                return (
                    pd.DataFrame(result)
                    .reset_index(drop=True)
                )

    return (
        pd.DataFrame(result)
        .reset_index(drop=True)
    )

# ==========================================================
# BYPASS SPLIT
# ==========================================================

def bypass_split():

    print()
    print("=" * 60)
    print("BYPASS SPLIT")
    print("=" * 60)

    with connect() as conn:

        print("Copying MergeTrades to SplitTrades...")

        cur = conn.cursor()

        # Create table if it doesn't exist
        cur.execute("""
        CREATE TABLE IF NOT EXISTS matalia."SplitTrades"
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
        );
        """)

        # Remove existing rows
        cur.execute("""
            TRUNCATE TABLE matalia."SplitTrades";
        """)

        # Copy all MergeTrades
        cur.execute("""
            INSERT INTO matalia."SplitTrades"
            (
                "MergeID",
                trade_date,
                trade_minute,
                instrument_id,
                scrip,
                expiry,
                strike,
                option_type,
                trade_type,
                quantity,
                average_price,
                account,
                trades_merged
            )

            SELECT
                id,
                trade_date,
                trade_minute,
                instrument_id,
                scrip,
                expiry,
                strike,
                option_type,
                trade_type,
                quantity,
                average_price,
                account,
                trades_merged

            FROM matalia."MergeTrades";
        """)

        conn.commit()

        df = pd.read_sql(
            """
            SELECT *
            FROM matalia."SplitTrades"
            ORDER BY
                trade_date,
                instrument_id,
                account,
                trade_type,
                trade_minute
            """,
            conn
        )

        print()
        print("=" * 60)
        print("SPLIT BYPASS COMPLETED")
        print("=" * 60)
        print(f"Rows Copied : {len(df):,}")

# ==========================================================
# MAIN
# ==========================================================

def main():

    pass

    with connect() as conn:

        pass

        df = load_trades(conn)

        summary = list_available_dates(df)

        selected_date = select_trade_date(summary)

        print()
        print(
            f"Selected Date : "
            f"{selected_date:%d-%b-%Y}"
        )

        filtered = (
            df[
                df["trade_date"] == selected_date
            ]
            .copy()
            .reset_index(drop=True)
        )

        split_df = review_trades(filtered)

        split_df = split_df.sort_values(
            [
                "trade_date",
                "instrument_id",
                "account",
                "trade_type",
                "trade_minute",
            ]
        ).reset_index(drop=True)

        upload_split_trades(
            conn,
            split_df
        )

        print()
        print("=" * 60)
        print("FINISHED")
        print("=" * 60)
        print(
            f"Rows Written : {len(split_df):,}"
        )


# ==========================================================
# ENTRY
# ==========================================================

import sys

if __name__ == "__main__":

    if len(sys.argv) > 1 and sys.argv[1].lower() == "bypass":

        bypass_split()

    else:

        main()
