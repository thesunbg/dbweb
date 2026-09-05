import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { Modal, copyText, toast } from "../lib/ui.js";
import { useTheme } from "../lib/theme.js";

interface Props {
  connection: ConnectionConfig;
  database: string;
  collection: string;
  doc: Record<string, unknown>;
  /** When false the modal is read-only (e.g. SQL row → JSON view). */
  editable?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function DocumentModal({ connection, database, collection, doc, editable = true, onClose, onSaved }: Props) {
  const qc = useQueryClient();
  const { monacoTheme } = useTheme();
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
      if (res.modifiedCount > 0) {
        toast.success("Document saved");
        onClose();
      } else setError(`No document modified (matched ${res.matchedCount}).`);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Modal
      title={
        <>
          {editable ? "Edit document" : "View document"} <span className="muted">· {database}.{collection}</span>
        </>
      }
      onClose={onClose}
      width={720}
      flush
      tall
      headerExtra={
        <button type="button" className="ghost" onClick={() => void copyText(text)}>
          Copy
        </button>
      }
    >
      <Editor
        height="60vh"
        language="json"
        theme={monacoTheme}
        value={text}
        onChange={(v) => {
          setText(v ?? "");
          setError(null);
        }}
        options={{ minimap: { enabled: false }, fontSize: 12, readOnly: !editable, scrollBeyondLastLine: false }}
      />
      {error && <div className="error" style={{ padding: 8 }}>{error}</div>}
      {editable && (
        <div className="modal-footer padded">
          <span className="muted hint">{dirty ? "Unsaved changes" : ""}</span>
          <div className="grow" />
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </Modal>
  );
}

/** Mongo extended-style stringify so ObjectId / Date stay readable. */
function stringify(doc: Record<string, unknown>): string {
  return JSON.stringify(
    doc,
    (_k, v) => {
      if (v && typeof v === "object") {
        const bson = (v as { _bsontype?: string })._bsontype;
        if (bson === "ObjectID" || bson === "ObjectId") return (v as { toString(): string }).toString();
      }
      return v;
    },
    2,
  );
}
