#!/bin/zsh
# Installs dbweb as a background service (launchd) so http://127.0.0.1:4317
# is always up — no `pnpm dev` needed. Then you install it once from Chrome
# as a desktop app (Chrome menu ⋮ → Cast, Save and Share → Install page as app…).
set -e
ROOT="${0:A:h:h}"
LABEL="com.dbweb.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/.dbweb/logs"
UID_="$(id -u)"

echo "▸ Building web + server bundles…"
(cd "$ROOT" && pnpm -r --workspace-concurrency=1 run build)

mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

echo "▸ Writing $PLIST"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/scripts/serve.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <!-- Quit after 20 idle minutes; the dbweb.app launcher starts it again. -->
    <key>DBWEB_IDLE_EXIT_MIN</key><string>${DBWEB_IDLE_EXIT_MIN:-20}</string>
  </dict>
</dict>
</plist>
PLISTEOF

"$ROOT/scripts/make-launcher.sh"

echo "▸ (Re)loading the LaunchAgent"
"$ROOT/scripts/app.sh" stop
if "$ROOT/scripts/app.sh" start; then
  open -a "Google Chrome" "http://127.0.0.1:4317/"
  cat <<'DONE'

dbweb starts on login, quits itself after 20 idle minutes, and lives at
http://127.0.0.1:4317

Last step, once, in the Chrome window that just opened:
  ⋮ menu → Cast, Save and Share → Install page as app…
  (or click ⤓ Install in the dbweb sidebar)

From then on, open dbweb from ~/Applications/dbweb.app (drag it to the Dock).
That launcher wakes the server if it has idled out, then opens the app window.

Logs: ~/.dbweb/logs/server.log     Uninstall: scripts/uninstall-app.sh
DONE
  exit 0
fi

echo "Server did not come up. Check $LOGDIR/server.err.log"
exit 1
