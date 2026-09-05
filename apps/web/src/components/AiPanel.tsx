import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { copyText, toast } from "../lib/ui.js";

interface Props {
  connection: ConnectionConfig;
  database?: string;
  /** Current editor text — used by explain / fix / optimize. */
  statement: string;
  lastError?: string;
  onInsert: (statement: string, title?: string) => void;
  onRun: (statement: string, title?: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

type Task = "generate" | "explain" | "fix" | "optimize";

/**
 * Side panel: natural language → statement, plus explain / fix / optimize
 * for whatever is in the editor. Every answer can be inserted as a new tab
 * or run straight away.
 */
export function AiPanel({ connection, database, statement, lastError, onInsert, onRun, onOpenSettings, onClose }: Props) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<{ task: Task; prompt?: string; text: string; code?: string; model: string }[]>([]);

  const ask = useMutation({
    mutationFn: (task: Task) =>
      api.ai({
        task,
        connectionId: connection.id,
        database,
        prompt: prompt.trim() || undefined,
        statement: task === "generate" ? undefined : statement,
        error: task === "fix" ? lastError : undefined,
      }),
    onSuccess: (res, task) => {
      setHistory((h) => [{ task, prompt: task === "generate" ? prompt : undefined, ...res }, ...h].slice(0, 20));
      if (task === "generate") setPrompt("");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const configured = settings.data?.aiConfigured;

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <strong>✨ AI assistant</strong>
        <span className="muted hint">{settings.data?.aiModel}</span>
        <div className="grow" />
        <button type="button" className="ghost icon-btn" onClick={onClose} title="Close">
          ×
        </button>
      </div>

      {settings.isSuccess && !configured && (
        <div className="banner error-banner">
          No API key yet.
          <button type="button" className="link" onClick={onOpenSettings}>
            Add one in Settings
          </button>
        </div>
      )}

      <textarea
        rows={3}
        value={prompt}
        placeholder={`Describe what you want, e.g. "top 10 customers by revenue this month"`}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && prompt.trim()) ask.mutate("generate");
        }}
      />
      <div className="ai-actions">
        <button type="button" className="primary" disabled={!configured || ask.isPending || !prompt.trim()} onClick={() => ask.mutate("generate")} title="⌘⏎">
          {ask.isPending && ask.variables === "generate" ? "Thinking…" : "Generate"}
        </button>
        <span className="muted hint">on the editor text:</span>
        <button type="button" className="ghost tiny" disabled={!configured || ask.isPending || !statement.trim()} onClick={() => ask.mutate("explain")}>
          Explain
        </button>
        <button type="button" className="ghost tiny" disabled={!configured || ask.isPending || !statement.trim()} onClick={() => ask.mutate("optimize")}>
          Optimize
        </button>
        <button type="button" className="ghost tiny" disabled={!configured || ask.isPending || !statement.trim() || !lastError} onClick={() => ask.mutate("fix")} title={lastError ? "Uses the last error message" : "Run a failing statement first"}>
          Fix error
        </button>
      </div>

      <div className="ai-history">
        {ask.isPending && <div className="muted hint">Asking {settings.data?.aiModel}…</div>}
        {history.length === 0 && !ask.isPending && (
          <div className="muted hint ai-empty">
            Answers appear here. The model sees your table and column names (not your data) so it can write queries against the real schema.
          </div>
        )}
        {history.map((h, i) => (
          <div key={i} className="ai-answer">
            <div className="ai-answer-head">
              <span className={`badge task-${h.task}`}>{h.task}</span>
              {h.prompt && <span className="muted hint ai-prompt">{h.prompt}</span>}
            </div>
            {h.code && (
              <pre className="ai-code">
                <code>{h.code}</code>
              </pre>
            )}
            <div className="ai-text">{stripCode(h.text)}</div>
            {h.code && (
              <div className="row-tight">
                <button type="button" className="ghost tiny" onClick={() => onInsert(h.code!, h.prompt ? h.prompt.slice(0, 30) : "AI")}>
                  Insert as tab
                </button>
                <button type="button" className="ghost tiny" onClick={() => onRun(h.code!, h.prompt ? h.prompt.slice(0, 30) : "AI")}>
                  ▶ Run
                </button>
                <button type="button" className="ghost tiny" onClick={() => void copyText(h.code!)}>
                  Copy
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function stripCode(text: string): string {
  return text.replace(/```[a-z]*\n[\s\S]*?```/g, "").trim();
}
