import vm from "node:vm";

/**
 * Driver-agnostic MongoDB shell evaluator.
 *
 * Both `mongodb@3.7` (legacy, wire v0–9 → MongoDB 2.6 to 4.2) and
 * `mongodb@6` (modern, wire v8+ → MongoDB 4.2+) expose enough common runtime
 * surface that one evaluator can speak to either: `db.collection()`,
 * `db.command()`, `coll.find()/aggregate()/insertOne()/...`, cursor `.sort/
 * .limit/.skip/.project/.toArray`. The few differences that mattered
 * (collection-level `.stats()` removed in v4, `.count()` removed in v4,
 * `.save()` removed in v4) are handled by routing through `db.command()`
 * which works identically in both lines.
 *
 * The caller passes in the driver package — that's the only piece that
 * actually differs between modern and legacy. We use it to access
 * `ObjectId` for the user's expressions.
 */
export async function runMongoShell(
  db: unknown,
  expression: string,
  defaultLimit: number,
  driverPkg: { ObjectId: new (s?: string) => unknown },
): Promise<unknown> {
  const dbProxy = createDbProxy(db, defaultLimit);
  const ctx = vm.createContext({
    db: dbProxy,
    ObjectId: driverPkg.ObjectId,
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

  // Auto-resolve cursor at top level. The caller didn't write `.toArray()`
  // so we resolve it here, applying default limit if they didn't ask.
  if (isCursorProxy(result)) {
    if (!result.__userLimited) result.__cursor.limit(defaultLimit);
    return result.__cursor.toArray();
  }
  return result;
}

interface CursorProxy {
  __cursor: {
    toArray(): Promise<unknown[]>;
    limit(n: number): unknown;
    sort(s: unknown): unknown;
    skip(n: number): unknown;
    project(p: unknown): unknown;
    count(): Promise<number>;
  };
  __userLimited: boolean;
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
type Collection = any;

function wrapCollection(coll: Collection, defaultLimit: number) {
  return {
    find: (q?: unknown, p?: unknown) =>
      wrapCursor(
        coll.find(
          (q as Record<string, unknown>) ?? {},
          p ? ({ projection: p } as Record<string, unknown>) : undefined,
        ),
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
    // .count() was deprecated in v3 and removed in v4. Always route to
    // countDocuments so the same shell call works on every server version.
    count: (q?: unknown) => coll.countDocuments((q as object) ?? {}),
    countDocuments: (q?: unknown) => coll.countDocuments((q as object) ?? {}),
    distinct: (field: string, q?: unknown) => coll.distinct(field, (q as object) ?? {}),
    aggregate: (pipeline: unknown, opts?: unknown) =>
      wrapCursor(coll.aggregate(pipeline as object[], (opts as object) ?? {})),
    createIndex: (spec: unknown, opts?: unknown) =>
      coll.createIndex(spec as Record<string, 1 | -1>, (opts as object) ?? {}),
    dropIndex: (name: unknown) => coll.dropIndex(name as string),
    getIndexes: () => coll.indexes(),
    indexes: () => coll.indexes(),
    drop: () => coll.drop(),
    rename: (n: unknown) => coll.rename(n as string),
    getName: () => coll.collectionName,
    // .stats() exists on the collection in v3 but was removed in v4. Routing
    // through db.command keeps the call portable.
    stats: () => {
      const dbRef = (coll as { s?: { db?: Db }; dbName?: string }).s?.db ?? coll.db;
      const cmdHost: Db = dbRef ?? coll;
      return cmdHost.command({ collStats: coll.collectionName });
    },
  };
  void defaultLimit;
}

function createDbProxy(db: Db, defaultLimit: number) {
  // Reserved db-level methods. Anything else is treated as a collection name.
  // Stats / serverStatus / hostInfo are routed through db.command() because
  // the corresponding sugar methods were removed in mongodb v4+.
  const reserved: Record<string, unknown> = {
    stats: () => db.command({ dbStats: 1 }),
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
      return wrapCollection(db.collection(prop), defaultLimit);
    },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
