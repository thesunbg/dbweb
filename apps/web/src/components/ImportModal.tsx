import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { Modal, toast } from "../lib/ui.js";

interface Props {
  connection: ConnectionConfig;
  database: string;
  /** Preselected target table (from the browser / tree). */
  table?: string;
  onClose: () => void;
  onImported?: () => void;
}

const PREVIEW = 5;
const SKIP = "__skip__";

/**
 * CSV / Excel → table. The file is parsed server-side (one code path for
 * both formats), the user maps file columns onto table columns, and rows go
 * up in one request — the adapter batches the inserts.
 */
export function ImportModal({ connection, database, table: initialTable, onClose, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [base64, setBase64] = useState<string | null>(null);
  const [table, setTable] = useState(initialTable ?? "");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [delimiter, setDelimiter] = useState("");

  const objects = useQuery({
    queryKey: ["objects", connection.id, database],
    queryFn: () => api.listObjects(connection.id, database),
  });
  const cols = useQuery({
    queryKey: ["cols", connection.id, database, table],
    queryFn: () => api.describeObject(connection.id, database, table),
    enabled: !!table,
  });
  const preview = useQuery({
    queryKey: ["import-preview", file?.name, file?.size, delimiter],
    queryFn: () => api.parseImport(file!.name, base64!, PREVIEW, delimiter || undefined),
    enabled: !!file && !!base64,
  });

  // Auto-map by (case-insensitive) name once both sides are known.
  useEffect(() => {
    if (!preview.data || !cols.data) return;
    const next: Record<string, string> = {};
    for (const fc of preview.data.columns) {
      const hit = cols.data.find((c) => c.name.toLowerCase() === fc.toLowerCase().replace(/\s+/g, "_")) ?? cols.data.find((c) => c.name.toLowerCase() === fc.toLowerCase());
      next[fc] = hit ? hit.name : SKIP;
    }
    setMapping(next);
  }, [preview.data, cols.data]);

  const onFile = async (f: File) => {
    setFile(f);
    setBase64(null);
    const buf = await f.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    setBase64(btoa(bin));
  };

  const mapped = useMemo(() => Object.entries(mapping).filter(([, t]) => t !== SKIP), [mapping]);
  const isMongo = connection.kind === "mongodb";

  const run = useMutation({
    mutationFn: async () => {
      const full = await api.parseImport(file!.name, base64!, undefined, delimiter || undefined);
      const fileCols = full.columns;
      const pairs = isMongo
        ? fileCols.map((c) => [c, mapping[c] && mapping[c] !== SKIP ? mapping[c]! : c] as [string, string])
        : mapped.map(([f, t]) => [f, t] as [string, string]);
      const idx = pairs.map(([f]) => fileCols.indexOf(f));
      const rows = full.rows.map((r) => idx.map((i) => (i === -1 ? null : coerce(r[i]))));
      return api.importRows(connection.id, { database, table, columns: pairs.map(([, t]) => t), rows });
    },
    onSuccess: (res) => {
      toast.success(`${res.inserted.toLocaleString()} rows imported into ${table}`);
      onImported?.();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const ready = !!file && !!base64 && !!table && preview.isSuccess && (isMongo || mapped.length > 0);

  return (
    <Modal title={`Import into ${database}`} onClose={onClose} width={760}>
      <div className="row">
        <label className="grow">
          <span>File (.csv, .tsv, .xlsx)</span>
          <input
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
        </label>
        {file && !/\.xlsx?$/i.test(file.name) && (
          <label style={{ width: 130 }}>
            <span>Delimiter</span>
            <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
              <option value="">auto</option>
              <option value=",">comma ,</option>
              <option value=";">semicolon ;</option>
              <option value="	">tab</option>
              <option value="|">pipe |</option>
            </select>
          </label>
        )}
        <label className="grow">
          <span>Target {isMongo ? "collection" : "table"}</span>
          <input list="import-tables" value={table} onChange={(e) => setTable(e.target.value)} placeholder={isMongo ? "existing or new collection" : "pick a table"} />
          <datalist id="import-tables">
            {objects.data?.map((o) => (
              <option key={o.name} value={o.name} />
            ))}
          </datalist>
        </label>
      </div>

      {preview.isError && <div className="error">{(preview.error as Error).message}</div>}
      {preview.data && (
        <>
          <div className="muted hint">
            {preview.data.totalRows.toLocaleString()} data rows · {preview.data.columns.length} columns · showing first {Math.min(PREVIEW, preview.data.rows.length)}
          </div>
          <div className="import-map">
            <table className="result-table compact">
              <thead>
                <tr>
                  <th>File column</th>
                  <th>→ {isMongo ? "Field" : "Table column"}</th>
                  <th>Sample</th>
                </tr>
              </thead>
              <tbody>
                {preview.data.columns.map((fc, i) => (
                  <tr key={fc}>
                    <td>{fc}</td>
                    <td>
                      {isMongo ? (
                        <input className="cell-input" value={mapping[fc] === SKIP ? "" : (mapping[fc] ?? fc)} onChange={(e) => setMapping((m) => ({ ...m, [fc]: e.target.value || SKIP }))} placeholder="(skip)" />
                      ) : (
                        <select value={mapping[fc] ?? SKIP} onChange={(e) => setMapping((m) => ({ ...m, [fc]: e.target.value }))} disabled={!cols.data}>
                          <option value={SKIP}>— skip —</option>
                          {cols.data?.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name} · {c.dataType}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="muted">{preview.data.rows.map((r) => String(r[i] ?? "")).filter(Boolean).slice(0, 3).join(" · ").slice(0, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table && cols.isError && !isMongo && <div className="error">{(cols.error as Error).message}</div>}
        </>
      )}

      <div className="modal-footer">
        <span className="muted hint">{connection.readOnly ? "Connection is read-only" : "Rows are appended; existing data is untouched."}</span>
        <div className="grow" />
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!ready || run.isPending || connection.readOnly} onClick={() => run.mutate()}>
          {run.isPending ? "Importing…" : `Import${preview.data ? ` ${preview.data.totalRows.toLocaleString()} rows` : ""}`}
        </button>
      </div>
    </Modal>
  );
}

/** CSV cells are strings — turn obvious numbers back into numbers so the
 *  driver can bind them to numeric columns. */
function coerce(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t === "") return null;
  if (/^-?\d{1,15}$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return v;
}
