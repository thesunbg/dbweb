import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";

interface Props {
  connection: ConnectionConfig;
  database: string;
  collection: string;
  doc: Record<string, unknown>;
  /** When false the modal is read-only (e.g. SQL row → JSON view). */
  editable?: boolean;
  onClose: () => void;
  /** Optional refetch hook so caller can reload the result list after save. */
  onSaved?: () => void;
}

export function DocumentModal({
  connection,
  database,
  collection,
  doc,
  editable = true,
  onClose,
  onSaved,
}: Props) {
  const qc = useQueryClient();
  const initial = useMemo(() => stringify(doc), [doc]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const dirty = text !== initial;

  const save = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`Invalid JSON: ${(e as Error).message}`);
      }
      return api.replaceDocument(connection.id, { database, collection, doc: parsed });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["browse", connection.id] });
      onSaved?.();
      if (res.modifiedCount > 0) onClose();
      else setError(`No document modified (matched ${res.matchedCount}).`);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide modal-tall" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            {editable ? "Edit document" : "View document"}
            <span className="muted"> · {database}.{collection}</span>
          </h3>
          <button type="button" className="ghost" onClick={onClose}>×</button>
        </div>

        <div className="modal-body modal-body-flush">
          <Editor
            height="60vh"
            language="json"
            theme="vs-dark"
            value={text}
            onChange={(v) => {
              setText(v ?? "");
              setError(null);
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              readOnly: !editable,
              scrollBeyondLastLine: false,
            }}
          />
          {error && <div className="error" style={{ padding: 8 }}>{error}</div>}
        </div>

        {editable && (
          <div className="modal-footer">
            <button type="button" className="ghost" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="primary"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving..." : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Mongo extended-style stringify so ObjectId / Date stay readable. */
function stringify(doc: Record<string, unknown>): string {
  return JSON.stringify(
    doc,
    (_k, v) => {
      // mongodb v3 serializes ObjectId as { _bsontype: 'ObjectID' }; v5+ uses
      // 'ObjectId' (lowercase d). We collapse either to its hex string form so
      // users see the value they expect, regardless of which driver is active.
      if (v && typeof v === "object") {
        const bson = (v as { _bsontype?: string })._bsontype;
        if (bson === "ObjectID" || bson === "ObjectId") {
          return (v as { toString(): string }).toString();
        }
      }
      return v;
    },
    2,
  );
}
