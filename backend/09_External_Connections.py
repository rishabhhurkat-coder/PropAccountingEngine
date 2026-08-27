"""Unified Supabase, GCS, and Zerodha connectivity for Matalia."""

from __future__ import annotations

import csv
import io
import json
import os
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS_DIR = PROJECT_ROOT / "backend"

_STREAM_LOCK = threading.RLock()
_STREAM: "ZerodhaMarketStream | None" = None
LIVE_PRICE_CACHE_TTL_SECONDS = 60
_DB_POOL: Any = None
_INSTRUMENT_LOCK = threading.RLock()
_INSTRUMENT_INDEX: dict[tuple[str, str, str, str], dict[str, str]] | None = None
_INSTRUMENT_ROWS_CACHE: list[dict[str, str]] = []
_INSTRUMENT_FILE_MTIME: float | None = None
_TOKEN_SOURCE: str | None = None
_TOKEN_LOAD_ERROR: str | None = None

INSTRUMENT_TABLE = 'public."ZerodhaInstrument.csv"'
INSTRUMENT_COLUMNS = (
    "exchange",
    "exchange_token",
    "expiry",
    "instrument_token",
    "instrument_type",
    "last_price",
    "lot_size",
    "name",
    "segment",
    "strike",
    "tick_size",
    "tradingsymbol",
)


def _path(value: str | Path) -> Path:
    result = Path(value).expanduser()
    return result if result.is_absolute() else CREDENTIALS_DIR / result


def _env_or_config(name: str, fallback: Any) -> Any:
    """Use an environment override only when it contains a real value."""
    value = os.getenv(name)
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def _set_env_value(name: str, value: str) -> None:
    # Hosted services receive secrets from their runtime secret store.  Keep a
    # refreshed Zerodha token in memory and in GCS; never create a plaintext
    # credentials file on a server unless a local desktop operator opted in.
    os.environ[name] = value
    if os.getenv("PERSIST_LOCAL_CONFIG", "false").lower() != "true":
        return
    env_path = PROJECT_ROOT / "backend" / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    replacement = f"{name}={value}"
    for index, line in enumerate(lines):
        if line.startswith(f"{name}="):
            lines[index] = replacement
            break
    else:
        lines.append(replacement)
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def connect_supabase():
    return _connect_postgres()


def _connect_postgres():
    global _DB_POOL
    if _DB_POOL is None:
        from psycopg_pool import ConnectionPool

        _DB_POOL = ConnectionPool(
            kwargs={
                "host": os.environ["SUPABASE_HOST"],
                "port": int(os.getenv("SUPABASE_PORT", "5432")),
                "dbname": os.environ["SUPABASE_DATABASE"],
                "user": os.environ["SUPABASE_USER"],
                "password": os.environ["SUPABASE_PASSWORD"],
                "sslmode": os.getenv("SUPABASE_SSLMODE", "require"),
                "connect_timeout": 10,
            },
            min_size=1,
            max_size=6,
            timeout=10,
            max_idle=300,
            open=True,
        )
    return _DB_POOL.connection()


def connect_gcs():
    from google.cloud import storage
    from google.oauth2 import service_account

    configured_json = os.getenv("GCS_SERVICE_ACCOUNT_JSON", "").strip()
    if len(configured_json) >= 2 and configured_json[0] == configured_json[-1] and configured_json[0] in "'\"":
        configured_json = configured_json[1:-1]
    if not configured_json.startswith("{"):
        raise RuntimeError("GCS_SERVICE_ACCOUNT_JSON must contain inline service-account JSON")
    inline_credentials = json.loads(configured_json)
    credentials = service_account.Credentials.from_service_account_info(inline_credentials)
    client = storage.Client(project=inline_credentials.get("project_id"), credentials=credentials)
    bucket_name = os.environ["GCS_BUCKET_NAME"]
    return client, client.bucket(bucket_name)


def _zerodha_config() -> dict[str, Any]:
    return {
        "api_key": os.environ["ZERODHA_API_KEY"],
        "api_secret": os.environ["ZERODHA_API_SECRET"],
        "access_token": os.getenv("ZERODHA_ACCESS_TOKEN", "").strip(),
        "instruments_path": _path(os.getenv("ZERODHA_INSTRUMENTS_FILE", "instruments.csv")),
        "gcs_config_path": os.getenv("ZERODHA_GCS_CONFIG_PATH", os.getenv("GCS_CONFIG_PATH", "config")),
        "auto_validate": os.getenv("ZERODHA_AUTO_VALIDATE", "true").lower() == "true",
        "browser_login": os.getenv("ZERODHA_BROWSER_LOGIN", "true").lower() == "true",
        "timeout": int(os.getenv("ZERODHA_TIMEOUT", "30")),
        "max_retry": int(os.getenv("ZERODHA_MAX_RETRY", "3")),
        "websocket_mode": os.getenv("ZERODHA_WEBSOCKET_MODE", "auto"),
    }


def _load_gcs_access_token(config: dict[str, Any]) -> str | None:
    global _TOKEN_SOURCE, _TOKEN_LOAD_ERROR
    try:
        _, bucket = connect_gcs()
        prefix = str(config.get("gcs_config_path", "config")).strip("/") or "config"
        data = json.loads(bucket.blob(f"{prefix}/token.json").download_as_text())
        access_token = str(data.get("access_token") or "").strip()
        if access_token:
            _set_env_value("ZERODHA_ACCESS_TOKEN", access_token)
            _TOKEN_SOURCE = f"GCS {prefix}/token.json"
            _TOKEN_LOAD_ERROR = None
            return access_token
        _TOKEN_LOAD_ERROR = f"GCS {prefix}/token.json does not contain an access_token"
    except Exception as error:
        _TOKEN_LOAD_ERROR = f"Could not read Zerodha token from GCS: {type(error).__name__}"
    _TOKEN_SOURCE = None
    return None


def _load_access_token(config: dict[str, Any]) -> str | None:
    # GCS is the authoritative source when configured. This lets Render pick
    # up a newly rotated daily Zerodha token even if an older environment
    # value is still present.
    gcs_json = os.getenv("GCS_SERVICE_ACCOUNT_JSON", "").strip().strip("'\"")
    gcs_configured = bool(os.getenv("GCS_BUCKET_NAME", "").strip()) and gcs_json.startswith("{")
    if gcs_configured:
        # Once GCS is configured, it is the authoritative source. Do not
        # silently revive a stale Render environment token after a restart.
        return _load_gcs_access_token(config)
    if config.get("access_token"):
        global _TOKEN_SOURCE, _TOKEN_LOAD_ERROR
        _TOKEN_SOURCE = "Render environment"
        _TOKEN_LOAD_ERROR = None
        return str(config["access_token"])
    return _load_gcs_access_token(config)


def create_kite():
    from kiteconnect import KiteConnect

    config = _zerodha_config()
    access_token = _load_access_token(config)
    if not access_token:
        raise RuntimeError(_TOKEN_LOAD_ERROR or "Zerodha access token is missing from Render and GCS")
    kite = KiteConnect(api_key=_env_or_config("ZERODHA_API_KEY", config["api_key"]))
    kite.set_access_token(access_token)
    return kite


def zerodha_login_url() -> str:
    from kiteconnect import KiteConnect

    config = _zerodha_config()
    return KiteConnect(api_key=_env_or_config("ZERODHA_API_KEY", config["api_key"])).login_url()


def _gcs_token_blob(config: dict[str, Any]):
    _, bucket = connect_gcs()
    prefix = str(config.get("gcs_config_path", "config")).strip("/") or "config"
    return bucket.blob(f"{prefix}/token.json")


def _read_gcs_access_token_data(config: dict[str, Any]) -> dict[str, Any] | None:
    blob = _gcs_token_blob(config)
    if not blob.exists():
        return None
    data = json.loads(blob.download_as_text())
    if not isinstance(data, dict):
        raise RuntimeError("GCS Zerodha token data is not a JSON object")
    return data


def _save_gcs_access_token(config: dict[str, Any], token_data: dict[str, str]) -> None:
    _gcs_token_blob(config).upload_from_string(
        json.dumps(token_data),
        content_type="application/json",
    )


def _gcs_instruments_blob(config: dict[str, Any]):
    _, bucket = connect_gcs()
    prefix = str(config.get("gcs_config_path", "config")).strip("/") or "config"
    return bucket.blob(f"{prefix}/instruments.csv")


def _upload_instruments_to_gcs(config: dict[str, Any], instruments_path: Path) -> None:
    blob = _gcs_instruments_blob(config)
    blob.upload_from_filename(str(instruments_path), content_type="text/csv")
    blob.reload()
    if blob.size != instruments_path.stat().st_size:
        raise RuntimeError("GCS instruments.csv upload size verification failed")


def _replace_supabase_instruments(instruments_path: Path) -> int:
    """Replace the instrument table atomically from a validated CSV file."""
    copy_columns = ", ".join(INSTRUMENT_COLUMNS)
    copy_sql = (
        f"COPY zerodha_instrument_stage ({copy_columns}) "
        "FROM STDIN WITH (FORMAT CSV, NULL '')"
    )
    insert_columns = copy_columns + ", updated_at"
    select_columns = copy_columns + ", now()"

    with connect_supabase() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                f"CREATE TEMP TABLE zerodha_instrument_stage "
                f"(LIKE {INSTRUMENT_TABLE} INCLUDING DEFAULTS) ON COMMIT DROP"
            )
            with instruments_path.open("r", newline="", encoding="utf-8") as source:
                reader = csv.DictReader(source)
                headers = {str(header).strip() for header in (reader.fieldnames or [])}
                missing = [column for column in INSTRUMENT_COLUMNS if column not in headers]
                if missing:
                    raise RuntimeError(
                        f"Zerodha instruments file is missing columns: {', '.join(missing)}"
                    )

                with cursor.copy(copy_sql) as copy:
                    buffer = io.StringIO()
                    writer = csv.writer(buffer, lineterminator="\n")
                    for index, row in enumerate(reader, start=1):
                        writer.writerow([row.get(column, "") or "" for column in INSTRUMENT_COLUMNS])
                        if index % 2000 == 0:
                            copy.write(buffer.getvalue().encode("utf-8"))
                            buffer.seek(0)
                            buffer.truncate(0)
                    if buffer.tell():
                        copy.write(buffer.getvalue().encode("utf-8"))

            cursor.execute("SELECT COUNT(*) FROM zerodha_instrument_stage")
            row_count = int(cursor.fetchone()[0])
            if row_count == 0:
                raise RuntimeError("Zerodha returned an empty instruments file")

            cursor.execute(
                """
                SELECT instrument_token
                FROM zerodha_instrument_stage
                GROUP BY instrument_token
                HAVING COUNT(*) > 1
                LIMIT 1
                """
            )
            duplicate = cursor.fetchone()
            if duplicate is not None:
                raise RuntimeError(
                    f"Duplicate Zerodha instrument_token in instruments file: {duplicate[0]}"
                )

            cursor.execute(f"DELETE FROM {INSTRUMENT_TABLE}")
            cursor.execute(
                f"INSERT INTO {INSTRUMENT_TABLE} ({insert_columns}) "
                f"SELECT {select_columns} FROM zerodha_instrument_stage"
            )
            cursor.execute(f"SELECT COUNT(*) FROM {INSTRUMENT_TABLE}")
            published_count = int(cursor.fetchone()[0])
            if published_count != row_count:
                raise RuntimeError(
                    f"Supabase instrument verification failed: staged {row_count}, published {published_count}"
                )
    return row_count


def sync_instruments() -> dict[str, Any]:
    """Download, archive, and atomically publish the current Zerodha catalogue."""
    config = _zerodha_config()
    instruments_path = download_instruments(force=True)
    _upload_instruments_to_gcs(config, instruments_path)
    row_count = _replace_supabase_instruments(instruments_path)
    return {
        "path": str(instruments_path),
        "gcs_object": f"{str(config.get('gcs_config_path', 'config')).strip('/') or 'config'}/instruments.csv",
        "row_count": row_count,
        "filtered": False,
    }


def _validate_zerodha_access_token(api_key: str, access_token: str) -> dict[str, Any]:
    """Verify a candidate token without changing the process or GCS token."""
    from kiteconnect import KiteConnect

    kite = KiteConnect(api_key=api_key)
    kite.set_access_token(access_token)
    return kite.profile()


def complete_zerodha_token(redirect_url: str) -> dict[str, Any]:
    request_token = parse_qs(urlparse(redirect_url).query).get("request_token", [None])[0]
    if not request_token:
        raise RuntimeError("The redirected Zerodha URL does not contain request_token")
    from kiteconnect import KiteConnect

    config = _zerodha_config()
    api_key = _env_or_config("ZERODHA_API_KEY", config["api_key"])
    api_secret = _env_or_config("ZERODHA_API_SECRET", config["api_secret"])
    session = KiteConnect(api_key=api_key).generate_session(request_token, api_secret=api_secret)
    new_access_token = str(session.get("access_token") or "").strip()
    if not new_access_token:
        raise RuntimeError("Zerodha did not return an access token")

    # Verify the candidate before touching the durable or process token.
    candidate_profile = _validate_zerodha_access_token(api_key, new_access_token)
    token_data = {"access_token": new_access_token, "login_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

    previous_token_data = _read_gcs_access_token_data(config)
    persisted = False
    try:
        # GCS is the durable source of truth on Render. Only update the
        # process token after durable persistence succeeds.
        _save_gcs_access_token(config, token_data)
        persisted = True
        _set_env_value("ZERODHA_ACCESS_TOKEN", new_access_token)

        # Reload from GCS and verify the exact persisted token, not merely the
        # in-memory candidate, before reporting a successful connection.
        reloaded_token = _load_access_token(config)
        if reloaded_token != new_access_token:
            raise RuntimeError("Persisted Zerodha token could not be reloaded from GCS")
        verification = validate_zerodha()
        if not verification.get("connected"):
            raise RuntimeError("Zerodha token was saved but final verification failed")
        return {
            "connected": True,
            "user": verification.get("user") or candidate_profile.get("user_id"),
            "message": "Zerodha connected; instrument synchronization queued",
        }
    except Exception:
        # Preserve the previously working token if the durable write or the
        # post-persistence verification fails. Never expose token contents.
        if persisted and previous_token_data is not None:
            try:
                _save_gcs_access_token(config, {str(key): str(value) for key, value in previous_token_data.items()})
                previous_access_token = str(previous_token_data.get("access_token") or "").strip()
                if previous_access_token:
                    _set_env_value("ZERODHA_ACCESS_TOKEN", previous_access_token)
            except Exception:
                pass
        raise


def validate_zerodha() -> dict[str, Any]:
    try:
        kite = create_kite()
        profile = kite.profile()
        instruments_path = _zerodha_config()["instruments_path"]
        return {
            "connected": True,
            "user": profile.get("user_id"),
            "instruments_ready": instruments_path.exists(),
            "message": "Zerodha connected",
        }
    except Exception as error:
        return {"connected": False, "user": None, "message": zerodha_error_message(error), "token_source": _TOKEN_SOURCE}


def zerodha_error_message(error: Exception | str) -> str:
    text = str(error)
    if "Incorrect `api_key` or `access_token`" in text or "TokenException" in text:
        return "Zerodha rejected the API key or access token. Update the token in GCS config/token.json, then redeploy."
    if "access token" in text.lower() and ("missing" in text.lower() or "does not contain" in text.lower()):
        return f"{text}. Update the Zerodha token in GCS config/token.json, then redeploy."
    return text


def download_instruments(force: bool = False) -> Path:
    config = _zerodha_config()
    destination = config["instruments_path"]
    if destination.exists() and not force:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    instruments = create_kite().instruments()
    rows = list(instruments)
    fieldnames = sorted({key for row in rows for key in row})
    with destination.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return destination


def _normalise_expiry(value: Any) -> str:
    if isinstance(value, (date, datetime)):
        return value.strftime("%d%b%Y").upper()
    raw = str(value or "").strip().replace("-", "").replace(" ", "").upper()
    for fmt in ("%d%b%Y", "%d%b%y", "%Y%m%d"):
        try:
            parsed = datetime.strptime(raw, fmt)
            return parsed.strftime("%d%b%Y").upper()
        except ValueError:
            continue
    return raw


def _normalise_strike(value: Any) -> str:
    text = str(value or "").strip().replace(",", "")
    try:
        number = float(text)
    except (TypeError, ValueError):
        return text
    return str(int(number)) if number.is_integer() else str(number)


def _instrument_catalog() -> tuple[dict[tuple[str, str, str, str], dict[str, str]], list[dict[str, str]]]:
    """Load and index the Zerodha instruments file once per file version."""
    global _INSTRUMENT_INDEX, _INSTRUMENT_ROWS_CACHE, _INSTRUMENT_FILE_MTIME
    file = download_instruments()
    mtime = file.stat().st_mtime
    with _INSTRUMENT_LOCK:
        if _INSTRUMENT_INDEX is not None and _INSTRUMENT_FILE_MTIME == mtime:
            return _INSTRUMENT_INDEX, _INSTRUMENT_ROWS_CACHE

        rows: list[dict[str, str]] = []
        index: dict[tuple[str, str, str, str], dict[str, str]] = {}
        with file.open("r", newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                if row.get("exchange") != "NFO":
                    continue
                rows.append(row)
                symbol = str(row.get("name") or "").upper().strip()
                expiry = _normalise_expiry(row.get("expiry"))
                strike = _normalise_strike(row.get("strike"))
                option = str(row.get("instrument_type") or "").upper().strip()
                if symbol and expiry and strike and option:
                    index.setdefault((symbol, expiry, strike, option), row)
        _INSTRUMENT_INDEX = index
        _INSTRUMENT_ROWS_CACHE = rows
        _INSTRUMENT_FILE_MTIME = mtime
        return index, rows


def resolve_instrument(position: dict[str, Any]) -> dict[str, Any] | None:
    symbol = str(position.get("scrip") or position.get("symbol") or "").upper().strip()
    expiry = _normalise_expiry(position.get("expiry"))
    strike = _normalise_strike(position.get("strike"))
    option = str(position.get("optType") or position.get("option") or "").upper().strip()
    index, rows = _instrument_catalog()
    exact = index.get((symbol, expiry, strike, option))
    if exact:
        return exact

    # Tolerant fallback for older instrument files without a `name` column.
    for row in rows:
        tradingsymbol = row.get("tradingsymbol", "").upper()
        if symbol and not tradingsymbol.startswith(symbol):
            continue
        if option and not tradingsymbol.endswith(f"{strike}{option}"):
            continue
        if expiry and _normalise_expiry(row.get("expiry")) != expiry:
            continue
        return row
    return None


def _resolve_positions(positions: list[dict[str, Any]]) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], str | None, float]:
    started = time.perf_counter()
    resolved: list[tuple[dict[str, Any], dict[str, Any]]] = []
    last_error: str | None = None
    try:
        for position in positions:
            instrument = resolve_instrument(position)
            if instrument:
                resolved.append((position, instrument))
    except Exception as error:
        last_error = f"Instrument catalogue unavailable: {error}"
    if positions and not resolved and not last_error:
        last_error = "No Zerodha instruments matched the open-position symbols, expiries, strikes, and options."
    return resolved, last_error, round((time.perf_counter() - started) * 1000, 1)


def refresh_prices(positions: list[dict[str, Any]], *, prefer_stream: bool = True) -> dict[str, Any]:
    started = time.perf_counter()
    if prefer_stream:
        prepared = prepare_live_prices(positions)
        quote_resolved = None
    else:
        resolved, resolve_error, resolve_ms = _resolve_positions(positions)
        stream = get_market_stream()
        mapping = {
            str(position.get("id") or f"{instrument['exchange']}:{instrument['tradingsymbol']}"): int(instrument["instrument_token"])
            for position, instrument in resolved
        }
        stream.set_position_tokens(mapping)
        prepared = {
            "prices": {},
            "price_age_seconds": {},
            "connected": False,
            "last_error": resolve_error,
            "mapped": len(resolved),
            "timings": {"resolve_ms": resolve_ms},
        }
        quote_resolved = resolved

    prices = dict(prepared["prices"])
    last_error = prepared.get("last_error")
    stale_positions = [
        position for position in positions
        if str(position.get("id") or "") not in prices
        or prepared["price_age_seconds"].get(str(position.get("id") or ""), float("inf")) > LIVE_PRICE_CACHE_TTL_SECONDS
    ]

    if stale_positions and prepared.get("mapped"):
        try:
            kite = create_kite()
            if quote_resolved is None:
                quote_resolved = [(position, resolve_instrument(position)) for position in stale_positions]
                quote_resolved = [(position, instrument) for position, instrument in quote_resolved if instrument]
            else:
                stale_ids = {str(position.get("id") or "") for position in stale_positions}
                quote_resolved = [
                    (position, instrument)
                    for position, instrument in quote_resolved
                    if str(position.get("id") or "") in stale_ids
                ]
            quotes = kite.ltp([f"{row['exchange']}:{row['tradingsymbol']}" for _, row in quote_resolved]) if quote_resolved else {}
            if quote_resolved and not quotes:
                last_error = last_error or "Zerodha returned no fresh quotes for the mapped positions."
            stream = get_market_stream()
            for position, instrument in quote_resolved:
                key = f"{instrument['exchange']}:{instrument['tradingsymbol']}"
                quote = quotes.get(key, {})
                if quote.get("last_price") is not None:
                    position_id = str(position.get("id") or key)
                    price = float(quote["last_price"])
                    prices[position_id] = price
                    stream.record_position_price(position_id, price)
        except Exception as error:
            last_error = last_error or zerodha_error_message(error)
    return {
        "prices": prices,
        "mapped": prepared["mapped"],
        "requested": len(positions),
        "last_error": last_error,
        "timings": {**prepared.get("timings", {}), "total_ms": round((time.perf_counter() - started) * 1000, 1)},
    }


def prepare_live_prices(positions: list[dict[str, Any]]) -> dict[str, Any]:
    started = time.perf_counter()
    resolved, last_error, resolve_ms = _resolve_positions(positions)

    stream = get_market_stream()
    mapping = {
        str(position.get("id") or f"{instrument['exchange']}:{instrument['tradingsymbol']}"): int(instrument["instrument_token"])
        for position, instrument in resolved
    }
    stream.set_position_tokens(mapping)
    if mapping:
        try:
            stream.subscribe(list(mapping.values()))
        except Exception as error:
            last_error = last_error or zerodha_error_message(error)
            with _STREAM_LOCK:
                stream.last_error = zerodha_error_message(error)

    snapshot = stream.snapshot()
    last_error = last_error or snapshot["last_error"]
    if mapping and not snapshot["connected"] and not last_error:
        last_error = "Live CMP feed is connecting; waiting for the first market tick."
    return {
        "prices": snapshot["prices"],
        "price_age_seconds": snapshot["price_age_seconds"],
        "connected": snapshot["connected"],
        "last_error": last_error,
        "mapped": len(resolved),
        "timings": {
            "resolve_ms": resolve_ms,
            "total_ms": round((time.perf_counter() - started) * 1000, 1),
        },
    }


class ZerodhaMarketStream:
    def __init__(self):
        self.ticker = None
        self.tokens: set[int] = set()
        self.prices: dict[int, float] = {}
        self.price_received_at: dict[int, float] = {}
        self.position_tokens: dict[str, int] = {}
        self.connected = False
        self.last_error: str | None = None
        self._start_in_progress = False
        self.connect_started_at: float | None = None

    def _on_ticks(self, _ws, ticks):
        with _STREAM_LOCK:
            for tick in ticks:
                token = tick.get("instrument_token")
                price = tick.get("last_price")
                if token is not None and price is not None:
                    self.prices[int(token)] = float(price)
                    self.price_received_at[int(token)] = time.time()

    def _on_connect(self, ws, _response):
        with _STREAM_LOCK:
            self.connected = True
            self.last_error = None
            self.connect_started_at = None
            if self.tokens:
                ws.subscribe(list(self.tokens))
                ws.set_mode(ws.MODE_LTP, list(self.tokens))

    def _on_error(self, _ws, code, reason):
        with _STREAM_LOCK:
            self.connected = False
            self.last_error = zerodha_error_message(f"Zerodha WebSocket error {code}: {reason}".strip())
            self.ticker = None
            self.connect_started_at = None

    def _on_close(self, _ws, _code, _reason):
        with _STREAM_LOCK:
            self.connected = False
            if _reason:
                self.last_error = zerodha_error_message(f"Zerodha WebSocket closed: {_reason}")
            self.ticker = None
            self.connect_started_at = None

    def start(self):
        with _STREAM_LOCK:
            if self.connected or self._start_in_progress:
                return
            if self.ticker is not None and self.connect_started_at is not None:
                if time.time() - self.connect_started_at < 20:
                    return
                self.ticker = None
            self._start_in_progress = True
        from kiteconnect import KiteTicker

        try:
            config = _zerodha_config()
            token = _load_access_token(config)
            if not token:
                raise RuntimeError("Zerodha access token is missing")
            ticker = KiteTicker(_env_or_config("ZERODHA_API_KEY", config["api_key"]), token)
            ticker.on_ticks = self._on_ticks
            ticker.on_connect = self._on_connect
            ticker.on_error = self._on_error
            ticker.on_close = self._on_close
            with _STREAM_LOCK:
                self.ticker = ticker
                self.connect_started_at = time.time()
            threading.Thread(target=self._connect_ticker, name="zerodha-market-stream", daemon=True).start()
        except Exception as error:
            with _STREAM_LOCK:
                self._start_in_progress = False
                self.ticker = None
                self.last_error = zerodha_error_message(error)
            raise

    def _connect_ticker(self):
        try:
            ticker = self.ticker
            if ticker is not None:
                # Avoid blocking the API worker during a broker handshake.
                ticker.connect(threaded=True)
        except Exception as error:
            with _STREAM_LOCK:
                self.connected = False
                self.last_error = zerodha_error_message(error)
                self.ticker = None
                self.connect_started_at = None
        finally:
            with _STREAM_LOCK:
                self._start_in_progress = False

    def subscribe(self, tokens: list[int]):
        self.start()
        with _STREAM_LOCK:
            next_tokens = set(tokens)
            added = next_tokens - self.tokens
            if self.connected and added:
                self.ticker.subscribe(list(added))
                self.ticker.set_mode(self.ticker.MODE_LTP, list(added))
            self.tokens = next_tokens

    def set_position_tokens(self, mapping: dict[str, int]):
        with _STREAM_LOCK:
            self.position_tokens = mapping

    def record_position_price(self, position_id: str, price: float) -> None:
        with _STREAM_LOCK:
            token = self.position_tokens.get(position_id)
            if token is None:
                return
            self.prices[token] = float(price)
            self.price_received_at[token] = time.time()
            # A successful REST LTP poll is a usable live-data connection even
            # when the optional WebSocket transport is unavailable.
            self.connected = True
            self.last_error = None

    def snapshot(self) -> dict[str, Any]:
        with _STREAM_LOCK:
            now = time.time()
            prices = {position_id: self.prices[token] for position_id, token in self.position_tokens.items() if token in self.prices}
            ages = {position_id: round(now - self.price_received_at[token], 2) for position_id, token in self.position_tokens.items() if token in self.price_received_at}
            last_error = self.last_error
            if self.position_tokens and not self.connected and not prices and not last_error and self.connect_started_at and now - self.connect_started_at >= 20:
                last_error = "Zerodha WebSocket connection timed out while waiting for live prices."
            return {"connected": self.connected, "prices": prices, "price_age_seconds": ages, "last_error": last_error, "mapped": len(self.position_tokens)}


def get_market_stream() -> ZerodhaMarketStream:
    global _STREAM
    with _STREAM_LOCK:
        if _STREAM is None:
            _STREAM = ZerodhaMarketStream()
        return _STREAM


def zerodha_status() -> dict[str, Any]:
    status = validate_zerodha()
    stream = get_market_stream().snapshot()
    status.update({"websocket": stream, "instruments_file": str(_zerodha_config()["instruments_path"]), "token_source": _TOKEN_SOURCE})
    return status


def live_prices() -> dict[str, Any]:
    snapshot = get_market_stream().snapshot()
    if snapshot["mapped"] and not snapshot["connected"] and not snapshot["prices"] and not snapshot["last_error"]:
        snapshot["last_error"] = "Live CMP feed is not connected yet."
    return snapshot



def connect():
    return connect_supabase()


def get_all_schemas(conn):
    return [row[0] for row in conn.execute("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name")]
