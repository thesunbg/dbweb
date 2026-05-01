import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

interface Props {
  onClose: () => void;
}

export function PortabilityModal({ onClose }: Props) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"export" | "import">("export");
  const [passphrase, setPassphrase] = useState("");
  const [payload, setPayload] = useState("");

  const exportMut = useMutation({
    mutationFn: () => api.exportConfigs(passphrase),
    onSuccess: (data) => setPayload(data.payload),
  });
  const importMut = useMutation({
    mutationFn: () => api.importConfigs(passphrase, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections"] });
    },
  });

  const downloadAsFile = () => {
    const blob = new Blob([payload], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dbweb-export-${new Date().toISOString().slice(0, 10)}.dbweb`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File) => {
    setPayload((await file.text()).trim());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Export / Import connections</h3>
          <button type="button" className="ghost" onClick={onClose}>×</button>
        </div>
        <div className="tabs">
          <button
            type="button"
            className={`tab ${mode === "export" ? "active" : ""}`}
            onClick={() => setMode("export")}
          >
            Export
          </button>
          <button
            type="button"
            className={`tab ${mode === "import" ? "active" : ""}`}
            onClick={() => setMode("import")}
          >
            Import
          </button>
        </div>

        <div className="modal-body">
          <label>
            <span>Passphrase (≥8 chars)</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Used to encrypt/decrypt the bundle"
            />
          </label>

          {mode === "export" ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={passphrase.length < 8 || exportMut.isPending}
                onClick={() => exportMut.mutate()}
              >
                {exportMut.isPending ? "Encrypting..." : "Export current connections"}
              </button>
              {exportMut.isError && (
                <div className="error">{(exportMut.error as Error).message}</div>
              )}
              {exportMut.data && (
                <>
                  <div className="muted">{exportMut.data.count} connections encoded.</div>
                  <textarea readOnly value={payload} rows={6} />
                  <button type="button" className="ghost" onClick={downloadAsFile}>
                    Download .dbweb
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <label>
                <span>Encrypted payload</span>
                <textarea
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  rows={6}
                  placeholder="Paste the DBWEB1:... payload"
                />
              </label>
              <input
                type="file"
                accept=".dbweb,.txt"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
              <button
                type="button"
                className="primary"
                disabled={passphrase.length < 8 || !payload.trim() || importMut.isPending}
                onClick={() => importMut.mutate()}
              >
                {importMut.isPending ? "Importing..." : "Import"}
              </button>
              {importMut.isError && (
                <div className="error">{(importMut.error as Error).message}</div>
              )}
              {importMut.data && (
                <div className="muted">{importMut.data.imported} connections imported.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
