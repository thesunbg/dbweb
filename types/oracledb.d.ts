// Minimal oracledb type shim covering only the surface we use.
// The full project doesn't ship official types; pulling @types/oracledb
// (community) creates churn — keep this scoped to what the adapter touches.
declare module "oracledb" {
  export const OUT_FORMAT_ARRAY: number;
  export const OUT_FORMAT_OBJECT: number;
  export const CLOB: number;
  export const DATE: number;
  export let fetchAsString: number[];

  export interface Metadata {
    name: string;
    dbType?: number;
    nullable?: boolean;
  }

  export interface ExecuteOptions {
    outFormat?: number;
    maxRows?: number;
    autoCommit?: boolean;
    fetchInfo?: Record<string, unknown>;
  }

  export interface Result<T> {
    rows?: T[];
    metaData?: Metadata[];
    rowsAffected?: number;
  }

  export interface Connection {
    execute<T = unknown>(
      sql: string,
      bindParams?: unknown[] | Record<string, unknown>,
      options?: ExecuteOptions,
    ): Promise<Result<T>>;
    close(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }

  export interface PoolAttributes {
    user?: string;
    password?: string;
    connectString?: string;
    poolMin?: number;
    poolMax?: number;
    poolIncrement?: number;
    [k: string]: unknown;
  }

  export interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }

  export function createPool(attrs: PoolAttributes): Promise<Pool>;
  export function initOracleClient(opts?: { libDir?: string }): void;

  const _default: {
    OUT_FORMAT_ARRAY: number;
    OUT_FORMAT_OBJECT: number;
    CLOB: number;
    DATE: number;
    fetchAsString: number[];
    createPool: typeof createPool;
    initOracleClient: typeof initOracleClient;
  };
  export default _default;
}
