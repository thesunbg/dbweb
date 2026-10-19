import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ConnectionInput } from "@dbweb/shared-types";
import { config } from "../config.js";
import { createConnection, deleteConnection, getConnection, listConnections, updateConnection } from "../store/connections.js";
import { dropAdapter } from "./adapter-pool.js";

/**
 * Embedded mode (DBWEB_EMBEDDED=1): dbweb is a "DB studio" inside a hosting
 * platform. That changes the security model of a local-first tool, so:
 *
 * - every request except GET /api/health must carry the `x-dbweb-token`
 *   header. Only the platform's proxy knows it and adds it after checking the
 *   user's session; other containers on the same network cannot use dbweb.
 * - the platform owns the connection list (DBWEB_CONNECTIONS, a JSON array of
 *   connections with an `id`), synced at startup. Creating, editing or probing
 *   arbitrary connections would let a user reach any host the server can.
 * - features that touch the server's filesystem or other hosts (SSH tunnels,
 *   dump/restore tools, encrypted bundles with passwords) are off.
 */

/** Routes refused in embedded mode, as [method, path pattern]. */
const BLOCKED: [string, RegExp][] = [
  ["POST", /^\/api\/connections$/],
  ["POST", /^\/api\/connections\/test$/],
  ["PATCH", /^\/api\/connections\/[^/]+$/],
  ["PUT", /^\/api\/connections\/[^/]+$/],
  ["DELETE", /^\/api\/connections\/[^/]+$/],
  ["POST", /^\/api\/connections\/[^/]+\/duplicate$/],
  ["*", /^\/api\/connections\/[^/]+\/(backup|backup-tools|restore)$/],
  ["*", /^\/api\/backups(\/|$)/],
  ["*", /^\/api\/portability(\/|$)/],
];

function tokenOK(got: string | string[] | undefined): boolean {
  if (typeof got !== "string" || !config.embedToken) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(config.embedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function installEmbeddedGuard(app: FastifyInstance): void {
  if (!config.embedded) return;
  if (config.embedToken.length < 16) {
    throw new Error("DBWEB_EMBEDDED=1 needs DBWEB_EMBED_TOKEN (at least 16 characters)");
  }
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] ?? "";
    if (req.method === "GET" && path === "/api/health") return;
    if (!tokenOK(req.headers["x-dbweb-token"])) {
      return reply.code(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "Open the DB studio from the platform dashboard" } });
    }
    for (const [method, re] of BLOCKED) {
      if ((method === "*" || method === req.method) && re.test(path)) {
        return reply.code(403).send({
          ok: false,
          error: { code: "EMBEDDED", message: "Not available in the hosted DB studio: connections are managed by the platform" },
        });
      }
    }
  });
}

interface SeedConnection extends ConnectionInput {
  id: string;
}

/** Makes the stored connections match DBWEB_CONNECTIONS (create, update, delete). */
export async function syncEmbeddedConnections(log: FastifyInstance["log"]): Promise<void> {
  if (!config.embedded) return;
  let wanted: SeedConnection[];
  try {
    wanted = JSON.parse(process.env.DBWEB_CONNECTIONS || "[]") as SeedConnection[];
    if (!Array.isArray(wanted)) throw new Error("not an array");
  } catch (err) {
    log.error(`DBWEB_CONNECTIONS is not valid JSON: ${(err as Error).message}`);
    return;
  }
  const keep = new Set<string>();
  for (const c of wanted) {
    if (!c || typeof c.id !== "string" || !c.id || !c.kind || !c.host || !c.port) continue;
    keep.add(c.id);
    const input: ConnectionInput = {
      name: c.name || c.id,
      kind: c.kind,
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      database: c.database,
      group: c.group ?? null,
      color: c.color ?? null,
      readOnly: c.readOnly ?? false,
      ssh: null,
      options: c.options,
    };
    if (await getConnection(c.id)) {
      await updateConnection(c.id, input);
      await dropAdapter(c.id);
    } else {
      await createConnection(input, c.id);
    }
  }
  for (const c of await listConnections()) {
    if (!keep.has(c.id)) {
      await dropAdapter(c.id);
      await deleteConnection(c.id);
    }
  }
  log.info(`embedded: ${keep.size} platform connection(s)`);
}
