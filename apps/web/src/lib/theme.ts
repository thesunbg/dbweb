import { useSyncExternalStore } from "react";
import { readPref, writePref } from "./prefs.js";

/**
 * Light / dark theme. Stored as a `data-theme` attribute on <html> so CSS
 * tokens swap in one place; Monaco needs its own theme name, exposed via
 * `useTheme().monacoTheme`.
 */
export type Theme = "dark" | "light";

let current: Theme = readPref<Theme>("theme", "dark");
const listeners = new Set<() => void>();

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
}
apply(current);

export function setTheme(t: Theme) {
  current = t;
  writePref("theme", t);
  apply(t);
  for (const l of listeners) l();
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => current,
  );
  return {
    theme,
    monacoTheme: theme === "dark" ? "vs-dark" : "light",
    toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
}
