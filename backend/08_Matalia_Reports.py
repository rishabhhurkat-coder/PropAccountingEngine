"""Fast Jobber F&O/FX report fetcher using the portal's direct report POST."""

from __future__ import annotations

import os
import importlib.util
import re
import sys
import subprocess
import threading
import uuid
from typing import Any
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from io import StringIO
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from playwright.sync_api import Error as PlaywrightError, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_external_connections_module = sys.modules.get("matalia_external_connections")
if _external_connections_module is None:
    _external_connections_spec = importlib.util.spec_from_file_location(
        "matalia_external_connections", Path(__file__).with_name("09_External_Connections.py")
    )
    if _external_connections_spec is None or _external_connections_spec.loader is None:
        raise ImportError("Unable to load backend/09_External_Connections.py")
    _external_connections_module = importlib.util.module_from_spec(_external_connections_spec)
    sys.modules["matalia_external_connections"] = _external_connections_module
    _external_connections_spec.loader.exec_module(_external_connections_module)
connect = _external_connections_module.connect

router = APIRouter()
JOBBER_PIPELINE = Path(__file__).resolve()
JOBBER_CAPTCHA = ROOT / "Other Logs" / "jobber_captcha.png"
JOBBER_FETCH_STATE: dict[str, Any] = {
    "status": "idle", "message": "Ready", "log": [], "error": None,
    "started_at": None, "finished_at": None,
}
JOBBER_FETCH_PROCESS: Any = None
JOBBER_FETCH_LOCK = threading.Lock()


class MataliaFetchRequest(BaseModel):
    from_date: str
    to_date: str
    existing_action: str | None = None


class MataliaCaptchaRequest(BaseModel):
    captcha: str

REPORT_PATH = "/Report/InvesterBasedFReport"
LOGIN_PATH = "/Tplus/DashBoard"
FIELDNAMES = [
    "record_type", "report_date", "client", "client_code", "exchange_segment",
    "series_id", "description", "b_f_qty", "buy_qty", "sell_qty", "exerc",
    "assgn", "out_qty", "close_out", "mtm_premium", "charge_name", "amount",
    "gross_profit_loss", "net_profit_loss", "total_charges", "trade_count",
    "reconciliation_status", "fetched_at", "run_id",
]


class VisibleText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if value:
            self.parts.append(value)

    def output(self) -> str:
        return "\n".join(self.parts)


def parse_date(value: str) -> date:
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Invalid date: {value}")


def dates_between(start: date, end: date) -> list[date]:
    if end < start:
        raise ValueError("End date must not be before start date")
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def money(value: str | float | int | None) -> float:
    if value is None or str(value).strip() == "":
        return 0.0
    return float(str(value).replace(",", "").replace("₹", "").strip())


def amount_after(text: str, label: str) -> float:
    found = re.search(re.escape(label) + r"\s*(-?[\d,]+(?:\.\d+)?)", text, re.I)
    return money(found.group(1)) if found else 0.0


def row_value(row: pd.Series, *needles: str) -> str:
    for key, value in row.items():
        compact = str(key).lower().replace(" ", "")
        if all(needle.lower().replace(" ", "") in compact for needle in needles):
            return "" if pd.isna(value) else str(value).strip()
    return ""


def parse_report(report_html: str, report_day: date, client: str, code: str,
                 segment: str, fetched_at: str, run_id: str) -> list[dict[str, str]]:
    visible = re.sub(r"<[^>]+>", " ", report_html)
    visible = " ".join(visible.split())
    if "no records found" in visible.lower():
        return []
    if "<table" not in report_html.lower():
        raise RuntimeError(f"Report returned no table: {visible[:500]}")
    parser = VisibleText()
    parser.feed(report_html)
    text = parser.output()
    charge_labels = {
        "Integrated GST @ 18%": "integrated_gst",
        "PCM CLERING CHG OPT": "clearing_charge",
        "STAM DUTY ON OPTION TO": "stamp_duty",
        "STT": "stt",
        "T.O. CHARGES (OPTION)": "turnover_charges",
    }
    charges = {name: amount_after(text, label) for label, name in charge_labels.items()}
    gross = amount_after(text, "Profit/Loss(+/-)")
    net = amount_after(text, "Net Profit/Loss(+/-)")
    total_charges = round(sum(abs(value) for value in charges.values()), 2)
    tables = pd.read_html(StringIO(report_html))
    candidates = [table for table in tables if len(table.columns) >= 9 and len(table) > 0]
    trades = max(candidates, key=len) if candidates else pd.DataFrame()
    if isinstance(trades.columns, pd.MultiIndex):
        trades.columns = [" ".join(str(part) for part in col if str(part) != "nan") for col in trades.columns]
    if trades.shape[1] >= 10 and not any("series" in str(col).lower() for col in trades.columns):
        trade_columns = ["series_id", "description", "b_f_qty", "buy_qty", "sell_qty",
                         "exerc", "assgn", "out_qty", "close_out", "mtm_premium"]
        trades.columns = trade_columns + [f"extra_{i}" for i in range(trades.shape[1] - len(trade_columns))]
    common = {
        "report_date": report_day.isoformat(), "client": client, "client_code": code,
        "exchange_segment": segment, "fetched_at": fetched_at, "run_id": run_id,
    }
    rows: list[dict[str, str]] = []
    for _, trade in trades.iterrows():
        series_id, description = row_value(trade, "series", "id"), row_value(trade, "desc")
        if not re.fullmatch(r"\d+", series_id):
            continue
        rows.append({**common, "record_type": "trade", "series_id": series_id,
                     "description": description, "b_f_qty": row_value(trade, "b/f", "qty"),
                     "buy_qty": row_value(trade, "buy", "qty"), "sell_qty": row_value(trade, "sell", "qty"),
                     "exerc": row_value(trade, "exerc"), "assgn": row_value(trade, "assgn"),
                     "out_qty": row_value(trade, "out", "qty"), "close_out": row_value(trade, "close", "out"),
                     "mtm_premium": row_value(trade, "mtm", "premium")})
    for name, value in charges.items():
        rows.append({**common, "record_type": "charge", "charge_name": name, "amount": f"{value:.2f}"})
    rows.append({**common, "record_type": "daily_total", "gross_profit_loss": f"{gross:.2f}",
                 "net_profit_loss": f"{net:.2f}", "total_charges": f"{total_charges:.2f}",
                 "trade_count": str(sum(r.get("record_type") == "trade" for r in rows)),
                 "reconciliation_status": "matched" if round(gross - total_charges, 2) == net else "review"})
    return [{field: str(row.get(field, "")) for field in FIELDNAMES} for row in rows]


def config() -> tuple[str, str, str, str, str, list[str], int]:
    load_dotenv(ROOT / "Credentials" / ".env")
    client = os.getenv("JOBBER_CLIENT", "SALONI RISHABH HURKAT~A00184")
    if "~" not in client:
        raise RuntimeError("JOBBER_CLIENT must be NAME~CLIENT_CODE")
    name, code = client.split("~", 1)
    base = os.getenv("JOBBER_BASE_URL", "https://jobber.matalia.co.in").rstrip("/")
    username, password = os.getenv("JOBBER_USERNAME", "A00184").strip(), os.getenv("JOBBER_PASSWORD", "").strip()
    if not username or not password:
        raise RuntimeError("Set JOBBER_USERNAME and JOBBER_PASSWORD in .env")
    try:
        workers = max(1, min(int(os.getenv("JOBBER_FETCH_WORKERS", "3")), 8))
    except ValueError:
        workers = 3
    configured_exchanges = os.getenv("JOBBER_EXCHANGES", "").strip()
    exchanges = [item.strip() for item in configured_exchanges.split(",") if item.strip()]
    if not exchanges:
        primary = os.getenv("JOBBER_EXCHANGE", "BNF").strip() or "BNF"
        secondary = os.getenv("JOBBER_BSE_EXCHANGE", "BSE").strip() or "BSE"
        exchanges = [primary, secondary]
    return base, username, password, name, code, list(dict.fromkeys(exchanges)), workers


def open_authenticated_page(playwright, base: str, username: str, password: str):
    """Use a hidden browser; show only a saved CAPTCHA image for manual entry."""
    profile = ROOT / "Other Logs" / "JobberBrowserProfile"
    captcha_path = ROOT / "Other Logs" / "jobber_captcha.png"
    browser_root = Path(os.getenv("LOCALAPPDATA", "")) / "ms-playwright"
    installed = sorted(browser_root.rglob("chrome.exe"), key=lambda p: p.stat().st_mtime, reverse=True) if browser_root.exists() else []
    launch_options = {"headless": True, "accept_downloads": False, "viewport": {"width": 1280, "height": 900}}
    if installed:
        launch_options["executable_path"] = str(installed[0])
    context = playwright.chromium.launch_persistent_context(
        str(profile), **launch_options,
    )
    page = context.pages[0] if context.pages else context.new_page()
    page.goto(base + "/Tplus/", wait_until="domcontentloaded")
    login_box = page.locator("#txtlogin")
    if login_box.count() and login_box.is_visible():
        page.locator("#txtlogin").fill(username)
        page.locator("#txtpwd").fill(password)
        captcha_image = page.locator("#imgCaptcha")
        captcha_image.screenshot(path=str(captcha_path))
        print(f"\nCAPTCHA image saved to: {captcha_path}")
        try:
            os.startfile(str(captcha_path))
        except AttributeError:
            pass
        captcha = input("Enter CAPTCHA: ").strip()
        page.locator("#txtCaptcha").fill(captcha)
        page.locator("#btnLogin").click()
        page.wait_for_timeout(1200)
    otp = page.locator("#txtOTP2FA")
    if otp.count() and otp.is_visible():
        print("A 2FA code is required in the Jobber browser window.")
        otp.fill(input("Enter 2FA code: ").strip())
        page.locator("#btnContinue").click()
        page.wait_for_timeout(1200)
    if "Dashboard" not in page.url and "DashBoard" not in page.url:
        raise RuntimeError(f"Login did not complete. Current page: {page.url}")
    return context, page


def download_reports(page, base: str, days: list[date], client: str, code: str, exchanges: list[str], workers: int) -> list[dict[str, str]]:
    tasks = []
    for day in days:
        for segment in exchanges:
            value = day.strftime("%d/%m/%Y")
            tasks.append({
                "day": day.isoformat(), "segment": segment,
                "payload": {"Code": code, "CName": client, "cmbSelect": "CL", "FromDt": value, "ToDt": value,
                            "cmbExchSeg": segment, "openopt": "ClosingPremium", "ChkAvgRate": "0",
                            "ChkBuySellValue": "0", "chkconsider": "0"},
            })
    def report_progress(message) -> None:
        if message.type == "log" and message.args:
            try:
                text = message.args[0].json_value()
            except PlaywrightError:
                return
            if isinstance(text, str) and text.startswith("REPORT_PROGRESS|"):
                print(text, flush=True)

    page.on("console", report_progress)
    try:
        return page.evaluate(
        """async ({endpoint, tasks, workerCount}) => {
            const results = new Array(tasks.length);
            let next = 0;
            async function worker() {
                while (true) {
                    const index = next++;
                    if (index >= tasks.length) return;
                    const item = tasks[index];
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
                        body: new URLSearchParams(item.payload)
                    });
                    if (!response.ok) throw new Error(`Report request failed for ${item.day}: ${response.status}`);
                    results[index] = {day: item.day, segment: item.segment, html: await response.text()};
                    console.log(`REPORT_PROGRESS|${item.segment}|${item.day}|${index + 1}|${tasks.length}`);
                }
            }
            await Promise.all(Array.from({length: Math.min(workerCount, tasks.length)}, worker));
            return results;
        }""",
            {"endpoint": base + REPORT_PATH, "tasks": tasks, "workerCount": workers},
        )
    finally:
        page.remove_listener("console", report_progress)


def overlap_action(overlap: list[date]) -> str:
    if not overlap:
        return "refetch"
    print("Existing data found for: " + ", ".join(d.strftime("%d-%m-%Y") for d in overlap))
    forced = os.getenv("JOBBER_EXISTING_ACTION", "").strip().lower()
    answer = forced or input("Use existing (U), refetch/overwrite (R), or cancel (C)? ").strip().lower()
    if answer.startswith("c"):
        return "cancel"
    return "use" if answer.startswith("u") else "refetch"


def run() -> int:
    try:
        base, username, password, client, code, exchanges, workers = config()
        start, end = parse_date(input("From date (DD-MM-YYYY): ")), parse_date(input("To date (DD-MM-YYYY): "))
        requested = dates_between(start, end)
        stored_dates = existing_dates()
        action = overlap_action([d for d in requested if d in stored_dates])
        if action == "cancel":
            return 0
        fetch_dates = [
            d for d in requested
            if action == "refetch" or d not in stored_dates
        ]
        if not fetch_dates:
            print("All requested dates are already stored; no fetch performed.")
            return 0
        run_id, fetched = uuid.uuid4().hex[:12], []
        with sync_playwright() as playwright:
            context, page = open_authenticated_page(playwright, base, username, password)
            try:
                started = datetime.now()
                total_requests = len(fetch_dates) * len(exchanges)
                downloaded = []
                for exchange_index, exchange in enumerate(exchanges):
                    print(f"Downloading {exchange} reports ({exchange_index + 1}/{len(exchanges)}) for {len(fetch_dates)} day(s) with {min(workers, len(fetch_dates))} worker(s)...", flush=True)
                    exchange_downloads = download_reports(page, base, fetch_dates, client, code, [exchange], workers)
                    downloaded.extend(exchange_downloads)
                    print(f"Downloaded {len(exchange_downloads)}/{len(fetch_dates)} {exchange} report(s).", flush=True)
                print(f"Downloaded {len(downloaded)}/{total_requests} report(s). Processing all reports...", flush=True)
                fetched_at = datetime.now().isoformat(timespec="seconds")
                for item in downloaded:
                    fetched.extend(parse_report(item["html"], date.fromisoformat(item["day"]), client, code, item["segment"], fetched_at, run_id))
                elapsed = (datetime.now() - started).total_seconds()
                print(f"  Download and processing elapsed: {elapsed:.2f}s", flush=True)
            finally:
                context.close()
        daily_by_date: dict[str, dict[str, object]] = {}
        for row in fetched:
            if row.get("record_type") != "daily_total":
                continue
            report_date = row["report_date"]
            target = daily_by_date.setdefault(report_date, {
                "report_date": report_date, "gross_profit_loss": 0.0, "net_profit_loss": 0.0,
                "total_charges": 0.0, "nse_charges": 0.0, "bse_charges": 0.0,
                "trade_count": 0, "reconciliation_status": "matched", "nse_fetched": False,
                "bse_fetched": False, "fetched_at": row["fetched_at"],
            })
            target["gross_profit_loss"] += money(row.get("gross_profit_loss"))
            target["net_profit_loss"] += money(row.get("net_profit_loss"))
            target["total_charges"] += money(row.get("total_charges"))
            target["trade_count"] += int(float(row.get("trade_count") or 0))
            target["nse_charges" if row.get("exchange_segment") == "BNF" else "bse_charges"] += money(row.get("total_charges"))
            target["nse_fetched" if row.get("exchange_segment") == "BNF" else "bse_fetched"] = True
        for target in daily_by_date.values():
            target["nse_fetched"] = "BNF" in exchanges
            target["bse_fetched"] = "BSE" in exchanges
        upsert_daily_rows(list(daily_by_date.values()))
        total = sum(float(row["total_charges"]) for row in daily_by_date.values())
        print(f"Upserted {len(daily_by_date)} daily charge rows to Supabase; total charges: {total:.2f}")
        return 0
    except (RuntimeError, ValueError, ImportError, PlaywrightError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

TABLE = 'matalia."jobber_daily_charges"'


def ensure_table(conn: Any) -> None:
    conn.execute(
        f'''
        CREATE TABLE IF NOT EXISTS {TABLE} (
            report_date date PRIMARY KEY,
            gross_profit_loss numeric(18, 2) NOT NULL DEFAULT 0,
            net_profit_loss numeric(18, 2) NOT NULL DEFAULT 0,
            total_charges numeric(18, 2) NOT NULL DEFAULT 0,
            nse_charges numeric(18, 2) NOT NULL DEFAULT 0,
            bse_charges numeric(18, 2) NOT NULL DEFAULT 0,
            trade_count integer NOT NULL DEFAULT 0,
            reconciliation_status text NOT NULL DEFAULT 'matched',
            nse_fetched boolean NOT NULL DEFAULT false,
            bse_fetched boolean NOT NULL DEFAULT false,
            fetched_at timestamptz NOT NULL DEFAULT now()
        )
        '''
    )
    conn.execute(f'ALTER TABLE {TABLE} ADD COLUMN IF NOT EXISTS nse_fetched boolean NOT NULL DEFAULT false')
    conn.execute(f'ALTER TABLE {TABLE} ADD COLUMN IF NOT EXISTS bse_fetched boolean NOT NULL DEFAULT false')


def load_daily_rows() -> list[dict[str, Any]]:
    with connect() as conn:
        ensure_table(conn)
        cursor = conn.execute(
            f'''
            SELECT report_date, gross_profit_loss, net_profit_loss, total_charges,
                   nse_charges, bse_charges, trade_count, reconciliation_status, nse_fetched, bse_fetched, fetched_at
            FROM {TABLE}
            ORDER BY report_date
            '''
        )
        columns = [column.name for column in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]


def existing_dates() -> set[date]:
    return {date.fromisoformat(str(row["report_date"])) for row in load_daily_rows() if row.get("nse_fetched") and row.get("bse_fetched")}


def upsert_daily_rows(rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    with connect() as conn:
        ensure_table(conn)
        with conn.cursor() as cursor:
            cursor.executemany(
            f'''
            INSERT INTO {TABLE}
              (report_date, gross_profit_loss, net_profit_loss, total_charges,
               nse_charges, bse_charges, trade_count, reconciliation_status, nse_fetched, bse_fetched, fetched_at)
            VALUES (%(report_date)s, %(gross_profit_loss)s, %(net_profit_loss)s, %(total_charges)s,
                    %(nse_charges)s, %(bse_charges)s, %(trade_count)s, %(reconciliation_status)s,
                    %(nse_fetched)s, %(bse_fetched)s, %(fetched_at)s)
            ON CONFLICT (report_date) DO UPDATE SET
              gross_profit_loss = EXCLUDED.gross_profit_loss,
              net_profit_loss = EXCLUDED.net_profit_loss,
              total_charges = EXCLUDED.total_charges,
              nse_charges = EXCLUDED.nse_charges,
              bse_charges = EXCLUDED.bse_charges,
              trade_count = EXCLUDED.trade_count,
              reconciliation_status = EXCLUDED.reconciliation_status,
              nse_fetched = EXCLUDED.nse_fetched,
              bse_fetched = EXCLUDED.bse_fetched,
              fetched_at = EXCLUDED.fetched_at
            ''',
                rows,
            )


def _existing_dates_in_range(from_date: str, to_date: str) -> list[str]:
    dates = sorted(value.isoformat() for value in existing_dates())
    return [value for value in dates if from_date <= value <= to_date]


@router.get("/api/matalia-charges")
def matalia_charges(from_date: str | None = None, to_date: str | None = None) -> JSONResponse:
    """Read combined daily charges directly from Supabase."""
    try:
        daily_rows = []
        for row in load_daily_rows():
            report_date = str(row["report_date"])
            if (from_date and report_date < from_date) or (to_date and report_date > to_date):
                continue
            daily_rows.append({
                "report_date": report_date,
                "nse_charges": f"{float(row.get('nse_charges') or 0):.2f}",
                "bse_charges": f"{float(row.get('bse_charges') or 0):.2f}",
                "total_charges": f"{float(row.get('total_charges') or 0):.2f}",
                "reconciliation_status": row.get("reconciliation_status") or "matched",
                "fetched_at": row.get("fetched_at").isoformat() if hasattr(row.get("fetched_at"), "isoformat") else str(row.get("fetched_at") or ""),
            })
        total_charges = round(sum(float(row["total_charges"]) for row in daily_rows), 2)
        return JSONResponse(status_code=200, content={
            "success": True, "daily": daily_rows, "trades": [], "charges": [],
            "total_charges": total_charges, "total_trades": 0,
            "total_days": len(daily_rows),
            "last_fetched_at": max((row["fetched_at"] for row in daily_rows), default=None),
        })
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "message": f"Unable to load Matalia charges: {error}"})


@router.get("/api/matalia-charges/next-date")
def matalia_next_charge_date() -> JSONResponse:
    rows = load_daily_rows()
    today = date.today()
    next_date = max((row["report_date"] for row in rows), default=None)
    if next_date:
        next_date = date.fromisoformat(str(next_date)) + timedelta(days=1)
    else:
        next_date = today
    return JSONResponse(status_code=200, content={
        "success": True, "next_date": next_date.isoformat(), "today": today.isoformat(),
    })


def _watch_fetch_process(process: Any) -> None:
    global JOBBER_FETCH_PROCESS
    try:
        assert process.stdout is not None
        for line in process.stdout:
            message = line.strip()
            if not message:
                continue
            with JOBBER_FETCH_LOCK:
                JOBBER_FETCH_STATE["log"].append(message)
                JOBBER_FETCH_STATE["message"] = message
                if "CAPTCHA image saved to:" in message:
                    JOBBER_FETCH_STATE["status"] = "waiting_captcha"
                    JOBBER_FETCH_STATE["message"] = "CAPTCHA is ready. Enter the text shown below."
                elif message.startswith("ERROR:"):
                    JOBBER_FETCH_STATE["status"] = "error"
                    JOBBER_FETCH_STATE["error"] = message
    finally:
        return_code = process.wait()
        JOBBER_CAPTCHA.unlink(missing_ok=True)
        with JOBBER_FETCH_LOCK:
            if JOBBER_FETCH_STATE["status"] not in {"error", "cancelled"}:
                JOBBER_FETCH_STATE["status"] = "completed" if return_code == 0 else "error"
            JOBBER_FETCH_STATE["finished_at"] = datetime.now().isoformat(timespec="seconds")
            if return_code != 0 and not JOBBER_FETCH_STATE.get("error"):
                JOBBER_FETCH_STATE["error"] = f"Pipeline exited with code {return_code}."
            JOBBER_FETCH_PROCESS = None


@router.post("/api/matalia-charges/fetch/start")
def start_matalia_fetch(payload: MataliaFetchRequest) -> JSONResponse:
    global JOBBER_FETCH_PROCESS
    try:
        start = datetime.strptime(payload.from_date, "%Y-%m-%d")
        end = datetime.strptime(payload.to_date, "%Y-%m-%d")
        if end < start:
            raise ValueError("The end date must not be before the start date.")
        overlap = _existing_dates_in_range(payload.from_date, payload.to_date)
        action = (payload.existing_action or "").strip().lower()
        if overlap and action not in {"use", "refetch"}:
            return JSONResponse(status_code=200, content={"success": True, "requires_choice": True, "existing_dates": overlap})
        with JOBBER_FETCH_LOCK:
            if JOBBER_FETCH_PROCESS is not None and JOBBER_FETCH_PROCESS.poll() is None:
                return JSONResponse(status_code=409, content={"success": False, "message": "A Matalia report fetch is already running."})
            env = os.environ.copy()
            env["JOBBER_EXISTING_ACTION"] = action or "refetch"
            if not env.get("JOBBER_USERNAME"):
                env["JOBBER_USERNAME"] = "A00184"
            if not env.get("JOBBER_PASSWORD"):
                return JSONResponse(status_code=400, content={"success": False, "message": "Set JOBBER_PASSWORD in .env before fetching from the UI."})
            JOBBER_CAPTCHA.unlink(missing_ok=True)
            process = subprocess.Popen(
                [sys.executable, str(JOBBER_PIPELINE)], cwd=str(ROOT), env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1,
            )
            JOBBER_FETCH_PROCESS = process
            JOBBER_FETCH_STATE.update({
                "status": "running", "message": "Starting Matalia report fetch…", "log": [],
                "error": None, "started_at": datetime.now().isoformat(timespec="seconds"), "finished_at": None,
            })
            assert process.stdin is not None
            process.stdin.write(f"{start.strftime('%d-%m-%Y')}\n")
            process.stdin.write(f"{end.strftime('%d-%m-%Y')}\n")
            process.stdin.flush()
            threading.Thread(target=_watch_fetch_process, args=(process,), daemon=True).start()
        return JSONResponse(status_code=200, content={"success": True, "requires_choice": False, "status": "running"})
    except Exception as error:
        return JSONResponse(status_code=400, content={"success": False, "message": f"Unable to start Matalia fetch: {error}"})


@router.get("/api/matalia-charges/fetch/status")
def matalia_fetch_status() -> JSONResponse:
    with JOBBER_FETCH_LOCK:
        return JSONResponse(status_code=200, content={"success": True, **JOBBER_FETCH_STATE, "captcha_available": JOBBER_CAPTCHA.exists()})


@router.get("/api/matalia-charges/fetch/captcha")
def matalia_fetch_captcha() -> FileResponse:
    if not JOBBER_CAPTCHA.exists():
        return FileResponse(str(JOBBER_CAPTCHA), status_code=404)
    return FileResponse(str(JOBBER_CAPTCHA), media_type="image/png")


@router.post("/api/matalia-charges/fetch/captcha")
def submit_matalia_captcha(payload: MataliaCaptchaRequest) -> JSONResponse:
    with JOBBER_FETCH_LOCK:
        if JOBBER_FETCH_PROCESS is None or JOBBER_FETCH_PROCESS.poll() is not None:
            return JSONResponse(status_code=409, content={"success": False, "message": "No Matalia fetch is waiting for CAPTCHA."})
        if not payload.captcha.strip():
            return JSONResponse(status_code=400, content={"success": False, "message": "Enter the CAPTCHA text."})
        assert JOBBER_FETCH_PROCESS.stdin is not None
        JOBBER_FETCH_PROCESS.stdin.write(payload.captcha.strip() + "\n")
        JOBBER_FETCH_PROCESS.stdin.flush()
        JOBBER_FETCH_STATE["status"] = "running"
        JOBBER_FETCH_STATE["message"] = "CAPTCHA submitted; fetching daily reports…"
    return JSONResponse(status_code=200, content={"success": True})


@router.post("/api/matalia-charges/fetch/cancel")
def cancel_matalia_fetch() -> JSONResponse:
    global JOBBER_FETCH_PROCESS
    with JOBBER_FETCH_LOCK:
        process = JOBBER_FETCH_PROCESS
        if process is None or process.poll() is not None:
            JOBBER_FETCH_STATE.update({"status": "cancelled", "message": "Fetch cancelled."})
            JOBBER_CAPTCHA.unlink(missing_ok=True)
            return JSONResponse(status_code=200, content={"success": True, "message": "No active fetch."})
        process.terminate()
        JOBBER_FETCH_STATE.update({"status": "cancelled", "message": "Fetch cancelled."})
        JOBBER_CAPTCHA.unlink(missing_ok=True)
    return JSONResponse(status_code=200, content={"success": True, "message": "Fetch cancelled."})


if __name__ == "__main__":
    raise SystemExit(run())
