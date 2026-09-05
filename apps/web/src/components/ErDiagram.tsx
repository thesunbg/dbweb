import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { useTheme } from "../lib/theme.js";
import { copyText, toast } from "../lib/ui.js";
import { describeAll } from "../lib/schema-index.js";

interface Props {
  connection: ConnectionConfig;
  database: string;
}

/**
 * Entity-relationship diagram from foreign keys, rendered with mermaid.
 * Column lists come from describeObject for every table (capped) so the
 * picture is useful even for tables without relations.
 */
export function ErDiagram({ connection, database }: Props) {
  const { theme } = useTheme();
  const [onlyRelated, setOnlyRelated] = useState(false);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const relations = useQuery({ queryKey: ["relations", connection.id, database], queryFn: () => api.relations(connection.id, database) });
  const schema = useQuery({ queryKey: ["schema-index", connection.id, database], queryFn: () => describeAll(connection.id, database), staleTime: 5 * 60_000 });

  const source = useMemo(() => {
    if (!relations.data || !schema.data) return "";
    const related = new Set(relations.data.flatMap((r) => [r.fromTable, r.toTable]));
    const tables = schema.data.tables.filter((t) => !onlyRelated || related.has(t.name));
    const lines = ["erDiagram"];
    for (const t of tables) {
      lines.push(`  ${ident(t.name)} {`);
      for (const c of t.columns.slice(0, 40)) lines.push(`    ${c.dataType.replace(/[^\w]/g, "_") || "col"} ${ident(c.name)} ${c.primaryKey ? "PK" : ""}`);
      lines.push("  }");
    }
    for (const r of relations.data) lines.push(`  ${ident(r.toTable)} ||--o{ ${ident(r.fromTable)} : "${r.fromColumn}"`);
    return lines.join("\n");
  }, [relations.data, schema.data, onlyRelated]);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: theme === "dark" ? "dark" : "default", er: { useMaxWidth: false } });
        const { svg } = await mermaid.render(`er-${Date.now()}`, source);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  const tableCount = schema.data?.tables.length ?? 0;

  return (
    <div className="er-shell">
      <div className="browser-toolbar">
        <strong>ER diagram</strong>
        <span className="muted hint">
          {database} · {tableCount} tables · {relations.data?.length ?? 0} relations
          {schema.data?.truncated ? " · (first 80 tables)" : ""}
        </span>
        <div className="grow" />
        <label className="inline hint">
          <input type="checkbox" checked={onlyRelated} onChange={(e) => setOnlyRelated(e.target.checked)} /> only tables with relations
        </label>
        <button type="button" className="ghost tiny" onClick={() => void copyText(source, "Mermaid source copied")} disabled={!source}>
          Copy mermaid
        </button>
        <button
          type="button"
          className="ghost tiny"
          disabled={!svg}
          onClick={() => {
            const blob = new Blob([svg], { type: "image/svg+xml" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${database}-er.svg`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("SVG downloaded");
          }}
        >
          ↓ SVG
        </button>
      </div>
      <div className="er-canvas" ref={ref}>
        {(relations.isLoading || schema.isLoading) && <div className="result-loading">Reading schema…</div>}
        {(relations.isError || schema.isError) && <div className="error result-error"><pre>{((relations.error ?? schema.error) as Error).message}</pre></div>}
        {relations.isSuccess && relations.data.length === 0 && schema.isSuccess && <div className="muted hint" style={{ padding: 12 }}>No foreign keys found — the diagram shows tables only. (MongoDB / Redis / ClickHouse have no declared relations.)</div>}
        {error && <div className="error result-error"><pre>{error}</pre></div>}
        {svg && <div className="er-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      </div>
    </div>
  );
}

function ident(s: string): string {
  return s.replace(/[^\w]/g, "_");
}
