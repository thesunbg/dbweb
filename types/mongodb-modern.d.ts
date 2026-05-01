// `mongodb-modern` is an npm alias for `mongodb@^6` (see packages/adapters/package.json).
// We don't need full type fidelity for the dispatcher — it interacts with both
// drivers through a narrow runtime surface — so we declare a permissive shim
// rather than chase the real v6 typings (which would conflict with @types/mongodb v3
// already installed for the legacy import).
declare module "mongodb-modern" {
  export class MongoClient {
    constructor(uri: string, options?: Record<string, unknown>);
    connect(): Promise<MongoClient>;
    db(name?: string): unknown;
    close(): Promise<void>;
  }
  export class ObjectId {
    constructor(id?: string);
    toString(): string;
  }
}
