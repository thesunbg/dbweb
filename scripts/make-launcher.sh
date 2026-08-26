#!/bin/zsh
# Builds ~/Applications/dbweb.app — a tiny launcher that starts the background
# server (which exits on its own when idle) and then opens the app window.
# Click this instead of the Chrome PWA icon and dbweb is always "cold-start safe".
set -e
setopt NULL_GLOB
ROOT="${0:A:h:h}"
APP="$HOME/Applications/dbweb.app"
LABEL="com.dbweb.server"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>dbweb</string>
  <key>CFBundleDisplayName</key><string>dbweb</string>
  <key>CFBundleIdentifier</key><string>com.dbweb.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>dbweb</string>
  <key>CFBundleIconFile</key><string>dbweb</string>
  <!-- No Dock icon: the launcher hands off to the browser window and exits. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/dbweb" <<LAUNCHER
#!/bin/zsh
setopt NULL_GLOB
LABEL="$LABEL"
TARGET="gui/\$(id -u)/\$LABEL"
PLIST="\$HOME/Library/LaunchAgents/\$LABEL.plist"
URL="http://127.0.0.1:4317/"

up() { curl -fsS "\${URL}api/health" >/dev/null 2>&1 }

if ! up; then
  launchctl bootstrap "gui/\$(id -u)" "\$PLIST" >/dev/null 2>&1 || true
  launchctl kickstart "\$TARGET" >/dev/null 2>&1 || true
  for i in {1..60}; do
    up && break
    sleep 1
  done
fi

if ! up; then
  osascript -e 'display alert "dbweb không khởi động được" message "Xem log: ~/.dbweb/logs/server.err.log" as critical'
  exit 1
fi

# Prefer the window Chrome installed (its own identity + icon); otherwise ask
# Chrome directly for an app-mode window — "open --args" is ignored when Chrome
# is already running, the binary is not.
PWA=(\$HOME/Applications/Chrome\ Apps*/dbweb.app)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -n "\$PWA" ]; then
  open -a "\$PWA[1]"
elif [ -x "\$CHROME" ]; then
  "\$CHROME" --app="\$URL" >/dev/null 2>&1 &
else
  open "\$URL"
fi
LAUNCHER
chmod +x "$APP/Contents/MacOS/dbweb"

# Icon: reuse the PWA artwork so launcher and installed app look identical.
SRC="$ROOT/apps/web/public/icon-512.png"
if [ -f "$SRC" ]; then
  ICONSET="$(mktemp -d)/dbweb.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    sips -z $size $size "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  done
  # @2x variants are just the next size up under a different name.
  cp "$ICONSET/icon_32x32.png"   "$ICONSET/icon_16x16@2x.png"
  cp "$ICONSET/icon_64x64.png"   "$ICONSET/icon_32x32@2x.png"
  cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
  rm -f "$ICONSET/icon_64x64.png"
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/dbweb.icns"
fi

# Nudge Finder/Launchpad to pick up the new bundle + icon.
touch "$APP"
echo "▸ Launcher: $APP"
