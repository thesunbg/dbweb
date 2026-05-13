/**
 * Postgres / Oracle fold unquoted identifiers to a single case (lowercase
 * for Postgres, uppercase for Oracle). Tools that create tables with mixed
 * case — Prisma, TypeORM, sqlc — have to wrap the names in `"..."` to
 * preserve them. Anyone running plain SQL afterwards then has to remember
 * the quotes, which is annoying.
 *
 * `autoQuoteSql` is a small string-aware preprocessor that:
 *   1) Skips string literals, line/block comments, and already-quoted
 *      identifiers — anything inside those is left untouched.
 *   2) For every bare identifier whose lowercase form matches a known
 *      mixed-case table on this connection, replaces the bare identifier
 *      with the canonical `"Name"` form.
 *
 * Lowercase tables (`users`, `audit_log`) need no quoting and are not
 * touched, so users on conventional schemas don't see any rewrite.
 */
export interface AutoQuoteResult {
  sql: string;
  replaced: string[];
}

export function autoQuoteSql(sql: string, tables: string[]): AutoQuoteResult {
  // Build the case-insensitive lookup. We only register tables whose lower-
  // case form differs from the canonical name — i.e. mixed-case ones. That's
  // the entire population that can fail without quoting.
  // Schema-qualified names come in as `schema.table` — register each part
  // separately so the tokenizer (which doesn't understand `.`) can still
  // recognise both halves and quote them independently.
  const map = new Map<string, string>();
  for (const t of tables) {
    if (!t) continue;
    for (const part of t.split(".")) {
      if (part && part.toLowerCase() !== part) {
        map.set(part.toLowerCase(), part);
      }
    }
  }
  if (map.size === 0) return { sql, replaced: [] };

  const replaced = new Set<string>();
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;

    // String literal — single quotes. Doubled '' inside is the escape form.
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // Quoted identifier — already quoted, preserve verbatim.
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // Line comment -- ... \n
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      if (end === -1) { out += sql.slice(i); i = n; continue; }
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) { out += sql.slice(i); i = n; continue; }
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Bare identifier — letter or underscore, followed by alphanumerics/_.
    // Postgres also allows $ in identifiers; we include it for completeness.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      const proper = map.get(word.toLowerCase());
      if (proper) {
        out += `"${proper}"`;
        replaced.add(proper);
      } else {
        out += word;
      }
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { sql: out, replaced: [...replaced] };
}
