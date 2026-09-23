#!/usr/bin/env python3
"""Filesystem tests for the company-offer export processor."""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile
from unittest.mock import patch


PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))
from handoff_processor import HandoffError, analyze_handoff_folder, process_handoff_folder  # noqa: E402


def create_export(parent: Path, name: str = "Klient Žluťoučký") -> Path:
    root = parent / name
    products = root / "Produkty"
    presentation = root / "Prezentace"
    products.mkdir(parents=True)
    presentation.mkdir()
    (presentation / "beze-zmeny.pdf").write_bytes(b"presentation")
    for index in range(1, 7):
        (products / f"libovolny-produkt_{index:02}.PNG").write_bytes(f"png-{index}".encode())
    for index in range(1, 11):
        (root / f"jiny-export_{index:02}.PDF").write_bytes(f"%PDF-1.4\npdf-{index}\n%%EOF".encode())
    return root


def fake_merge(sources, destination: Path) -> str:
    content = b"|".join(source.read_bytes() for source in sources)
    destination.write_bytes(b"%PDF-1.4\n" + content + b"\n%%EOF")
    return "test merger"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pp-handoff-test-") as temp_name:
        temp = Path(temp_name)
        root = create_export(temp)
        with patch("handoff_processor.available_pdf_mergers", return_value=[("test merger", "test")]):
            plan = analyze_handoff_folder(root)
            assert plan["status"] == "ready", plan["errors"]
            assert plan["prefix"] == "Klient Žluťoučký"
            assert plan["products"][0]["destination"] == "Produkty/Klient Žluťoučký_VandrBag_Front.png"
            assert plan["products"][5]["destination"] == "Produkty/Klient Žluťoučký_250g_Back.png"
            assert plan["pdfs"][0]["destination"] == "Klient Žluťoučký_VandrDrip.pdf"
            assert plan["pdfs"][4]["destination"] == "Klient Žluťoučký_VandrBag.pdf"

            result = process_handoff_folder(root, merge_pdf=fake_merge)
            assert result["status"] == "completed"
            assert result["processed"] is True
            assert result["merger"] == "test merger"

            expected_products = {
                "Klient Žluťoučký_VandrBag_Front.png",
                "Klient Žluťoučký_VandrBag_Back.png",
                "Klient Žluťoučký_VandrDrip_Front.png",
                "Klient Žluťoučký_VandrDrip_Back.png",
                "Klient Žluťoučký_250g_Front.png",
                "Klient Žluťoučký_250g_Back.png",
            }
            assert {item.name for item in (root / "Produkty").iterdir()} == expected_products
            expected_pdfs = {
                "Klient Žluťoučký_VandrDrip.pdf",
                "Klient Žluťoučký_75g.pdf",
                "Klient Žluťoučký_250g.pdf",
                "Klient Žluťoučký_150g.pdf",
                "Klient Žluťoučký_VandrBag.pdf",
            }
            assert {item.name for item in root.glob("*.pdf")} == expected_pdfs
            assert b"pdf-1" in (root / "Klient Žluťoučký_VandrDrip.pdf").read_bytes()
            assert b"pdf-2" in (root / "Klient Žluťoučký_VandrDrip.pdf").read_bytes()
            assert result["backupFolder"] == "Klient Žluťoučký_Backup"
            backup = root / result["backupFolder"]
            assert backup.is_dir()
            assert len(list(backup.glob("*.PDF"))) == 10
            assert (root / "Prezentace" / "beze-zmeny.pdf").read_bytes() == b"presentation"

            second_result = process_handoff_folder(root, merge_pdf=fake_merge)
            assert second_result["status"] == "completed"
            assert second_result["processed"] is False

        collision_root = create_export(temp, "Kolize")
        (collision_root / "Kolize_75g.pdf").write_bytes(b"existing")
        with patch("handoff_processor.available_pdf_mergers", return_value=[("test merger", "test")]):
            collision = analyze_handoff_folder(collision_root)
        assert collision["status"] == "error"
        assert any("Cílový soubor už existuje" in error for error in collision["errors"])

        rollback_root = create_export(temp, "Rollback")
        calls = 0

        def failing_merge(sources, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise HandoffError("záměrná chyba")
            return fake_merge(sources, destination)

        with patch("handoff_processor.available_pdf_mergers", return_value=[("test merger", "test")]):
            try:
                process_handoff_folder(rollback_root, merge_pdf=failing_merge)
            except HandoffError:
                pass
            else:
                raise AssertionError("Chyba spojování měla zpracování zastavit.")
        assert len(list(rollback_root.glob("*_??.PDF"))) == 10
        assert len(list((rollback_root / "Produkty").glob("*_??.PNG"))) == 6
        assert not (rollback_root / "Rollback_Backup").exists()

        backup_collision_root = create_export(temp, "Existujici-zaloha")
        (backup_collision_root / "Existujici-zaloha_Backup").mkdir()
        with patch("handoff_processor.available_pdf_mergers", return_value=[("test merger", "test")]):
            backup_collision = analyze_handoff_folder(backup_collision_root)
        assert backup_collision["status"] == "error"
        assert any("Záložní složka už existuje" in error for error in backup_collision["errors"])

    print("✓ Číselné vstupy se mapují podle názvu vybrané složky")
    print("✓ Produkty se přejmenují a PDF se spojí ve správných dvojicích")
    print("✓ Původní PDF zůstávají ve viditelné složce <klient>_Backup a Prezentace se nemění")
    print("✓ Opakované spuštění pozná hotovou složku")
    print("✓ Kolize a chyba spojování nezpůsobí částečné přejmenování")
    print("5/5 testů zpracování exportů prošlo.")


if __name__ == "__main__":
    main()
