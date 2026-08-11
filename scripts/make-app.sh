#!/bin/zsh
# Buduje klikalną aplikację .app dla macOS.
#
# Ścieżka do projektu jest liczona w locie z położenia tego skryptu, więc
# .app działa u każdego, kto sklonuje repo (wcześniej była zaszyta na sztywno).
#
#   ./scripts/make-app.sh                 -> ~/Applications/<nazwa>.app
#   ./scripts/make-app.sh ~/Desktop       -> na Pulpicie
#
# Wymaga: npm install (Electron musi być w node_modules).

set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
APP_NAME="$(node -p "require('$PROJECT_DIR/package.json').productName || 'SuperGrok Desktop'")"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version || '0.0.0'")"
DEST_DIR="${1:-$HOME/Applications}"
APP_DIR="$DEST_DIR/$APP_NAME.app"
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Brak Electrona. Najpierw: cd '$PROJECT_DIR' && npm install" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

# Ikona (opcjonalna)
if [[ -f "$PROJECT_DIR/assets/GrokSessions.icns" ]]; then
  cp "$PROJECT_DIR/assets/GrokSessions.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"
fi

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>pl.sosky.supergrok-desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP_DIR/Contents/MacOS/launcher" <<LAUNCHER
#!/bin/zsh
set -e
APP_DIR="$PROJECT_DIR"
ELECTRON_BIN="\$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG="\${TMPDIR:-/tmp}/supergrok-desktop.log"

if [[ ! -x "\$ELECTRON_BIN" ]]; then
  osascript -e 'display alert "$APP_NAME" message "Brak Electrona w projekcie. Uruchom: npm install w katalogu projektu." as critical'
  exit 1
fi

cd "\$APP_DIR" || exit 1
# exec = jeden wpis w Docku (bez procesu-rodzica)
exec "\$ELECTRON_BIN" "\$APP_DIR" >>"\$LOG" 2>&1
LAUNCHER

chmod +x "$APP_DIR/Contents/MacOS/launcher"
printf 'APPL????' > "$APP_DIR/Contents/PkgInfo"
touch "$APP_DIR"

echo "Gotowe: $APP_DIR"
echo "Projekt: $PROJECT_DIR"
echo
echo "Aplikacja nie jest podpisana. Przy pierwszym uruchomieniu macOS może ją"
echo "zablokować: kliknij prawym > Otwórz, albo Ustawienia > Prywatność."
