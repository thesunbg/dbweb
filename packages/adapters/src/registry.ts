import type { ConnectionConfig, DbKind } from "@dbweb/shared-types";
import type { AdapterFactory, DbAdapter } from "./types.js";

const factories = new Map<DbKind, AdapterFactory>();

export function registerAdapter(kind: DbKind, factory: AdapterFactory): void {
  factories.set(kind, factory);
}

export function createAdapter(config: ConnectionConfig): DbAdapter {
  const factory = factories.get(config.kind);
  if (!factory) {
    throw new Error(
      `No adapter registered for kind "${config.kind}". Did you forget to import it?`,
    );
  }
  return factory(config);
}

export function listRegisteredKinds(): DbKind[] {
  return [...factories.keys()];
}
