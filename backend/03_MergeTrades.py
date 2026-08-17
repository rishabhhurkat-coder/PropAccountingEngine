from __future__ import annotations
import pandas as pd
from pathlib import Path
import sys
import importlib.util

_external_spec = importlib.util.spec_from_file_location("matalia_external_connections", Path(__file__).with_name("09_External_Connections.py"))
_external_module = importlib.util.module_from_spec(_external_spec)
_external_spec.loader.exec_module(_external_module)
connect = _external_module.connect

import warnings

warnings.filterwarnings(
    "ignore",
    message="pandas only supports SQLAlchemy connectable*"
)

# print("ARGV =", sys.argv)


# ==========================================================
# CONFIG
# ==========================================================

TABLE_NAME = 'matalia."01RawTxtData"'

GROUP_COLUMNS = [
    "trade_date",
    "instrument_id",
    "trade_type",
    "account",
]

DISPLAY_COLUMNS = [
    "id",
    "trade_minute",
    "quantity",
    "average_price",
    "account",
    "trades_merged",
]

# ==========================================================
# EXPORT
# ==========================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent


# ==========================================================
# LOAD TRADES
# ==========================================================

def load_trades(conn) -> pd.DataFrame:
    """
    Load all processed trades from Supabase.
    """

    
    sql = f"""
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
            trades_merged,
            merge_trade_id
        FROM {TABLE_NAME}
        ORDER BY
            trade_date,
            instrument_id,
            account,
            trade_type,
            trade_minute;
    """

    df = pd.read_sql(sql, conn)

    if df.empty:

        print()
        print("01RawTxtData is empty.")

        raise SystemExit()

    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date

    df["trade_minute"] = df["trade_minute"].astype(str)

    df["quantity"] = df["quantity"].astype(float)

    df["average_price"] = df["average_price"].astype(float)

    print(f"Trades Loaded : {len(df):,}")

    return df

# ==========================================================
# LIST AVAILABLE DATES
# ==========================================================

def list_available_dates(df: pd.DataFrame):

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

        date = row["trade_date"].strftime("%d-%b-%Y")

        print(
            f"{i+1:2d}. {date:<15} "
            f"({row['trade_count']:,} Trades)"
        )

    print()

    return summary


# ==========================================================
# SELECT DATE
# ==========================================================

def select_trade_date(summary: pd.DataFrame):

    while True:

        try:

            choice = int(input("Select Date : "))

            if 1 <= choice <= len(summary):

                return summary.iloc[choice - 1]["trade_date"]

        except ValueError:
            pass

        print("Invalid Selection.")


# ==========================================================
# CALCULATE WAP
# ==========================================================

def calculate_wap(group: pd.DataFrame):

    total_qty = group["quantity"].sum()

    if total_qty == 0:

        wap = 0.0

    else:

        wap = (
            (group["quantity"] * group["average_price"]).sum()
            / total_qty
        )

    first_time = group["trade_minute"].min()

    last_time = group["trade_minute"].max()

    return {

        "total_qty": total_qty,

        "wap": round(wap, 2),

        "first_time": first_time,

        "last_time": last_time,

    }

def upload_merge_trades(conn, df, lineage):

    print()
    print("Uploading MergeTrades to Supabase...")

    cur = conn.cursor()

    upload_df = df.copy()

    # MergeTrades should not contain merge_trade_id
    upload_df.drop(
        columns=["merge_trade_id"],
        errors="ignore",
        inplace=True
    )

    # Remove existing table
    cur.execute("""
        DROP TABLE IF EXISTS matalia."MergeTrades";
    """)

    # Create MergeTrades table
    cur.execute("""
        CREATE TABLE matalia."MergeTrades" (

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

        );
    """)

    # Don't insert id because PostgreSQL generates it
    cols = [
        c
        for c in upload_df.columns
        if c != "id"
    ]

    placeholders = ",".join(["%s"] * len(cols))

    columns = ",".join(
        f'"{c}"'
        for c in cols
    )

    sql = f"""
        INSERT INTO matalia."MergeTrades"
        ({columns})
        VALUES ({placeholders})
        RETURNING id
    """

    merge_lineage = {}

    # Insert all rows
    for _, row in upload_df.iterrows():

        cur.execute(
            sql,
            [row[col] for col in cols]
        )

        merge_trade_id = cur.fetchone()[0]

        source_id = int(row["id"])

        merge_lineage[merge_trade_id] = lineage.get(
            source_id,
            [source_id]
        )

    # Clear previous mapping
    cur.execute(f"""
        UPDATE {TABLE_NAME}
        SET merge_trade_id = NULL;
    """)

    # Update RawTxtData with MergeTrade IDs
    for merge_trade_id, raw_ids in merge_lineage.items():

        cur.execute(
            f"""
            UPDATE {TABLE_NAME}
            SET merge_trade_id = %s
            WHERE id = ANY(%s);
            """,
            (
                merge_trade_id,
                raw_ids
            )
        )

    conn.commit()

    cur.close()

    print()
    print("=" * 60)
    print("UPLOAD COMPLETE")
    print("=" * 60)
    print(f"MergeTrades Rows : {len(upload_df):,}")
    print(f"RawTxtData Rows Updated : {sum(len(v) for v in merge_lineage.values()):,}")

def find_merge_candidates(df):

    candidates = []

    grouped = df.groupby(GROUP_COLUMNS, sort=True)

    for _, group in grouped:

        if len(group) < 2:
            continue

        candidates.append(group.sort_values("trade_minute"))

    return candidates

def review_candidates(candidates, df, lineage):

    merged = 0
    skipped = 0

    for index, group in enumerate(candidates, start=1):

        stats = calculate_wap(group)

        print()
        print("=" * 100)
        print(f"Candidate #{index}")
        print("=" * 100)

        print(f"Underlying    : {group.iloc[0]['scrip']}")
        print(f"Expiry        : {group.iloc[0]['expiry']}")
        print(f"Strike        : {group.iloc[0]['strike']:.0f}")
        print(f"Option        : {group.iloc[0]['option_type']}")
        print(f"Trade Type    : {group.iloc[0]['trade_type']}")
        print(f"Account       : {group.iloc[0]['account']}")

        print()
        print("-" * 100)
        print(f"{'Trade ID':<10}{'Time':<10}{'Qty':>10}{'Avg Price':>15}")
        print("-" * 100)

        for _, row in group.iterrows():

            print(
                f"{int(row['id']):<10}"
                f"{row['trade_minute']:<10}"
                f"{row['quantity']:>10.0f}"
                f"{row['average_price']:>15.2f}"
            )

        print("-" * 100)

        print()
        print("Merge Preview")
        print("-----------------------------------")
        print(f"Merged Qty : {stats['total_qty']:.0f}")
        print(f"WAP        : {stats['wap']:.2f}")

        while True:

            choice = input(
                "\n[Y] Merge  [N] Skip  [Q] Quit : "
            ).strip().upper()

            if choice == "Y":

                ids = group["id"].tolist()

                raw_ids = []

                for source_id in ids:
                    source_id = int(source_id)
                    raw_ids.extend(
                        lineage.get(source_id, [source_id])
                    )

                first = group.iloc[0].copy()

                # Remove original trades
                df.drop(
                    df[df["id"].isin(ids)].index,
                    inplace=True
                )

                # Give merged row a unique temporary ID
                min_id = df["id"].min()

                if min_id > 0:
                    first["id"] = -1
                else:
                    first["id"] = min_id - 1

                lineage[int(first["id"])] = raw_ids
                first["trade_minute"] = stats["first_time"]
                first["quantity"] = stats["total_qty"]
                first["average_price"] = stats["wap"]
                first["trades_merged"] = len(group)

                df.loc[len(df)] = first

                merged += 1

                print("Merged and database updated.")
                return "MERGED"

            elif choice == "N":

                skipped += 1

                print("Skipped.")
                return "SKIPPED"

            elif choice == "Q":

                print()

                print("=" * 60)
                print("SUMMARY")
                print("=" * 60)
                print(f"Merged : {merged}")
                print(f"Skipped: {skipped}")

                return "QUIT"

    print()

    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Merged : {merged}")
    print(f"Skipped: {skipped}")

# ==========================================================
# BYPASS MERGE
# ==========================================================

def bypass_merge():

    print()
    print("=" * 60)
    print("BYPASS MERGE")
    print("=" * 60)

    with connect() as conn:

        print("Copying RawTxtData to MergeTrades...")

        cur = conn.cursor()

        # Remove existing MergeTrades data
        cur.execute("""
            DROP TABLE IF EXISTS matalia."MergeTrades";
        """)

        # Create MergeTrades directly from RawTxtData
        cur.execute("""
            CREATE TABLE matalia."MergeTrades" AS

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

            FROM matalia."01RawTxtData";
        """)

        conn.commit()

        df = pd.read_sql(
            """
            SELECT *
            FROM matalia."MergeTrades"
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
        print("MERGE BYPASS COMPLETED")
        print("=" * 60)
        print(f"Rows Copied : {len(df):,}")

# ==========================================================
# MAIN
# ==========================================================

def main():
     
    with connect() as conn:
       
        conn.execute(f"""
            ALTER TABLE {TABLE_NAME}
            ADD COLUMN IF NOT EXISTS merge_trade_id BIGINT NULL;
        """)

        df = load_trades(conn)

        lineage = {
            int(raw_id): [int(raw_id)]
            for raw_id in df["id"].tolist()
        }

        summary = list_available_dates(df)

        selected_date = select_trade_date(summary)

        print()
        print(f"Selected Date : {selected_date:%d-%b-%Y}")

        skipped = set()

        while True:

            filtered = df[
                df["trade_date"] == selected_date
            ].copy()

            candidates = []

            for group in find_merge_candidates(filtered):

                ids = tuple(sorted(group["id"].tolist()))

                if ids not in skipped:

                    candidates.append(group)

            if not candidates:

                print()
                print("=" * 60)
                print("NO MORE MERGE CANDIDATES")
                print("=" * 60)

                upload_merge_trades(
                    conn,
                    df,
                    lineage
                )
                break

            print()
            print(f"Candidates Remaining : {len(candidates)}")

            action = review_candidates(
                [candidates[0]],
                df,
                lineage
            )

            if action == "MERGED":
                continue

            elif action == "SKIPPED":

                ids = tuple(sorted(candidates[0]["id"].tolist()))

                skipped.add(ids)

                continue

            elif action == "QUIT":

                upload_merge_trades(
                    conn,
                    df,
                    lineage
                )

                print()
                print("Finished.")

                break
# ==========================================================
# ENTRY
# ==========================================================

import sys

if __name__ == "__main__":

    if len(sys.argv) > 1 and sys.argv[1].lower() == "bypass":

        bypass_merge()

    else:

        main()
