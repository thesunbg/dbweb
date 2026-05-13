import type { ConnectionConfig, ConnectionInput, DbKind } from "@dbweb/shared-types";

/**
 * Map a URI scheme back to a `DbKind`. The list covers the variants every
 * popular ORM (TypeORM, Prisma, Sequelize, SQLAlchemy, Knex) emits, plus a
 * couple of Mongo-specific ones (`mongodb+srv` for Atlas, `rediss` for TLS
 * Redis).
 */
const SCHEME_TO_KIND: Record<string, DbKind> = {
  "postgres:": "postgres",
  "postgresql:": "postgres",
  "mysql:": "mysql",
  "mysql2:": "mysql",
  "mariadb:": "mysql",
  "mongodb:": "mongodb",
  "mongodb+srv:": "mongodb",
  "redis:": "redis",
  "rediss:": "redis",
  "mssql:": "mssql",
  "sqlserver:": "mssql",
  "oracle:": "oracle",
  "oracledb:": "oracle",
};

const KIND_TO_SCHEME: Record<DbKind, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mongodb: "mongodb",
  redis: "redis",
  mssql: "mssql",
  oracle: "oracle",
};

const DEFAULT_PORTS: Record<DbKind, number> = {
  mysql: 3306,
  postgres: 5432,
  oracle: 1521,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379,
};

export interface ParsedConnection {
  kind: DbKind;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  options?: Record<string, unknown>;
}

/**
 * Parse a connection URL string into the same shape we use for
 * `ConnectionInput`. Returns `null` if the URL is malformed or the scheme is
 * one we don't recognise — callers display a hint to the user instead of
 * silently doing nothing.
 *
 * Accepts the loose forms commonly seen in `.env` files:
 *   postgres://user:pass@host:5432/db
 *   postgresql://user:pass@host/db?sslmode=require
 *   mysql://user:pass@host:3306/db
 *   mongodb://user:pass@host:27017/db?authSource=admin
 *   mongodb+srv://user:pass@cluster.example.net/db
 *   redis://:password@host:6379/0
 *   sqlserver://user:pass@host:1433/db
 */
export function parseConnectionUrl(input: string): ParsedConnection | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Strip a leading `DATABASE_URL=` so the user can paste a literal env line.
  const stripped = trimmed.replace(/^[A-Z_][A-Z0-9_]*\s*=\s*/i, "");
  // Allow surrounding quotes — common when copying from .env files.
  const cleaned = stripped.replace(/^['"]/, "").replace(/['"]$/, "");

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }

  const kind = SCHEME_TO_KIND[url.protocol];
  if (!kind) return null;

  const host = url.hostname;
  if (!host) return null;
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[kind];
  const username = url.username ? safeDecode(url.username) : undefined;
  const password = url.password ? safeDecode(url.password) : undefined;
  // pathname starts with "/" if present — strip it. Empty pathname → no DB.
  const dbRaw = url.pathname.replace(/^\//, "");
  const database = dbRaw ? safeDecode(dbRaw) : undefined;

  const options: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => {
    options[k] = v;
  });
  // For mongodb+srv we keep the SRV scheme by stashing the full URI in
  // options so the adapter uses it verbatim — SRV needs DNS resolution that
  // simple host/port can't represent.
  if (url.protocol === "mongodb+srv:") {
    options.uri = cleaned;
  }

  return {
    kind,
    host,
    port,
    username,
    password,
    database,
    options: Object.keys(options).length > 0 ? options : undefined,
  };
}

/**
 * Reverse of `parseConnectionUrl` — build a canonical URL from a connection.
 * Used both for "Copy as URL" and for displaying what the connection looks
 * like in env-var form.
 */
export function buildConnectionUrl(
  c: ConnectionConfig | (ConnectionInput & { password?: string }),
): string {
  // mongodb+srv pre-stashed in options.uri → return it as-is so SRV records
  // resolve correctly.
  const opts = c.options as { uri?: string } | undefined;
  if (c.kind === "mongodb" && typeof opts?.uri === "string") return opts.uri;

  const scheme = KIND_TO_SCHEME[c.kind];
  const auth =
    c.username
      ? `${encodeURIComponent(c.username)}${c.password ? `:${encodeURIComponent(c.password)}` : ""}@`
      : "";
  // Show port unless it's the default — keeps URLs short and matches what
  // ORMs typically emit.
  const port =
    c.port && c.port !== DEFAULT_PORTS[c.kind] ? `:${c.port}` : c.port ? `:${c.port}` : "";
  const dbPath = c.database ? `/${encodeURIComponent(c.database)}` : "";

  const params = new URLSearchParams();
  if (c.options) {
    for (const [k, v] of Object.entries(c.options)) {
      if (k === "uri") continue;
      if (v === undefined || v === null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        params.set(k, String(v));
      } else {
        params.set(k, JSON.stringify(v));
      }
    }
  }
  const qs = params.toString() ? `?${params.toString()}` : "";

  return `${scheme}://${auth}${c.host}${port}${dbPath}${qs}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
