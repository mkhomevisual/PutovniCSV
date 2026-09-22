# PP CSV Editor

Lokální editor jediného pevného CSV pro InDesign Data Merge. Data neopouštějí počítač.

## Spuštění a práce

1. Celou složku `pp-csv-editor` ponechte pohromadě. Pracovní `PP-Masterfile-Labels.csv` leží přímo v ní vedle `start.command`.
2. Dvojklikem spusťte `start.command`. Aplikace si sama vybere volný lokální port a otevře se ve výchozím prohlížeči; okno Terminálu nechte otevřené.
3. Aplikace automaticky načte právě CSV ze své vlastní složky. Díky tomu lze celou složku přenést na jiný Mac bez změny cesty v editoru.
4. Upravte buňky. Editor vždy zobrazí nejméně 50 řádků, takže jsou dole připravená volná místa.
5. Klikněte na **Uložit CSV** nebo stiskněte `Cmd+S`. Aktualizuje se přímo tentýž pevný soubor – neotevírá se výběr názvu ani se nestahuje kopie.
6. Server ukončíte v Terminálu klávesami `Ctrl+C`.

Zelené **+** v levém horním rohu tabulky duplikuje poslední vyplněný řádek a vloží kopii hned pod něj. V každé buňce sloupce `@images` je tlačítko **+ Nahrát**. Vybraný soubor se zkopíruje do složky `logo` uvnitř aplikace a do buňky se zapíše relativní cesta `logo/nazev.ext`. Při shodném názvu se aplikace před přepsáním zeptá.

`index.html` nelze pro tento režim spouštět samostatně dvojklikem: bezpečnostní pravidla Safari i Chromia nedovolují stránce bez lokálního serveru automaticky přepisovat soubor na disku.

Koncové zcela prázdné pracovní řádky se při uložení oříznou, aby InDesign Data Merge nevytvářel prázdné záznamy. Při dalším načtení je editor znovu doplní do minimálního počtu 50. Výstup je vždy UTF-16LE s BOM `FF FE`, CRLF mezi záznamy, přesnými 9 hlavičkami a korektním CSV escapováním.

## Testy

- V terminálu: `node tests/node-tests.js`
- Server a upload log: `python3 -B tests/server-tests.py`
- V prohlížeči: k adrese vypsané v Terminálu přidejte `tests/test-runner.html`

Integrační test UI je chráněný testovacím režimem serveru a nelze jej omylem spustit nad pracovním CSV. Fixture v `tests/fixtures/` je explicitní kopie dodaného referenčního souboru pro ověření 27 řádků, 9 sloupců a popisu délky 404.
