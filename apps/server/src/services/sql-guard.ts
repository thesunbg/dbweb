import type { DbKind } from "@dbweb/shared-types";

/**
 * Read-only enforcement. Deliberately conservative: a false positive
 * (blocking a SELECT that mentions a column called `update`) is far cheaper
 * than a false negative on a production box, and the error message tells
 * the user exactly why so they can flip the flag if they really mean it.
 */
const SQL_WRITE = new Set([
  "insert", "update", "delete", "drop", "alter", "create", "truncate", "replace", "merge", "grant", "revoke",
  "rename", "call", "exec", "execute", "upsert", "copy", "vacuum", "lock", "load", "optimize", "attach", "detach",
  "kill", "shutdown", "reindex", "cluster", "refresh", "purge", "flashback", "commit", "rollback", "begin", "start",
]);

const REDIS_WRITE = new Set([
  "set", "del", "unlink", "flushall", "flushdb", "hset", "hmset", "hdel", "hincrby", "hincrbyfloat", "lpush", "rpush",
  "lpop", "rpop", "lset", "lrem", "ltrim", "linsert", "sadd", "srem", "spop", "smove", "zadd", "zrem", "zincrby",
  "zpopmin", "zpopmax", "zremrangebyscore", "zremrangebyrank", "incr", "incrby", "incrbyfloat", "decr", "decrby",
  "expire", "expireat", "pexpire", "pexpireat", "persist", "rename", "renamenx", "append", "setex", "psetex", "setnx",
  "mset", "msetnx", "getset", "getdel", "config", "eval", "evalsha", "script", "xadd", "xdel", "xtrim", "restore",
  "migrate", "move", "swapdb", "pfadd", "geoadd", "bitop", "setbit", "setrange", "copy", "function", "acl", "debug",
  "multi", "exec", "discard", "watch", "publish", "spublish", "client", "cluster", "failover", "replicaof", "slaveof",
]);

const MONGO_WRITE = /\.(insert\w*|update\w*|replace\w*|delete\w*|remove|drop\w*|rename\w*|createIndex\w*|dropIndex\w*|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findAndModify|createCollection|save|reIndex|convertToCapped|adminCommand|fsync\w*|shutdownServer|setProfilingLevel)\s*\(/i;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/#[^\n]*/g, " ");
}

/** Returns the offending keyword when `statement` writes, else null. */
export function findWriteKeyword(kind: DbKind, statement: string): string | null {
  const s = statement.trim();
  if (!s) return null;
  if (kind === "mongodb") {
    const m = MONGO_WRITE.exec(s);
    if (m) return m[1]!;
    if (/runCommand\s*\(\s*\{\s*["']?(insert|update|delete|drop\w*|create\w*|rename\w*|findAndModify|shutdown)/i.test(s)) return "runCommand";
    return null;
  }
  if (kind === "redis" || kind === "dragonfly") {
    const first = s.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    return REDIS_WRITE.has(first) ? first.toUpperCase() : null;
  }
  // SQL: strip string literals + comments, then look for whole-word write verbs.
  const cleaned = stripSqlComments(s).replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/`[^`]*`/g, "``");
  for (const stmt of cleaned.split(";")) {
    const words = stmt.toLowerCase().match(/[a-z_]+/g) ?? [];
    const first = words[0];
    if (!first) continue;
    // `WITH cte AS (...) INSERT ...` and `SELECT ... FOR UPDATE` are caught
    // by scanning every word, not only the leading one.
    if (first === "explain" || first === "describe" || first === "desc" || first === "show") {
      // EXPLAIN ANALYZE actually runs the statement — only allow plain EXPLAIN.
      if (first === "explain" && words[1] === "analyze") return "EXPLAIN ANALYZE";
      continue;
    }
    for (const w of words) if (SQL_WRITE.has(w)) return w.toUpperCase();
  }
  return null;
}
