import vm from "node:vm";
import mongodbPkg from "mongodb";
import type { Db, Collection } from "mongodb";

const { ObjectId } = mongodbPkg;

/**
 * Evaluate a mongo-shell-style expression against a connected Db and return
 * a plain value (array, document, number, ...). Cursors are auto-resolved
 * via toArray(); a default limit is injected when the user didn't set one,
 * so that `db.users.find()` doesn't dump millions of rows.
 *
 * Supported surface mirrors what Robo3T / mongosh users expect:
 *   db.coll.find/findOne/insert/update/delete/count/distinct/aggregate
 *   db.coll.createIndex/dropIndex/getIndexes/indexes/stats
 *   db.stats / db.getCollectionNames / db.runCommand
 *   ObjectId(...), ISODate(...), NumberLong/Int (no-op casts)
 */
export async function runMongoShell(
  db: Db,
  expression: string,
  defaultLimit: number,
): Promise<unknown> {
  const dbProxy = createDbProxy(db, defaultLimit);
  const ctx = vm.createContext({
    db: dbProxy,
    ObjectId,
    ISODate: (s?: string) => (s ? new Date(s) : new Date()),
    Date,
    NumberLong: (v: unknown) => Number(v),
    NumberInt: (v: unknown) => Number(v),
    print: () => undefined,
    printjson: () => undefined,
  });

  // Wrap in an async IIFE so `await` works inside the user's expression.
  const code = `(async () => (${expression.trim().replace(/;\s*$/, "")}))()`;
  let result: unknown;
  try {
    result = vm.runInContext(code, ctx, { timeout: 30_000 });
  } catch (err) {
    throw new Error(`Shell parse: ${(err as Error).message}`);
  }
  result = await result;

  // If the user's expression ended at a cursor (e.g. `db.x.find().sort(...)`),
  // resolve it now. Apply default limit only when they didn't specify one.
  if (isCursorProxy(result)) {
    const cp = result as CursorProxy;
    if (!cp.__userLimited) cp.__cursor.limit(defaultLimit);
    return cp.__cursor.toArray();
  }
  return result;
}

interface CursorProxy {
  __cursor: { toArray(): Promise<unknown[]>; limit(n: number): unknown; sort(s: unknown): unknown; skip(n: number): unknown; project(p: unknown): unknown; count(): Promise<number> };
  __userLimited: boolean;
  // chainables — forwarded
  sort(s: unknown): CursorProxy;
  limit(n: number): CursorProxy;
  skip(n: number): CursorProxy;
  project(p: unknown): CursorProxy;
  toArray(): Promise<unknown[]>;
  count(): Promise<number>;
  then<T>(onFulfilled?: (v: unknown[]) => T, onRejected?: (e: Error) => T): Promise<T>;
}

function isCursorProxy(v: unknown): v is CursorProxy {
  return !!v && typeof v === "object" && "__cursor" in (v as object);
}

function wrapCursor(cursor: CursorProxy["__cursor"], userLimited = false): CursorProxy {
  const proxy: CursorProxy = {
    __cursor: cursor,
    __userLimited: userLimited,
    sort: (s) => {
      cursor.sort(s);
      return wrapCursor(cursor, userLimited);
    },
    limit: (n) => {
      cursor.limit(n);
      return wrapCursor(cursor, true);
    },
    skip: (n) => {
      cursor.skip(n);
      return wrapCursor(cursor, userLimited);
    },
    project: (p) => {
      cursor.project(p);
      return wrapCursor(cursor, userLimited);
    },
    toArray: () => cursor.toArray(),
    count: () => cursor.count(),
    then: (onFulfilled, onRejected) =>
      cursor.toArray().then(onFulfilled as (v: unknown[]) => unknown, onRejected) as Promise<never>,
  };
  return proxy;
}

function wrapCollection(coll: Collection, defaultLimit: number) {
  return {
    find: (q?: unknown, p?: unknown) =>
      wrapCursor(
        coll.find(
          (q as Record<string, unknown>) ?? {},
          p ? ({ projection: p } as Record<string, unknown>) : undefined,
        ) as unknown as CursorProxy["__cursor"],
      ),
    findOne: (q?: unknown, p?: unknown) =>
      coll.findOne(
        (q as Record<string, unknown>) ?? {},
        p ? ({ projection: p } as Record<string, unknown>) : undefined,
      ),
    insert: (d: unknown) =>
      Array.isArray(d) ? coll.insertMany(d as object[]) : coll.insertOne(d as object),
    insertOne: (d: unknown) => coll.insertOne(d as object),
    insertMany: (d: unknown) => coll.insertMany(d as object[]),
    save: (d: unknown) => coll.save(d as object),
    update: (q: unknown, u: unknown, opts?: unknown) =>
      coll.updateMany(q as object, u as object, opts as object),
    updateOne: (q: unknown, u: unknown, opts?: unknown) =>
      coll.updateOne(q as object, u as object, opts as object),
    updateMany: (q: unknown, u: unknown, opts?: unknown) =>
      coll.updateMany(q as object, u as object, opts as object),
    replaceOne: (q: unknown, d: unknown, opts?: unknown) =>
      coll.replaceOne(q as object, d as object, opts as object),
    remove: (q: unknown) => coll.deleteMany((q as object) ?? {}),
    deleteOne: (q: unknown) => coll.deleteOne((q as object) ?? {}),
    deleteMany: (q: unknown) => coll.deleteMany((q as object) ?? {}),
    count: (q?: unknown) => coll.countDocuments((q as object) ?? {}),
    countDocuments: (q?: unknown) => coll.countDocuments((q as object) ?? {}),
    distinct: (field: string, q?: unknown) => coll.distinct(field, (q as object) ?? {}),
    aggregate: (pipeline: unknown, opts?: unknown) =>
      wrapCursor(
        coll.aggregate(pipeline as object[], (opts as object) ?? {}) as unknown as CursorProxy["__cursor"],
      ),
    createIndex: (spec: unknown, opts?: unknown) =>
      coll.createIndex(spec as Record<string, 1 | -1>, (opts as object) ?? {}),
    dropIndex: (name: unknown) => coll.dropIndex(name as string),
    getIndexes: () => coll.indexes(),
    indexes: () => coll.indexes(),
    stats: () => coll.stats(),
    drop: () => coll.drop(),
    rename: (n: unknown) => coll.rename(n as string),
    // unused by us but printed nicely if user inspects
    getName: () => coll.collectionName,
    explain: () => ({ note: "explain() requires runCommand" }),
  };
  // Note on parameter defaults: defaultLimit is consumed at toArray time inside
  // runMongoShell, not here. Kept as a parameter so future per-call overrides
  // can flow through wrapCollection if needed.
  void defaultLimit;
}

function createDbProxy(db: Db, defaultLimit: number) {
  // Reserved db-level methods. Anything else is treated as a collection name.
  const reserved: Record<string, unknown> = {
    stats: () => db.stats(),
    getCollectionNames: async () => {
      const list = (await db.listCollections({}, { nameOnly: true }).toArray()) as { name: string }[];
      return list.map((c) => c.name);
    },
    getCollection: (name: string) => wrapCollection(db.collection(name), defaultLimit),
    runCommand: (cmd: unknown) => db.command(cmd as object),
    listCollections: () => db.listCollections().toArray(),
    dropDatabase: () => db.dropDatabase(),
    getName: () => db.databaseName,
    serverStatus: () => db.command({ serverStatus: 1 }),
    hostInfo: () => db.command({ hostInfo: 1 }),
    version: async () => {
      const r = (await db.command({ buildInfo: 1 })) as { version?: string };
      return r.version;
    },
  };

  return new Proxy(reserved, {
    get(target, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop in target) return target[prop as string];
      // Treat any other property access as a collection.
      return wrapCollection(db.collection(prop), defaultLimit);
    },
  });
}
