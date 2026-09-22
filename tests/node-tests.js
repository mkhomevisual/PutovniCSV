#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const U = require("../csv-utils.js");
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "Podmínka neplatí");
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "Hodnoty se liší"}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}: ${error.message}`);
  }
}

function utf8(text, bom) {
  const data = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]) : data;
}

function utf16be(text) {
  const data = Buffer.alloc(2 + text.length * 2);
  data[0] = 0xfe;
  data[1] = 0xff;
  for (let i = 0; i < text.length; i += 1) {
    data[2 + i * 2] = text.charCodeAt(i) >>> 8;
    data[3 + i * 2] = text.charCodeAt(i) & 0xff;
  }
  return data;
}

const sample = `${U.HEADERS.join(",")}\nŽluťoučký kůň,Praha,,,,,,,logo/café.svg`;

test("UTF-8 bez BOM", function () { equal(U.decodeCsvBytes(utf8(sample, false)).text, sample); });
test("UTF-8 s BOM", function () { equal(U.decodeCsvBytes(utf8(sample, true)).text, sample); });
test("UTF-16LE s BOM", function () { equal(U.decodeCsvBytes(U.encodeUtf16LE(sample)).text, sample); });
test("UTF-16BE s BOM", function () { equal(U.decodeCsvBytes(utf16be(sample)).text, sample); });
test("Česká diakritika", function () { equal(U.parseCsv(U.serializeCsv([["Příliš žluťoučký kůň"]]))[0][0], "Příliš žluťoučký kůň"); });
test("Čárka v buňce", function () { equal(U.parseCsv('a,"b,c",d')[0][1], "b,c"); });
test("Uvozovky v buňce", function () { equal(U.parseCsv('a,"b""c",d')[0][1], 'b"c'); });
test("Multiline hodnota", function () { equal(U.parseCsv('a,"b\nc",d')[0][1], "b\nc"); });
test("Prázdná buňka", function () { equal(U.parseCsv("a,,c")[0][1], ""); });
test("210 znaků je validních", function () { equal(U.descriptionLength("x".repeat(210)), 210); });
test("211 znaků je nevalidních", function () { equal(U.descriptionLength("x".repeat(211)), 211); });
test("CR/LF se nahradí mezerou", function () { equal(U.normalizeDescription("A\r\nB\nC\rD"), "A B C D"); });
test("TRIM a redukce mezer", function () { equal(U.normalizeDescription("  A    B  "), "A B"); });
test("Unicode code points", function () { equal(U.descriptionLength("☕😀"), 2); });
test("CSV round-trip", function () {
  const rows = [["a", "b,c", 'd"e'], ["", "b\nc", "č"]];
  equal(JSON.stringify(U.parseCsv(U.serializeCsv(rows))), JSON.stringify(rows));
});
test("UTF-16LE BOM", function () {
  const bytes = U.encodeUtf16LE("abc");
  assert(bytes[0] === 0xff && bytes[1] === 0xfe);
});
test("CRLF výstup", function () { equal(U.serializeCsv([["a"], ["b"]]), "a\r\nb"); });
test("Hlavička @images", function () { equal(U.parseCsv(U.serializeCsv([U.HEADERS]))[0][8], "@images"); });
test("Přesně 9 sloupců", function () {
  const rows = [U.HEADERS, new Array(9).fill("")];
  assert(U.validateTable(rows).valid);
  assert(rows.every(function (row) { return row.length === 9; }));
});
test("Reálný fixture", function () {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "PP-Masterfile-Labels.fixture.csv"));
  const rows = U.parseCsv(U.decodeCsvBytes(fixture).text);
  equal(rows.length, 28, "1 hlavička + 27 datových řádků");
  assert(rows.every(function (row) { return row.length === 9; }), "Každý řádek má 9 sloupců");
  assert(U.validateHeaders(rows[0]).valid, "Přesné hlavičky");
  const over = rows.slice(1).map(function (row) { return U.descriptionLength(row[6]); }).filter(function (length) { return length > 210; });
  equal(over.length, 1, "Jeden popis nad limitem");
  equal(over[0], 404, "Délka popisu");
});
test("Export lze znovu načíst", function () {
  const rows = [U.HEADERS, ["Česká", "", "", "", "", "", "řádek\ndva", "", "logo/test.svg"]];
  const bytes = U.createExport(rows);
  const decoded = U.decodeCsvBytes(bytes);
  const reparsed = U.parseCsv(decoded.text);
  equal(JSON.stringify(reparsed), JSON.stringify(rows));
  equal(decoded.encoding, "UTF-16LE s BOM");
});
test("Duplikace posledního vyplněného řádku zachová 50 míst", function () {
  const rows = [U.HEADERS, ["První", "", "", "", "", "", "", "", "logo/a.svg"]];
  while (rows.length < 51) rows.push(new Array(9).fill(""));
  const result = U.duplicateLastFilledRow(rows, 50);
  equal(result.sourceRow, 1);
  equal(result.newRow, 2);
  equal(result.rows.length, 51);
  equal(result.rows[2][0], "První");
  equal(result.rows[2][8], "logo/a.svg");
});

console.log(`\n${passed}/${passed + failed} testů prošlo.`);
if (failed) process.exitCode = 1;
