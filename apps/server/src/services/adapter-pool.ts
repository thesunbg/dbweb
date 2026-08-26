import { createAdapter, type DbAdapter } from "@dbweb/adapters";
import { getConnection } from "../store/connections.js";

const cache = new Map<string, { adapter: DbAdapter; lastUsed: number }>();
const IDLE_MS = 5 * 60 * 1000;

// reapIdle() only ran on the next request, so with the app window closed the
// server sat on live sockets to every remote DB indefinitely. Sweep on a timer
// too; unref() keeps this from holding the process open by itself.
const sweep = setInterval(() => reapIdle(), 60 * 1000);
sweep.unref();

/**
 * Returns a connected adapter for the given connection id, reusing one if
 * we've spoken to this connection recently. Idle adapters are reaped on every
 * call and by the sweep timer above.
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

/** Returns IDs of every connection that has a live adapter in the cache.
 *  Used by the UI to render a "connected" dot per connection without paying
 *  for a fresh ping. */
export function getActiveConnectionIds(): string[] {
  reapIdle();
  return [...cache.keys()];
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

/** Closes every pooled adapter — used on shutdown so `pnpm app:stop` (SIGTERM)
 *  hangs up on remote DBs instead of dropping the sockets on the floor. */
export async function closeAllAdapters(): Promise<void> {
  const entries = [...cache.values()];
  cache.clear();
  await Promise.all(entries.map((e) => e.adapter.close().catch(() => undefined)));
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
