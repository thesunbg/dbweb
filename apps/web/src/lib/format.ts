/** Small display helpers shared across components. */

/** "PostgreSQL 18.4 on x86_64-pc-linux-musl, compiled by…" → "PostgreSQL 18.4". */
export function shortVersion(v?: string): string {
  if (!v) return "ok";
  const m = /^([A-Za-z]+(?:\s+Server)?\s+[\d.]+)/.exec(v);
  return m ? m[1]! : v.length > 40 ? v.slice(0, 40) + "…" : v;
}

/** Compact column type for badges: "character varying(255)" → "varchar". */
export function shortType(t: string): string {
  return t
    .replace(/character varying/i, "varchar")
    .replace(/timestamp without time zone/i, "timestamp")
    .replace(/timestamp with time zone/i, "timestamptz")
    .replace(/double precision/i, "double")
    .replace(/\(.*\)/, "")
    .toLowerCase();
}
