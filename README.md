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

Production build:

```bash
pnpm build
pnpm --filter @dbweb/server start    # serves the built server (node dist/index.js)
```

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

### Workbench

- **Editor**: Monaco with kind-aware syntax highlighting (SQL / JSON / shell). `Cmd/Ctrl + Enter` runs the query — works even when the editor is focused, because the binding is registered through `editor.addCommand`.
- **Result toggle**: Table view (default) or JSON view (Monaco read-only with fold/unfold).
- **Resizable**: drag the divider between editor and result to adjust the split. Persisted to localStorage.
- **Browse tab** (SQL): table viewer with per-column filter builder (`= != > < >= <= LIKE IS NULL`), pagination, in-place cell editing keyed by primary key, save per row.
- **Stats tab**: cards (size, table count, query count, average latency), 14-day query histogram, top 5 slowest queries, top 10 largest tables.
- **History tab**: two sections — Saved queries (named, click to load) and History (every executed statement with status ✓/✕, elapsed time, row count, timestamp).
- **Export**: query result → CSV (RFC 4180-compliant) or JSON download.

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
- **Query result**: CSV or JSON download straight from the result toolbar.

### Security

- Bound to 127.0.0.1 by default — never exposed on LAN unless explicitly reconfigured.
- DB passwords: AES-256-GCM at rest, master key kept separate (Keychain or file vault, mode 0600).
- The server never returns a stored password in any response — it's read internally by the adapter pool only.
- SQLite WAL mode enabled to avoid corruption on concurrent reads/writes.
- MongoDB shell evaluation runs in a `vm` sandbox with a 30-second timeout.

## Keyboard shortcuts & UI

| Action | Shortcut / Click |
|---|---|
| Run query | `⌘ Enter` (mac) / `Ctrl + Enter` (Win/Linux) |
| New connection | `+` in the sidebar |
| Connection actions (Copy URL, Edit, Delete) | `⋯` per-connection — opens an overflow menu; closes on outside click / Escape |
| Export / Import | `⇅` in the sidebar |
| Collapse connections sidebar | `‹` in the sidebar header |
| Collapse db-tree | `‹` in the workbench tree header |
| Toggle Table / JSON view | Segmented control in the editor toolbar |
| Save current query | `☆ Save` button (prompts for a name) |
| Right-click host | Server Status / Host Info / Version / Refresh |
| Right-click table or collection | View / Insert / Update / Remove / Drop / Indexes / Stats |
| Drag the pane divider | Resize editor vs result |

## Roadmap

- [ ] Inline `updateRow` for Oracle / MSSQL — needs proper bind-type mapping (currently returns `NOT_SUPPORTED 501`)
- [ ] PostgreSQL multi-database browse — today the configured database is used and the `database` param is treated as a schema
- [ ] `AbortSignal` cancellation for long-running queries
- [ ] Robo3T-style hierarchical JSON tree (key / value / type columns) — currently only pretty-printed JSON
- [ ] Multiple parallel query tabs
- [ ] ClickHouse native TCP support — current HTTP adapter can't reach Coolify's default proxy mapping
- [ ] Tauri build for a packaged desktop binary

## License

Proprietary / internal use.
