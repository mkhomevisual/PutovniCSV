#!/usr/bin/env python3
"""Local-only server for the single PP InDesign Data Merge CSV."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
from typing import Optional
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


OUTPUT_NAME = "PP-Masterfile-Labels.csv"
HEADERS = [
    "Název kávy (Nadpis)",
    "Lokace kávy (nadpis)",
    "Druh",
    "Zpracování",
    "Původ",
    "Chuť",
    "Krátký popis (Drip, Bags) 210 znaků",
    "Web",
    "@images",
]
MAX_FILE_SIZE = 20 * 1024 * 1024
MAX_LOGO_SIZE = 100 * 1024 * 1024
WRITE_LOCK = threading.Lock()


class PPCsvHandler(SimpleHTTPRequestHandler):
    server_version = "PPCsvEditor/2.0"
    target_file: Path
    logo_dir: Path
    test_mode = False

    def do_GET(self) -> None:
        request_path = urlsplit(self.path).path
        if request_path == "/api/csv":
            self._send_csv()
            return
        if request_path == "/api/config":
            self._send_json(200, {"testMode": self.test_mode, "file": OUTPUT_NAME, "logoFolder": "logo"})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/api/logo":
            self._send_json(404, {"error": "Neznámý endpoint."})
            return
        self._save_logo()

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/csv":
            self._send_json(404, {"error": "Neznámý endpoint."})
            return
        self._save_csv()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _send_csv(self) -> None:
        try:
            data = self.target_file.read_bytes()
        except FileNotFoundError:
            self._send_json(404, {"error": f"Pevný soubor {OUTPUT_NAME} nebyl nalezen."})
            return
        except OSError as error:
            self._send_json(500, {"error": f"Soubor nelze přečíst: {error}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'inline; filename="{OUTPUT_NAME}"')
        self.end_headers()
        self.wfile.write(data)

    def _save_csv(self) -> None:
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "")
        except ValueError:
            self._send_json(411, {"error": "Chybí platná délka ukládaného souboru."})
            return
        if length < 2 or length > MAX_FILE_SIZE:
            self._send_json(413, {"error": "Ukládaný CSV soubor má neplatnou velikost."})
            return

        data = self.rfile.read(length)
        try:
            self._validate_export(data)
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return

        temp_path: Optional[Path] = None
        try:
            self.target_file.parent.mkdir(parents=True, exist_ok=True)
            with WRITE_LOCK:
                previous_mode = None
                if self.target_file.exists():
                    previous_mode = stat.S_IMODE(self.target_file.stat().st_mode)
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    prefix=".pp-csv-editor-",
                    suffix=".tmp",
                    dir=self.target_file.parent,
                    delete=False,
                ) as temp_file:
                    temp_file.write(data)
                    temp_file.flush()
                    os.fsync(temp_file.fileno())
                    temp_path = Path(temp_file.name)
                if previous_mode is not None:
                    os.chmod(temp_path, previous_mode)
                os.replace(temp_path, self.target_file)
                temp_path = None
        except OSError as error:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            self._send_json(500, {"error": f"Soubor nelze bezpečně uložit: {error}"})
            return

        self._send_json(200, {"ok": True, "file": OUTPUT_NAME, "bytes": len(data)})

    def _save_logo(self) -> None:
        request = urlsplit(self.path)
        values = parse_qs(request.query, keep_blank_values=True).get("name", [])
        name = values[0] if values else ""
        overwrite = parse_qs(request.query).get("overwrite", [""])[0] == "1"
        if (
            not name
            or name in {".", ".."}
            or "/" in name
            or "\\" in name
            or "\x00" in name
            or Path(name).name != name
            or len(name.encode("utf-8")) > 255
        ):
            self._send_json(400, {"error": "Soubor má neplatný název."})
            return

        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "")
        except ValueError:
            self._send_json(411, {"error": "Chybí platná délka nahrávaného souboru."})
            return
        if length < 1 or length > MAX_LOGO_SIZE:
            self._send_json(413, {"error": "Nahrávaný soubor je prázdný nebo větší než 100 MB."})
            return

        destination = self.logo_dir / name
        temp_path: Optional[Path] = None
        try:
            self.logo_dir.mkdir(parents=True, exist_ok=True)
            with WRITE_LOCK:
                if destination.exists() and not overwrite:
                    self._send_json(409, {"error": f"Soubor {name} už ve složce logo existuje.", "conflict": True})
                    return
                previous_mode = stat.S_IMODE(destination.stat().st_mode) if destination.is_file() else None
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    prefix=".pp-logo-",
                    suffix=".tmp",
                    dir=self.logo_dir,
                    delete=False,
                ) as temp_file:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise OSError("Nahrávání bylo předčasně ukončeno.")
                        temp_file.write(chunk)
                        remaining -= len(chunk)
                    temp_file.flush()
                    os.fsync(temp_file.fileno())
                    temp_path = Path(temp_file.name)
                if previous_mode is not None:
                    os.chmod(temp_path, previous_mode)
                os.replace(temp_path, destination)
                temp_path = None
        except OSError as error:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            self._send_json(500, {"error": f"Soubor nelze zkopírovat do složky logo: {error}"})
            return

        self._send_json(200, {"ok": True, "name": name, "path": f"logo/{name}", "bytes": length})

    @staticmethod
    def _validate_export(data: bytes) -> None:
        if not data.startswith(b"\xff\xfe"):
            raise ValueError("Uložení odmítnuto: výstup nemá BOM UTF-16LE.")
        try:
            text = data[2:].decode("utf-16le")
        except UnicodeDecodeError as error:
            raise ValueError("Uložení odmítnuto: neplatné UTF-16LE.") from error
        try:
            rows = list(csv.reader(io.StringIO(text, newline="")))
        except csv.Error as error:
            raise ValueError(f"Uložení odmítnuto: neplatné CSV ({error}).") from error
        if not rows or rows[0] != HEADERS:
            raise ValueError("Uložení odmítnuto: hlavičky nejsou přesné nebo mají jiné pořadí.")
        if any(len(row) != len(HEADERS) for row in rows):
            raise ValueError("Uložení odmítnuto: některý řádek nemá přesně 9 sloupců.")
        if len(rows) > 1 and "\r\n" not in text:
            raise ValueError("Uložení odmítnuto: záznamy nejsou oddělené CRLF.")

    def _send_json(self, status_code: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    project_dir = Path(__file__).resolve().parent
    default_target = project_dir / OUTPUT_NAME
    default_logo_dir = project_dir / "logo"
    parser = argparse.ArgumentParser(description="PP CSV Editor local server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--target", type=Path, default=default_target)
    parser.add_argument("--logo-dir", type=Path, default=default_logo_dir)
    parser.add_argument("--open-browser", action="store_true")
    parser.add_argument("--test-mode", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    target = args.target.expanduser().resolve()
    logo_dir = args.logo_dir.expanduser().resolve()
    if target.name != OUTPUT_NAME:
        parser.error(f"Cílový soubor se musí jmenovat {OUTPUT_NAME}")
    if args.test_mode and target == default_target.resolve():
        parser.error("Testovací režim vyžaduje izolovaný --target.")
    if args.test_mode and logo_dir == default_logo_dir.resolve():
        parser.error("Testovací režim vyžaduje izolovaný --logo-dir.")

    handler = lambda *handler_args, **handler_kwargs: PPCsvHandler(
        *handler_args, directory=str(project_dir), **handler_kwargs
    )
    PPCsvHandler.target_file = target
    PPCsvHandler.logo_dir = logo_dir
    PPCsvHandler.test_mode = args.test_mode
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    actual_port = server.server_address[1]
    url = f"http://127.0.0.1:{actual_port}/"
    print(f"PP CSV Editor: {url}", flush=True)
    print(f"Pevný CSV soubor: {target}", flush=True)
    print(f"Složka pro loga: {logo_dir}", flush=True)
    print("Server ukončíte klávesami Ctrl+C.", flush=True)
    if args.open_browser:
        opener = threading.Timer(0.4, lambda: webbrowser.open(url))
        opener.daemon = True
        opener.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer ukončen.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
