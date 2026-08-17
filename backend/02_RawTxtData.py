"""Supabase-only raw trade verification step.

Raw TXT parsing and upsert are handled by ``01_Txt_DB.py``.  This compatibility
entry point performs no local staging and simply verifies the Supabase table.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / "Credentials" / ".env")


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


def main() -> None:
    with connect() as conn:
        exists = conn.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = %s AND table_name = %s)",
            ("matalia", "01RawTxtData"),
        ).fetchone()[0]
        if not exists:
            raise RuntimeError('Supabase table matalia."01RawTxtData" does not exist')
        count = conn.execute('SELECT count(*) FROM matalia."01RawTxtData"').fetchone()[0]
    print(f'Supabase table matalia."01RawTxtData" is ready ({count:,} row(s)).')


if __name__ == "__main__":
    main()
