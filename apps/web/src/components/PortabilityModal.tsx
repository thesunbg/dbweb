import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { Modal, copyText, toast } from "../lib/ui.js";

interface Props {
  onClose: () => void;
  /** Scoped to one connection: export only, no Import tab. */
  scope?: { id: string; name: string };
}

export function PortabilityModal({ onClose, scope }: Props) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"export" | "import">("export");
  const [passphrase, setPassphrase] = useState("");
  const [payload, setPayload] = useState("");

  const exportMut = useMutation({
    mutationFn: () => api.exportConfigs(passphrase, scope ? [scope.id] : undefined),
    onSuccess: (data) => setPayload(data.payload),
  });
  const importMut = useMutation({
    mutationFn: () => api.importConfigs(passphrase, payload),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      toast.success(`${r.imported} connection${r.imported === 1 ? "" : "s"} imported`);
    },
  });

  const downloadAsFile = () => {
    const blob = new Blob([payload], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = scope ? scope.name.replace(/[^\w.-]+/g, "_") : "all";
    a.download = `dbweb-${safe}-${stamp}.dbweb`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title={scope ? `Export · ${scope.name}` : "Export / Import connections"} onClose={onClose} width={600}>
      {!scope && (
        <div className="seg" role="tablist" style={{ alignSelf: "flex-start" }}>
          <button type="button" className={`seg-btn ${mode === "export" ? "active" : ""}`} onClick={() => setMode("export")}>
            Export
          </button>
          <button type="button" className={`seg-btn ${mode === "import" ? "active" : ""}`} onClick={() => setMode("import")}>
            Import
          </button>
        </div>
      )}

      <p className="muted hint">
        Bundles are encrypted with the passphrase (AES-256-GCM) and include passwords, so you can move them between machines safely.
      </p>

      <label>
        <span>Passphrase (≥ 8 characters)</span>
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Used to encrypt / decrypt the bundle" autoFocus />
      </label>

      {mode === "export" ? (
        <>
          <div className="row-tight">
            <button type="button" className="primary" disabled={passphrase.length < 8 || exportMut.isPending} onClick={() => exportMut.mutate()}>
              {exportMut.isPending ? "Encrypting…" : scope ? "Export this connection" : "Export all connections"}
            </button>
          </div>
          {exportMut.isError && <div className="error">{(exportMut.error as Error).message}</div>}
          {exportMut.data && (
            <>
              <div className="muted">{exportMut.data.count} connection{exportMut.data.count === 1 ? "" : "s"} encoded.</div>
              <textarea readOnly value={payload} rows={5} />
              <div className="row-tight">
                <button type="button" className="primary" onClick={downloadAsFile}>
                  ↓ Download .dbweb
                </button>
                <button type="button" className="ghost" onClick={() => void copyText(payload, "Bundle copied")}>
                  Copy to clipboard
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <label>
            <span>Encrypted payload</span>
            <textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={5} placeholder="Paste the DBWEB1:… payload, or pick a file below" />
          </label>
          <input
            type="file"
            accept=".dbweb,.txt"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setPayload((await f.text()).trim());
            }}
          />
          <div className="row-tight">
            <button type="button" className="primary" disabled={passphrase.length < 8 || !payload.trim() || importMut.isPending} onClick={() => importMut.mutate()}>
              {importMut.isPending ? "Importing…" : "Import"}
            </button>
          </div>
          {importMut.isError && <div className="error">{(importMut.error as Error).message}</div>}
        </>
      )}
    </Modal>
  );
}
