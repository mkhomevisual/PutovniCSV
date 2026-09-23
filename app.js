(function () {
  "use strict";

  const U = window.PPCsvUtils;
  const OUTPUT_NAME = "PP-Masterfile-Labels.csv";
  const API_URL = "/api/csv";
  const HANDOFF_SELECT_URL = "/api/handoff/select";
  const HANDOFF_PROCESS_URL = "/api/handoff/process";
  const MIN_VISIBLE_ROWS = 50;
  const DESCRIPTION_COLUMN = 6;
  const IMAGE_COLUMN = 8;
  const MAX_DESCRIPTION = 210;
  const DISPLAY_HEADERS = [
    "Název kávy",
    "Lokalita",
    "Druh",
    "Zpracování",
    "Původ",
    "Chuť",
    "Krátký popis",
    "Web",
    "Logo"
  ];

  const elements = {};
  const ids = [
    "appShell", "openButton", "welcomeOpenButton", "errorOpenButton",
    "searchInput", "addRowButton", "undoButton", "redoButton", "saveButton",
    "fileSummary", "fileName", "dirtyDot", "dirtyLabel", "rowCount",
    "columnCount", "encodingInfo", "nextInvalidButton", "invalidSummary", "rowTools",
    "selectedRowLabel", "duplicateRowButton", "deleteRowButton", "workspace", "welcomeCard",
    "errorCard", "errorTitle", "errorDetails", "tableRegion", "tableScroll", "dataGrid", "gridHead",
    "gridBody", "noResults", "imageFileInput", "statusMessage", "statusBar", "limitDialog", "limitRows",
    "saveSuccessDialog",
    "handoffButton", "handoffDialog", "selectHandoffFolderButton", "handoffProgress", "handoffPlan",
    "handoffFolderName", "handoffProfileName", "handoffFolderPath", "handoffMessage", "handoffActions", "handoffProductList",
    "handoffPdfList", "handoffNotes", "closeHandoffButton", "processHandoffButton"
  ];

  const state = {
    rows: [],
    fileName: OUTPUT_NAME,
    encoding: "",
    valid: false,
    selectedRow: null,
    undo: [],
    redo: [],
    savedSignature: "",
    editSession: null,
    invalidCursor: -1,
    pendingImageRow: null,
    handoffToken: null,
    handoffStatus: null,
    handoffBusy: false
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    ids.forEach(function (id) { elements[id] = document.getElementById(id); });
    renderHeader();
    bindEvents();
    updateControls();
    loadFixedFile(false);
  }

  function bindEvents() {
    [elements.openButton, elements.welcomeOpenButton, elements.errorOpenButton].forEach(function (button) {
      button.addEventListener("click", function () { loadFixedFile(true); });
    });
    elements.addRowButton.addEventListener("click", addRow);
    elements.duplicateRowButton.addEventListener("click", duplicateSelectedRow);
    elements.deleteRowButton.addEventListener("click", deleteSelectedRow);
    elements.undoButton.addEventListener("click", undo);
    elements.redoButton.addEventListener("click", redo);
    elements.saveButton.addEventListener("click", saveCsv);
    elements.searchInput.addEventListener("input", applySearch);
    elements.nextInvalidButton.addEventListener("click", goToNextInvalid);
    elements.gridBody.addEventListener("focusin", onCellFocus);
    elements.gridBody.addEventListener("input", onCellInput);
    elements.gridBody.addEventListener("focusout", onCellBlur);
    elements.gridBody.addEventListener("keydown", onCellKeydown);
    elements.gridBody.addEventListener("paste", onCellPaste);
    elements.gridBody.addEventListener("click", onGridClick);
    elements.imageFileInput.addEventListener("change", uploadSelectedImage);
    elements.handoffButton.addEventListener("click", openHandoffDialog);
    elements.selectHandoffFolderButton.addEventListener("click", selectHandoffFolder);
    elements.processHandoffButton.addEventListener("click", processHandoffFolder);
    elements.handoffDialog.addEventListener("cancel", function (event) {
      if (state.handoffBusy) event.preventDefault();
    });
    document.addEventListener("keydown", onGlobalKeydown);
    window.addEventListener("beforeunload", function (event) {
      if (isDirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }

  function canReplaceDocument() {
    return !isDirty() || window.confirm("Máte neuložené změny. Opravdu chcete znovu načíst hlavní CSV?");
  }

  async function loadFixedFile(confirmReplacement) {
    if (confirmReplacement && !canReplaceDocument()) return;
    if (window.location.protocol === "file:") {
      const error = new Error("Pevný soubor lze bezpečně načíst a ukládat pouze přes start.command.");
      state.valid = false;
      showLoadError(error);
      setStatus(error.message, "error");
      updateControls();
      return;
    }
    setStatus("Otevírám hlavní přehled etiket…");
    try {
      const response = await fetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, loadFailureMessage(response.status)));
      const decoded = U.decodeCsvBytes(await response.arrayBuffer());
      const rows = U.parseCsv(decoded.text);
      const validation = U.validateTable(rows);

      if (validation.valid) ensureVisibleRows(rows);
      state.rows = rows;
      state.fileName = OUTPUT_NAME;
      state.encoding = decoded.encoding;
      state.valid = validation.valid;
      state.selectedRow = null;
      state.undo = [];
      state.redo = [];
      state.editSession = null;
      state.invalidCursor = -1;
      state.savedSignature = validation.valid ? signature() : "";
      elements.searchInput.value = "";

      if (!validation.valid) {
        showValidationError(validation);
        setStatus("Přehled se nepodařilo bezpečně otevřít.", "error");
      } else {
        renderGrid();
        const filled = filledRowCount();
        setStatus(`Přehled je připraven: ${filled} ${plural(filled, "vyplněná etiketa", "vyplněné etikety", "vyplněných etiket")}.`, "success");
      }
      updateControls();
    } catch (error) {
      state.valid = false;
      showLoadError(error);
      setStatus(error && error.message ? error.message : "Soubor se nepodařilo načíst.", "error");
      updateControls();
    }
  }

  async function responseError(response, fallback) {
    try {
      const data = await response.json();
      return data.error || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function loadFailureMessage(status) {
    if (status === 404) return `Soubor ${OUTPUT_NAME} nebyl nalezen vedle start.command.`;
    if (status === 501) return "Aplikaci obsluhuje starý server. Zavřete jeho Terminál a spusťte znovu start.command.";
    return "Hlavní CSV se nepodařilo načíst. Zavřete Terminál aplikace a spusťte znovu start.command.";
  }

  function ensureVisibleRows(rows) {
    while (rows.length - 1 < MIN_VISIBLE_ROWS) rows.push(new Array(U.HEADERS.length).fill(""));
  }

  function showLoadError(error) {
    elements.welcomeCard.hidden = true;
    elements.tableRegion.hidden = true;
    elements.errorCard.hidden = false;
    elements.errorTitle.textContent = "Hlavní CSV se nepodařilo načíst";
    elements.errorDetails.replaceChildren();
    const paragraph = document.createElement("p");
    paragraph.textContent = error && error.message ? error.message : "Neznámá chyba při čtení CSV.";
    elements.errorDetails.appendChild(paragraph);
  }

  function showValidationError(validation) {
    elements.welcomeCard.hidden = true;
    elements.tableRegion.hidden = true;
    elements.errorCard.hidden = false;
    elements.errorTitle.textContent = "CSV nemá očekávanou strukturu";
    elements.errorDetails.replaceChildren();
    const headers = validation.headers;
    if (headers.missing.length) appendDetailList("Chybějící hlavičky:", headers.missing);
    if (headers.extra.length) appendDetailList("Přebývající nebo chybně pojmenované hlavičky:", headers.extra);
    if (headers.wrongOrder.length) {
      appendDetailList("Odlišné pozice hlaviček:", headers.wrongOrder.map(function (item) {
        return `${item.position}. očekáváno „${item.expected}“, nalezeno „${item.actual}“`;
      }));
    }
    if (validation.badRows.length) {
      appendDetailList("Řádky s jiným počtem sloupců:", validation.badRows.map(function (item) {
        return `CSV řádek ${item.row}: ${item.columns} sloupců místo 9`;
      }));
    }
  }

  function appendDetailList(title, values) {
    const label = document.createElement("p");
    label.textContent = title;
    const list = document.createElement("ul");
    values.forEach(function (value) {
      const item = document.createElement("li");
      item.textContent = value;
      list.appendChild(item);
    });
    elements.errorDetails.append(label, list);
  }

  function renderHeader() {
    const row = document.createElement("tr");
    const corner = document.createElement("th");
    corner.scope = "col";
    const duplicateLastButton = document.createElement("button");
    duplicateLastButton.type = "button";
    duplicateLastButton.className = "duplicate-last-button";
    duplicateLastButton.textContent = "+";
    duplicateLastButton.title = "Duplikovat poslední vyplněný řádek";
    duplicateLastButton.setAttribute("aria-label", "Duplikovat poslední vyplněný řádek");
    duplicateLastButton.addEventListener("click", duplicateLastFilledRow);
    corner.appendChild(duplicateLastButton);
    row.appendChild(corner);
    DISPLAY_HEADERS.forEach(function (header) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = header;
      th.title = header;
      row.appendChild(th);
    });
    elements.gridHead.replaceChildren(row);
  }

  function renderGrid(focusTarget) {
    const fragment = document.createDocumentFragment();
    for (let rowIndex = 1; rowIndex < state.rows.length; rowIndex += 1) {
      const tr = document.createElement("tr");
      tr.dataset.row = String(rowIndex);
      if (state.selectedRow === rowIndex) tr.classList.add("selected");

      const rowHeader = document.createElement("th");
      rowHeader.scope = "row";
      const selector = document.createElement("button");
      selector.type = "button";
      selector.className = "row-selector";
      selector.dataset.row = String(rowIndex);
      selector.textContent = String(rowIndex);
      selector.setAttribute("aria-label", `Vybrat datový řádek ${rowIndex}`);
      rowHeader.appendChild(selector);
      tr.appendChild(rowHeader);

      state.rows[rowIndex].forEach(function (value, columnIndex) {
        const td = document.createElement("td");
        td.dataset.row = String(rowIndex);
        td.dataset.column = String(columnIndex);
        const editor = document.createElement("div");
        editor.className = "cell-editor";
        editor.contentEditable = "plaintext-only";
        if (editor.contentEditable !== "plaintext-only") editor.contentEditable = "true";
        editor.spellcheck = false;
        editor.dataset.row = String(rowIndex);
        editor.dataset.column = String(columnIndex);
        editor.setAttribute("role", "textbox");
        editor.setAttribute("aria-label", `${DISPLAY_HEADERS[columnIndex]}, řádek ${rowIndex}`);
        editor.textContent = value;
        td.appendChild(editor);
        if (columnIndex === DESCRIPTION_COLUMN) {
          td.classList.add("description-cell");
          updateDescriptionCell(td, value);
        }
        if (columnIndex === IMAGE_COLUMN) {
          td.classList.add("image-cell");
          const uploadButton = document.createElement("button");
          uploadButton.type = "button";
          uploadButton.className = "upload-image-button";
          uploadButton.dataset.row = String(rowIndex);
          uploadButton.textContent = "+ Nahrát";
          uploadButton.setAttribute("aria-label", `Nahrát soubor loga pro řádek ${rowIndex}`);
          td.appendChild(uploadButton);
        }
        tr.appendChild(td);
      });
      fragment.appendChild(tr);
    }
    elements.gridBody.replaceChildren(fragment);
    elements.welcomeCard.hidden = true;
    elements.errorCard.hidden = true;
    elements.tableRegion.hidden = false;
    applySearch();
    updateControls();
    if (focusTarget) focusCell(focusTarget.row, focusTarget.column);
  }

  function updateDescriptionCell(td, value) {
    const length = U.descriptionLength(value);
    td.classList.toggle("is-valid", length <= MAX_DESCRIPTION);
    td.classList.toggle("is-invalid", length > MAX_DESCRIPTION);
    let counter = td.querySelector(".char-count");
    if (!counter) {
      counter = document.createElement("span");
      counter.className = "char-count";
      td.appendChild(counter);
    }
    counter.textContent = length > MAX_DESCRIPTION
      ? `${length} / ${MAX_DESCRIPTION} — o ${length - MAX_DESCRIPTION} více`
      : `${length} / ${MAX_DESCRIPTION}`;
  }

  function onCellFocus(event) {
    const editor = event.target.closest(".cell-editor");
    if (!editor) return;
    const row = Number(editor.dataset.row);
    const column = Number(editor.dataset.column);
    selectRow(row);
    if (!state.editSession) {
      state.editSession = { row: row, column: column, before: cloneRows(), startValue: state.rows[row][column] };
    }
  }

  function onCellInput(event) {
    const editor = event.target.closest(".cell-editor");
    if (!editor) return;
    const row = Number(editor.dataset.row);
    const column = Number(editor.dataset.column);
    state.rows[row][column] = editor.innerText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (column === DESCRIPTION_COLUMN) updateDescriptionCell(editor.parentElement, state.rows[row][column]);
    updateControls();
  }

  function onCellBlur(event) {
    const editor = event.target.closest(".cell-editor");
    if (!editor) return;
    commitActiveEdit();
  }

  function commitActiveEdit() {
    if (!state.editSession) return;
    const session = state.editSession;
    state.editSession = null;
    if (state.rows[session.row] && state.rows[session.row][session.column] !== session.startValue) {
      pushUndo(session.before);
    }
    updateControls();
  }

  function onCellKeydown(event) {
    const editor = event.target.closest(".cell-editor");
    if (!editor) return;
    const row = Number(editor.dataset.row);
    const column = Number(editor.dataset.column);
    let target = null;
    if (event.key === "Tab") {
      event.preventDefault();
      const delta = event.shiftKey ? -1 : 1;
      const flat = (row - 1) * U.HEADERS.length + column + delta;
      if (flat >= 0 && flat < (state.rows.length - 1) * U.HEADERS.length) {
        target = { row: Math.floor(flat / U.HEADERS.length) + 1, column: flat % U.HEADERS.length };
      }
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      target = { row: Math.min(state.rows.length - 1, row + 1), column: column };
    } else if (event.key === "ArrowUp" && caretAtBoundary(editor, true)) {
      event.preventDefault();
      target = { row: Math.max(1, row - 1), column: column };
    } else if (event.key === "ArrowDown" && caretAtBoundary(editor, false)) {
      event.preventDefault();
      target = { row: Math.min(state.rows.length - 1, row + 1), column: column };
    } else if (event.key === "ArrowLeft" && caretAtTextEdge(editor, true)) {
      event.preventDefault();
      target = { row: row, column: Math.max(0, column - 1) };
    } else if (event.key === "ArrowRight" && caretAtTextEdge(editor, false)) {
      event.preventDefault();
      target = { row: row, column: Math.min(U.HEADERS.length - 1, column + 1) };
    }
    if (target) {
      commitActiveEdit();
      focusCell(target.row, target.column);
    }
  }

  function caretAtBoundary(editor, top) {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(editor);
    if (top) range.setEnd(selection.anchorNode, selection.anchorOffset);
    else range.setStart(selection.anchorNode, selection.anchorOffset);
    return range.toString().indexOf("\n") === -1;
  }

  function caretAtTextEdge(editor, start) {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || !selection.rangeCount) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (start) range.setEnd(selection.anchorNode, selection.anchorOffset);
    else range.setStart(selection.anchorNode, selection.anchorOffset);
    return range.toString().length === 0;
  }

  function onCellPaste(event) {
    const editor = event.target.closest(".cell-editor");
    if (!editor) return;
    const plain = event.clipboardData && event.clipboardData.getData("text/plain");
    if (plain == null) return;
    const matrix = U.parseTsv(plain);
    if (matrix.length === 1 && matrix[0].length === 1) {
      event.preventDefault();
      insertPlainText(matrix[0][0]);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    event.preventDefault();
    const startRow = Number(editor.dataset.row);
    const startColumn = Number(editor.dataset.column);
    const before = state.editSession ? state.editSession.before : cloneRows();
    const neededLastRow = startRow + matrix.length - 1;
    while (state.rows.length - 1 < neededLastRow) state.rows.push(new Array(U.HEADERS.length).fill(""));
    matrix.forEach(function (pasteRow, rowOffset) {
      pasteRow.forEach(function (value, columnOffset) {
        const column = startColumn + columnOffset;
        if (column < U.HEADERS.length) state.rows[startRow + rowOffset][column] = value;
      });
    });
    state.editSession = null;
    pushUndo(before);
    state.selectedRow = startRow;
    renderGrid({ row: startRow, column: startColumn });
    setStatus(`Vloženo ${matrix.length} × ${Math.max.apply(null, matrix.map(function (row) { return row.length; }))} buněk.`, "success");
  }

  function insertPlainText(text) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    selection.deleteFromDocument();
    const node = document.createTextNode(text);
    const range = selection.getRangeAt(0);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function onGridClick(event) {
    const uploadButton = event.target.closest(".upload-image-button");
    if (uploadButton) {
      chooseImageFile(Number(uploadButton.dataset.row));
      return;
    }
    const selector = event.target.closest(".row-selector");
    if (selector) selectRow(Number(selector.dataset.row));
  }

  function chooseImageFile(row) {
    if (!state.valid || !state.rows[row]) return;
    commitActiveEdit();
    state.pendingImageRow = row;
    selectRow(row);
    elements.imageFileInput.value = "";
    elements.imageFileInput.click();
  }

  async function uploadSelectedImage() {
    const file = elements.imageFileInput.files && elements.imageFileInput.files[0];
    const row = state.pendingImageRow;
    state.pendingImageRow = null;
    if (!file || !state.rows[row]) return;

    setStatus(`Kopíruji ${file.name} do složky logo…`);
    try {
      let response = await sendLogoFile(file, false);
      if (response.status === 409) {
        const overwrite = window.confirm(`Soubor „${file.name}“ už ve složce logo existuje. Chcete ho přepsat?`);
        if (!overwrite) {
          setStatus("Nahrání souboru bylo zrušeno.");
          return;
        }
        response = await sendLogoFile(file, true);
      }
      if (!response.ok) throw new Error(await responseError(response, "Soubor se nepodařilo zkopírovat do složky logo."));
      const result = await response.json();
      const before = cloneRows();
      state.rows[row][IMAGE_COLUMN] = result.path;
      pushUndo(before);
      state.selectedRow = row;
      renderGrid();
      const cell = elements.gridBody.querySelector(`td[data-row="${row}"][data-column="${IMAGE_COLUMN}"]`);
      if (cell) cell.scrollIntoView({ block: "nearest", inline: "nearest" });
      setStatus(`Soubor ${result.name} byl zkopírován do logo a cesta byla vložena do řádku ${row}.`, "success");
    } catch (error) {
      setStatus(`Nahrání se nezdařilo: ${error && error.message ? error.message : "neznámá chyba"}`, "error");
    }
  }

  function sendLogoFile(file, overwrite) {
    const query = new URLSearchParams({ name: file.name });
    if (overwrite) query.set("overwrite", "1");
    return fetch(`/api/logo?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file
    });
  }

  function selectRow(row) {
    if (state.selectedRow === row) return;
    state.selectedRow = row;
    elements.gridBody.querySelectorAll("tr.selected").forEach(function (tr) { tr.classList.remove("selected"); });
    const selected = elements.gridBody.querySelector(`tr[data-row="${row}"]`);
    if (selected) selected.classList.add("selected");
    updateControls();
  }

  function focusCell(row, column) {
    const editor = elements.gridBody.querySelector(`.cell-editor[data-row="${row}"][data-column="${column}"]`);
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function addRow() {
    commitActiveEdit();
    const before = cloneRows();
    state.rows.push(new Array(U.HEADERS.length).fill(""));
    pushUndo(before);
    state.selectedRow = state.rows.length - 1;
    renderGrid({ row: state.selectedRow, column: 0 });
    setStatus(`Přidán řádek ${state.selectedRow}.`, "success");
  }

  function duplicateLastFilledRow() {
    if (!state.valid) return;
    commitActiveEdit();
    const result = U.duplicateLastFilledRow(state.rows, MIN_VISIBLE_ROWS);
    if (!result) {
      setStatus("Není k dispozici žádný vyplněný řádek k duplikování.", "error");
      return;
    }
    const before = cloneRows();
    state.rows = result.rows;
    state.selectedRow = result.newRow;
    pushUndo(before);
    renderGrid({ row: result.newRow, column: 0 });
    setStatus(`Poslední vyplněný řádek ${result.sourceRow} byl duplikován jako řádek ${result.newRow}.`, "success");
  }

  function duplicateSelectedRow() {
    if (!hasSelectedRow()) return;
    commitActiveEdit();
    const before = cloneRows();
    state.rows.splice(state.selectedRow + 1, 0, state.rows[state.selectedRow].slice());
    state.selectedRow += 1;
    pushUndo(before);
    renderGrid({ row: state.selectedRow, column: 0 });
    setStatus(`Řádek byl duplikován jako řádek ${state.selectedRow}.`, "success");
  }

  function deleteSelectedRow() {
    if (!hasSelectedRow()) return;
    const row = state.selectedRow;
    if (!window.confirm(`Opravdu odstranit datový řádek ${row}?`)) return;
    commitActiveEdit();
    const before = cloneRows();
    state.rows.splice(row, 1);
    ensureVisibleRows(state.rows);
    state.selectedRow = state.rows.length > 1 ? Math.min(row, state.rows.length - 1) : null;
    pushUndo(before);
    renderGrid(state.selectedRow ? { row: state.selectedRow, column: 0 } : null);
    setStatus(`Řádek ${row} byl odstraněn.`, "success");
  }

  function hasSelectedRow() {
    return state.selectedRow != null && state.selectedRow > 0 && state.selectedRow < state.rows.length;
  }

  function cloneRows() {
    return state.rows.map(function (row) { return row.slice(); });
  }

  function pushUndo(before) {
    state.undo.push(before);
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    updateControls();
  }

  function undo() {
    commitActiveEdit();
    if (!state.undo.length) return;
    state.redo.push(cloneRows());
    state.rows = state.undo.pop();
    if (state.selectedRow >= state.rows.length) state.selectedRow = state.rows.length > 1 ? state.rows.length - 1 : null;
    renderGrid();
    setStatus("Poslední změna byla vrácena.", "success");
  }

  function redo() {
    commitActiveEdit();
    if (!state.redo.length) return;
    state.undo.push(cloneRows());
    state.rows = state.redo.pop();
    renderGrid();
    setStatus("Změna byla provedena znovu.", "success");
  }

  function applySearch() {
    if (!state.valid) return;
    const query = elements.searchInput.value.trim().toLocaleLowerCase("cs");
    let visible = 0;
    elements.gridBody.querySelectorAll("tr").forEach(function (tr) {
      const rowIndex = Number(tr.dataset.row);
      const matches = !query || state.rows[rowIndex].some(function (value) {
        return value.toLocaleLowerCase("cs").includes(query);
      });
      tr.classList.toggle("search-hidden", !matches);
      tr.querySelectorAll("td").forEach(function (td) {
        const column = Number(td.dataset.column);
        td.classList.toggle("search-match", Boolean(query) && state.rows[rowIndex][column].toLocaleLowerCase("cs").includes(query));
      });
      if (matches) visible += 1;
    });
    elements.noResults.hidden = visible !== 0;
    if (query) setStatus(`Hledání „${elements.searchInput.value}“: ${visible} odpovídajících řádků.`);
  }

  function invalidRows() {
    const invalid = [];
    for (let i = 1; i < state.rows.length; i += 1) {
      const length = U.descriptionLength(state.rows[i][DESCRIPTION_COLUMN]);
      if (length > MAX_DESCRIPTION) invalid.push({ row: i, length: length });
    }
    return invalid;
  }

  function goToNextInvalid() {
    const invalid = invalidRows();
    if (!invalid.length) return;
    state.invalidCursor = (state.invalidCursor + 1) % invalid.length;
    const target = invalid[state.invalidCursor];
    selectRow(target.row);
    focusCell(target.row, DESCRIPTION_COLUMN);
    setStatus(`Řádek ${target.row}: popis má ${target.length} znaků, o ${target.length - MAX_DESCRIPTION} více.`, "error");
  }

  async function saveCsv() {
    if (!state.valid) return;
    commitActiveEdit();
    const invalid = invalidRows();
    if (invalid.length && !(await confirmLimit(invalid))) return;

    let bytes;
    try {
      bytes = U.createExport(rowsForExport());
    } catch (error) {
      setStatus(error.message, "error");
      return;
    }

    try {
      const response = await fetch(API_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes
      });
      if (!response.ok) throw new Error(await responseError(response, "Hlavní CSV se nepodařilo uložit."));
      state.encoding = "UTF-16LE s BOM";
      markSaved();
      setStatus(`${OUTPUT_NAME} byl aktualizován.`, "success");
      showSaveSuccess();
    } catch (error) {
      setStatus(`Uložení se nezdařilo: ${error && error.message ? error.message : "neznámá chyba"}`, "error");
    }
  }

  function rowsForExport() {
    const rows = cloneRows();
    while (rows.length > 1 && rows[rows.length - 1].every(function (value) { return value === ""; })) {
      rows.pop();
    }
    return rows;
  }

  function confirmLimit(invalid) {
    elements.limitRows.replaceChildren();
    invalid.forEach(function (item) {
      const li = document.createElement("li");
      li.textContent = `Řádek ${item.row}: ${item.length} / ${MAX_DESCRIPTION} — o ${item.length - MAX_DESCRIPTION} více`;
      elements.limitRows.appendChild(li);
    });
    return showDialog(elements.limitDialog, "Uložit i tak?", "continue");
  }

  function showDialog(dialog, fallbackMessage, acceptedValue) {
    if (typeof dialog.showModal !== "function") return Promise.resolve(window.confirm(fallbackMessage));
    return new Promise(function (resolve) {
      function onClose() {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === acceptedValue);
      }
      dialog.addEventListener("close", onClose);
      dialog.showModal();
    });
  }

  function showSaveSuccess() {
    if (typeof elements.saveSuccessDialog.showModal === "function") {
      if (!elements.saveSuccessDialog.open) elements.saveSuccessDialog.showModal();
    } else {
      window.alert("Změny byly uloženy.");
    }
  }

  function openHandoffDialog() {
    resetHandoffDialog();
    if (typeof elements.handoffDialog.showModal === "function") {
      elements.handoffDialog.showModal();
    } else {
      window.alert("Tato funkce vyžaduje aktuální verzi Safari nebo Chromu.");
    }
  }

  function resetHandoffDialog() {
    state.handoffToken = null;
    state.handoffStatus = null;
    state.handoffBusy = false;
    elements.handoffProgress.hidden = true;
    elements.handoffProgress.textContent = "";
    elements.handoffProgress.className = "handoff-progress";
    elements.handoffPlan.hidden = true;
    elements.handoffProductList.replaceChildren();
    elements.handoffPdfList.replaceChildren();
    elements.handoffNotes.replaceChildren();
    elements.handoffNotes.hidden = true;
    setHandoffBusy(false);
  }

  function setHandoffBusy(busy) {
    state.handoffBusy = busy;
    elements.handoffButton.disabled = busy;
    elements.selectHandoffFolderButton.disabled = busy;
    elements.closeHandoffButton.disabled = busy;
    elements.processHandoffButton.disabled = busy || state.handoffStatus !== "ready";
  }

  async function selectHandoffFolder() {
    state.handoffToken = null;
    state.handoffStatus = null;
    setHandoffBusy(true);
    elements.handoffPlan.hidden = true;
    elements.handoffProgress.hidden = false;
    elements.handoffProgress.className = "handoff-progress";
    elements.handoffProgress.textContent = "Otevírám systémový výběr složky…";
    try {
      const response = await fetch(HANDOFF_SELECT_URL, { method: "POST" });
      if (response.status === 204) {
        elements.handoffProgress.hidden = true;
        setStatus("Výběr složky byl zrušen.");
        return;
      }
      if (!response.ok) throw new Error(await responseError(response, "Složku se nepodařilo zkontrolovat."));
      const plan = await response.json();
      state.handoffToken = plan.selectionToken || null;
      renderHandoffPlan(plan);
      if (plan.status === "ready") {
        setStatus(`Složka ${plan.prefix} je připravená ke zpracování.`, "success");
      } else if (plan.status === "completed") {
        setStatus(`Složka ${plan.prefix} už je zpracovaná.`, "success");
      } else {
        setStatus(`Složku ${plan.prefix || ""} nelze zpracovat.`, "error");
      }
    } catch (error) {
      state.handoffToken = null;
      state.handoffStatus = "error";
      elements.handoffProgress.hidden = false;
      elements.handoffProgress.className = "handoff-progress is-error";
      elements.handoffProgress.textContent = error && error.message ? error.message : "Složku se nepodařilo vybrat.";
      setStatus(elements.handoffProgress.textContent, "error");
    } finally {
      setHandoffBusy(false);
    }
  }

  function renderHandoffPlan(plan) {
    state.handoffStatus = plan.status;
    elements.handoffProgress.hidden = true;
    elements.handoffPlan.hidden = false;
    elements.handoffPlan.className = `handoff-plan is-${plan.status}`;
    elements.handoffFolderName.textContent = plan.prefix || "Neznámá složka";
    elements.handoffProfileName.textContent = plan.profileLabel || "Typ nerozpoznán";
    elements.handoffProfileName.hidden = !plan.profileLabel;
    elements.handoffFolderPath.textContent = plan.folder || "";
    elements.handoffProductList.replaceChildren();
    elements.handoffPdfList.replaceChildren();

    (plan.products || []).forEach(function (item) {
      const destination = baseName(item.destination);
      if (plan.status === "completed") {
        appendHandoffResult(elements.handoffProductList, destination);
      } else {
        appendHandoffMapping(elements.handoffProductList, item.source ? baseName(item.source) : `…_${item.number}.png`, destination);
      }
    });
    (plan.pdfs || []).forEach(function (item) {
      const destination = baseName(item.destination);
      if (plan.status === "completed") {
        appendHandoffResult(elements.handoffPdfList, destination);
      } else {
        const sources = (item.sources || []).map(function (source, index) {
          return source ? baseName(source) : `…_${item.numbers[index]}.pdf`;
        }).join(" + ");
        appendHandoffMapping(elements.handoffPdfList, sources, destination);
      }
    });

    elements.handoffMessage.className = "handoff-message";
    if (plan.status === "ready") {
      elements.handoffMessage.textContent = `Rozpoznáno: ${plan.profileLabel}. Po potvrzení vznikne ${plan.productCount} pojmenovaných PNG a ${plan.pdfOutputCount} výsledných PDF.`;
    } else if (plan.status === "completed") {
      elements.handoffMessage.classList.add("is-success");
      elements.handoffMessage.textContent = plan.processed === false
        ? "Tato složka už obsahuje všechny hotové výstupy. Nic jsem neměnil."
        : "Hotovo. Produkty i tiskoviny jsou připravené pod výslednými názvy.";
    } else {
      elements.handoffMessage.classList.add("is-error");
      elements.handoffMessage.textContent = "Složka nesplňuje očekávanou strukturu. Níže najdete, co je potřeba opravit.";
    }

    elements.handoffNotes.replaceChildren();
    const errors = plan.errors || [];
    const warnings = plan.warnings || [];
    if (errors.length) appendHandoffNotes("Nelze pokračovat", errors, "error");
    if (warnings.length) appendHandoffNotes("Upozornění", warnings, "warning");
    if (plan.backupFolder) {
      appendHandoffNotes(
        "Záloha původních PDF",
        [`Původních ${plan.pdfSourceCount} číslovaných PDF zůstalo bezpečně uloženo ve složce ${plan.backupFolder}.`],
        "success"
      );
    }
    elements.handoffNotes.hidden = !elements.handoffNotes.childElementCount;
    setHandoffBusy(false);
  }

  function appendHandoffMapping(list, source, destination) {
    const item = document.createElement("li");
    const before = document.createElement("span");
    const arrow = document.createElement("span");
    const after = document.createElement("strong");
    before.textContent = source;
    before.title = source;
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    after.textContent = destination;
    after.title = destination;
    item.append(before, arrow, after);
    list.appendChild(item);
  }

  function appendHandoffResult(list, destination) {
    const item = document.createElement("li");
    item.className = "is-result";
    const check = document.createElement("span");
    const name = document.createElement("strong");
    check.className = "handoff-check";
    check.textContent = "✓";
    check.setAttribute("aria-hidden", "true");
    name.textContent = destination;
    item.append(check, name);
    list.appendChild(item);
  }

  function appendHandoffNotes(title, messages, kind) {
    const section = document.createElement("section");
    const heading = document.createElement("strong");
    const list = document.createElement("ul");
    section.className = `handoff-note is-${kind}`;
    heading.textContent = title;
    messages.forEach(function (message) {
      const item = document.createElement("li");
      item.textContent = message;
      list.appendChild(item);
    });
    section.append(heading, list);
    elements.handoffNotes.appendChild(section);
  }

  function baseName(path) {
    return String(path || "").split("/").pop();
  }

  async function processHandoffFolder() {
    if (!state.handoffToken || state.handoffStatus !== "ready") return;
    setHandoffBusy(true);
    elements.handoffProgress.hidden = false;
    elements.handoffProgress.className = "handoff-progress";
    elements.handoffProgress.textContent = "Přejmenovávám soubory a spojuji potřebná PDF…";
    try {
      const response = await fetch(HANDOFF_PROCESS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectionToken: state.handoffToken })
      });
      if (!response.ok) throw new Error(await responseError(response, "Exporty se nepodařilo zpracovat."));
      const result = await response.json();
      state.handoffToken = null;
      renderHandoffPlan(result);
      setStatus(`Exporty ve složce ${result.prefix} jsou připravené.`, "success");
    } catch (error) {
      elements.handoffProgress.hidden = false;
      elements.handoffProgress.className = "handoff-progress is-error";
      elements.handoffProgress.textContent = error && error.message ? error.message : "Exporty se nepodařilo zpracovat.";
      setStatus(elements.handoffProgress.textContent, "error");
    } finally {
      setHandoffBusy(false);
    }
  }

  function markSaved() {
    state.savedSignature = signature();
    updateControls();
  }

  function signature() {
    return JSON.stringify(state.rows);
  }

  function isDirty() {
    return state.valid && signature() !== state.savedSignature;
  }

  function filledRowCount() {
    if (!state.valid) return 0;
    return state.rows.slice(1).filter(function (row) {
      return row.some(function (value) { return value !== ""; });
    }).length;
  }

  function updateControls() {
    const valid = state.valid;
    const dirty = isDirty();
    const count = valid ? state.rows.length - 1 : 0;
    const filled = valid ? filledRowCount() : 0;
    const invalid = valid ? invalidRows() : [];
    elements.searchInput.disabled = !valid;
    elements.addRowButton.disabled = !valid;
    elements.saveButton.disabled = !valid;
    elements.undoButton.disabled = !valid || state.undo.length === 0;
    elements.redoButton.disabled = !valid || state.redo.length === 0;
    elements.fileName.textContent = state.fileName || "Bez souboru";
    elements.fileSummary.textContent = valid ? "Pevný přehled etiket pro tisk" : "Hlavní přehled etiket";
    elements.dirtyDot.classList.toggle("dirty", dirty);
    elements.dirtyLabel.textContent = valid ? (dirty ? "Neuložené změny" : "Uloženo") : "—";
    elements.rowCount.textContent = valid ? `${count} řádků (${filled} vyplněných)` : "0 datových řádků";
    elements.columnCount.textContent = valid ? `${U.HEADERS.length} sloupců` : "9 sloupců";
    elements.encodingInfo.textContent = `Kódování: ${state.encoding || "—"}`;
    elements.invalidSummary.textContent = `${invalid.length} ${plural(invalid.length, "popis nad limitem", "popisy nad limitem", "popisů nad limitem")}`;
    elements.nextInvalidButton.disabled = !invalid.length;
    elements.nextInvalidButton.classList.toggle("has-issues", invalid.length > 0);
    elements.rowTools.hidden = !hasSelectedRow();
    if (hasSelectedRow()) elements.selectedRowLabel.textContent = `Řádek ${state.selectedRow}`;
  }

  function plural(count, one, few, many) {
    if (count === 1) return one;
    if (count >= 2 && count <= 4) return few;
    return many;
  }

  function setStatus(message, kind) {
    elements.statusMessage.textContent = message;
    elements.statusMessage.className = kind || "";
  }

  function onGlobalKeydown(event) {
    const command = event.metaKey || event.ctrlKey;
    if (!command) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      saveCsv();
    } else if (key === "z" && event.shiftKey) {
      event.preventDefault();
      redo();
    } else if (key === "z") {
      event.preventDefault();
      undo();
    } else if (key === "f" && state.valid) {
      event.preventDefault();
      elements.searchInput.focus();
      elements.searchInput.select();
    } else if (key === "o") {
      event.preventDefault();
      loadFixedFile(true);
    }
  }
})();
