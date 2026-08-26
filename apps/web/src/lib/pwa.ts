import { useEffect, useState } from "react";

/**
 * Chrome fires `beforeinstallprompt` right after load — usually before React
 * has mounted — so the event is captured at module-eval time and replayed to
 * whoever subscribes later. Firefox/Safari never fire it; `canInstall` simply
 * stays false there and the button never shows.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // keep Chrome's mini-infobar out of the way
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

/** True once the app runs in its own window (installed) rather than a tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(deferred !== null);

  useEffect(() => {
    const sync = () => setCanInstall(deferred !== null);
    subscribers.add(sync);
    sync();
    return () => {
      subscribers.delete(sync);
    };
  }, []);

  const install = async () => {
    const event = deferred;
    if (!event) return;
    await event.prompt();
    await event.userChoice;
    deferred = null;
    emit();
  };

  return { canInstall: canInstall && !isStandalone(), install };
}
