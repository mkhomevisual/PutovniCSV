(function () {
  "use strict";
  const U = window.PPCsvUtils;
  const results = [];

  function assert(condition, message) {
    if (!condition) throw new Error(message || "Podmínka neplatí");
  }

  function equal(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message || "Hodnoty se liší"}: očekáváno ${JSON.stringify(expected)}, získáno ${JSON.stringify(actual)}`);
  }

  function test(name, fn) {
    return Promise.resolve().then(fn).then(function () {
      results.push({ name: name, pass: true });
    }).catch(function (error) {
      results.push({ name: name, pass: false, error: error.message });
    });
  }

  function utf8(text, bom) {
    const bytes = new TextEncoder().encode(text);
    if (!bom) return bytes;
    const out = new Uint8Array(bytes.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(bytes, 3);
    return out;
  }

  function utf16be(text) {
    const out = new Uint8Array(2 + text.length * 2);
    out.set([0xfe, 0xff]);
    for (let i = 0; i < text.length; i += 1) {
      out[2 + i * 2] = text.charCodeAt(i) >>> 8;
      out[3 + i * 2] = text.charCodeAt(i) & 0xff;
    }
    return out;
  }

  async function run() {
    const sample = `${U.HEADERS.join(",")}\nŽluťoučký kůň,Praha,,,,,,,logo/café.svg`;
    await test("UTF-8 vstup bez BOM", function () {
      const decoded = U.decodeCsvBytes(utf8(sample, false));
      equal(decoded.encoding, "UTF-8 bez BOM");
      equal(U.parseCsv(decoded.text)[1][0], "Žluťoučký kůň");
    });
    await test("UTF-8 vstup s BOM", function () {
      const decoded = U.decodeCsvBytes(utf8(sample, true));
      equal(decoded.encoding, "UTF-8 s BOM");
      equal(decoded.text[0], "N");
    });
    await test("UTF-16LE vstup s BOM", function () {
      const decoded = U.decodeCsvBytes(U.encodeUtf16LE(sample));
      equal(decoded.encoding, "UTF-16LE s BOM");
      equal(decoded.text, sample);
    });
    await test("UTF-16BE vstup s BOM", function () {
      const decoded = U.decodeCsvBytes(utf16be(sample));
      equal(decoded.encoding, "UTF-16BE s BOM");
      equal(decoded.text, sample);
    });
    await test("Česká diakritika zůstane zachována", function () {
      equal(U.parseCsv(U.serializeCsv([["Příliš žluťoučký kůň"]]))[0][0], "Příliš žluťoučký kůň");
    });
    await test("Čárka uvnitř buňky", function () {
      equal(U.parseCsv('a,"b,c",d')[0][1], "b,c");
    });
    await test("Escapované uvozovky uvnitř buňky", function () {
      equal(U.parseCsv('a,"řekl ""ahoj""",d')[0][1], 'řekl "ahoj"');
    });
    await test("Multiline hodnota", function () {
      equal(U.parseCsv('a,"první\ndruhý",c')[0][1], "první\ndruhý");
    });
    await test("Prázdná buňka", function () {
      equal(U.parseCsv("a,,c")[0][1], "");
    });
    await test("Přesně 210 znaků je validních", function () {
      equal(U.descriptionLength("x".repeat(210)), 210);
      assert(U.descriptionLength("x".repeat(210)) <= 210);
    });
    await test("211 znaků překračuje limit", function () {
      equal(U.descriptionLength("x".repeat(211)), 211);
      assert(U.descriptionLength("x".repeat(211)) > 210);
    });
    await test("CR a LF se pro výpočet nahradí mezerou", function () {
      equal(U.normalizeDescription("A\r\nB\nC\rD"), "A B C D");
      equal(U.descriptionLength("A\r\nB\nC\rD"), 7);
    });
    await test("TRIM a opakované mezery", function () {
      equal(U.normalizeDescription("   jedna    dvě   "), "jedna dvě");
      equal(U.descriptionLength("   jedna    dvě   "), 9);
    });
    await test("Unicode znaky se počítají jako znaky", function () {
      equal(U.descriptionLength("☕😀"), 2);
    });
    await test("CSV parse → serialize → parse round-trip", function () {
      const original = [["a", "b,c", 'd"e'], ["", "více\nřádků", "čaj"]];
      equal(JSON.stringify(U.parseCsv(U.serializeCsv(original))), JSON.stringify(original));
    });
    await test("UTF-16LE export obsahuje BOM FF FE", function () {
      const bytes = U.encodeUtf16LE("test");
      equal(bytes[0], 0xff);
      equal(bytes[1], 0xfe);
    });
    await test("CSV výstup používá CRLF mezi záznamy", function () {
      equal(U.serializeCsv([["a"], ["b"]]), "a\r\nb");
    });
    await test("Hlavička @images zůstane zachována", function () {
      const parsed = U.parseCsv(U.serializeCsv([U.HEADERS]));
      equal(parsed[0][8], "@images");
    });
    await test("Validní tabulka má přesně 9 sloupců", function () {
      const rows = [U.HEADERS, new Array(9).fill("")];
      assert(U.validateTable(rows).valid);
      assert(U.parseCsv(U.serializeCsv(rows)).every(function (row) { return row.length === 9; }));
    });
    await test("Chybné hlavičky a délky řádků se odmítnou", function () {
      const rows = [U.HEADERS.slice().reverse(), ["jen jedna"]];
      const validation = U.validateTable(rows);
      assert(!validation.valid);
      assert(validation.headers.wrongOrder.length > 0);
      equal(validation.badRows[0].columns, 1);
    });
    await test("Reálný fixture: 27 řádků, 9 sloupců, jeden popis délky 404", async function () {
      const response = await fetch("fixtures/PP-Masterfile-Labels.fixture.csv");
      assert(response.ok, "Fixture nelze načíst; spusťte testy přes start.command");
      const decoded = U.decodeCsvBytes(await response.arrayBuffer());
      const rows = U.parseCsv(decoded.text);
      equal(rows.length, 28, "Celkový počet řádků");
      assert(rows.every(function (row) { return row.length === 9; }), "Všechny řádky musí mít 9 sloupců");
      assert(U.validateHeaders(rows[0]).valid, "Hlavičky nejsou přesné");
      const over = rows.slice(1).map(function (row, index) {
        return { row: index + 1, length: U.descriptionLength(row[6]) };
      }).filter(function (item) { return item.length > 210; });
      equal(over.length, 1, "Počet popisů nad limitem");
      equal(over[0].length, 404, "Délka problematického popisu");
      assert(U.descriptionLength("x".repeat(210)) <= 210, "210 znaků musí být validních");
    });
    await test("Duplikace posledního vyplněného řádku zachová 50 míst", function () {
      const rows = [U.HEADERS, ["První", "", "", "", "", "", "", "", "logo/a.svg"]];
      while (rows.length < 51) rows.push(new Array(9).fill(""));
      const result = U.duplicateLastFilledRow(rows, 50);
      equal(result.sourceRow, 1);
      equal(result.newRow, 2);
      equal(result.rows.length, 51);
      equal(result.rows[2][8], "logo/a.svg");
    });

    const list = document.getElementById("results");
    results.forEach(function (result) {
      const item = document.createElement("li");
      item.className = result.pass ? "pass" : "fail";
      item.textContent = result.pass ? `✓ ${result.name}` : `✗ ${result.name}: ${result.error}`;
      list.appendChild(item);
    });
    const passed = results.filter(function (result) { return result.pass; }).length;
    const summary = document.getElementById("summary");
    summary.textContent = `${passed}/${results.length} testů prošlo.`;
    summary.className = passed === results.length ? "pass" : "fail";
    document.title = `${passed === results.length ? "✓" : "✗"} ${passed}/${results.length} – PP CSV Editor`;
  }

  run();
})();
