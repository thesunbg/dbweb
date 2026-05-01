// We pin two MongoDB drivers side-by-side because no single line covers every
// server we need to talk to:
//
//   mongodb@3.7  → wire v0–9  → MongoDB 2.6 to 4.2
//   mongodb@6.x  → wire v8+   → MongoDB 4.2 onwards (incl. 5, 6, 7, 8)
//
// The dispatcher in this file picks one at connect time. By default it tries
// the modern driver first; if the server reports a wire version the modern
// driver refuses, we silently fall back to legacy. Users can also force a
// specific line via `connection.options.driver = "modern" | "legacy"`.
import legacyPkg from "mongodb";
// `mongodb-modern` is an npm alias to mongodb@6 — see package.json.
import * as modernPkg from "mongodb-modern";

import type { ConnectionConfig } from "@dbweb/shared-types";
import type {
  ColumnInfo,
  DbAdapter,
  DbStats,
  ExecuteOptions,
  QueryResult,
  SchemaObject,
} from "./types.js";
import { registerAdapter } from "./registry.js";
import { runMongoShell } from "./mongodb-shell.js";

type DriverKind = "modern" | "legacy";

interface DriverPkg {
  MongoClient: new (uri: string, opts?: Record<string, unknown>) => MongoLikeClient;
  ObjectId: new (s?: string) => unknown;
}

interface MongoLikeClient {
  connect(): Promise<MongoLikeClient> | Promise<void>;
  db(name?: string): MongoLikeDb;
  close(): Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type MongoLikeDb = any;

class MongoAdapter implements DbAdapter {
  readonly kind = "mongodb" as const;
  private client: MongoLikeClient | null = null;
  private driverKind: DriverKind | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  /**
   * Returns the connected client, the driver kind that was used, and the
   * driver package itself (so callers can mint `ObjectId` etc.).
   */
  private async getClientAndDriver(): Promise<{
    client: MongoLikeClient;
    driver: DriverKind;
    pkg: DriverPkg;
  }> {
    if (this.client && this.driverKind) {
      return {
        client: this.client,
        driver: this.driverKind,
        pkg: this.driverKind === "modern"
          ? (modernPkg as unknown as DriverPkg)
          : (legacyPkg as unknown as DriverPkg),
      };
    }

    const uri = this.buildUri();
    const opts = (this.config.options as { driver?: "auto" | DriverKind } | undefined) ?? {};
    const forced = opts.driver;

    const tryConnect = async (kind: DriverKind) => {
      if (kind === "modern") {
        const pkg = modernPkg as unknown as DriverPkg;
        const client = new pkg.MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
        await client.connect();
        return { client, driver: "modern" as const, pkg };
      }
      const pkg = legacyPkg as unknown as DriverPkg;
      const client = new pkg.MongoClient(uri, {
        useUnifiedTopology: true,
        useNewUrlParser: true,
        serverSelectionTimeoutMS: 4000,
      });
      await client.connect();
      return { client, driver: "legacy" as const, pkg };
    };

    let chosen: { client: MongoLikeClient; driver: DriverKind; pkg: DriverPkg };
    if (forced === "legacy") {
      chosen = await tryConnect("legacy");
    } else if (forced === "modern") {
      chosen = await tryConnect("modern");
    } else {
      // auto: try modern first.
      try {
        chosen = await tryConnect("modern");
      } catch (err) {
        const msg = String((err as Error)?.message ?? "");
        // The modern driver emits this exact phrase against pre-4.2 servers.
        // Anything else (auth, network, DNS) we propagate as-is to keep the
        // error message helpful for the user.
        if (/wire version/i.test(msg)) {
          try {
            chosen = await tryConnect("legacy");
          } catch {
            throw err; // surface the modern wire-version message
          }
        } else {
          throw err;
        }
      }
    }

    this.client = chosen.client;
    this.driverKind = chosen.driver;
    return chosen;
  }

  private buildUri(): string {
    const opts = (this.config.options as Record<string, unknown> | undefined) ?? {};
    if (typeof opts.uri === "string") return opts.uri;
    const auth =
      this.config.username && this.config.password
        ? `${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.password)}@`
        : "";
    // Putting the database in the URI path makes it the default authSource —
    // matches how most MongoDB users are provisioned (per-DB roles, not
    // admin-DB users). Without this, the driver auths against `admin` and
    // returns "Authentication failed" for legitimate per-DB credentials.
    const dbPath = this.config.database ? `/${encodeURIComponent(this.config.database)}` : "";
    const authSourceQs =
      typeof opts.authSource === "string"
        ? `?authSource=${encodeURIComponent(opts.authSource)}`
        : "";
    return `mongodb://${auth}${this.config.host}:${this.config.port}${dbPath}${authSourceQs}`;
  }

  private async db(name?: string): Promise<MongoLikeDb> {
    const { client } = await this.getClientAndDriver();
    return client.db(name ?? this.config.database ?? "test");
  }

  async connect(): Promise<void> {
    await this.getClientAndDriver();
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    const start = performance.now();
    const { client, driver } = await this.getClientAndDriver();
    const r = (await client.db("admin").command({ buildInfo: 1 })) as { version?: string };
    const elapsed = performance.now() - start;
    // Surface which line we picked alongside the version — useful when the
    // user is checking their connection in the workbench.
    return {
      latencyMs: Math.round(elapsed),
      serverVersion: r.version ? `${r.version} (${driver})` : driver,
    };
  }

  async listDatabases(): Promise<SchemaObject[]> {
    const { client } = await this.getClientAndDriver();
    const r = (await client.db().admin().listDatabases()) as {
      databases: { name: string; sizeOnDisk?: number }[];
    };
    return r.databases
      .filter((d) => !["admin", "config", "local"].includes(d.name))
      .map((d) => ({ name: d.name, kind: "database" as const, meta: { sizeBytes: d.sizeOnDisk } }));
  }

  async listObjects(database: string): Promise<SchemaObject[]> {
    const db = await this.db(database);
    // listCollections({}, {nameOnly:false}) works on both drivers; the second
    // arg is ignored on v6 when not set explicitly so we keep it.
    const list = (await db.listCollections({}, { nameOnly: false }).toArray()) as {
      name: string;
      type?: string;
    }[];
    return list.map((c) => ({
      name: c.name,
      parent: database,
      kind: c.type === "view" ? ("view" as const) : ("collection" as const),
    }));
  }

  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    const db = await this.db(database);
    const coll = db.collection(name);
    const docs = (await coll.find({}).limit(50).toArray()) as Record<string, unknown>[];
    const keys = new Set<string>();
    for (const d of docs) for (const k of Object.keys(d)) keys.add(k);
    return [...keys].map((k) => ({
      name: k,
      dataType: "any",
      nullable: true,
      primaryKey: k === "_id",
    }));
  }

  /**
   * Three input shapes are accepted:
   *   1) Mongo-shell: `db.users.find({a:1}).sort({_id:-1}).limit(10)`
   *   2) JSON command: `{ "find": "users", "filter": {...} }` /
   *      `{ "aggregate": "users", "pipeline": [...] }`
   *   3) Bare collection name: dumps the collection with default limit.
   */
  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? 1000;
    const defaultLimit = Math.min(50, maxRows);
    const start = performance.now();
    const { pkg } = await this.getClientAndDriver();
    const db = await this.db();
    const trimmed = statement.trim();

    let raw: unknown;
    if (trimmed.startsWith("db.") || trimmed.startsWith("db[")) {
      raw = await runMongoShell(db, trimmed, defaultLimit, pkg);
    } else if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const collName = (parsed.find ?? parsed.aggregate) as string | undefined;
      if (!collName) throw new Error("JSON command must include 'find' or 'aggregate'");
      const coll = db.collection(collName);
      let cursor;
      if (parsed.aggregate !== undefined) {
        cursor = coll.aggregate((parsed.pipeline as object[] | undefined) ?? [], {
          allowDiskUse: true,
        });
      } else {
        cursor = coll.find(
          (parsed.filter as Record<string, unknown> | undefined) ?? {},
          {
            projection: parsed.projection as Record<string, unknown> | undefined,
            sort: parsed.sort as [string, 1 | -1][] | undefined,
            limit: (parsed.limit as number | undefined) ?? defaultLimit,
          },
        );
      }
      raw = await cursor.toArray();
    } else {
      raw = await db
        .collection(trimmed)
        .find({})
        .limit(defaultLimit)
        .toArray();
    }

    const elapsedMs = Math.round(performance.now() - start);
    return normalizeResult(raw, elapsedMs, maxRows);
  }

  async getStats(database?: string): Promise<DbStats> {
    const db = await this.db(database);
    const stats = (await db.command({ dbStats: 1 })) as {
      dataSize?: number;
      storageSize?: number;
      indexes?: number;
    };
    const colls = await db.listCollections({}, { nameOnly: true }).toArray();
    return {
      sizeBytes: stats.dataSize ?? stats.storageSize,
      tableCount: colls.length,
      extras: { storageSize: stats.storageSize, indexes: stats.indexes },
    };
  }

  async replaceDocument(
    database: string,
    collection: string,
    rawDoc: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const id = rawDoc._id;
    if (id === undefined || id === null) {
      throw new Error("Document must contain _id to be replaceable");
    }
    const { pkg } = await this.getClientAndDriver();
    const filter = { _id: coerceObjectId(id, pkg) };
    const replacement = { ...rawDoc };
    delete replacement._id;
    const db = await this.db(database);
    const res = await db.collection(collection).replaceOne(filter, replacement);
    return {
      matchedCount: (res.matchedCount as number) ?? 0,
      modifiedCount: (res.modifiedCount as number) ?? 0,
    };
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    this.driverKind = null;
    await c.close();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function coerceObjectId(v: unknown, pkg: DriverPkg): unknown {
  // Only coerce the canonical 24-char hex; anything else (numeric ids, custom
  // string keys) passes through unchanged.
  if (typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v)) {
    try {
      return new pkg.ObjectId(v);
    } catch {
      return v;
    }
  }
  return v;
}

function normalizeResult(raw: unknown, elapsedMs: number, maxRows: number): QueryResult {
  const docs: unknown[] = Array.isArray(raw)
    ? raw
    : raw === null || raw === undefined
      ? []
      : [raw];
  const truncated = docs.length > maxRows;
  const limited = truncated ? docs.slice(0, maxRows) : docs;

  const keyed = limited.every((d) => d !== null && typeof d === "object" && !Array.isArray(d));
  if (!keyed) {
    return {
      fields: ["result"],
      rows: limited.map((d) => [d]),
      rowCount: limited.length,
      elapsedMs,
      truncated,
    };
  }
  const fieldsSet = new Set<string>();
  for (const d of limited) for (const k of Object.keys(d as object)) fieldsSet.add(k);
  const fields = [...fieldsSet];
  const rows = limited.map((d) => fields.map((f) => (d as Record<string, unknown>)[f]));
  return { fields, rows, rowCount: limited.length, elapsedMs, truncated };
}

registerAdapter("mongodb", (config) => new MongoAdapter(config));
