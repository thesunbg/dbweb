# dbweb

Local-first web admin for multiple database engines (MySQL, Postgres, Oracle, MSSQL, MongoDB, Redis, Dragonfly, ClickHouse), inspired by Robo3T / phpMyAdmin but cross-DBMS, bound exclusively to `127.0.0.1`.

![architecture](https://img.shields.io/badge/stack-Node.js%2022%20LTS-339933) ![architecture](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB) ![architecture](https://img.shields.io/badge/backend-Fastify%205-000000)

## Project layout

```
apps/
  server/                  Fastify API server (TypeScript)
    src/
      config.ts            host/port/data-dir env config
      store/sqlite.ts      better-sqlite3, migrations
      store/secrets.ts     AES-256-GCM master-key vault
      store/connections.ts connection-config CRUD
      store/history.ts     query history
      store/saved.ts       saved queries
      services/adapter-pool.ts  per-connection adapter cache (5-min idle reap)
      routes/connections.ts  CRUD endpoints
      routes/db.ts           execute / browse / stats / row-edit / saved
      routes/portability.ts  encrypted bundle export/import
      index.ts               bootstrap

  web/                     Vite + React SPA
    src/
      App.tsx                connection list + sidebar collapse
      components/
        Workbench.tsx        editor + result + tabs
        DbTree.tsx           recursive tree (host → db → coll → indexes/stats)
        TableBrowser.tsx     SQL row browser + filter + inline edit
        Stats.tsx            dashboard (db size, slow queries, charts)
        DocumentModal.tsx    Mongo doc view/edit
        ConnectionForm.tsx   create/edit connection
        PortabilityModal.tsx export/import bundle
      api.ts                 typed client
      lib/export.ts          CSV / JSON download

packages/
  shared-types/            DTOs shared between server and web
  adapters/                Adapter contract + driver wrappers
    src/
      types.ts             DbAdapter contract
      registry.ts          factory map by DbKind
      mysql.ts             mysql2
      postgres.ts          pg
      oracle.ts            oracledb (thin mode by default)
      mssql.ts             tedious
      mongodb.ts           mongodb@3.7 (legacy server compat)
      mongodb-shell.ts     vm-sandboxed shell evaluator
      redis.ts             ioredis (used by both `redis` and `dragonfly` kinds)
      dragonfly.ts         thin Redis-compat alias
      clickhouse.ts        @clickhouse/client (HTTP)
types/
  oracledb.d.ts            type shim for oracledb (driver ships none)
```

## Requirements

- **Node.js 20 or 22 LTS** — avoid Node 21 (no prebuilds for `better-sqlite3` / `keytar` on odd-numbered Node releases)
- pnpm >= 10
- macOS or Linux (Windows untested)

## Run

```bash
nvm use 22       # if you use nvm
pnpm install
pnpm dev          # runs server (4317) + web (4318) in parallel
# or:
pnpm -w run dev:server
pnpm -w run dev:web
```

Open [http://127.0.0.1:4318](http://127.0.0.1:4318).

Production run (single process — Fastify serves the API *and* the built web bundle
from `apps/web/dist`, so 4318 is not needed):

```bash
pnpm build
pnpm serve                           # http://127.0.0.1:4317
```

## Install as a desktop app (macOS + Chrome)

One command builds everything, registers a LaunchAgent so the server is always
running (starts at login, restarts if it crashes), and opens Chrome:

```bash
pnpm app:install
```

Then in the Chrome window that opens, click **⤓ Install** in the dbweb sidebar
(or Chrome's ⋮ menu → *Cast, Save and Share* → *Install page as app…*). dbweb
gets its own window + Dock/Launchpad icon and no longer needs `pnpm dev`.

| Command | What it does |
|---|---|
| `pnpm app:install` | Build + install/refresh the LaunchAgent + launcher + open Chrome |
| `pnpm app:status` | Is the background server up? |
| `pnpm app:restart` | Rebuild after code changes and bounce the service |
| `pnpm app:stop` | Stop it — frees port 4317 so `pnpm dev` can use it |
| `pnpm app:start` | Start it again |
| `pnpm app:logs` | `tail -f ~/.dbweb/logs/server.log` |
| `pnpm app:launcher` | Rebuild `~/Applications/dbweb.app` only |
| `pnpm app:uninstall` | Remove the LaunchAgent + launcher (data in `~/.dbweb` untouched) |

### Idle shutdown

The LaunchAgent sets `DBWEB_IDLE_EXIT_MIN=20`, so the server quits itself after
20 minutes with no requests (in-flight requests hold it open — a long export is
never cut short). It frees ~50MB and closes every pooled DB connection.

Waking it back up is what `~/Applications/dbweb.app` is for: it starts the
service, waits for `/api/health`, then opens the app window. **Launch dbweb from
that icon** (drag it to the Dock) rather than from the Chrome PWA icon, which
can't start a stopped server. Override the timeout with
`DBWEB_IDLE_EXIT_MIN=60 pnpm app:install`, or `0` to keep it running forever.

Notes:

- The background service and `pnpm dev:server` both want port 4317 — run
  `pnpm app:stop` before a dev session.
- The installed app serves the **built** bundle. After changing code run
  `pnpm app:restart`, or use `pnpm dev` on 4318 as usual while developing.
- The service picks Node 22 (then 20) out of `~/.nvm` — never Node 21, which has
  no `better-sqlite3` / `keytar` prebuilds.
- A service worker (`apps/web/public/sw.js`) caches the app shell only; `/api`
  responses are never cached. Monaco still loads from the jsDelivr CDN, so the
  SQL editor needs internet on first load after a build.

## Where data lives

Everything sits under `~/.dbweb/` (override with `DBWEB_DATA_DIR`):

| Path | Contents |
|---|---|
| `dbweb.sqlite` | Connection configs (passwords encrypted), query history, saved queries |
| `dbweb.sqlite-wal`, `-shm` | SQLite WAL journal (auto-managed) |
| `vault.key` | Master AES key — only present when `DBWEB_FILE_VAULT=1` |

The **master encryption key** lives in the **macOS Keychain** by default (service `dbweb`, account `master-key`) via `keytar`. On headless Linux or for a portable setup, set `DBWEB_FILE_VAULT=1` and the key is written to `~/.dbweb/vault.key` with mode 0600.

**UI preferences** are stored in the browser's `localStorage`:
- `dbweb:sidebarCollapsed` — connections sidebar in rail mode
- `dbweb:treeCollapsed` — workbench db-tree collapsed
- `dbweb:editorHeight` — editor pane height (px)
- `dbweb:resultView` — `table` | `json`

### Backup & migrate

- **Recommended**: use the **Export** action in the UI (sidebar `⇅`). It produces a `.dbweb` file encrypted with a passphrase. On the destination machine, **Import** the file using the same passphrase.
- **Manual**: copy the entire `~/.dbweb/` directory **together with** the matching Keychain entry (`Keychain Access → dbweb → master-key`). Copying only the SQLite file without the master key leaves passwords undecryptable — connections will appear in the UI but `Test` will fail authentication.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DBWEB_HOST` | `127.0.0.1` | Bind address. **Keep `127.0.0.1`** unless you intentionally want LAN access |
| `DBWEB_PORT` | `4317` | API server port (web dev port is 4318) |
| `DBWEB_DATA_DIR` | `~/.dbweb` | Where SQLite + vault are stored |
| `DBWEB_FILE_VAULT` | unset | Set to `1` to use a file-based vault instead of the OS Keychain |
| `DBWEB_IDLE_EXIT_MIN` | `0` (off) | Minutes of inactivity before the server exits by itself. The LaunchAgent sets `20`; `pnpm dev` leaves it off |
| `DBWEB_WEB_DIR` | auto | Override the folder served as the web UI (defaults to `apps/web/dist` next to the server) |

## Features

### Supported databases

| Kind | Driver | Default port | Versions tested | CRUD UI | Inline edit |
|---|---|---|---|---|---|
| MySQL | `mysql2` | 3306 | 5.7+ / 8.x | ✓ | ✓ (by PK) |
| PostgreSQL | `pg` | 5432 | 12+ | ✓ | ✓ (by PK) |
| Oracle | `oracledb` thin | 1521 | 12c+ (thin mode) | ✓ | — |
| MSSQL | `tedious` | 1433 | 2017+ | ✓ | — |
| MongoDB | `mongodb@3.7` + `mongodb@6` | 27017 | **2.6 → 8.x** (auto-fallback) | ✓ | ✓ (replace doc) |
| Redis | `ioredis` | 6379 | 4+ | ✓ | — |
| Dragonfly | `ioredis` (Redis-compat) | 6379 | 1.x+ | ✓ | — |
| ClickHouse | `@clickhouse/client` (HTTP) | 8123 | 22+ / 25+ / 26+ | ✓ | — (mutations are async; use `ALTER TABLE … UPDATE` from the workbench) |

### Connection sidebar

- **Filter**: `⌘K` / `Ctrl-K` focuses the search box; every whitespace-separated
  term must match somewhere in the connection (name, kind, host, port, database,
  username, group), so `co my` finds `coolify-mysql`. `Esc` clears it.
- **Groups**: drag a connection onto a group header to file it there, or onto the
  “＋ Thả vào đây để tạo group mới” zone that appears mid-drag to create one.
  Drop on **Ungrouped** to take it back out. Click a header to collapse (kept in
  `localStorage`), double-click to rename the group everywhere.
- Groups are just a `group` column on the connection — no group table — so a
  group exists exactly as long as something is in it. Export bundles carry it;
  bundles made before this feature import as ungrouped.

### Workbench

- **Tabs**: any number of query tabs (`+`, `⌥⌘T`) plus one browse tab per table; tabs and their statements are remembered per connection. Double-click a tab to rename, middle-click to close.
- **Editor**: Monaco with kind-aware syntax highlighting (SQL / JavaScript for Mongo shell / shell). `⌘/Ctrl + Enter` runs the query, or **only the highlighted selection** when there is one. Table and column names autocomplete from whatever the tree has already loaded. `⌁ Format` (sql-formatter) and `◈ Explain` (opens the plan in a new tab) for SQL engines.
- **DB selector + row cap**: the toolbar `DB` dropdown decides which database the statement runs against; `rows` caps the result (50 → 20 000) so large queries don't stall the browser.
- **Result grid**: row numbers, dimmed `NULL`s, click-to-sort headers, a cell inspector strip (full value of the selected cell, `Open ↗` for JSON / long text), keyboard navigation, and a right-click menu (copy cell / row as JSON / CSV / INSERT, set NULL, delete row).
- **Result toggle**: Table view (default) or JSON view (Monaco read-only with fold/unfold). `↓ Export…` downloads or copies CSV / JSON.
- **Resizable**: sidebar, schema tree and editor/result split are all draggable; sizes persist.
- **Browse tab** (SQL): server-side paging with total count, click-to-sort columns, filter builder (`= != > < >= <= LIKE NOT LIKE IN IS NULL`), double-click cell editing with one **Save n rows** commit, row delete, `+ Row` INSERT template, `≡ SQL` to open the current query in the editor, export this page or the whole table (CSV / JSON / Excel).
- **Connection banner**: when the ping fails the workbench shows the error with **Retry** and **Edit connection** instead of silently disabling everything. `⟳` next to the status drops the pooled adapter and reconnects.
- **Stats tab**: cards (size, table count, query count, average latency), 14-day query histogram, slowest queries, top 10 largest tables.
- **History tab**: searchable — Saved queries (named, copy / delete) and every executed statement with status ✓/✕, elapsed time, row count, timestamp; click opens it in a new tab.
- **Theme**: dark (default) or light, toggled from the status bar.

### Robo3T-style tree view

```
▾ host:port (N)                 ← right-click: Server Status, Host Info, Version, Refresh
  ▾ <database>
    ▾ <collection / table>      ← right-click: View / Insert / Update / Remove / Drop / Indexes / Stats
      │ Indexes                 ← click → runs db.coll.getIndexes()
      │ Stats                   ← click → runs db.coll.stats()
    │ DB Stats                  ← click → runs db.stats()
```

### MongoDB — multi-version support

dbweb ships **two MongoDB drivers side-by-side** because no single line covers every server in the wild:

| Driver | Wire versions | Server range |
|---|---|---|
| `mongodb@6.x` (modern) | v8+ | MongoDB **4.2 → 8.x** |
| `mongodb@3.7` (legacy) | v0–9 | MongoDB **2.6 → 4.2** |

The adapter picks one automatically at connect time:

1. **Try modern first.** If the server speaks wire v8+, use it — fastest path, supports the latest features.
2. **Fall back on wire mismatch.** If the modern driver rejects with `Server reports maximum wire version N, but this version of the Node.js Driver requires at least 8`, the dispatcher silently retries with the legacy driver.
3. **Other errors propagate as-is** — auth failures, DNS, network timeouts surface verbatim so the user sees a useful message.

Force a specific driver via connection options if needed:

```json
{ "options": { "driver": "modern" } }   // skip fallback, fail fast on legacy servers
{ "options": { "driver": "legacy" } }   // skip modern probe, useful for old prod fleets
{ "options": { "driver": "auto" } }     // default
```

The shell evaluator routes server commands through `db.command(...)` (e.g. `db.stats()` → `db.command({ dbStats: 1 })`) so the same expression behaves identically on both lines, even where the modern driver dropped the sugar method.

### Full MongoDB shell syntax

Native MongoDB shell expressions run directly in the editor:

```js
db.quote.find({ status: "active" }).sort({ _id: -1 }).limit(10)
db.quote.findOne({ _id: ObjectId("5cd95a06710bed2e066cee83") })
db.quote.countDocuments({})
db.quote.distinct("status")
db.quote.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])

db.quote.insertOne({ text: "...", status: "draft" })
db.quote.updateMany({ status: null }, { $set: { status: "draft" } })
db.quote.deleteOne({ _id: ObjectId("...") })

db.quote.createIndex({ slug: 1 }, { unique: true })
db.quote.getIndexes()
db.quote.dropIndex("slug_1")
db.quote.stats()

db.stats()
db.serverStatus()
db.hostInfo()
db.version()
db.runCommand({ listDatabases: 1 })
```

Helpers automatically available: `ObjectId(...)`, `ISODate(...)`, `Date`, `NumberLong`, `NumberInt`. Cursor methods `.sort()` / `.limit()` / `.skip()` / `.project()` chain naturally. A default `.limit(50)` is injected when the user doesn't set one explicitly.

Blocked commands (safety): `flushall`, `flushdb`, `shutdown`, `config`, `debug`.

### Dragonfly — Redis drop-in

Dragonfly speaks the Redis wire protocol verbatim, so dbweb shares the `ioredis` driver for both. The only reason `dragonfly` exists as a separate kind is so the sidebar can label the connection accurately and the version probe pulls `dragonfly_version:` (instead of `redis_version:`) out of `INFO server`. Same commands, same workbench shortcuts, same key types — pick the kind that matches what's actually running.

### ClickHouse

ClickHouse is reached over its HTTP interface via `@clickhouse/client`. The workbench dispatches per statement:

- **Readonly statements** (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `EXISTS`, `WITH`) go through `client.query()` and stream rows back via `JSONCompactEachRowWithNames` so field names round-trip with their values.
- **Everything else** (DDL, INSERT, ALTER, OPTIMIZE, TRUNCATE, DROP …) goes through `client.command()`; ClickHouse's HTTP API does not return an affected-row count for these, so the result surfaces `affectedRows: 0` to signal "success, no rows reported".

```sql
SHOW DATABASES;
SHOW TABLES FROM default;
DESCRIBE TABLE system.parts;
SELECT version(), now(), hostName();

-- Heavy aggregates work straight in the editor:
SELECT toStartOfHour(event_time) AS h, count() AS n
FROM events
WHERE event_date = today()
GROUP BY h ORDER BY h;

-- Mutations are async — they queue a background mutation rather than blocking:
ALTER TABLE events UPDATE status = 'done' WHERE id = 42;
```

Connection options (passed under `options` on the connection):

| Option | Default | Effect |
|---|---|---|
| `tls` | `false` | Use HTTPS (`https://host:port`) instead of HTTP. Set this when terminating TLS at a proxy like Traefik or Cloudflare. |
| `protocol` | derived from `tls` | Explicit override; either `"http"` or `"https"`. Wins over `tls`. |
| `compression` | `false` | Compress the request body. Response compression stays off because Node's `fetch` handles transfer encoding for us. |

Inline row edit is intentionally disabled for ClickHouse — see the [Inline edit](#inline-row-edit) column in the support table.

> **Coolify gotcha:** the official Coolify v4 ClickHouse template publishes only the native TCP port (9000) through its proxy. Since dbweb's adapter is HTTP-only, the bundled "Make it publicly available" toggle won't reach `8123`. Use `clickhouse.cloud`, a self-managed image with explicit `-p 8123:8123`, or front the container with Traefik/HTTPS routed to 8123.

### Portability — export / import

- **Connection bundle**: `.dbweb` file in the `DBWEB1:salt:iv:tag:ciphertext` format. AES-256-GCM with a key derived from the passphrase (≥8 chars) via scrypt + 16-byte salt. Wrong passphrase → `DECRYPT_FAILED` (GCM auth tag protects against silent corruption).
  - **All connections**: the sidebar `⇅` button exports every connection and imports any bundle (1 or N entries).
  - **Single connection**: `⋯ → Export…` on a row bundles just that connection (filename `dbweb-<name>-<date>.dbweb`). Server-side this is the same endpoint with an `ids` allow-list — omit `ids` for the bulk export. Import is shared: a single-connection bundle just imports one entry.
- **Duplicate**: `⋯ → Duplicate` clones a connection in place (password + options copied), naming it `<name> (copy)`, `(copy 2)`, … to avoid collisions. The new copy is auto-selected.
- **Query result**: CSV or JSON download straight from the result toolbar.

### Security

- Bound to 127.0.0.1 by default — never exposed on LAN unless explicitly reconfigured.
- DB passwords: AES-256-GCM at rest, master key kept separate (Keychain or file vault, mode 0600).
- The server never returns a stored password in any response — it's read internally by the adapter pool only.
- SQLite WAL mode enabled to avoid corruption on concurrent reads/writes.
- MongoDB shell evaluation runs in a `vm` sandbox with a 30-second timeout.

## Advanced features

- **Read-only connections** — tick *Read-only* in the connection form; the server rejects INSERT/UPDATE/DELETE/DDL, row edits, imports and restores with a clear error. Perfect with the red *Production* colour.
- **Cancel** a running statement (■ button) — PostgreSQL and MySQL cancel on the server too.
- **Transactions** — *⎔ Begin tx* turns auto-commit off (PostgreSQL / MySQL); every statement runs on one session until *Commit* / *Rollback*.
- **AI assistant** (✨, `⌘⇧I`) — generate a query from plain language, explain / optimize the editor text, or fix the last error. Needs an Anthropic API key under *Settings*; only table and column names are sent, never rows.
- **Query parameters** — write `:name` (quoted literal) or `{{name}}` (raw) and dbweb asks for values on run, remembering them per connection.
- **Import CSV / Excel** — Tools → Import: map file columns to table columns, preview, insert in batches.
- **Chart** view on any result — bar / line / area / pie, colour-blind-safe palette.
- **ER diagram** — Tools → ER diagram (foreign keys from PostgreSQL / MySQL / SQL Server), export as SVG or mermaid.
- **Find column / table** — `⌘⇧F` searches every column in the current database.
- **Snippets** — a global library with `{{placeholders}}`; insert from the status bar or Tools.
- **Compare** — schema diff (tables, columns, types) between two connections with generated `CREATE/ALTER`, or data diff of one table by primary key with generated `INSERT/UPDATE/DELETE`.
- **Server insights** on the Stats tab — slowest statements (`pg_stat_statements`, `performance_schema`, `dm_exec_query_stats`, `system.query_log`, `v$sql`), active sessions, scan hotspots.
- **Backups** — pg_dump / mysqldump / mongodump into `~/.dbweb/backups`, restore with one click, job log inline. The CLI tools must be installed (`brew install libpq mysql-client mongodb-database-tools`) and `pg_dump` must be at least the server's major version.
- **Scheduled queries & alerts** — run a statement every N minutes or on a cron, alert when the row count / first value crosses a threshold or the query fails. Alerts appear in the status-bar bell and as macOS notifications; the background server stays alive while a schedule is enabled.
- **SSH tunnel** — per connection: jump host, password or private key; every driver then dials the local forward.

## Keyboard shortcuts & UI

| Action | Shortcut / Click |
|---|---|
| Run query (or the highlighted selection) | `⌘ Enter` (mac) / `Ctrl + Enter` (Win/Linux) |
| Save current query | `⌘ S` |
| New query tab | `⌥ ⌘ T` or `+` in the tab bar |
| New connection | `⌥ ⌘ N` or `+ New` in the sidebar |
| Search connections | `⌘ K` |
| Toggle sidebar | `⌘ \` |
| All shortcuts | `?` (or `? Shortcuts` in the status bar) |
| Move between result cells / open a cell / copy it | `↑ ↓ ← →` / `Enter` / `⌘ C` after clicking a cell |
| Connection actions (Copy URL, Edit, Duplicate, Export…, Delete) | `⋯` per-connection — opens an overflow menu; closes on outside click / Escape |
| Export / Import all connections | `⇅` in the sidebar |
| Collapse connections sidebar | `‹` in the sidebar header |
| Collapse db-tree | `‹` in the workbench tree header |
| Toggle Table / JSON view | Segmented control in the editor toolbar |
| Test a connection before saving | `Test connection` in the connection form |
| Environment color | Connection form → red = Production, orange = Staging, … shows as a stripe + pill |
| Right-click host | Server Status / Host Info / Version / Refresh |
| Right-click table or collection | View / Insert / Update / Remove / Drop / Indexes / Stats |
| Drag the pane divider | Resize editor vs result |

## Roadmap

- [ ] Inline `updateRow` for Oracle / MSSQL — needs proper bind-type mapping (currently returns `NOT_SUPPORTED 501`)
- [x] Per-call database context (Postgres per-db pool, MySQL `USE`, MSSQL `USE` prefix, Mongo `db.`)
- [x] `AbortSignal` cancellation for long-running queries (pg / mysql cancel server-side)
- [ ] Robo3T-style hierarchical JSON tree (key / value / type columns) — currently only pretty-printed JSON
- [x] Multiple parallel query tabs
- [ ] ClickHouse native TCP support — current HTTP adapter can't reach Coolify's default proxy mapping
- [ ] Tauri build for a packaged desktop binary

## License

Proprietary / internal use.
