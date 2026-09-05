import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { BackupFileDto, BackupJobDto, ConnectionConfig } from "@dbweb/shared-types";
import { config } from "../config.js";
import { getConnection } from "../store/connections.js";
import { getEndpoint } from "./adapter-pool.js";

/**
 * Thin wrappers over the vendor CLI tools. Files land in ~/.dbweb/backups
 * with a sidecar .json describing which connection/database they came from.
 * Jobs run detached from the HTTP request; the UI polls `listJobs()`.
 */
const jobs = new Map<string, BackupJobDto>();

export function backupsDir(): string {
  const dir = join(config.dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listJobs(connectionId?: string): BackupJobDto[] {
  return [...jobs.values()]
    .filter((j) => !connectionId || j.connectionId === connectionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 50);
}

export function listBackupFiles(): BackupFileDto[] {
  const dir = backupsDir();
  return readdirSync(dir)
    .filter((f) => !f.endsWith(".json"))
    .map((file) => {
      const st = statSync(join(dir, file));
      let meta: Partial<BackupFileDto> = {};
      const metaFile = join(dir, `${file}.json`);
      if (existsSync(metaFile)) {
        try {
          meta = JSON.parse(readFileSync(metaFile, "utf8")) as Partial<BackupFileDto>;
        } catch {
          // ignore corrupt sidecar
        }
      }
      return { file, sizeBytes: st.size, createdAt: st.mtime.toISOString(), ...meta };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteBackupFile(file: string): boolean {
  const safe = sanitizeFile(file);
  const path = join(backupsDir(), safe);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  const meta = `${path}.json`;
  if (existsSync(meta)) unlinkSync(meta);
  return true;
}

/** Which CLI a kind needs, so the UI can say "install pg_dump" up front. */
export function toolsFor(kind: ConnectionConfig["kind"]): { backup: string; restore: string } | null {
  switch (kind) {
    case "postgres":
      return { backup: "pg_dump", restore: "pg_restore" };
    case "mysql":
      return { backup: "mysqldump", restore: "mysql" };
    case "mongodb":
      return { backup: "mongodump", restore: "mongorestore" };
    default:
      return null;
  }
}

export async function toolAvailable(tool: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("which", [tool]);
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

export async function startBackup(connectionId: string, database: string): Promise<BackupJobDto> {
  const conn = await getConnection(connectionId, true);
  if (!conn) throw new Error("Connection not found");
  const tools = toolsFor(conn.kind);
  if (!tools) throw new Error(`Backup is not supported for ${conn.kind}`);
  if (!(await toolAvailable(tools.backup))) throw new Error(`${tools.backup} not found in PATH — install the ${conn.kind} client tools first.`);

  const ep = await getEndpoint(connectionId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = conn.name.replace(/[^\w.-]+/g, "_");
  const ext = conn.kind === "postgres" ? "dump" : conn.kind === "mysql" ? "sql" : "archive";
  const file = `${safeName}-${database}-${stamp}.${ext}`;
  const path = join(backupsDir(), file);

  const { cmd, args, env } = backupCommand(conn, ep, database, path);
  const job = runJob({ connectionId, kind: "backup", database, file, cmd, args, env });
  writeFileSync(`${path}.json`, JSON.stringify({ connectionId, connectionName: conn.name, kind: conn.kind, database }, null, 2));
  return job;
}

export async function startRestore(connectionId: string, database: string, file: string): Promise<BackupJobDto> {
  const conn = await getConnection(connectionId, true);
  if (!conn) throw new Error("Connection not found");
  const tools = toolsFor(conn.kind);
  if (!tools) throw new Error(`Restore is not supported for ${conn.kind}`);
  if (!(await toolAvailable(tools.restore))) throw new Error(`${tools.restore} not found in PATH — install the ${conn.kind} client tools first.`);
  const path = join(backupsDir(), sanitizeFile(file));
  if (!existsSync(path)) throw new Error("Backup file not found");

  const ep = await getEndpoint(connectionId);
  const { cmd, args, env, stdinFile } = restoreCommand(conn, ep, database, path);
  return runJob({ connectionId, kind: "restore", database, file, cmd, args, env, stdinFile });
}

function backupCommand(conn: ConnectionConfig, ep: { host: string; port: number }, database: string, path: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (conn.kind === "postgres") {
    if (conn.password) env.PGPASSWORD = conn.password;
    return { cmd: "pg_dump", args: ["-h", ep.host, "-p", String(ep.port), "-U", conn.username ?? "postgres", "-d", database, "-F", "c", "-f", path], env };
  }
  if (conn.kind === "mysql") {
    if (conn.password) env.MYSQL_PWD = conn.password;
    return { cmd: "mysqldump", args: ["-h", ep.host, "-P", String(ep.port), "-u", conn.username ?? "root", "--single-transaction", "--routines", "--triggers", `--result-file=${path}`, database], env };
  }
  return { cmd: "mongodump", args: [`--uri=${mongoUri(conn, ep)}`, "--db", database, "--gzip", `--archive=${path}`], env };
}

function restoreCommand(conn: ConnectionConfig, ep: { host: string; port: number }, database: string, path: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (conn.kind === "postgres") {
    if (conn.password) env.PGPASSWORD = conn.password;
    return { cmd: "pg_restore", args: ["-h", ep.host, "-p", String(ep.port), "-U", conn.username ?? "postgres", "-d", database, "--no-owner", "--clean", "--if-exists", path], env };
  }
  if (conn.kind === "mysql") {
    if (conn.password) env.MYSQL_PWD = conn.password;
    return { cmd: "mysql", args: ["-h", ep.host, "-P", String(ep.port), "-u", conn.username ?? "root", database], env, stdinFile: path };
  }
  return { cmd: "mongorestore", args: [`--uri=${mongoUri(conn, ep)}`, "--gzip", `--archive=${path}`, "--drop", `--nsInclude=${database}.*`], env };
}

function mongoUri(conn: ConnectionConfig, ep: { host: string; port: number }): string {
  const auth = conn.username ? `${encodeURIComponent(conn.username)}${conn.password ? `:${encodeURIComponent(conn.password)}` : ""}@` : "";
  const opts = conn.options as { authSource?: string } | undefined;
  const qs = opts?.authSource ? `?authSource=${encodeURIComponent(opts.authSource)}` : "";
  return `mongodb://${auth}${ep.host}:${ep.port}/${qs}`;
}

function runJob(spec: { connectionId: string; kind: "backup" | "restore"; database: string; file: string; cmd: string; args: string[]; env: Record<string, string>; stdinFile?: string }): BackupJobDto {
  const job: BackupJobDto = {
    id: nanoid(10),
    connectionId: spec.connectionId,
    kind: spec.kind,
    database: spec.database,
    file: spec.file,
    status: "running",
    log: `$ ${spec.cmd} ${spec.args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}\n`,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  const child = spawn(spec.cmd, spec.args, { env: spec.env, stdio: [spec.stdinFile ? "pipe" : "ignore", "pipe", "pipe"] });
  if (spec.stdinFile && child.stdin) createReadStream(spec.stdinFile).pipe(child.stdin);
  const append = (chunk: Buffer) => {
    job.log = (job.log + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (err) => {
    job.status = "error";
    job.log += `\n${err.message}`;
    job.finishedAt = new Date().toISOString();
  });
  child.on("close", (code) => {
    job.status = code === 0 ? "done" : "error";
    job.log += `\nexit ${code}`;
    job.finishedAt = new Date().toISOString();
    if (spec.kind === "backup" && code !== 0) {
      // Don't leave a half-written dump around.
      try {
        deleteBackupFile(spec.file);
      } catch {
        // ignore
      }
    }
  });
  return job;
}

function sanitizeFile(file: string): string {
  const safe = file.replace(/[/\\]/g, "");
  if (!safe || safe.startsWith(".")) throw new Error("Bad file name");
  return safe;
}
