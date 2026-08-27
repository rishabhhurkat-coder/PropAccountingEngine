from __future__ import annotations

from pathlib import Path
from datetime import datetime
from collections import defaultdict


# ==========================================================
# PATHS
# ==========================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

INPUT_FOLDER = PROJECT_ROOT / "Input" / "Txt"
OUTPUT_FOLDER = PROJECT_ROOT / "Other Logs"

INPUT_FILE = INPUT_FOLDER / "ALL_COMBINED_OrderBook.txt"


# ==========================================================
# HELPERS
# ==========================================================

def parse_trade_date(date_str: str) -> str:
    """
    Convert

        21/07/2026

    to

        21-07-2026
    """

    return datetime.strptime(
        date_str.strip(),
        "%d/%m/%Y",
    ).strftime("%d-%m-%Y")


def get_user_code(columns: list[str]) -> str:
    """
    Last column contains

        A00184
    """

    return columns[-1].strip()


def create_output_file(code: str, trade_date: str) -> Path:
    """
    Returns

    Output/
        A00184/
            21-07-2026.txt
    """

    folder = OUTPUT_FOLDER / code
    folder.mkdir(parents=True, exist_ok=True)

    return folder / f"{trade_date}.txt"


# ==========================================================
# READ INPUT FILE
# ==========================================================

def read_orderbook(
    file_path: Path,
) -> tuple[str, list[str]]:

    with file_path.open(
        "r",
        encoding="utf-8",
    ) as f:

        lines = [
            line.rstrip("\n")
            for line in f
            if line.strip()
        ]

    if not lines:
        raise ValueError("Input file is empty.")

    header = lines[0]
    rows = lines[1:]

    return header, rows


# ==========================================================
# GROUP RECORDS
# ==========================================================

def group_records(
    rows: list[str],
) -> dict[tuple[str, str], list[str]]:

    grouped = defaultdict(list)

    for row in rows:

        cols = [c.strip() for c in row.split(",")]

        if len(cols) < 2:
            continue

        trade_date = parse_trade_date(cols[0])
        code = get_user_code(cols)

        grouped[(code, trade_date)].append(row)

    return grouped


# ==========================================================
# WRITE FILES
# ==========================================================

def write_files(
    header: str,
    grouped: dict[tuple[str, str], list[str]],
) -> None:

    created = 0

    for (code, trade_date), rows in grouped.items():

        output_file = create_output_file(
            code,
            trade_date,
        )

        with output_file.open(
            "w",
            encoding="utf-8",
        ) as f:

            f.write(header + "\n")

            for row in rows:
                f.write(row + "\n")

        created += 1

    print(f"Created {created:,} files.")


# ==========================================================
# MAIN
# ==========================================================

def split_orderbook_by_code_and_date() -> None:

    print("=" * 60)
    print("TXT Splitter")
    print("=" * 60)

    print(f"Base Folder  : {PROJECT_ROOT}")
    print(f"Input Folder : {INPUT_FOLDER}")
    print(f"Output Folder: {OUTPUT_FOLDER}")
    print()

    if not INPUT_FILE.exists():
        raise FileNotFoundError(
            f"\nInput file not found:\n{INPUT_FILE}"
        )

    OUTPUT_FOLDER.mkdir(
        parents=True,
        exist_ok=True,
    )

    print("Reading Order Book...")

    header, rows = read_orderbook(INPUT_FILE)

    print(f"Total Trades : {len(rows):,}")

    print("Grouping records...")

    grouped = group_records(rows)

    print(f"Unique Code + Date Groups : {len(grouped):,}")

    print("Writing files...")

    write_files(
        header,
        grouped,
    )

    print()
    print("Done.")
    print(f"Output Folder : {OUTPUT_FOLDER}")


# ==========================================================
# ENTRY
# ==========================================================

if __name__ == "__main__":
    split_orderbook_by_code_and_date()
