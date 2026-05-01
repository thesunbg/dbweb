import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createConnection,
  getConnection,
  listConnections,
} from "../store/connections.js";
import { keyFromPassphrase } from "../store/secrets.js";

const exportSchema = z.object({ passphrase: z.string().min(8) });
const importSchema = z.object({
  passphrase: z.string().min(8),
  payload: z.string().min(1),
});

interface BundleEntry {
  name: string;
  kind: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  options?: Record<string, unknown>;
}

interface Bundle {
  version: 1;
  exportedAt: string;
  entries: BundleEntry[];
}

export async function portabilityRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/portability/export", async (req, reply) => {
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    }

    const list = await listConnections();
    const entries: BundleEntry[] = [];
    for (const c of list) {
      // We need plaintext password to re-import elsewhere; pull via secret store.
      const full = await getConnection(c.id, true);
      if (!full) continue;
      entries.push({
        name: full.name,
        kind: full.kind,
        host: full.host,
        port: full.port,
        username: full.username,
        password: full.password,
        database: full.database,
        options: full.options,
      });
    }

    const bundle: Bundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
    };
    const payload = encryptBundle(JSON.stringify(bundle), parsed.data.passphrase);
    return { ok: true, data: { payload, count: entries.length } };
  });

  app.post("/api/portability/import", async (req, reply) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    }

    let bundle: Bundle;
    try {
      const raw = decryptBundle(parsed.data.payload, parsed.data.passphrase);
      bundle = JSON.parse(raw) as Bundle;
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: "DECRYPT_FAILED",
          message: `Wrong passphrase or corrupt payload: ${(err as Error).message}`,
        },
      });
    }

    if (bundle.version !== 1) {
      return reply.code(400).send({
        ok: false,
        error: { code: "UNSUPPORTED_VERSION", message: `Unknown bundle version ${bundle.version}` },
      });
    }

    let imported = 0;
    for (const entry of bundle.entries) {
      // We don't dedupe here — the user may want a clean re-import. UI can warn.
      await createConnection({
        name: entry.name,
        kind: entry.kind as never,
        host: entry.host,
        port: entry.port,
        username: entry.username,
        password: entry.password,
        database: entry.database,
        options: entry.options,
      });
      imported += 1;
    }
    return { ok: true, data: { imported } };
  });
}

const ALGO = "aes-256-gcm";

function encryptBundle(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const key = keyFromPassphrase(passphrase, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "DBWEB1",
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

function decryptBundle(payload: string, passphrase: string): string {
  const parts = payload.split(":");
  if (parts.length !== 5 || parts[0] !== "DBWEB1") {
    throw new Error("Not a dbweb export bundle");
  }
  const [, saltB64, ivB64, tagB64, encB64] = parts;
  const key = keyFromPassphrase(passphrase, Buffer.from(saltB64!, "base64"));
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64!, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
