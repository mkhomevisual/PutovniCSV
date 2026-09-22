#!/usr/bin/env python3
"""Isolated HTTP tests for fixed CSV and logo upload endpoints."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import threading
from typing import Optional
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))
from server import OUTPUT_NAME, PPCsvHandler  # noqa: E402


def request(url: str, method: str = "GET", data: Optional[bytes] = None):
    req = Request(url, method=method, data=data)
    try:
        with urlopen(req, timeout=5) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pp-csv-server-test-") as temp_name:
        temp = Path(temp_name)
        target = temp / OUTPUT_NAME
        logo_dir = temp / "logo"
        logo_dir.mkdir()
        fixture = Path(__file__).resolve().parent / "fixtures" / "PP-Masterfile-Labels.fixture.csv"
        target.write_bytes(fixture.read_bytes())

        PPCsvHandler.target_file = target
        PPCsvHandler.logo_dir = logo_dir
        PPCsvHandler.test_mode = True
        handler = lambda *args, **kwargs: PPCsvHandler(*args, directory=str(PROJECT_DIR), **kwargs)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"

        try:
            status, csv_bytes = request(f"{base}/api/csv")
            assert status == 200 and csv_bytes == fixture.read_bytes()

            logo_bytes = b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'
            logo_name = "Nové logo.svg"
            logo_url = f"{base}/api/logo?{urlencode({'name': logo_name})}"
            status, body = request(logo_url, "POST", logo_bytes)
            result = json.loads(body)
            assert status == 200 and result["path"] == f"logo/{logo_name}"
            assert (logo_dir / logo_name).read_bytes() == logo_bytes

            status, _ = request(logo_url, "POST", b"new")
            assert status == 409 and (logo_dir / logo_name).read_bytes() == logo_bytes

            overwrite_url = f"{logo_url}&overwrite=1"
            status, _ = request(overwrite_url, "POST", b"new")
            assert status == 200 and (logo_dir / logo_name).read_bytes() == b"new"

            traversal_url = f"{base}/api/logo?{urlencode({'name': '../evil.svg'})}"
            status, _ = request(traversal_url, "POST", b"evil")
            assert status == 400 and not (temp / "evil.svg").exists()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    print("✓ Server načítá pevné CSV")
    print("✓ Upload ukládá soubor do izolované složky logo")
    print("✓ Konflikt vyžaduje potvrzené přepsání")
    print("✓ Nebezpečná cesta je odmítnuta")
    print("4/4 serverových testů prošlo.")


if __name__ == "__main__":
    main()
