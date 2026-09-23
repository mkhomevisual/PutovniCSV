#!/usr/bin/env python3
"""Validate, rename and merge a numbered company-offer export folder."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Callable, Iterable, Optional


PRODUCT_NAMES = {
    "01": "VandrBag_Front",
    "02": "VandrBag_Back",
    "03": "VandrDrip_Front",
    "04": "VandrDrip_Back",
    "05": "250g_Front",
    "06": "250g_Back",
}

PDF_GROUPS = (
    (("01", "02"), "VandrDrip"),
    (("03", "04"), "75g"),
    (("05", "06"), "250g"),
    (("07", "08"), "150g"),
    (("09", "10"), "VandrBag"),
)

AUTOMATOR_JOIN = Path(
    "/System/Library/Automator/Combine PDF Pages.action/Contents/MacOS/join"
)
NUMBERED_STEM = re.compile(r"_(\d{2})$")


class HandoffError(RuntimeError):
    """A user-facing validation or processing error."""


def _relative_name(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _numbered_files(directory: Path, extension: str) -> dict[str, list[Path]]:
    matches: dict[str, list[Path]] = {}
    if not directory.is_dir():
        return matches
    for entry in directory.iterdir():
        if not entry.is_file() or entry.suffix.lower() != extension:
            continue
        match = NUMBERED_STEM.search(entry.stem)
        if match:
            matches.setdefault(match.group(1), []).append(entry)
    for entries in matches.values():
        entries.sort(key=lambda item: item.name.casefold())
    return matches


def available_pdf_mergers() -> list[tuple[str, object]]:
    """Return PDF merge engines in preference order."""
    engines: list[tuple[str, object]] = []
    if AUTOMATOR_JOIN.is_file() and os.access(AUTOMATOR_JOIN, os.X_OK):
        engines.append(("macOS Combine PDF Pages", AUTOMATOR_JOIN))
    pdfunite = shutil.which("pdfunite")
    if pdfunite:
        engines.append(("pdfunite", Path(pdfunite)))
    if importlib.util.find_spec("pypdf") is not None:
        engines.append(("pypdf", "pypdf"))
    return engines


def _valid_pdf(path: Path) -> bool:
    try:
        if not path.is_file() or path.stat().st_size <= 8:
            return False
        with path.open("rb") as pdf_file:
            return pdf_file.read(5) == b"%PDF-"
    except OSError:
        return False


def merge_pdfs(sources: Iterable[Path], destination: Path) -> str:
    """Merge PDFs with a built-in macOS tool and portable fallbacks."""
    source_list = list(sources)
    failures: list[str] = []
    engines = available_pdf_mergers()
    if not engines:
        raise HandoffError(
            "V systému není dostupný nástroj pro spojení PDF. "
            "Na Macu spusťte aplikaci přes start.command."
        )

    for name, executable in engines:
        destination.unlink(missing_ok=True)
        try:
            if executable == "pypdf":
                from pypdf import PdfWriter  # type: ignore[import-not-found]

                writer = PdfWriter()
                for source in source_list:
                    writer.append(str(source))
                with destination.open("wb") as output:
                    writer.write(output)
                writer.close()
            else:
                if name == "pdfunite":
                    command = [str(executable), *(str(item) for item in source_list), str(destination)]
                else:
                    command = [str(executable), "-o", str(destination), *(str(item) for item in source_list)]
                completed = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=180,
                    check=False,
                )
                if completed.returncode != 0:
                    detail = (completed.stderr or completed.stdout).strip()
                    raise RuntimeError(detail or f"návratový kód {completed.returncode}")
            if not _valid_pdf(destination):
                raise RuntimeError("výstup není platný PDF soubor")
            return name
        except Exception as error:  # try every available local engine
            failures.append(f"{name}: {error}")

    destination.unlink(missing_ok=True)
    raise HandoffError("PDF se nepodařilo spojit (" + "; ".join(failures) + ").")


def analyze_handoff_folder(folder: Path | str) -> dict:
    """Build a serializable, non-mutating plan for one selected folder."""
    requested = Path(folder).expanduser()
    try:
        root = requested.resolve(strict=True)
    except (OSError, RuntimeError):
        return {
            "ok": False,
            "status": "error",
            "folder": str(requested),
            "prefix": requested.name,
            "errors": ["Vybraná složka neexistuje nebo ji nelze otevřít."],
            "warnings": [],
            "products": [],
            "pdfs": [],
        }

    errors: list[str] = []
    warnings: list[str] = []
    prefix = root.name
    products_dir = root / "Produkty"

    if not root.is_dir():
        errors.append("Vybraná položka není složka.")
    if not prefix or prefix in {".", ".."}:
        errors.append("Název vybrané složky nelze použít jako prefix souborů.")
    if not products_dir.is_dir():
        errors.append("Ve vybrané složce chybí podsložka Produkty.")
    if not (root / "Prezentace").is_dir():
        warnings.append("Podsložka Prezentace nebyla nalezena; zpracování se jí nedotkne.")

    product_matches = _numbered_files(products_dir, ".png")
    pdf_matches = _numbered_files(root, ".pdf")
    product_actions: list[dict] = []
    pdf_actions: list[dict] = []

    for number, output_label in PRODUCT_NAMES.items():
        matches = product_matches.get(number, [])
        destination = products_dir / f"{prefix}_{output_label}.png"
        source = matches[0] if len(matches) == 1 else None
        product_actions.append(
            {
                "number": number,
                "source": _relative_name(root, source) if source else None,
                "destination": _relative_name(root, destination),
            }
        )
        if len(matches) > 1:
            names = ", ".join(item.name for item in matches)
            errors.append(f"Pro produkt {number} bylo nalezeno více PNG: {names}.")

    for numbers, output_label in PDF_GROUPS:
        sources: list[Optional[Path]] = []
        for number in numbers:
            matches = pdf_matches.get(number, [])
            sources.append(matches[0] if len(matches) == 1 else None)
            if len(matches) > 1:
                names = ", ".join(item.name for item in matches)
                errors.append(f"Pro tiskovinu {number} bylo nalezeno více PDF: {names}.")
        destination = root / f"{prefix}_{output_label}.pdf"
        pdf_actions.append(
            {
                "numbers": list(numbers),
                "sources": [_relative_name(root, item) if item else None for item in sources],
                "destination": _relative_name(root, destination),
            }
        )

    product_destinations = [root / item["destination"] for item in product_actions]
    pdf_destinations = [root / item["destination"] for item in pdf_actions]
    backup_destination = root / f"{prefix}_Backup"
    source_products_present = [item for item in product_actions if item["source"] is not None]
    source_pdfs_present = [source for item in pdf_actions for source in item["sources"] if source]
    destinations_present = [path for path in product_destinations + pdf_destinations if path.exists()]

    completed = (
        len(source_products_present) == 0
        and len(source_pdfs_present) == 0
        and all(path.is_file() for path in product_destinations + pdf_destinations)
    )

    if not completed:
        for item in product_actions:
            if item["source"] is None:
                errors.append(f"V Produkty chybí PNG s číselnou příponou _{item['number']}.")
        for item in pdf_actions:
            for number, source in zip(item["numbers"], item["sources"]):
                if source is None:
                    errors.append(f"V kořenové složce chybí PDF s číselnou příponou _{number}.")
        for path in destinations_present:
            errors.append(f"Cílový soubor už existuje: {_relative_name(root, path)}.")
        if backup_destination.exists():
            errors.append(f"Záložní složka už existuje: {backup_destination.name}.")
        if not os.access(root, os.W_OK) or (products_dir.is_dir() and not os.access(products_dir, os.W_OK)):
            errors.append("Do vybrané složky nebo do podsložky Produkty nelze zapisovat.")
        if not available_pdf_mergers():
            errors.append("V systému není dostupný nástroj pro spojení PDF.")

    for path in product_destinations + pdf_destinations:
        if len(path.name.encode("utf-8")) > 255:
            errors.append(f"Výsledný název je příliš dlouhý: {path.name}.")

    if completed:
        status = "completed"
    elif errors:
        status = "error"
    else:
        status = "ready"

    mergers = available_pdf_mergers()
    return {
        "ok": status in {"ready", "completed"},
        "status": status,
        "folder": str(root),
        "prefix": prefix,
        "errors": errors,
        "warnings": warnings,
        "products": product_actions,
        "pdfs": pdf_actions,
        "merger": mergers[0][0] if mergers else None,
    }


def process_handoff_folder(
    folder: Path | str,
    merge_pdf: Callable[[Iterable[Path], Path], str] = merge_pdfs,
) -> dict:
    """Execute a validated plan, rolling file moves back on any failure."""
    plan = analyze_handoff_folder(folder)
    if plan["status"] == "completed":
        return {**plan, "processed": False, "backupFolder": None}
    if plan["status"] != "ready":
        raise HandoffError(" ".join(plan["errors"]))

    root = Path(plan["folder"])
    moved_products: list[tuple[Path, Path]] = []
    moved_sources: list[tuple[Path, Path]] = []
    published_outputs: list[tuple[Path, Path]] = []
    backup = root / f"{plan['prefix']}_Backup"
    merger_names: list[str] = []

    try:
        with tempfile.TemporaryDirectory(prefix=".pp-handoff-", dir=root) as temporary_name:
            staging = Path(temporary_name)

            for item in plan["pdfs"]:
                sources = [root / source for source in item["sources"]]
                staged_output = staging / Path(item["destination"]).name
                merger_names.append(merge_pdf(sources, staged_output))
                if not _valid_pdf(staged_output):
                    raise HandoffError(f"Spojený soubor {staged_output.name} není platné PDF.")

            for item in plan["products"]:
                source = root / item["source"]
                destination = root / item["destination"]
                if destination.exists():
                    raise HandoffError(f"Cílový soubor mezitím vznikl: {destination.name}.")
                source.replace(destination)
                moved_products.append((source, destination))

            backup.mkdir()
            for item in plan["pdfs"]:
                for relative_source in item["sources"]:
                    source = root / relative_source
                    archived = backup / source.name
                    source.replace(archived)
                    moved_sources.append((source, archived))

            for item in plan["pdfs"]:
                staged_output = staging / Path(item["destination"]).name
                destination = root / item["destination"]
                if destination.exists():
                    raise HandoffError(f"Cílový soubor mezitím vznikl: {destination.name}.")
                staged_output.replace(destination)
                published_outputs.append((staged_output, destination))
    except Exception as error:
        for _staged_output, destination in reversed(published_outputs):
            destination.unlink(missing_ok=True)
        for source, archived in reversed(moved_sources):
            if archived.exists():
                archived.replace(source)
        for source, destination in reversed(moved_products):
            if destination.exists():
                destination.replace(source)
        try:
            backup.rmdir()
        except OSError:
            pass
        if isinstance(error, HandoffError):
            raise
        raise HandoffError(f"Zpracování se nepodařilo a změny byly vráceny: {error}") from error

    result = analyze_handoff_folder(root)
    if result["status"] != "completed":
        raise HandoffError("Soubory byly zpracovány, ale závěrečná kontrola nebyla úspěšná.")
    engines = list(dict.fromkeys(merger_names))
    return {
        **result,
        "processed": True,
        "backupFolder": backup.name,
        "merger": ", ".join(engines),
    }
