# dbweb

Local-first web admin cho nhiều loại database (MySQL, Postgres, Oracle, MSSQL, MongoDB, Redis), inspired bởi Robo3T / phpMyAdmin nhưng đa-DBMS, chạy duy nhất trên `127.0.0.1`.

![architecture](https://img.shields.io/badge/stack-Node.js%2022%20LTS-339933) ![architecture](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB) ![architecture](https://img.shields.io/badge/backend-Fastify%205-000000)

## Cấu trúc

```
apps/
  server/                  Fastify API server (TypeScript)
    src/
      config.ts            host/port/data-dir env config
      store/sqlite.ts      better-sqlite3, migrations
      store/secrets.ts     AES-256-GCM master-key vault
      store/connections.ts CRUD connection configs
      store/history.ts     query history
      store/saved.ts       saved queries
      services/adapter-pool.ts  per-connection adapter cache (5min idle reap)
      routes/connections.ts  CRUD endpoints
      routes/db.ts          execute / browse / stats / row-edit / saved
      routes/portability.ts encrypted bundle export/import
      index.ts              bootstrap

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
  shared-types/            DTOs dùng chung server↔web
  adapters/                Adapter interface + driver wrappers
    src/
      types.ts             DbAdapter contract
      registry.ts          factory map by DbKind
      mysql.ts             mysql2
      postgres.ts          pg
      oracle.ts            oracledb (thin mode mặc định)
      mssql.ts             tedious
      mongodb.ts           mongodb@3.7 (legacy server compat)
      mongodb-shell.ts     vm-sandboxed shell evaluator
      redis.ts             ioredis
types/
  oracledb.d.ts            type shim cho oracledb (chưa ship types)
```

## Yêu cầu

- **Node.js 20 hoặc 22 LTS** — tránh Node 21 (`better-sqlite3` / `keytar` không có prebuild cho odd-version)
- pnpm >= 10
- macOS hoặc Linux (Windows chưa test)

## Chạy

```bash
nvm use 22       # nếu dùng nvm
pnpm install
pnpm dev          # song song server (4317) + web (4318)
# hoặc:
pnpm -w run dev:server
pnpm -w run dev:web
```

Mở [http://127.0.0.1:4318](http://127.0.0.1:4318).

Build production:
```bash
pnpm build
pnpm --filter @dbweb/server start    # cần node dist/index.js
```

## Lưu trữ dữ liệu

Tất cả nằm trong `~/.dbweb/` (override bằng `DBWEB_DATA_DIR`):

| Path | Nội dung |
|---|---|
| `dbweb.sqlite` | Connection configs (password mã hoá), query history, saved queries |
| `dbweb.sqlite-wal`, `-shm` | SQLite WAL journal (tự sinh) |
| `vault.key` | Master AES key (chỉ tồn tại khi `DBWEB_FILE_VAULT=1`) |

**Master encryption key** mặc định ở **macOS Keychain** (service `dbweb`, account `master-key`) qua `keytar`. Trên Linux headless hoặc khi muốn portable, set `DBWEB_FILE_VAULT=1` → key lưu vào `~/.dbweb/vault.key` chmod 600.

**UI preferences** lưu ở browser `localStorage`:
- `dbweb:sidebarCollapsed` — connections sidebar collapsed (rail mode)
- `dbweb:treeCollapsed` — db-tree collapsed trong workbench
- `dbweb:editorHeight` — chiều cao editor pane (px)
- `dbweb:resultView` — `table` | `json`

### Backup & migrate

- **Cách an toàn**: dùng tính năng **Export** trong UI (sidebar `⇅`) → tạo file `.dbweb` mã hoá bằng passphrase. Mang sang máy mới, **Import** với cùng passphrase.
- **Cách thủ công**: copy cả `~/.dbweb/` SANG kèm theo Keychain entry (qua `Keychain Access → dbweb → master-key`). Nếu chỉ copy SQLite mà mất master key, password không decrypt được — connection vẫn hiện nhưng `Test` sẽ fail auth.

## Biến môi trường

| Biến | Mặc định | Mô tả |
|---|---|---|
| `DBWEB_HOST` | `127.0.0.1` | Bind address. **Luôn giữ `127.0.0.1`** trừ khi cố ý mở mạng nội bộ |
| `DBWEB_PORT` | `4317` | API server port (web dev port là 4318) |
| `DBWEB_DATA_DIR` | `~/.dbweb` | Nơi chứa SQLite + vault |
| `DBWEB_FILE_VAULT` | unset | Đặt `1` để dùng file vault thay cho OS Keychain |

## Tính năng

### Database hỗ trợ
| Kind | Driver | Default port | Versions tested | CRUD UI | Inline edit |
|---|---|---|---|---|---|
| MySQL | `mysql2` | 3306 | 5.7+ / 8.x | ✓ | ✓ (by PK) |
| PostgreSQL | `pg` | 5432 | 12+ | ✓ | ✓ (by PK) |
| Oracle | `oracledb` thin | 1521 | 12c+ (thin mode) | ✓ | — |
| MSSQL | `tedious` | 1433 | 2017+ | ✓ | — |
| MongoDB | `mongodb@3.7` | 27017 | **3.4 → 4.2** (wire v0–9) | ✓ | ✓ (replace doc) |
| Redis | `ioredis` | 6379 | 4+ | ✓ | — |

### Workbench
- **Editor**: Monaco với syntax highlight tự đổi theo kind (SQL / JSON / shell). `Cmd/Ctrl + Enter` để run (hoạt động cả khi focus ở trong editor — wired qua `editor.addCommand`).
- **Result toggle**: Table view (mặc định) hoặc JSON view (Monaco read-only, fold/unfold).
- **Resizable**: kéo divider giữa editor và result để chỉnh tỉ lệ. Lưu vào localStorage.
- **Browse tab** (SQL): viewer của bảng với filter builder per-column (= != > < >= <= LIKE IS NULL), pagination, inline edit từng cell theo PK, save per-row.
- **Stats tab**: cards (size, table count, query count, avg latency), bar chart 14 ngày, top 5 slow queries, top 10 largest tables.
- **History tab**: 2 section — Saved queries (đặt tên, click load) và History (toàn bộ statement đã chạy, có status ✓/✕, elapsed, row count, time).
- **Export**: kết quả query → CSV (RFC4180) hoặc JSON download.

### Tree view (Robo3T-style)
```
▾ host:port (N)                 ← right-click: Server Status, Host Info, Version, Refresh
  ▾ <database>
    ▾ <collection / table>      ← right-click: View / Insert / Update / Remove / Drop / Indexes / Stats
      │ Indexes                 ← click → tự chạy db.coll.getIndexes()
      │ Stats                   ← click → tự chạy db.coll.stats()
    │ DB Stats                  ← click → tự chạy db.stats()
```

### MongoDB shell syntax đầy đủ
Native MongoDB shell expressions chạy thẳng trong editor:

```js
db.quote.find({status: "Hoạt động"}).sort({_id: -1}).limit(10)
db.quote.findOne({_id: ObjectId("5cd95a06710bed2e066cee83")})
db.quote.countDocuments({})
db.quote.distinct("status")
db.quote.aggregate([{$group: {_id: "$status", n: {$sum: 1}}}])

db.quote.insertOne({text: "...", status: "draft"})
db.quote.updateMany({status: null}, {$set: {status: "draft"}})
db.quote.deleteOne({_id: ObjectId("...")})

db.quote.createIndex({slug: 1}, {unique: true})
db.quote.getIndexes()
db.quote.dropIndex("slug_1")
db.quote.stats()

db.stats()
db.serverStatus()
db.hostInfo()
db.version()
db.runCommand({listDatabases: 1})
```

Helpers tự nhận: `ObjectId(...)`, `ISODate(...)`, `Date`, `NumberLong`, `NumberInt`. Cursor methods `.sort()` `.limit()` `.skip()` `.project()` chainable. Default `.limit(50)` áp dụng nếu user không gọi limit.

Block list (an toàn): `flushall`, `flushdb`, `shutdown`, `config`, `debug`.

### Export / Import portability
- **Connection bundle**: file `.dbweb` định dạng `DBWEB1:salt:iv:tag:ciphertext`, AES-256-GCM với key derive bằng scrypt từ passphrase (≥8 chars). Sai passphrase → `DECRYPT_FAILED` (GCM auth tag bảo vệ).
- **Query result**: CSV / JSON download trực tiếp từ result toolbar.

### Bảo mật
- Bind 127.0.0.1 mặc định — không lộ ra LAN.
- Mật khẩu DB: AES-256-GCM at rest, master key tách rời (Keychain hoặc vault file 0600).
- Server không bao giờ trả password ra response (chỉ adapter-pool đọc nội bộ).
- SQLite WAL mode bật để tránh corruption.
- vm sandbox cho Mongo shell (timeout 30s).

## Phím tắt & UI

| Action | Phím / Click |
|---|---|
| Run query | `⌘ Enter` (mac) / `Ctrl + Enter` (Win/Linux) |
| New connection | `+` ở sidebar |
| Edit connection | `✎` per-connection |
| Delete connection | `×` per-connection |
| Export / Import | `⇅` ở sidebar |
| Collapse connections sidebar | `‹` ở header |
| Collapse db-tree | `‹` ở header tree trong workbench |
| Toggle Table / JSON view | Segmented control trong editor toolbar |
| Save current query | `☆ Save` button (ask cho name) |
| Right-click host | Server Status / Host Info / Version / Refresh |
| Right-click table/collection | View / Insert / Update / Remove / Drop / Indexes / Stats |
| Drag pane divider | Resize editor vs result |

## Roadmap chưa làm

- [ ] Inline `updateRow` cho Oracle / MSSQL (cần map bind-types — hiện trả `NOT_SUPPORTED 501`)
- [ ] Postgres multi-database browse (hiện browse trong DB cấu hình; `database` param hiểu là schema)
- [ ] AbortSignal cancel cho long-running query
- [ ] JSON tree view kiểu Robo3T (hierarchical key/value/type) — hiện chỉ có pretty JSON
- [ ] Tab queries song song (mỗi query 1 tab editor riêng)
- [ ] Tauri build → desktop binary

## License

Proprietary / Internal use.
