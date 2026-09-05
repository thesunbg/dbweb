import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DbKind, SnippetDto } from "@dbweb/shared-types";
import { api } from "../api.js";
import { KIND_LABEL, KIND_ORDER } from "../lib/kinds.js";
import { Modal, confirmDialog, toast } from "../lib/ui.js";

interface Props {
  /** Prefill for "New snippet" from the editor. */
  initialStatement?: string;
  kind?: DbKind;
  onInsert?: (statement: string, title: string) => void;
  onClose: () => void;
}

/**
 * Global snippet library. Not tied to a connection; `{{table}}`-style
 * placeholders are prompted for on insert (see lib/params.ts).
 */
export function SnippetsModal({ initialStatement, kind, onInsert, onClose }: Props) {
  const qc = useQueryClient();
  const snippets = useQuery({ queryKey: ["snippets"], queryFn: api.listSnippets });
  const [editing, setEditing] = useState<Partial<SnippetDto> | null>(initialStatement ? { statement: initialStatement, kind: kind ?? null } : null);
  const [q, setQ] = useState("");

  const save = useMutation({
    mutationFn: (s: Partial<SnippetDto>) =>
      s.id
        ? api.updateSnippet(s.id, { name: s.name!, statement: s.statement!, kind: s.kind ?? null })
        : api.createSnippet({ name: s.name!, statement: s.statement!, kind: s.kind ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["snippets"] });
      setEditing(null);
      toast.success("Snippet saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSnippet(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snippets"] }),
  });

  const term = q.trim().toLowerCase();
  const list = (snippets.data ?? []).filter((s) => !term || s.name.toLowerCase().includes(term) || s.statement.toLowerCase().includes(term));

  return (
    <Modal title="Snippets" onClose={onClose} width={720}>
      {editing ? (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(editing);
          }}
        >
          <div className="row">
            <label className="grow">
              <span>Name</span>
              <input required value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
            </label>
            <label>
              <span>Engine</span>
              <select value={editing.kind ?? ""} onChange={(e) => setEditing({ ...editing, kind: (e.target.value || null) as DbKind | null })}>
                <option value="">Any</option>
                {KIND_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>
              Statement — use <code>{"{{name}}"}</code> for placeholders you want to fill in on insert
            </span>
            <textarea required rows={8} value={editing.statement ?? ""} onChange={(e) => setEditing({ ...editing, statement: e.target.value })} spellCheck={false} />
          </label>
          <div className="modal-footer">
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              Back
            </button>
            <button type="submit" className="primary" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save snippet"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="row-tight" style={{ gap: 8 }}>
            <div className="conn-search grow" style={{ marginBottom: 0 }}>
              <span className="conn-search-icon">⌕</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search snippets…" autoFocus />
            </div>
            <button type="button" className="primary" onClick={() => setEditing({ kind: kind ?? null })}>
              + New
            </button>
          </div>
          {list.length === 0 && <div className="muted hint">No snippets yet. Save reusable queries here — they work across every connection.</div>}
          <ul className="snippet-list">
            {list.map((s) => (
              <li key={s.id} className="snippet-item">
                <div className="snippet-head">
                  <strong>{s.name}</strong>
                  {s.kind && <span className={`badge kind-${s.kind}`}>{KIND_LABEL[s.kind].glyph}</span>}
                  <div className="grow" />
                  {onInsert && (
                    <button type="button" className="ghost tiny" onClick={() => onInsert(s.statement, s.name)}>
                      Insert
                    </button>
                  )}
                  <button type="button" className="ghost tiny" onClick={() => setEditing(s)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost icon-btn danger"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Delete snippet "${s.name}"?`, danger: true, confirmLabel: "Delete" })) remove.mutate(s.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                <pre className="snippet-code">{s.statement}</pre>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
