/**
 * Tiny localStorage wrapper. Every UI preference lives under the `dbweb:`
 * namespace (see CLAUDE.md) and is stored as JSON so callers never have to
 * hand-roll "1"/"0" string flags. Reads never throw — a private window or a
 * blocked storage API just yields the fallback.
 */
const PREFIX = "dbweb:";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable — preference simply won't persist
  }
}

/** Legacy flags written as "1"/"0" before prefs.ts existed. */
export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(PREFIX + key, value ? "1" : "0");
  } catch {
    // ignore
  }
}
