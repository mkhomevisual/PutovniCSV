(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PPCsvUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HEADERS = Object.freeze([
    "Název kávy (Nadpis)",
    "Lokace kávy (nadpis)",
    "Druh",
    "Zpracování",
    "Původ",
    "Chuť",
    "Krátký popis (Drip, Bags) 210 znaků",
    "Web",
    "@images"
  ]);

  function bytesFrom(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError("Vstup musí být ArrayBuffer nebo Uint8Array.");
  }

  function decodeUtf16(bytes, littleEndian, offset) {
    if ((bytes.length - offset) % 2 !== 0) {
      throw new Error("Soubor UTF-16 má neúplný poslední znak.");
    }
    let result = "";
    const chunk = [];
    for (let i = offset; i < bytes.length; i += 2) {
      const code = littleEndian
        ? bytes[i] | (bytes[i + 1] << 8)
        : (bytes[i] << 8) | bytes[i + 1];
      chunk.push(code);
      if (chunk.length === 8192) {
        result += String.fromCharCode.apply(null, chunk);
        chunk.length = 0;
      }
    }
    if (chunk.length) result += String.fromCharCode.apply(null, chunk);
    return result;
  }

  function looksLikeUtf16(bytes) {
    const length = Math.min(bytes.length - (bytes.length % 2), 4096);
    if (length < 8) return null;
    let evenZero = 0;
    let oddZero = 0;
    const pairs = length / 2;
    for (let i = 0; i < length; i += 2) {
      if (bytes[i] === 0) evenZero += 1;
      if (bytes[i + 1] === 0) oddZero += 1;
    }
    const evenRatio = evenZero / pairs;
    const oddRatio = oddZero / pairs;
    if (oddRatio > 0.25 && oddRatio > evenRatio * 2.5) return "UTF-16LE (bez BOM, heuristika)";
    if (evenRatio > 0.25 && evenRatio > oddRatio * 2.5) return "UTF-16BE (bez BOM, heuristika)";
    return null;
  }

  function decodeCsvBytes(input) {
    const bytes = bytesFrom(input);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)),
        encoding: "UTF-8 s BOM"
      };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: decodeUtf16(bytes, true, 2), encoding: "UTF-16LE s BOM" };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: decodeUtf16(bytes, false, 2), encoding: "UTF-16BE s BOM" };
    }

    const guessed = looksLikeUtf16(bytes);
    if (guessed && guessed.startsWith("UTF-16LE")) {
      return { text: decodeUtf16(bytes, true, 0), encoding: guessed };
    }
    if (guessed && guessed.startsWith("UTF-16BE")) {
      return { text: decodeUtf16(bytes, false, 0), encoding: guessed };
    }

    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        encoding: "UTF-8 bez BOM"
      };
    } catch (error) {
      throw new Error("Kódování souboru se nepodařilo rozpoznat. Použijte UTF-8 nebo UTF-16 s BOM.");
    }
  }

  function parseDelimited(text, delimiter) {
    if (typeof text !== "string") throw new TypeError("CSV vstup musí být text.");
    const separator = delimiter || ",";
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let justClosedQuote = false;
    let touched = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
            justClosedQuote = true;
          }
        } else {
          field += char;
        }
        touched = true;
        continue;
      }

      if (justClosedQuote) {
        if (char === separator) {
          row.push(field);
          field = "";
          justClosedQuote = false;
          touched = true;
          continue;
        }
        if (char === "\r" || char === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
          justClosedQuote = false;
          touched = false;
          if (char === "\r" && text[i + 1] === "\n") i += 1;
          continue;
        }
        throw new Error(`Neplatný znak za uzavírací uvozovkou na pozici ${i + 1}.`);
      }

      if (char === '"' && field === "") {
        quoted = true;
        touched = true;
      } else if (char === separator) {
        row.push(field);
        field = "";
        touched = true;
      } else if (char === "\r" || char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        touched = false;
        if (char === "\r" && text[i + 1] === "\n") i += 1;
      } else {
        field += char;
        touched = true;
      }
    }

    if (quoted) throw new Error("CSV obsahuje neuzavřenou hodnotu v uvozovkách.");
    if (justClosedQuote || touched || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function parseCsv(text) {
    return parseDelimited(text, ",");
  }

  function parseTsv(text) {
    return parseDelimited(text, "\t");
  }

  function escapeCsvField(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function serializeCsv(rows) {
    if (!Array.isArray(rows)) throw new TypeError("Řádky CSV musí být pole.");
    return rows.map(function (row, index) {
      if (!Array.isArray(row)) throw new TypeError(`Řádek ${index + 1} není pole.`);
      return row.map(escapeCsvField).join(",");
    }).join("\r\n");
  }

  function encodeUtf16LE(text) {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xff;
    out[1] = 0xfe;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      out[2 + i * 2] = code & 0xff;
      out[3 + i * 2] = code >>> 8;
    }
    return out;
  }

  function normalizeDescription(value) {
    return String(value == null ? "" : value)
      .replace(/\n/g, " ")
      .replace(/\r/g, " ")
      .trim()
      .replace(/ +/g, " ");
  }

  function descriptionLength(value) {
    return Array.from(normalizeDescription(value)).length;
  }

  function validateHeaders(actualHeaders) {
    const actual = Array.isArray(actualHeaders) ? actualHeaders : [];
    const missing = HEADERS.filter(function (header) { return !actual.includes(header); });
    const extra = actual.filter(function (header) { return !HEADERS.includes(header); });
    const wrongOrder = [];
    const max = Math.max(actual.length, HEADERS.length);
    for (let i = 0; i < max; i += 1) {
      if (actual[i] !== HEADERS[i]) {
        wrongOrder.push({ position: i + 1, expected: HEADERS[i] || "—", actual: actual[i] || "—" });
      }
    }
    return {
      valid: missing.length === 0 && extra.length === 0 && wrongOrder.length === 0,
      missing: missing,
      extra: extra,
      wrongOrder: wrongOrder
    };
  }

  function validateTable(rows) {
    const headerResult = validateHeaders(rows[0] || []);
    const badRows = [];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].length !== HEADERS.length) {
        badRows.push({ row: i + 1, columns: rows[i].length });
      }
    }
    return {
      valid: headerResult.valid && badRows.length === 0,
      headers: headerResult,
      badRows: badRows
    };
  }

  function createExport(rows) {
    const validation = validateTable(rows);
    if (!validation.valid) throw new Error("CSV nelze exportovat: hlavičky nebo počet sloupců nejsou platné.");
    return encodeUtf16LE(serializeCsv(rows));
  }

  function duplicateLastFilledRow(rows, minimumDataRows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const copy = rows.map(function (row) { return row.slice(); });
    let sourceRow = 0;
    for (let row = copy.length - 1; row >= 1; row -= 1) {
      if (copy[row].some(function (value) { return value !== ""; })) {
        sourceRow = row;
        break;
      }
    }
    if (!sourceRow) return null;
    const newRow = sourceRow + 1;
    copy.splice(newRow, 0, copy[sourceRow].slice());
    const minimum = Number.isFinite(minimumDataRows) ? Math.max(0, minimumDataRows) : 0;
    if (copy.length - 1 > minimum && copy[copy.length - 1].every(function (value) { return value === ""; })) {
      copy.pop();
    }
    return { rows: copy, sourceRow: sourceRow, newRow: newRow };
  }

  return Object.freeze({
    HEADERS: HEADERS,
    decodeCsvBytes: decodeCsvBytes,
    parseCsv: parseCsv,
    parseTsv: parseTsv,
    serializeCsv: serializeCsv,
    encodeUtf16LE: encodeUtf16LE,
    normalizeDescription: normalizeDescription,
    descriptionLength: descriptionLength,
    validateHeaders: validateHeaders,
    validateTable: validateTable,
    createExport: createExport,
    duplicateLastFilledRow: duplicateLastFilledRow
  });
});
