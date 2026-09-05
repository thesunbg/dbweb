import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { Modal } from "../lib/ui.js";
import { describeAll } from "../lib/schema-index.js";

interface Props {
  connection: ConnectionConfig;
  database: string;
  onPick: (table: string, column?: string) => void;
  onClose: () => void;
}

/** Find a column or table anywhere in the current database (⌘⇧F). */
export function SchemaSearch({ connection, database, onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const index = useQuery({ queryKey: ["schema-index", connection.id, database], queryFn: () => describeAll(connection.id, database), staleTime: 5 * 60_000 });

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!index.data) return [];
    const out: { table: string; column?: string; type?: string; pk?: boolean; score: number }[] = [];
    for (const t of index.data.tables) {
      const tn = t.name.toLowerCase();
      if (!term || tn.includes(term)) out.push({ table: t.name, score: tn === term ? 0 : tn.startsWith(term) ? 1 : 2 });
      if (!term) continue;
      for (const c of t.columns) {
        const cn = c.name.toLowerCase();
        if (cn.includes(term)) out.push({ table: t.name, column: c.name, type: c.dataType, pk: c.primaryKey, score: cn === term ? 0 : cn.startsWith(term) ? 1 : 3 });
      }
    }
    return out.sort((a, b) => a.score - b.score || a.table.localeCompare(b.table)).slice(0, 200);
  }, [q, index.data]);

  useEffect(() => setCursor(0), [q]);

  return (
    <Modal title={`Search schema · ${database}`} onClose={onClose} width={640}>
      <div className="conn-search" style={{ marginBottom: 0 }}>
        <span className="conn-search-icon">⌕</span>
        <input
          ref={inputRef}
          type="search"
          value={q}
          placeholder="Column or table name… (e.g. email, created_at)"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(results.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter" && results[cursor]) {
              onPick(results[cursor]!.table, results[cursor]!.column);
              onClose();
            }
          }}
        />
      </div>
      <div className="muted hint">
        {index.isLoading && "Indexing tables…"}
        {index.data && `${index.data.tables.length} tables · ${index.data.tables.reduce((n, t) => n + t.columns.length, 0)} columns indexed${index.data.truncated ? " (first 80 tables)" : ""}`}
        {index.isError && <span className="error">{(index.error as Error).message}</span>}
      </div>
      <ul className="search-results">
        {results.map((r, i) => (
          <li
            key={`${r.table}.${r.column ?? ""}`}
            className={`search-result ${i === cursor ? "active" : ""}`}
            onMouseEnter={() => setCursor(i)}
            onClick={() => {
              onPick(r.table, r.column);
              onClose();
            }}
          >
            <span className={`tree-icon ${r.column ? (r.pk ? "i-key" : "i-col") : "i-table"}`} />
            <span className="search-table">{r.table}</span>
            {r.column && (
              <>
                <span className="muted">.</span>
                <strong>{r.column}</strong>
                <span className="muted hint">{r.type}</span>
              </>
            )}
          </li>
        ))}
        {q && index.data && results.length === 0 && <li className="muted hint">No match.</li>}
      </ul>
    </Modal>
  );
}
