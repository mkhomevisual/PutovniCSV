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


def create_local_export(parent: Path, name: str = "Nicaraguer") -> Path:
    root = parent / name
    products = root / "Produkty"
    products.mkdir(parents=True)
    for index in range(1, 6):
        (products / f"lokalni-produkt_{index:02}.png").write_bytes(f"local-png-{index}".encode())
    for index in range(1, 9):
        (root / f"lokalni-tisk_{index:02}.pdf").write_bytes(f"%PDF-1.4\nlocal-pdf-{index}\n%%EOF".encode())
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
            assert plan["profile"] == "company_offer"
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

        local_root = create_local_export(temp)
        with patch("handoff_processor.available_pdf_mergers", return_value=[("test merger", "test")]):
            local_plan = analyze_handoff_folder(local_root)
            assert local_plan["status"] == "ready", local_plan["errors"]
            assert local_plan["profile"] == "local_coffee"
            assert local_plan["profileLabel"] == "Lokální káva"
            assert local_plan["warnings"] == []
            assert local_plan["products"][0]["destination"] == "Produkty/Nicaraguer_VandrBag_Back.png"
            assert local_plan["products"][1]["destination"] == "Produkty/Nicaraguer_VandrBag_Front.png"
            assert local_plan["products"][4]["destination"] == "Produkty/Nicaraguer_Pytlik_250g.png"
            assert local_plan["pdfs"][0]["destination"] == "Nicaraguer_250g.pdf"
            assert local_plan["pdfs"][0]["operation"] == "rename"
            assert local_plan["pdfs"][4]["destination"] == "Nicaraguer_VandrDrip.pdf"
            assert local_plan["pdfs"][4]["operation"] == "merge"

            local_result = process_handoff_folder(local_root, merge_pdf=fake_merge)
            assert local_result["status"] == "completed"
            assert local_result["processed"] is True
            assert local_result["backupFolder"] == "Nicaraguer_Backup"
            expected_local_products = {
                "Nicaraguer_VandrBag_Back.png",
                "Nicaraguer_VandrBag_Front.png",
                "Nicaraguer_VandrDrip_Back.png",
                "Nicaraguer_VandrDrip_Front.png",
                "Nicaraguer_Pytlik_250g.png",
            }
            assert {item.name for item in (local_root / "Produkty").iterdir()} == expected_local_products
            expected_local_pdfs = {
                "Nicaraguer_250g.pdf",
                "Nicaraguer_500g.pdf",
                "Nicaraguer_1kg.pdf",
                "Nicaraguer_Kolky.pdf",
                "Nicaraguer_VandrDrip.pdf",
                "Nicaraguer_VandrBag.pdf",
            }
            assert {item.name for item in local_root.glob("*.pdf")} == expected_local_pdfs
            assert b"local-pdf-1" in (local_root / "Nicaraguer_250g.pdf").read_bytes()
            assert b"local-pdf-5" in (local_root / "Nicaraguer_VandrDrip.pdf").read_bytes()
            assert b"local-pdf-6" in (local_root / "Nicaraguer_VandrDrip.pdf").read_bytes()
            assert len(list((local_root / "Nicaraguer_Backup").glob("*.pdf"))) == 8

            local_second_result = process_handoff_folder(local_root, merge_pdf=fake_merge)
            assert local_second_result["status"] == "completed"
            assert local_second_result["profile"] == "local_coffee"
            assert local_second_result["processed"] is False

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
    print("✓ Lokální káva se rozpozná a použije vlastní mapování 5 PNG + 8 PDF")
    print("✓ Původní PDF zůstávají ve viditelné složce <klient>_Backup a Prezentace se nemění")
    print("✓ Opakované spuštění pozná hotovou složku")
    print("✓ Kolize a chyba spojování nezpůsobí částečné přejmenování")
    print("6/6 testů zpracování exportů prošlo.")


if __name__ == "__main__":
    main()
