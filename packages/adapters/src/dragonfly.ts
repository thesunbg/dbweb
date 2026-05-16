import { RedisAdapter } from "./redis.js";
import { registerAdapter } from "./registry.js";

// Dragonfly speaks the Redis wire protocol verbatim — same commands, same
// driver, same tooling. The only reason it exists as a separate registry
// entry is so the UI can label connections accurately and the version-probe
// regex picks up `dragonfly_version` from INFO.
registerAdapter("dragonfly", (config) => new RedisAdapter(config, "dragonfly"));
