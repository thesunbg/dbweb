#!/bin/zsh
# Control the background dbweb service (see scripts/install-app.sh for setup).
#   ./scripts/app.sh start | stop | restart | status | logs
set -e
ROOT="${0:A:h:h}"
LABEL="com.dbweb.server"
UID_="$(id -u)"
TARGET="gui/$UID_/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

loaded() { launchctl print "$TARGET" >/dev/null 2>&1 }

# bootout is asynchronous: a bootstrap issued while the old job is still tearing
# down fails with EIO, so retry until launchd actually has the job.
ensure_loaded() {
  for i in {1..15}; do
    loaded && return 0
    launchctl bootstrap "gui/$UID_" "$PLIST" >/dev/null 2>&1 || true
    sleep 1
  done
  loaded
}

# tsx compiles every adapter source on boot — a cold start takes ~15s, more on a
# busy machine, so give it a generous window before calling it a failure.
wait_up() {
  for i in {1..60}; do
    curl -fsS http://127.0.0.1:4317/api/health >/dev/null 2>&1 && { echo "up   http://127.0.0.1:4317"; return 0 }
    sleep 1
  done
  echo "timed out — see ~/.dbweb/logs/server.err.log"; return 1
}

case "${1:-status}" in
  start)   ensure_loaded
           launchctl kickstart "$TARGET" >/dev/null 2>&1 || true
           wait_up ;;
  stop)    launchctl bootout "$TARGET" >/dev/null 2>&1 || true
           for i in {1..10}; do loaded || break; sleep 1; done
           echo "stopped (port 4317 is free — 'pnpm dev' can use it again)" ;;
  restart) # picks up code changes: rebuild, then bounce the service
           (cd "$ROOT" && pnpm -r --workspace-concurrency=1 run build)
           ensure_loaded
           launchctl kickstart -k "$TARGET" >/dev/null 2>&1 || true
           wait_up ;;
  status)  if curl -fsS http://127.0.0.1:4317/api/health >/dev/null 2>&1; then
             echo "up   http://127.0.0.1:4317"
           else
             echo "down (start with: pnpm app:start)"
           fi ;;
  logs)    tail -f "$HOME/.dbweb/logs/server.log" ;;
  *)       echo "usage: $0 {start|stop|restart|status|logs}"; exit 2 ;;
esac
