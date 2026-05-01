function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // RFC4180: wrap in quotes if needed, double internal quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(fields: string[], rows: unknown[][]): string {
  const lines = [fields.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return lines.join("\n");
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
