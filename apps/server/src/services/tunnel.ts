import { createServer, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { Client } from "ssh2";
import type { SshConfig } from "@dbweb/shared-types";

export interface Tunnel {
  localPort: number;
  close(): Promise<void>;
}

/**
 * Opens an SSH connection and a local TCP listener on 127.0.0.1 that forwards
 * every socket to `targetHost:targetPort` through it. Each DB adapter then
 * simply connects to the local port — no driver needs to know about SSH.
 */
export async function openTunnel(ssh: SshConfig, targetHost: string, targetPort: number): Promise<Tunnel> {
  const client = new Client();
  const privateKey = resolveKey(ssh.privateKey);

  await new Promise<void>((resolve, reject) => {
    client
      .once("ready", () => resolve())
      .once("error", (err) => reject(new Error(`SSH ${ssh.username}@${ssh.host}:${ssh.port}: ${err.message}`)))
      .connect({
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.username,
        password: ssh.password || undefined,
        privateKey,
        passphrase: ssh.passphrase || undefined,
        readyTimeout: 15_000,
        keepaliveInterval: 30_000,
      });
  });

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    client.forwardOut("127.0.0.1", 0, targetHost, targetPort, (err, stream) => {
      if (err) {
        socket.destroy(err);
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.once("close", () => socket.end());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const localPort = typeof address === "object" && address ? address.port : 0;

  return {
    localPort,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.end();
    },
  };
}

/** Accepts PEM contents or an absolute path to a key file (~ expanded). */
function resolveKey(key?: string): Buffer | undefined {
  if (!key) return undefined;
  const trimmed = key.trim();
  if (trimmed.startsWith("-----BEGIN")) return Buffer.from(trimmed);
  const path = trimmed.replace(/^~(?=$|\/)/, process.env.HOME ?? "");
  return readFileSync(path);
}
