// mongodb@3.x is CommonJS — Node ESM can't pull named exports directly.
// Default-import the whole module then destructure at runtime.
import mongodbPkg from "mongodb";
import type { Db, Collection, Cursor, MongoClient as MongoClientType } from "mongodb";
const { MongoClient } = mongodbPkg;
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

/**
 * Pinned to mongodb@3.7 because that's the last driver line that still talks
 * to MongoDB ≤4.0 (wire version <8). Modern v6 driver throws "maximum wire
 * version 5" against legacy servers — common in long-lived production fleets.
 */
class MongoAdapter implements DbAdapter {
  readonly kind = "mongodb" as const;
  private client: MongoClientType | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  private async getClient(): Promise<MongoClientType> {
    if (this.client) return this.client;
    const opts = (this.config.options as Record<string, unknown> | undefined) ?? {};
    const auth =
      this.config.username && this.config.password
        ? `${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.password)}@`
        : "";
    // Putting the database in the URI path makes it the default authSource,
    // which matches how most MongoDB users are provisioned (per-DB role, not
    // an admin-DB user). Without this, the driver auths against `admin` and
    // returns "Authentication failed" for legitimate per-DB credentials.
    // Override via options.uri or options.authSource if you really want admin.
    const dbPath = this.config.database ? `/${encodeURIComponent(this.config.database)}` : "";
    const authSourceQs =
      opts.authSource && typeof opts.authSource === "string"
        ? `?authSource=${encodeURIComponent(opts.authSource)}`
        : "";
    const uri =
      typeof opts.uri === "string"
        ? opts.uri
        : `mongodb://${auth}${this.config.host}:${this.config.port}${dbPath}${authSourceQs}`;
    const client = new MongoClient(uri, {
      useUnifiedTopology: true,
      useNewUrlParser: true,
      serverSelectionTimeoutMS: 4000,
    });
    await client.connect();
    this.client = client;
    return client;
  }

  private async db(name?: string): Promise<Db> {
    const c = await this.getClient();
    return c.db(name ?? this.config.database ?? "test");
  }

  async connect(): Promise<void> {
    await this.getClient();
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    const start = performance.now();
    const c = await this.getClient();
    const r = (await c.db("admin").command({ buildInfo: 1 })) as { version?: string };
    const elapsed = performance.now() - start;
    return { latencyMs: Math.round(elapsed), serverVersion: r.version };
  }

  async listDatabases(): Promise<SchemaObject[]> {
    const c = await this.getClient();
    const r = (await c.db().admin().listDatabases()) as {
      databases: { name: string; sizeOnDisk?: number }[];
    };
    return r.databases
      .filter((d) => !["admin", "config", "local"].includes(d.name))
      .map((d) => ({ name: d.name, kind: "database" as const, meta: { sizeBytes: d.sizeOnDisk } }));
  }

  async listObjects(database: string): Promise<SchemaObject[]> {
    const db = await this.db(database);
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

  /**
   * Mongo is schemaless. We sample N docs and union their top-level keys —
   * rough but useful for the column header in the browser.
   */
  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    const db = await this.db(database);
    const coll = db.collection(name) as Collection;
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
   * Three input shapes are accepted for maximum interop with how engineers
   * already think about MongoDB:
   *
   *   1) Mongo-shell expression: `db.users.find({a:1}).sort({_id:-1}).limit(10)`
   *      — evaluated through a vm sandbox; cursors auto-resolve to arrays.
   *   2) JSON command: `{ "find": "users", "filter": {...}, "limit": 50 }` /
   *      `{ "aggregate": "users", "pipeline": [...] }` — handy from scripts.
   *   3) Bare collection name: `users` — equivalent to a full dump (capped).
   *
   * Output is normalised to the SQL-flavored QueryResult shape so the same
   * result viewer works for every DB kind.
   */
  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? 1000;
    // Default limit injected for unbounded find/aggregate when the user didn't
    // ask for one. 50 mirrors Robo3T / dbweb empty-state hint and matches the
    // user's expectation in the workbench.
    const defaultLimit = Math.min(50, maxRows);
    const start = performance.now();
    const db = await this.db();
    const trimmed = statement.trim();

    let raw: unknown;
    if (trimmed.startsWith("db.") || trimmed.startsWith("db[")) {
      raw = await runMongoShell(db, trimmed, defaultLimit);
    } else if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const collName = (parsed.find ?? parsed.aggregate) as string | undefined;
      if (!collName) throw new Error("JSON command must include 'find' or 'aggregate'");
      const coll = db.collection(collName);
      let cursor: Cursor;
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

  /**
   * Replace a document by `_id` after the user edited the JSON in the UI.
   * The payload is the full document (including `_id`); we strip `_id` from
   * the replacement and use it in the filter so the user can't accidentally
   * change the primary key.
   */
  async replaceDocument(
    database: string,
    collection: string,
    rawDoc: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const id = rawDoc._id;
    if (id === undefined || id === null) {
      throw new Error("Document must contain _id to be replaceable");
    }
    const filter = { _id: coerceObjectId(id) };
    const replacement = { ...rawDoc };
    delete replacement._id;
    const db = await this.db(database);
    const res = await db.collection(collection).replaceOne(filter, replacement);
    return { matchedCount: res.matchedCount ?? 0, modifiedCount: res.modifiedCount ?? 0 };
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    await c.close();
  }
}

/** Accepts the wire forms _id can arrive in: ObjectId hex string, plain number, plain string. */
function coerceObjectId(v: unknown): unknown {
  if (typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v)) {
    try {
      return new (mongodbPkg.ObjectId)(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Mongo shell calls return wildly different shapes (cursor → docs, single
 * document, count number, insert/update/delete result, index list, stats
 * object, …). We funnel them all through a single tabular projection so the
 * web result viewer can render anything.
 */
function normalizeResult(raw: unknown, elapsedMs: number, maxRows: number): QueryResult {
  const docs: unknown[] = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const truncated = docs.length > maxRows;
  const limited = truncated ? docs.slice(0, maxRows) : docs;

  // Determine the field set:
  //  - If every doc is an object → union of keys.
  //  - Otherwise → single column "result".
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
