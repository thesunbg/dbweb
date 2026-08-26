#!/bin/zsh
# Production launcher for the dbweb server (also what the LaunchAgent runs).
# One process: Fastify serves /api *and* the built web bundle from apps/web/dist.
set -e
setopt NULL_GLOB          # launchd has no NVM_DIR — unmatched globs must vanish, not abort
ROOT="${0:A:h:h}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

# Adapters ship as TypeScript source, so production runs through tsx too.
# Node 21 has no prebuilds for better-sqlite3/keytar — prefer 22, then 20.
pick_node() {
  for v in "$NVM_DIR"/versions/node/v22.* "$NVM_DIR"/versions/node/v20.*; do
    [ -x "$v/bin/node" ] && { echo "$v/bin"; return; }
  done
  echo ""
}
NODE_BIN="$(pick_node)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

cd "$ROOT/apps/server"
export NODE_ENV=production
exec ./node_modules/.bin/tsx src/index.ts
