"""Unified Supabase, GCS, and Zerodha connectivity for Matalia."""

from __future__ import annotations

import csv
import json
import os
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS_DIR = PROJECT_ROOT / "Credentials"

_STREAM_LOCK = threading.RLock()
_STREAM: "ZerodhaMarketStream | None" = None
LIVE_PRICE_CACHE_TTL_SECONDS = 60


def _path(value: str | Path) -> Path:
    result = Path(value).expanduser()
    return result if result.is_absolute() else CREDENTIALS_DIR / result


def _env_or_config(name: str, fallback: Any) -> Any:
    """Use an environment override only when it contains a real value."""
    value = os.getenv(name)
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def _set_env_value(name: str, value: str) -> None:
    env_path = PROJECT_ROOT / "Credentials" / ".env"
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
    import psycopg

    return psycopg.connect(
        host=os.environ["SUPABASE_HOST"],
        port=int(os.getenv("SUPABASE_PORT", "5432")),
        dbname=os.environ["SUPABASE_DATABASE"],
        user=os.environ["SUPABASE_USER"],
        password=os.environ["SUPABASE_PASSWORD"],
        sslmode=os.getenv("SUPABASE_SSLMODE", "require"),
    )


def connect_gcs():
    from google.cloud import storage
    from google.oauth2 import service_account

    configured_json = os.getenv("GCS_SERVICE_ACCOUNT_JSON", "").strip()
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
        "gcs_config_path": os.getenv("ZERODHA_GCS_CONFIG_PATH", "config"),
        "auto_validate": os.getenv("ZERODHA_AUTO_VALIDATE", "true").lower() == "true",
        "browser_login": os.getenv("ZERODHA_BROWSER_LOGIN", "true").lower() == "true",
        "timeout": int(os.getenv("ZERODHA_TIMEOUT", "30")),
        "max_retry": int(os.getenv("ZERODHA_MAX_RETRY", "3")),
        "websocket_mode": os.getenv("ZERODHA_WEBSOCKET_MODE", "auto"),
    }


def _load_access_token(config: dict[str, Any]) -> str | None:
    if config.get("access_token"):
        return str(config["access_token"])
    try:
        _, bucket = connect_gcs()
        prefix = str(config.get("gcs_config_path", "config")).strip("/") or "config"
        data = json.loads(bucket.blob(f"{prefix}/token.json").download_as_text())
        access_token = str(data.get("access_token") or "").strip()
        if access_token:
            _set_env_value("ZERODHA_ACCESS_TOKEN", access_token)
            return access_token
    except Exception:
        pass
    return None


def create_kite():
    from kiteconnect import KiteConnect

    config = _zerodha_config()
    access_token = _load_access_token(config)
    if not access_token:
        raise RuntimeError("Zerodha access token is missing")
    kite = KiteConnect(api_key=_env_or_config("ZERODHA_API_KEY", config["api_key"]))
    kite.set_access_token(access_token)
    return kite


def zerodha_login_url() -> str:
    from kiteconnect import KiteConnect

    config = _zerodha_config()
    return KiteConnect(api_key=_env_or_config("ZERODHA_API_KEY", config["api_key"])).login_url()


def complete_zerodha_token(redirect_url: str) -> dict[str, Any]:
    request_token = parse_qs(urlparse(redirect_url).query).get("request_token", [None])[0]
    if not request_token:
        raise RuntimeError("The redirected Zerodha URL does not contain request_token")
    from kiteconnect import KiteConnect

    config = _zerodha_config()
    api_key = _env_or_config("ZERODHA_API_KEY", config["api_key"])
    api_secret = _env_or_config("ZERODHA_API_SECRET", config["api_secret"])
    session = KiteConnect(api_key=api_key).generate_session(request_token, api_secret=api_secret)
    token_data = {"access_token": session["access_token"], "login_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    _set_env_value("ZERODHA_ACCESS_TOKEN", token_data["access_token"])
    try:
        _, bucket = connect_gcs()
        prefix = str(config.get("gcs_config_path", "config")).strip("/") or "config"
        bucket.blob(f"{prefix}/token.json").upload_from_string(json.dumps(token_data), content_type="application/json")
    except Exception:
        pass
    download_instruments(force=True)
    return {"connected": True, "user": session.get("user_id"), "message": "Zerodha token saved"}


def validate_zerodha() -> dict[str, Any]:
    try:
        kite = create_kite()
        profile = kite.profile()
        instruments_ready = False
        try:
            download_instruments()
            instruments_ready = True
        except Exception:
            instruments_ready = False
        return {"connected": True, "user": profile.get("user_id"), "instruments_ready": instruments_ready, "message": "Zerodha connected"}
    except Exception as error:
        return {"connected": False, "user": None, "message": str(error)}


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


def _instrument_rows() -> list[dict[str, str]]:
    file = download_instruments()
    with file.open("r", newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def resolve_instrument(position: dict[str, Any]) -> dict[str, Any] | None:
    symbol = str(position.get("scrip") or position.get("symbol") or "").upper().strip()
    expiry = _normalise_expiry(position.get("expiry"))
    strike = str(position.get("strike") or "").replace(",", "").replace(".0", "")
    option = str(position.get("optType") or position.get("option") or "").upper().strip()
    candidates = []
    for row in _instrument_rows():
        if row.get("exchange") != "NFO":
            continue
        tradingsymbol = row.get("tradingsymbol", "").upper()
        if symbol and not tradingsymbol.startswith(symbol):
            continue
        if option and not tradingsymbol.endswith(f"{strike}{option}"):
            continue
        if expiry and _normalise_expiry(row.get("expiry")) != expiry:
            continue
        candidates.append(row)
    return candidates[0] if candidates else None


def refresh_prices(positions: list[dict[str, Any]]) -> dict[str, Any]:
    prepared = prepare_live_prices(positions)
    prices = dict(prepared["prices"])
    stale_positions = [
        position for position in positions
        if str(position.get("id") or "") not in prices
        or prepared["price_age_seconds"].get(str(position.get("id") or ""), float("inf")) > LIVE_PRICE_CACHE_TTL_SECONDS
    ]

    if stale_positions:
        kite = create_kite()
        resolved = [(position, resolve_instrument(position)) for position in stale_positions]
        resolved = [(position, instrument) for position, instrument in resolved if instrument]
        quotes = kite.ltp([f"{row['exchange']}:{row['tradingsymbol']}" for _, row in resolved]) if resolved else {}
        for position, instrument in resolved:
            key = f"{instrument['exchange']}:{instrument['tradingsymbol']}"
            quote = quotes.get(key, {})
            if quote.get("last_price") is not None:
                prices[str(position.get("id") or key)] = float(quote["last_price"])
    return {"prices": prices, "mapped": prepared["mapped"], "requested": len(positions)}


def prepare_live_prices(positions: list[dict[str, Any]]) -> dict[str, Any]:
    resolved: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for position in positions:
        instrument = resolve_instrument(position)
        if instrument:
            resolved.append((position, instrument))

    stream = get_market_stream()
    mapping = {
        str(position.get("id") or f"{instrument['exchange']}:{instrument['tradingsymbol']}"): int(instrument["instrument_token"])
        for position, instrument in resolved
    }
    stream.set_position_tokens(mapping)
    try:
        stream.subscribe(list(mapping.values()))
    except Exception as error:
        with _STREAM_LOCK:
            stream.last_error = str(error)

    snapshot = stream.snapshot()
    return {
        "prices": snapshot["prices"],
        "price_age_seconds": snapshot["price_age_seconds"],
        "connected": snapshot["connected"],
        "last_error": snapshot["last_error"],
        "mapped": len(resolved),
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
            if self.tokens:
                ws.subscribe(list(self.tokens))
                ws.set_mode(ws.MODE_LTP, list(self.tokens))

    def _on_close(self, _ws, _code, _reason):
        with _STREAM_LOCK:
            self.connected = False

    def start(self):
        if self.ticker is not None:
            return
        from kiteconnect import KiteTicker

        config = _zerodha_config()
        token = _load_access_token(config)
        if not token:
            raise RuntimeError("Zerodha access token is missing")
        self.ticker = KiteTicker(_env_or_config("ZERODHA_API_KEY", config["api_key"]), token)
        self.ticker.on_ticks = self._on_ticks
        self.ticker.on_connect = self._on_connect
        self.ticker.on_close = self._on_close
        self.ticker.connect(threaded=True)

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

    def snapshot(self) -> dict[str, Any]:
        with _STREAM_LOCK:
            now = time.time()
            prices = {position_id: self.prices[token] for position_id, token in self.position_tokens.items() if token in self.prices}
            ages = {position_id: round(now - self.price_received_at[token], 2) for position_id, token in self.position_tokens.items() if token in self.price_received_at}
            return {"connected": self.connected, "prices": prices, "price_age_seconds": ages, "last_error": self.last_error}


def get_market_stream() -> ZerodhaMarketStream:
    global _STREAM
    with _STREAM_LOCK:
        if _STREAM is None:
            _STREAM = ZerodhaMarketStream()
        return _STREAM


def zerodha_status() -> dict[str, Any]:
    status = validate_zerodha()
    stream = get_market_stream().snapshot()
    status.update({"websocket": stream, "instruments_file": str(_zerodha_config()["instruments_path"])})
    return status


def live_prices() -> dict[str, Any]:
    return get_market_stream().snapshot()



def connect():
    return connect_supabase()


def get_all_schemas(conn):
    return [row[0] for row in conn.execute("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name")]
