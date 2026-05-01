import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { getDb } from "./store/sqlite.js";
import { connectionRoutes } from "./routes/connections.js";
import { dbRoutes } from "./routes/db.js";
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
  await portabilityRoutes(app);

  // Eager-init SQLite so first request doesn't pay the migration cost.
  getDb();

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`dbweb server ready at http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
