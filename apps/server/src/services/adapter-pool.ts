import { createAdapter, type DbAdapter } from "@dbweb/adapters";
import { getConnection } from "../store/connections.js";

const cache = new Map<string, { adapter: DbAdapter; lastUsed: number }>();
const IDLE_MS = 5 * 60 * 1000;

/**
 * Returns a connected adapter for the given connection id, reusing one if
 * we've spoken to this connection recently. Idle adapters are reaped lazily.
 */
export async function getAdapter(connectionId: string): Promise<DbAdapter> {
  reapIdle();
  const hit = cache.get(connectionId);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.adapter;
  }
  const conn = await getConnection(connectionId, true);
  if (!conn) throw new Error(`Connection ${connectionId} not found`);
  const adapter = createAdapter(conn);
  await adapter.connect();
  cache.set(connectionId, { adapter, lastUsed: Date.now() });
  return adapter;
}

export async function dropAdapter(connectionId: string): Promise<void> {
  const hit = cache.get(connectionId);
  if (!hit) return;
  cache.delete(connectionId);
  try {
    await hit.adapter.close();
  } catch {
    // best-effort
  }
}

function reapIdle(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (now - entry.lastUsed > IDLE_MS) {
      cache.delete(id);
      void entry.adapter.close().catch(() => undefined);
    }
  }
}
