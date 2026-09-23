# PP CSV Editor

Lokální editor jediného pevného CSV pro InDesign Data Merge a příprava exportů firemních nabídek. Data neopouštějí počítač.

## Spuštění a práce

1. Celou složku `pp-csv-editor` ponechte pohromadě. Pracovní `PP-Masterfile-Labels.csv` leží přímo v ní vedle `start.command`.
2. Dvojklikem spusťte `start.command`. Aplikace si sama vybere volný lokální port a otevře se ve výchozím prohlížeči; okno Terminálu nechte otevřené.
3. Aplikace automaticky načte právě CSV ze své vlastní složky. Díky tomu lze celou složku přenést na jiný Mac bez změny cesty v editoru.
4. Upravte buňky. Editor vždy zobrazí nejméně 50 řádků, takže jsou dole připravená volná místa.
5. Klikněte na **Uložit CSV** nebo stiskněte `Cmd+S`. Aktualizuje se přímo tentýž pevný soubor – neotevírá se výběr názvu ani se nestahuje kopie.
6. Server ukončíte v Terminálu klávesami `Ctrl+C`.

Po úspěšném uložení aplikace zobrazí potvrzovací okno **Změny byly uloženy**.

Zelené **+** v levém horním rohu tabulky duplikuje poslední vyplněný řádek a vloží kopii hned pod něj. V každé buňce sloupce `@images` je tlačítko **+ Nahrát**. Vybraný soubor se zkopíruje do složky `logo` uvnitř aplikace a do buňky se zapíše relativní cesta `logo/nazev.ext`. Při shodném názvu se aplikace před přepsáním zeptá.

`index.html` nelze pro tento režim spouštět samostatně dvojklikem: bezpečnostní pravidla Safari i Chromia nedovolují stránce bez lokálního serveru automaticky přepisovat soubor na disku.

Koncové zcela prázdné pracovní řádky se při uložení oříznou, aby InDesign Data Merge nevytvářel prázdné záznamy. Při dalším načtení je editor znovu doplní do minimálního počtu 50. Výstup je vždy UTF-16LE s BOM `FF FE`, CRLF mezi záznamy, přesnými 9 hlavičkami a korektním CSV escapováním.

## Příprava exportů

Tlačítko **Připravit exporty** otevře samostatné okno. Po kliknutí na **Vybrat složku…** zvolte hlavní složku, například `Holandia` nebo `Nicaraguer`. Název této složky se automaticky použije jako prefix všech výsledků; původní názvy exportů nejsou důležité, rozhodují číselné přípony. Vstupní PNG mohou být už v `Produkty`, nebo volně v hlavní složce společně s PDF. Aplikace sama rozpozná jeden ze dvou typů:

- **Firemní nabídka:** 6 PNG, 10 číslovaných PDF a jedno PDF se suffixem `_Prezentace.pdf`.
- **Lokální káva:** 5 PNG a 8 PDF.

Aplikace nejprve jen zkontroluje strukturu, zobrazí rozpoznaný typ a ukáže náhled všech změn. Soubory změní až tlačítko **Přejmenovat a spojit**.

### Firemní nabídka

- `Produkty/*_01.png` až `*_06.png` přejmenuje na `VandrBag_Front`, `VandrBag_Back`, `VandrDrip_Front`, `VandrDrip_Back`, `250g_Front` a `250g_Back`.
- PDF `*_01.pdf` až `*_10.pdf` spojí v pořadí po dvojicích do `VandrDrip`, `75g`, `250g`, `150g` a `VandrBag`.
- Prezentaci z hlavní složky přejmenuje na `<název>_Prezentace.pdf` a přesune do automaticky vytvořené složky `Prezentace`. Pokud už prezentace ve složce `Prezentace` je, ponechá ji na místě.

### Lokální káva

- `Produkty/*_01.png` až `*_05.png` přejmenuje na `VandrBag_Back`, `VandrBag_Front`, `VandrDrip_Back`, `VandrDrip_Front` a `Pytlik_250g`.
- PDF `*_01.pdf` až `*_04.pdf` přejmenuje na `250g`, `500g`, `1kg` a `Kolky`.
- PDF `*_05.pdf` + `*_06.pdf` spojí do `VandrDrip`; `*_07.pdf` + `*_08.pdf` spojí do `VandrBag`.

Pro oba typy platí:

- Pokud složka `Produkty` neexistuje, aplikace ji vytvoří a přesune do ní přejmenované PNG. Přijímá číslování `_01` i `_1`.
- Existující výsledné soubory nikdy bez upozornění nepřepisuje.
- Před změnou názvů nejprve připraví všechna výsledná PDF. Původní číslovaná PDF potom uloží do složky `_backup_<název>`, například `_backup_Holandia` nebo `_backup_Nicaraguer`.

Spojování PDF používá systémovou funkci macOS. Při zrušení výběru, chybějícím souboru, duplicitním čísle nebo kolizi názvu se nic nezmění.

## Testy

- V terminálu: `node tests/node-tests.js`
- Server a upload log: `python3 -B tests/server-tests.py`
- Zpracování exportů: `python3 -B tests/handoff-tests.py`
- V prohlížeči: k adrese vypsané v Terminálu přidejte `tests/test-runner.html`

Integrační test UI je chráněný testovacím režimem serveru a nelze jej omylem spustit nad pracovním CSV. Fixture v `tests/fixtures/` je explicitní kopie dodaného referenčního souboru pro ověření 27 řádků, 9 sloupců a popisu délky 404.
