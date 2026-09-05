import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConnectionConfig, DbKind } from "@dbweb/shared-types";
import { api } from "../api.js";
import { Modal, copyText } from "../lib/ui.js";
import { describeAll, type IndexedTable } from "../lib/schema-index.js";
import { buildSelect, quoteIdent, sqlLiteral, tableRef } from "../lib/sql.js";
import { KIND_LABEL } from "../lib/kinds.js";

interface Props {
  connections: ConnectionConfig[];
  /** Left side defaults to the current connection. */
  initial: ConnectionConfig;
  initialDatabase?: string;
  onClose: () => void;
}

type Mode = "schema" | "data";
const DATA_LIMIT = 5000;

/**
 * Compare two databases: schema (tables + columns) or one table's rows by
 * primary key. Generates the SQL to make B look like A.
 */
export function CompareModal({ connections, initial, initialDatabase, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("schema");
  const [aId, setAId] = useState(initial.id);
  const [bId, setBId] = useState(() => connections.find((c) => c.id !== initial.id && c.kind === initial.kind)?.id ?? connections.find((c) => c.id !== initial.id)?.id ?? initial.id);
  const [aDb, setADb] = useState(initialDatabase ?? initial.database ?? "");
  const [bDb, setBDb] = useState("");
  const [table, setTable] = useState("");
  const [go, setGo] = useState(0);

  const a = connections.find((c) => c.id === aId)!;
  const b = connections.find((c) => c.id === bId)!;

  const aDbs = useQuery({ queryKey: ["dbs", aId], queryFn: () => api.listDatabases(aId) });
  const bDbs = useQuery({ queryKey: ["dbs", bId], queryFn: () => api.listDatabases(bId) });
  const aTables = useQuery({ queryKey: ["objects", aId, aDb], queryFn: () => api.listObjects(aId, aDb), enabled: !!aDb });

  const aIdx = useQuery({ queryKey: ["schema-index", aId, aDb], queryFn: () => describeAll(aId, aDb), enabled: go > 0 && mode === "schema" && !!aDb, staleTime: 5 * 60_000 });
  const bIdx = useQuery({ queryKey: ["schema-index", bId, bDb], queryFn: () => describeAll(bId, bDb), enabled: go > 0 && mode === "schema" && !!bDb, staleTime: 5 * 60_000 });

  const aData = useQuery({
    queryKey: ["compare-data", aId, aDb, table, go],
    queryFn: async () => ({ cols: await api.describeObject(aId, aDb, table), res: await api.execute(aId, buildSelect(a.kind, aDb, table, { limit: DATA_LIMIT }), aDb, DATA_LIMIT) }),
    enabled: go > 0 && mode === "data" && !!aDb && !!table,
  });
  const bData = useQuery({
    queryKey: ["compare-data", bId, bDb, table, go],
    queryFn: async () => ({ cols: await api.describeObject(bId, bDb, table), res: await api.execute(bId, buildSelect(b.kind, bDb, table, { limit: DATA_LIMIT }), bDb, DATA_LIMIT) }),
    enabled: go > 0 && mode === "data" && !!bDb && !!table,
  });

  const schemaDiff = useMemo(() => (aIdx.data && bIdx.data ? diffSchema(aIdx.data.tables, bIdx.data.tables, b.kind, bDb) : null), [aIdx.data, bIdx.data, b.kind, bDb]);
  const dataDiff = useMemo(() => (aData.data && bData.data ? diffData(aData.data, bData.data, b.kind, bDb, table) : null), [aData.data, bData.data, b.kind, bDb, table]);

  const ready = mode === "schema" ? !!aDb && !!bDb : !!aDb && !!bDb && !!table;
  const loading = aIdx.isFetching || bIdx.isFetching || aData.isFetching || bData.isFetching;
  const err = (aIdx.error ?? bIdx.error ?? aData.error ?? bData.error) as Error | null;

  return (
    <Modal title="Compare" onClose={onClose} width={900} tall>
      <div className="seg" role="tablist" style={{ alignSelf: "flex-start" }}>
        <button type="button" className={`seg-btn ${mode === "schema" ? "active" : ""}`} onClick={() => setMode("schema")}>
          Schema
        </button>
        <button type="button" className={`seg-btn ${mode === "data" ? "active" : ""}`} onClick={() => setMode("data")}>
          Data (one table)
        </button>
      </div>
      <div className="compare-sides">
        <Side label="A (source)" connections={connections} id={aId} setId={setAId} db={aDb} setDb={setADb} dbs={aDbs.data?.map((d) => d.name) ?? []} />
        <Side label="B (target)" connections={connections} id={bId} setId={setBId} db={bDb} setDb={setBDb} dbs={bDbs.data?.map((d) => d.name) ?? []} />
      </div>
      {mode === "data" && (
        <label>
          <span>Table (must exist on both sides, with a primary key)</span>
          <input list="cmp-tables" value={table} onChange={(e) => setTable(e.target.value)} />
          <datalist id="cmp-tables">{aTables.data?.map((t) => <option key={t.name} value={t.name} />)}</datalist>
        </label>
      )}
      <div className="row-tight">
        <button type="button" className="primary" disabled={!ready || loading} onClick={() => setGo((g) => g + 1)}>
          {loading ? "Comparing…" : "Compare"}
        </button>
        <span className="muted hint">{mode === "data" ? `First ${DATA_LIMIT.toLocaleString()} rows per side, matched by primary key.` : "Tables and columns; types compared as reported by each engine."}</span>
      </div>
      {err && <div className="error result-error"><pre>{err.message}</pre></div>}

      {mode === "schema" && schemaDiff && (
        <div className="compare-result">
          <div className="stats-grid">
            <Stat label="Only in A" value={schemaDiff.onlyA.length} />
            <Stat label="Only in B" value={schemaDiff.onlyB.length} />
            <Stat label="Tables with column diffs" value={schemaDiff.changed.length} />
            <Stat label="Identical tables" value={schemaDiff.same} />
          </div>
          {schemaDiff.onlyA.length + schemaDiff.onlyB.length + schemaDiff.changed.length === 0 && <div className="banner ok-banner">Schemas match.</div>}
          {schemaDiff.onlyA.length > 0 && <DiffList title="Only in A (missing on B)" items={schemaDiff.onlyA} cls="add" />}
          {schemaDiff.onlyB.length > 0 && <DiffList title="Only in B (extra on B)" items={schemaDiff.onlyB} cls="del" />}
          {schemaDiff.changed.map((t) => (
            <section key={t.table} className="diff-section">
              <h4 className="section-title">{t.table}</h4>
              <ul className="diff-list">
                {t.lines.map((l, i) => (
                  <li key={i} className={`diff-${l.cls}`}>{l.text}</li>
                ))}
              </ul>
            </section>
          ))}
          {schemaDiff.sql && <SqlOut title={`SQL to apply on B (${KIND_LABEL[b.kind].label})`} sql={schemaDiff.sql} />}
        </div>
      )}

      {mode === "data" && dataDiff && (
        <div className="compare-result">
          <div className="stats-grid">
            <Stat label="Rows in A" value={dataDiff.countA} />
            <Stat label="Rows in B" value={dataDiff.countB} />
            <Stat label="Missing on B" value={dataDiff.missing.length} />
            <Stat label="Extra on B" value={dataDiff.extra.length} />
            <Stat label="Changed" value={dataDiff.changed.length} />
          </div>
          {dataDiff.error && <div className="banner error-banner">{dataDiff.error}</div>}
          {!dataDiff.error && dataDiff.missing.length + dataDiff.extra.length + dataDiff.changed.length === 0 && <div className="banner ok-banner">Rows match.</div>}
          {dataDiff.changed.slice(0, 200).length > 0 && (
            <section className="diff-section">
              <h4 className="section-title">Changed rows (showing {Math.min(200, dataDiff.changed.length)})</h4>
              <ul className="diff-list">
                {dataDiff.changed.slice(0, 200).map((c, i) => (
                  <li key={i} className="diff-chg">
                    <code>{c.key}</code> {c.fields.map((f) => `${f.name}: ${f.a} → ${f.b}`).join(" · ")}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {dataDiff.sql && <SqlOut title="SQL to make B match A" sql={dataDiff.sql} />}
        </div>
      )}
    </Modal>
  );
}

function Side({ label, connections, id, setId, db, setDb, dbs }: { label: string; connections: ConnectionConfig[]; id: string; setId: (v: string) => void; db: string; setDb: (v: string) => void; dbs: string[] }) {
  return (
    <div className="compare-side">
      <span className="muted hint">{label}</span>
      <select value={id} onChange={(e) => { setId(e.target.value); setDb(""); }}>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {KIND_LABEL[c.kind].glyph} · {c.name}
          </option>
        ))}
      </select>
      <select value={db} onChange={(e) => setDb(e.target.value)}>
        <option value="">— database —</option>
        {dbs.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value.toLocaleString()}</div>
    </div>
  );
}

function DiffList({ title, items, cls }: { title: string; items: string[]; cls: string }) {
  return (
    <section className="diff-section">
      <h4 className="section-title">{title}</h4>
      <ul className="diff-list">
        {items.map((t) => (
          <li key={t} className={`diff-${cls}`}>{t}</li>
        ))}
      </ul>
    </section>
  );
}

function SqlOut({ title, sql }: { title: string; sql: string }) {
  return (
    <section className="diff-section">
      <div className="row-tight" style={{ justifyContent: "space-between" }}>
        <h4 className="section-title">{title}</h4>
        <button type="button" className="ghost tiny" onClick={() => void copyText(sql, "SQL copied")}>
          Copy
        </button>
      </div>
      <pre className="snippet-code">{sql}</pre>
    </section>
  );
}

function diffSchema(a: IndexedTable[], b: IndexedTable[], kind: DbKind, bDb: string) {
  const bMap = new Map(b.map((t) => [t.name.toLowerCase(), t]));
  const aMap = new Map(a.map((t) => [t.name.toLowerCase(), t]));
  const onlyA = a.filter((t) => !bMap.has(t.name.toLowerCase())).map((t) => t.name);
  const onlyB = b.filter((t) => !aMap.has(t.name.toLowerCase())).map((t) => t.name);
  const changed: { table: string; lines: { cls: string; text: string }[] }[] = [];
  const sql: string[] = [];
  let same = 0;
  for (const t of a) {
    const bt = bMap.get(t.name.toLowerCase());
    if (!bt) {
      sql.push(`CREATE TABLE ${tableRef(kind, bDb, t.name)} (\n${t.columns.map((c) => `  ${quoteIdent(kind, c.name)} ${c.dataType}${c.nullable ? "" : " NOT NULL"}`).join(",\n")}${t.columns.some((c) => c.primaryKey) ? `,\n  PRIMARY KEY (${t.columns.filter((c) => c.primaryKey).map((c) => quoteIdent(kind, c.name)).join(", ")})` : ""}\n);`);
      continue;
    }
    const lines: { cls: string; text: string }[] = [];
    const bc = new Map(bt.columns.map((c) => [c.name.toLowerCase(), c]));
    const ac = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]));
    for (const c of t.columns) {
      const o = bc.get(c.name.toLowerCase());
      if (!o) {
        lines.push({ cls: "add", text: `+ ${c.name} ${c.dataType}${c.nullable ? "" : " NOT NULL"} (missing on B)` });
        sql.push(`ALTER TABLE ${tableRef(kind, bDb, t.name)} ADD ${kind === "postgres" || kind === "mysql" || kind === "clickhouse" ? "COLUMN " : ""}${quoteIdent(kind, c.name)} ${c.dataType}${c.nullable ? "" : " NOT NULL"};`);
      } else if (norm(o.dataType) !== norm(c.dataType) || o.nullable !== c.nullable) {
        lines.push({ cls: "chg", text: `~ ${c.name}: A ${c.dataType}${c.nullable ? "" : " NOT NULL"} · B ${o.dataType}${o.nullable ? "" : " NOT NULL"}` });
      }
    }
    for (const c of bt.columns) if (!ac.has(c.name.toLowerCase())) lines.push({ cls: "del", text: `- ${c.name} ${c.dataType} (only on B)` });
    if (lines.length) changed.push({ table: t.name, lines });
    else same++;
  }
  return { onlyA, onlyB, changed, same, sql: sql.join("\n\n") };
}

function norm(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").replace(/character varying/, "varchar").replace(/int4/, "integer").replace(/int8/, "bigint");
}

function diffData(a: { cols: { name: string; primaryKey: boolean }[]; res: { fields: string[]; rows: unknown[][] } }, b: typeof a, kind: DbKind, bDb: string, table: string) {
  const pk = a.cols.filter((c) => c.primaryKey).map((c) => c.name);
  if (pk.length === 0) return { countA: a.res.rows.length, countB: b.res.rows.length, missing: [], extra: [], changed: [], sql: "", error: "Table has no primary key on A — rows can't be matched." };
  const keyOf = (fields: string[], row: unknown[]) => pk.map((k) => String(row[fields.indexOf(k)])).join("|");
  const aMap = new Map(a.res.rows.map((r) => [keyOf(a.res.fields, r), r]));
  const bMap = new Map(b.res.rows.map((r) => [keyOf(b.res.fields, r), r]));
  const fields = a.res.fields.filter((f) => b.res.fields.includes(f));
  const missing: string[] = [];
  const extra: string[] = [];
  const changed: { key: string; fields: { name: string; a: string; b: string }[] }[] = [];
  const sql: string[] = [];
  const ref = tableRef(kind, bDb, table);
  const where = (row: unknown[], flds: string[]) => pk.map((k) => `${quoteIdent(kind, k)} = ${sqlLiteral(row[flds.indexOf(k)])}`).join(" AND ");
  for (const [k, ar] of aMap) {
    const br = bMap.get(k);
    if (!br) {
      missing.push(k);
      sql.push(`INSERT INTO ${ref} (${a.res.fields.map((f) => quoteIdent(kind, f)).join(", ")}) VALUES (${ar.map((v) => sqlLiteral(v)).join(", ")});`);
      continue;
    }
    const diffs = fields.filter((f) => !pk.includes(f) && String(ar[a.res.fields.indexOf(f)] ?? null) !== String(br[b.res.fields.indexOf(f)] ?? null));
    if (diffs.length) {
      changed.push({ key: k, fields: diffs.map((f) => ({ name: f, a: String(ar[a.res.fields.indexOf(f)] ?? "NULL"), b: String(br[b.res.fields.indexOf(f)] ?? "NULL") })) });
      sql.push(`UPDATE ${ref} SET ${diffs.map((f) => `${quoteIdent(kind, f)} = ${sqlLiteral(ar[a.res.fields.indexOf(f)])}`).join(", ")} WHERE ${where(ar, a.res.fields)};`);
    }
  }
  for (const [k, br] of bMap) {
    if (!aMap.has(k)) {
      extra.push(k);
      sql.push(`DELETE FROM ${ref} WHERE ${where(br, b.res.fields)};`);
    }
  }
  return { countA: a.res.rows.length, countB: b.res.rows.length, missing, extra, changed, sql: sql.slice(0, 2000).join("\n"), error: undefined };
}

