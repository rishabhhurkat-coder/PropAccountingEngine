from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "09_External_Connections.py"
SPEC = importlib.util.spec_from_file_location("live_price_external_test", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
external = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(external)


class FakeStream:
    def __init__(self) -> None:
        self.position_tokens: dict[str, int] = {}
        self.prices: dict[str, float] = {}

    def set_position_tokens(self, mapping: dict[str, int]) -> None:
        self.position_tokens = mapping

    def record_position_price(self, position_id: str, price: float) -> None:
        self.prices[position_id] = price


class FakeKite:
    def ltp(self, instruments: list[str]) -> dict[str, dict[str, float]]:
        assert instruments == ["NFO:NIFTY24JUN24200CE"]
        return {instruments[0]: {"last_price": 123.45}}


class BackgroundPollingTests(unittest.TestCase):
    def test_poll_mode_updates_the_shared_live_price_cache_without_websocket(self) -> None:
        stream = FakeStream()
        positions = [{"id": "position-1", "scrip": "NIFTY", "expiry": "24Jun2026", "strike": "24200", "optType": "CE"}]
        instrument = {
            "exchange": "NFO",
            "tradingsymbol": "NIFTY24JUN24200CE",
            "instrument_token": "123",
        }

        with patch.object(external, "resolve_instrument", return_value=instrument), \
                patch.object(external, "get_market_stream", return_value=stream), \
                patch.object(external, "create_kite", return_value=FakeKite()):
            result = external.refresh_prices(positions, prefer_stream=False)

        self.assertEqual(result["prices"], {"position-1": 123.45})
        self.assertEqual(result["mapped"], 1)
        self.assertEqual(stream.position_tokens, {"position-1": 123})
        self.assertEqual(stream.prices, {"position-1": 123.45})


if __name__ == "__main__":
    unittest.main()
