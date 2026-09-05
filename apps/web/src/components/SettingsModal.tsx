import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { Modal, toast } from "../lib/ui.js";

const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [key, setKey] = useState("");
  const [model, setModel] = useState("claude-opus-5");
  useEffect(() => {
    if (settings.data) setModel(settings.data.aiModel);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.saveSettings({ ...(key ? { anthropicApiKey: key } : {}), aiModel: model }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Settings saved");
      setKey("");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const clearKey = useMutation({
    mutationFn: () => api.saveSettings({ anthropicApiKey: null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("API key removed");
    },
  });

  return (
    <Modal title="Settings" onClose={onClose} width={520}>
      <section className="settings-section">
        <h4>AI assistant (Claude)</h4>
        <p className="muted hint">
          The key is encrypted with the same master key as your database passwords and never leaves this machine except to call the Anthropic API. Schema names and column types are sent as context; row data is not.
        </p>
        <label>
          <span>
            Anthropic API key{" "}
            {settings.data?.aiConfigured && (
              <span className="ok"> · configured{settings.data.aiKeySource === "env" ? " via ANTHROPIC_API_KEY" : ""}</span>
            )}
          </span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.data?.aiConfigured ? "•••••••• (leave blank to keep)" : "sk-ant-…"} autoComplete="off" />
        </label>
        <label>
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {[...new Set([model, ...MODELS])].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </section>
      <div className="modal-footer">
        {settings.data?.aiKeySource === "settings" && (
          <button type="button" className="ghost danger" onClick={() => clearKey.mutate()}>
            Remove key
          </button>
        )}
        <div className="grow" />
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
        <button type="button" className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
