#!/usr/bin/env python3
"""Validate and prepare numbered company-offer or local-coffee exports."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Callable, Iterable, Optional


COMPANY_PRODUCT_NAMES = {
    "01": "VandrBag_Front",
    "02": "VandrBag_Back",
    "03": "VandrDrip_Front",
    "04": "VandrDrip_Back",
    "05": "250g_Front",
    "06": "250g_Back",
}

COMPANY_PDF_GROUPS = (
    (("01", "02"), "VandrDrip"),
    (("03", "04"), "75g"),
    (("05", "06"), "250g"),
    (("07", "08"), "150g"),
    (("09", "10"), "VandrBag"),
)

LOCAL_PRODUCT_NAMES = {
    "01": "VandrBag_Back",
    "02": "VandrBag_Front",
    "03": "VandrDrip_Back",
    "04": "VandrDrip_Front",
    "05": "Pytlik_250g",
}

LOCAL_PDF_GROUPS = (
    (("01",), "250g"),
    (("02",), "500g"),
    (("03",), "1kg"),
    (("04",), "Kolky"),
    (("05", "06"), "VandrDrip"),
    (("07", "08"), "VandrBag"),
)

PROFILES = {
    "company_offer": {
        "label": "Firemní nabídka",
        "products": COMPANY_PRODUCT_NAMES,
        "pdfs": COMPANY_PDF_GROUPS,
        "expects_presentation": True,
    },
    "local_coffee": {
        "label": "Lokální káva",
        "products": LOCAL_PRODUCT_NAMES,
        "pdfs": LOCAL_PDF_GROUPS,
        "expects_presentation": False,
    },
}

# Backward-compatible names used by existing integrations.
PRODUCT_NAMES = COMPANY_PRODUCT_NAMES
PDF_GROUPS = COMPANY_PDF_GROUPS

AUTOMATOR_JOIN = Path(
    "/System/Library/Automator/Combine PDF Pages.action/Contents/MacOS/join"
)
NUMBERED_STEM = re.compile(r"_(\d{1,2})$")
PRESENTATION_STEM = re.compile(r"_prezentace$", re.IGNORECASE)


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
            matches.setdefault(match.group(1).zfill(2), []).append(entry)
    for entries in matches.values():
        entries.sort(key=lambda item: item.name.casefold())
    return matches


def _merge_numbered_files(*groups: dict[str, list[Path]]) -> dict[str, list[Path]]:
    merged: dict[str, list[Path]] = {}
    for group in groups:
        for number, paths in group.items():
            merged.setdefault(number, []).extend(paths)
    for entries in merged.values():
        entries.sort(key=lambda item: item.as_posix().casefold())
    return merged


def _presentation_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(
        (
            entry
            for entry in directory.iterdir()
            if entry.is_file()
            and entry.suffix.lower() == ".pdf"
            and PRESENTATION_STEM.search(entry.stem)
        ),
        key=lambda item: item.name.casefold(),
    )


def _backup_name(prefix: str) -> str:
    return f"_backup_{prefix}"


def _pdf_numbers(profile: dict) -> set[str]:
    return {number for numbers, _label in profile["pdfs"] for number in numbers}


def _profile_destinations(root: Path, prefix: str, profile: dict) -> tuple[list[Path], list[Path]]:
    products = [
        root / "Produkty" / f"{prefix}_{label}.png"
        for label in profile["products"].values()
    ]
    pdfs = [root / f"{prefix}_{label}.pdf" for _numbers, label in profile["pdfs"]]
    return products, pdfs


def _detect_profile(
    root: Path,
    prefix: str,
    product_matches: dict[str, list[Path]],
    pdf_matches: dict[str, list[Path]],
) -> Optional[tuple[str, dict]]:
    product_numbers = set(product_matches)
    pdf_numbers = set(pdf_matches)
    ranked: list[tuple[int, str, dict]] = []

    for key, profile in PROFILES.items():
        expected_products = set(profile["products"])
        expected_pdfs = _pdf_numbers(profile)
        product_destinations, pdf_destinations = _profile_destinations(root, prefix, profile)
        output_matches = sum(path.is_file() for path in product_destinations + pdf_destinations)
        unexpected = len(product_numbers - expected_products) + len(pdf_numbers - expected_pdfs)
        source_matches = len(product_numbers & expected_products) + len(pdf_numbers & expected_pdfs)
        score = source_matches + output_matches * 5 - unexpected * 20
        if product_numbers == expected_products and pdf_numbers == expected_pdfs:
            score += 100
        if (
            not product_numbers
            and not pdf_numbers
            and all(path.is_file() for path in product_destinations + pdf_destinations)
        ):
            score += 200
        ranked.append((score, key, profile))

    ranked.sort(key=lambda item: item[0], reverse=True)
    if not ranked or ranked[0][0] <= 0:
        return None
    if len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
        return None
    return ranked[0][1], ranked[0][2]


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


def _error_plan(requested: Path, errors: list[str]) -> dict:
    return {
        "ok": False,
        "status": "error",
        "folder": str(requested),
        "prefix": requested.name,
        "profile": None,
        "profileLabel": None,
        "errors": errors,
        "warnings": [],
        "products": [],
        "pdfs": [],
        "presentations": [],
        "productCount": 0,
        "pdfOutputCount": 0,
        "pdfSourceCount": 0,
        "presentationCount": 0,
        "merger": None,
    }


def analyze_handoff_folder(folder: Path | str) -> dict:
    """Build a serializable, non-mutating plan for one selected folder."""
    requested = Path(folder).expanduser()
    try:
        root = requested.resolve(strict=True)
    except (OSError, RuntimeError):
        return _error_plan(requested, ["Vybraná složka neexistuje nebo ji nelze otevřít."])

    if not root.is_dir():
        return _error_plan(root, ["Vybraná položka není složka."])

    errors: list[str] = []
    warnings: list[str] = []
    prefix = root.name
    products_dir = root / "Produkty"

    if not prefix or prefix in {".", ".."}:
        errors.append("Název vybrané složky nelze použít jako prefix souborů.")
    if products_dir.exists() and not products_dir.is_dir():
        errors.append("Položka Produkty existuje, ale není to složka.")

    product_matches = _merge_numbered_files(
        _numbered_files(products_dir, ".png"),
        _numbered_files(root, ".png"),
    )
    pdf_matches = _numbered_files(root, ".pdf")
    detected = _detect_profile(root, prefix, product_matches, pdf_matches)
    if detected is None:
        errors.append(
            "Nelze rozpoznat typ exportu. Očekávám firemní nabídku (6 PNG + 10 PDF) "
            "nebo lokální kávu (5 PNG + 8 PDF)."
        )
        result = _error_plan(root, errors)
        result["warnings"] = warnings
        return result

    profile_key, profile = detected
    product_names: dict[str, str] = profile["products"]
    pdf_groups = profile["pdfs"]

    product_actions: list[dict] = []
    pdf_actions: list[dict] = []
    presentation_actions: list[dict] = []
    presentation_missing = False

    for number, output_label in product_names.items():
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

    for numbers, output_label in pdf_groups:
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
                "operation": "merge" if len(numbers) > 1 else "rename",
            }
        )

    if profile["expects_presentation"]:
        presentations_dir = root / "Prezentace"
        if presentations_dir.exists() and not presentations_dir.is_dir():
            errors.append("Položka Prezentace existuje, ale není to složka.")
        root_presentations = _presentation_files(root)
        nested_presentations = sorted(
            (
                entry
                for entry in presentations_dir.iterdir()
                if entry.is_file() and entry.suffix.lower() == ".pdf"
            ),
            key=lambda item: item.name.casefold(),
        ) if presentations_dir.is_dir() else []
        if len(root_presentations) == 1 and not nested_presentations:
            source = root_presentations[0]
            destination = presentations_dir / f"{prefix}_Prezentace.pdf"
            presentation_actions.append(
                {
                    "source": _relative_name(root, source),
                    "destination": _relative_name(root, destination),
                    "operation": "move",
                }
            )
        elif not root_presentations and len(nested_presentations) == 1:
            existing = nested_presentations[0]
            presentation_actions.append(
                {
                    "source": None,
                    "destination": _relative_name(root, existing),
                    "operation": "keep",
                }
            )
        elif not root_presentations and not nested_presentations:
            presentation_missing = True
        else:
            found = root_presentations + nested_presentations
            names = ", ".join(_relative_name(root, item) for item in found)
            errors.append(f"Bylo nalezeno více PDF prezentací: {names}.")

    expected_product_numbers = set(product_names)
    expected_pdf_numbers = _pdf_numbers(profile)
    for number in sorted(set(product_matches) - expected_product_numbers):
        errors.append(f"Bylo nalezeno neočekávané PNG s číselnou příponou _{number}.")
    for number in sorted(set(pdf_matches) - expected_pdf_numbers):
        errors.append(f"V kořenové složce je neočekávané PDF s číselnou příponou _{number}.")

    product_destinations = [root / item["destination"] for item in product_actions]
    pdf_destinations = [root / item["destination"] for item in pdf_actions]
    presentation_destinations = [
        root / item["destination"]
        for item in presentation_actions
        if item["operation"] == "move"
    ]
    backup_destination = root / _backup_name(prefix)
    source_products_present = [item for item in product_actions if item["source"] is not None]
    source_pdfs_present = [source for item in pdf_actions for source in item["sources"] if source]
    source_presentations_present = [
        item for item in presentation_actions if item["operation"] == "move"
    ]
    destinations_present = [
        path
        for path in product_destinations + pdf_destinations + presentation_destinations
        if path.exists()
    ]
    core_outputs_completed = (
        len(source_products_present) == 0
        and len(source_pdfs_present) == 0
        and all(path.is_file() for path in product_destinations + pdf_destinations)
    )
    if presentation_missing:
        if core_outputs_completed:
            warnings.append("Hotová starší firemní složka neobsahuje PDF prezentaci.")
        else:
            errors.append("Chybí firemní PDF prezentace se suffixem _Prezentace.pdf.")
    presentation_ready = (
        not profile["expects_presentation"]
        or len(presentation_actions) == 1
        or (presentation_missing and core_outputs_completed)
    )

    completed = (
        core_outputs_completed
        and len(source_presentations_present) == 0
        and presentation_ready
    )

    if not completed:
        for item in product_actions:
            if item["source"] is None:
                errors.append(f"Chybí PNG s číselnou příponou _{item['number']}.")
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
        if any(len(numbers) > 1 for numbers, _label in pdf_groups) and not available_pdf_mergers():
            errors.append("V systému není dostupný nástroj pro spojení PDF.")

    for path in product_destinations + pdf_destinations + presentation_destinations:
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
        "profile": profile_key,
        "profileLabel": profile["label"],
        "errors": errors,
        "warnings": warnings,
        "products": product_actions,
        "pdfs": pdf_actions,
        "presentations": presentation_actions,
        "productCount": len(product_actions),
        "pdfOutputCount": len(pdf_actions),
        "pdfSourceCount": len(expected_pdf_numbers),
        "presentationCount": len(presentation_actions),
        "merger": mergers[0][0] if mergers else None,
    }


def process_handoff_folder(
    folder: Path | str,
    merge_pdf: Callable[[Iterable[Path], Path], str] = merge_pdfs,
) -> dict:
    """Execute a validated plan, rolling file moves back on any failure."""
    plan = analyze_handoff_folder(folder)
    root = Path(plan["folder"])
    backup = root / _backup_name(plan["prefix"])
    if plan["status"] == "completed":
        return {
            **plan,
            "processed": False,
            "backupFolder": backup.name if backup.is_dir() else None,
        }
    if plan["status"] != "ready":
        raise HandoffError(" ".join(plan["errors"]))

    moved_products: list[tuple[Path, Path]] = []
    moved_presentations: list[tuple[Path, Path]] = []
    moved_sources: list[tuple[Path, Path]] = []
    published_outputs: list[tuple[Path, Path]] = []
    created_directories: list[Path] = []
    merger_names: list[str] = []

    try:
        with tempfile.TemporaryDirectory(prefix=".pp-handoff-", dir=root) as temporary_name:
            staging = Path(temporary_name)

            for item in plan["pdfs"]:
                sources = [root / source for source in item["sources"]]
                staged_output = staging / Path(item["destination"]).name
                if item["operation"] == "merge":
                    merger_names.append(merge_pdf(sources, staged_output))
                else:
                    shutil.copy2(sources[0], staged_output)
                if not _valid_pdf(staged_output):
                    raise HandoffError(f"Výsledný soubor {staged_output.name} není platné PDF.")

            products_dir = root / "Produkty"
            if not products_dir.exists():
                products_dir.mkdir()
                created_directories.append(products_dir)
            for item in plan["products"]:
                source = root / item["source"]
                destination = root / item["destination"]
                if destination.exists():
                    raise HandoffError(f"Cílový soubor mezitím vznikl: {destination.name}.")
                source.replace(destination)
                moved_products.append((source, destination))

            for item in plan["presentations"]:
                if item["operation"] != "move":
                    continue
                source = root / item["source"]
                destination = root / item["destination"]
                if not destination.parent.exists():
                    destination.parent.mkdir()
                    created_directories.append(destination.parent)
                if destination.exists():
                    raise HandoffError(f"Cílový soubor mezitím vznikl: {destination.name}.")
                source.replace(destination)
                moved_presentations.append((source, destination))

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
        for source, destination in reversed(moved_presentations):
            if destination.exists():
                destination.replace(source)
        for source, destination in reversed(moved_products):
            if destination.exists():
                destination.replace(source)
        for directory in reversed(created_directories):
            try:
                directory.rmdir()
            except OSError:
                pass
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
        "merger": ", ".join(engines) if engines else None,
    }
