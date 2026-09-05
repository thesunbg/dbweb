import { api, type ColumnInfoDto } from "../api.js";

export interface IndexedTable {
  name: string;
  kind: string;
  columns: ColumnInfoDto[];
}

export interface SchemaIndex {
  database: string;
  tables: IndexedTable[];
  truncated: boolean;
}

const MAX_TABLES = 80;
const CONCURRENCY = 6;

/**
 * Describes every table in a database with bounded parallelism. Shared by
 * the ER diagram, global schema search and the compare tool; cached by
 * TanStack Query under ["schema-index", connId, db].
 */
export async function describeAll(connectionId: string, database: string, limit = MAX_TABLES): Promise<SchemaIndex> {
  const objects = await api.listObjects(connectionId, database);
  const slice = objects.slice(0, limit);
  const tables: IndexedTable[] = new Array(slice.length);
  let next = 0;
  const worker = async () => {
    while (next < slice.length) {
      const i = next++;
      const o = slice[i]!;
      let columns: ColumnInfoDto[] = [];
      try {
        columns = await api.describeObject(connectionId, database, o.name);
      } catch {
        // keep the table with no columns rather than failing the whole index
      }
      tables[i] = { name: o.name, kind: o.kind, columns };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, worker));
  return { database, tables, truncated: objects.length > limit };
}
