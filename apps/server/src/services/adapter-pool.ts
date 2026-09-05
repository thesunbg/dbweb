import { createAdapter, type DbAdapter } from "@dbweb/adapters";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { getConnection } from "../store/connections.js";
import { openTunnel, type Tunnel } from "./tunnel.js";

interface Entry {
  adapter: DbAdapter;
  tunnel: Tunnel | null;
  /** Host/port the adapter actually dials (127.0.0.1:<tunnel port> when tunnelled). */
  endpoint: { host: string; port: number };
  lastUsed: number;
}

const cache = new Map<string, Entry>();
const IDLE_MS = 5 * 60 * 1000;

// reapIdle() only ran on the next request, so with the app window closed the
// server sat on live sockets to every remote DB indefinitely. Sweep on a timer
// too; unref() keeps this from holding the process open by itself.
const sweep = setInterval(() => reapIdle(), 60 * 1000);
sweep.unref();

/**
 * Returns a connected adapter for the given connection id, reusing one if
 * we've spoken to this connection recently. Idle adapters are reaped on every
 * call and by the sweep timer above. Connections with an SSH config get a
 * tunnel opened first; the adapter then dials the local forward.
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
  const { adapter, tunnel, endpoint } = await openAdapter(conn);
  cache.set(connectionId, { adapter, tunnel, endpoint, lastUsed: Date.now() });
  return adapter;
}

/** Builds (and connects) an adapter for a config, tunnelling when needed.
 *  Shared with the ad-hoc "Test connection" route, which never caches. */
export async function openAdapter(conn: ConnectionConfig): Promise<{ adapter: DbAdapter; tunnel: Tunnel | null; endpoint: { host: string; port: number } }> {
  let tunnel: Tunnel | null = null;
  let effective = conn;
  if (conn.ssh?.host) {
    tunnel = await openTunnel(conn.ssh, conn.host, conn.port);
    effective = { ...conn, host: "127.0.0.1", port: tunnel.localPort };
  }
  const adapter = createAdapter(effective);
  try {
    await adapter.connect();
  } catch (err) {
    await tunnel?.close().catch(() => undefined);
    throw err;
  }
  return { adapter, tunnel, endpoint: { host: effective.host, port: effective.port } };
}

/** Where a live adapter is dialling — CLI tools (pg_dump…) reuse the tunnel. */
export async function getEndpoint(connectionId: string): Promise<{ host: string; port: number }> {
  await getAdapter(connectionId);
  return cache.get(connectionId)!.endpoint;
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
  await closeEntry(hit);
}

/** Closes every pooled adapter — used on shutdown so `pnpm app:stop` (SIGTERM)
 *  hangs up on remote DBs instead of dropping the sockets on the floor. */
export async function closeAllAdapters(): Promise<void> {
  const entries = [...cache.values()];
  cache.clear();
  await Promise.all(entries.map((e) => closeEntry(e)));
}

/** Keeps an adapter alive across the idle sweep (open transactions, schedules). */
export function touchAdapter(connectionId: string): void {
  const hit = cache.get(connectionId);
  if (hit) hit.lastUsed = Date.now();
}

async function closeEntry(e: Entry): Promise<void> {
  try {
    await e.adapter.close();
  } catch {
    // best-effort
  }
  await e.tunnel?.close().catch(() => undefined);
}

function reapIdle(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (now - entry.lastUsed > IDLE_MS) {
      cache.delete(id);
      void closeEntry(entry);
    }
  }
}
