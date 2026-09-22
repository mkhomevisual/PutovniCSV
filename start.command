#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"

cd "$SCRIPT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Pro spuštění lokálního serveru je potřeba Python 3."
  echo "Aplikaci můžete stále otevřít dvojklikem na index.html."
  read "?Stiskněte Enter pro zavření…"
  exit 1
fi

exec python3 "$SCRIPT_DIR/server.py" --port 0 --open-browser
