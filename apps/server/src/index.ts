import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { getDb } from "./store/sqlite.js";
import { closeAllAdapters } from "./services/adapter-pool.js";
import { connectionRoutes } from "./routes/connections.js";
import { dbRoutes } from "./routes/db.js";
import { exportRoutes } from "./routes/export.js";
import { portabilityRoutes } from "./routes/portability.js";

async function main() {
  const app = Fastify({
    logger: { transport: { target: "pino-pretty", options: { colorize: true } } },
  });

  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    data: { service: "dbweb", version: "0.1.0", time: new Date().toISOString() },
  }));

  await connectionRoutes(app);
  await dbRoutes(app);
  await exportRoutes(app);
  await portabilityRoutes(app);

  // Serve the built web app from the same origin so the whole thing is one
  // process — that is what the installed Chrome PWA points at. Dev still uses
  // the Vite server on 4318 with its /api proxy.
  const webDir = resolveWebDir();
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, index: ["index.html"] });
    // SPA fallback: anything that isn't /api and isn't a real file gets index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api")) {
        return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
      }
      return reply.sendFile("index.html");
    });
  }

  // Eager-init SQLite so first request doesn't pay the migration cost.
  getDb();

  installIdleExit(app);

  // launchctl bootout / Ctrl-C: hang up on remote DBs before exiting.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void (async () => {
        app.log.info(`${signal} — shutting down`);
        await closeAllAdapters();
        await app.close();
        process.exit(0);
      })();
    });
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`dbweb server ready at http://${config.host}:${config.port}`);
  if (webDir) app.log.info(`serving web ui from ${webDir}`);
}

/**
 * Exits cleanly once nothing has talked to the server for `idleExitMinutes`.
 * KeepAlive in the plist is `SuccessfulExit: false`, so a zero exit means
 * launchd leaves it down until the launcher app (or the next login) brings it
 * back. In-flight requests hold it open — a long export never gets cut off.
 */
function installIdleExit(app: FastifyInstance): void {
  const minutes = config.idleExitMinutes;
  if (!minutes || minutes <= 0) return;

  const idleMs = minutes * 60 * 1000;
  let lastActivity = Date.now();
  let inFlight = 0;

  app.addHook("onRequest", async () => {
    inFlight += 1;
    lastActivity = Date.now();
  });
  app.addHook("onResponse", async () => {
    inFlight = Math.max(0, inFlight - 1);
    lastActivity = Date.now();
  });

  const timer = setInterval(() => {
    if (inFlight > 0) return;
    if (Date.now() - lastActivity < idleMs) return;
    clearInterval(timer);
    void (async () => {
      app.log.info(`idle for ${minutes}m — exiting`);
      await closeAllAdapters();
      await app.close();
      process.exit(0);
    })();
  }, 30_000);
  timer.unref();

  app.log.info(`idle-exit armed: ${minutes}m`);
}

/**
 * Locates the built web bundle. DBWEB_WEB_DIR wins; otherwise walk the usual
 * spots relative to this file so both `tsx src/index.ts` and `node dist/index.js`
 * resolve it.
 */
function resolveWebDir(): string | null {
  if (process.env.DBWEB_WEB_DIR) {
    const dir = resolve(process.env.DBWEB_WEB_DIR);
    return existsSync(join(dir, "index.html")) ? dir : null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../web/dist", "../../../web/dist"]) {
    const dir = resolve(here, rel);
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
