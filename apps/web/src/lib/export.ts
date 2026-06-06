function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Normalize every flavour of in-field line break to CRLF. Excel for Mac
  // respects quote-state for embedded CRLF but treats a lone LF as a hard
  // row terminator even inside `"…"`, which silently truncates a CSV with
  // multi-line text fields (Vietnamese poems, JSON blobs, etc.).
  const s = (typeof v === "object" ? JSON.stringify(v) : String(v)).replace(
    /\r\n|\r|\n/g,
    "\r\n",
  );
  // RFC4180: wrap in quotes if needed, double internal quotes.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(fields: string[], rows: unknown[][]): string {
  const lines = [fields.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  // CRLF record terminator (RFC4180). Excel for Mac in particular needs
  // this to distinguish row boundaries from `\n` embedded inside a quoted
  // field — LF-only files often get silently truncated mid-import.
  return lines.join("\r\n");
}

export function rowsToJson(fields: string[], rows: unknown[][]): string {
  const out = rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
  return JSON.stringify(out, null, 2);
}

export function downloadText(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
