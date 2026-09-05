import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

/**
 * App-wide toasts + confirm/prompt dialogs, replacing the native
 * `alert()` / `confirm()` / `prompt()` calls that used to interrupt the UI.
 *
 * A tiny external store keeps the API callable from anywhere (mutations,
 * event handlers) without threading props; `<UiHost />` mounted once in App
 * renders whatever is queued.
 */

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface FormField {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
}

type Dialog =
  | {
      type: "form";
      title: string;
      message?: string;
      fields: FormField[];
      confirmLabel?: string;
      resolve: (values: Record<string, string> | null) => void;
    }
  | {
      type: "confirm";
      title: string;
      message?: string;
      confirmLabel?: string;
      danger?: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      type: "prompt";
      title: string;
      label?: string;
      defaultValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      resolve: (value: string | null) => void;
    };

interface UiState {
  toasts: Toast[];
  dialog: Dialog | null;
}

let state: UiState = { toasts: [], dialog: null };
const listeners = new Set<() => void>();
let nextId = 1;

function emit(next: UiState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function push(kind: ToastKind, message: string, ttl = kind === "error" ? 6000 : 2800) {
  const id = nextId++;
  emit({ ...state, toasts: [...state.toasts, { id, kind, message }] });
  window.setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number) {
  if (!state.toasts.some((t) => t.id === id)) return;
  emit({ ...state, toasts: state.toasts.filter((t) => t.id !== id) });
}

export const toast = {
  info: (m: string) => push("info", m),
  success: (m: string) => push("success", m),
  error: (m: string) => push("error", m),
};

export function confirmDialog(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    emit({ ...state, dialog: { type: "confirm", ...opts, resolve } });
  });
}

export function promptDialog(opts: {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    emit({ ...state, dialog: { type: "prompt", ...opts, resolve } });
  });
}

/** Several labelled inputs at once — used for query parameters. */
export function formDialog(opts: {
  title: string;
  message?: string;
  fields: FormField[];
  confirmLabel?: string;
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    emit({ ...state, dialog: { type: "form", ...opts, resolve } });
  });
}

function closeDialog() {
  emit({ ...state, dialog: null });
}

export function UiHost() {
  const snap = useSyncExternalStore(subscribe, () => state);
  return (
    <>
      {snap.toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {snap.toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
              <span className="toast-icon">{t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : "i"}</span>
              <span className="toast-msg">{t.message}</span>
            </div>
          ))}
        </div>
      )}
      {snap.dialog && <DialogView dialog={snap.dialog} />}
    </>
  );
}

function DialogView({ dialog }: { dialog: Dialog }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (dialog.type === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (dialog.type === "form") {
      const first = formRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
      first?.focus();
      first?.select();
    } else {
      okRef.current?.focus();
    }
  }, [dialog]);

  const cancel = () => {
    if (dialog.type === "confirm") dialog.resolve(false);
    else dialog.resolve(null);
    closeDialog();
  };
  const ok = () => {
    if (dialog.type === "confirm") dialog.resolve(true);
    else if (dialog.type === "form") {
      const data = new FormData(formRef.current!);
      const out: Record<string, string> = {};
      for (const f of dialog.fields) out[f.name] = String(data.get(f.name) ?? "");
      dialog.resolve(out);
    } else dialog.resolve(inputRef.current?.value ?? "");
    closeDialog();
  };

  return (
    <Modal title={dialog.title} onClose={cancel} width={dialog.type === "form" ? 480 : 400}>
      <form
        ref={formRef}
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        {dialog.type !== "prompt" && dialog.message && <p className="dialog-msg">{dialog.message}</p>}
        {dialog.type === "form" &&
          dialog.fields.map((f) => (
            <label key={f.name}>
              <span>{f.label}</span>
              {f.multiline ? (
                <textarea name={f.name} defaultValue={f.defaultValue ?? ""} placeholder={f.placeholder} rows={3} />
              ) : (
                <input name={f.name} defaultValue={f.defaultValue ?? ""} placeholder={f.placeholder} autoComplete="off" />
              )}
            </label>
          ))}
        {dialog.type === "prompt" && (
          <label>
            {dialog.label && <span>{dialog.label}</span>}
            <input ref={inputRef} defaultValue={dialog.defaultValue ?? ""} placeholder={dialog.placeholder} />
          </label>
        )}
        <div className="modal-footer">
          <button type="button" className="ghost" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={okRef}
            type="submit"
            className={`primary ${dialog.type === "confirm" && dialog.danger ? "danger" : ""}`}
          >
            {dialog.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Removes body padding — for modals that host an editor edge-to-edge. */
  flush?: boolean;
  tall?: boolean;
  /** Extra controls rendered in the header, left of the close button. */
  headerExtra?: ReactNode;
}

/**
 * Shared modal chrome. Escape closes, backdrop click closes, and the panel
 * itself stops propagation so clicks inside never leak to the backdrop.
 */
export function Modal({ title, onClose, children, width, flush, tall, headerExtra }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal ${tall ? "modal-tall" : ""}`}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <div className="row-tight">
            {headerExtra}
            <button type="button" className="ghost icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className={`modal-body ${flush ? "modal-body-flush" : ""}`}>{children}</div>
      </div>
    </div>
  );
}

/** Clipboard helper with a toast so the user always gets feedback. */
export async function copyText(text: string, label = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch (err) {
    toast.error(`Copy failed: ${(err as Error).message}`);
  }
}
