import type { ConnectionColor, DbKind } from "@dbweb/shared-types";

/** Display metadata per engine — glyph for the 24px badge, human label,
 *  default port. Single place so the sidebar, form and workbench agree. */
export const KIND_LABEL: Record<DbKind, { glyph: string; label: string; port: number }> = {
  mysql: { glyph: "My", label: "MySQL / MariaDB", port: 3306 },
  postgres: { glyph: "Pg", label: "PostgreSQL", port: 5432 },
  oracle: { glyph: "Or", label: "Oracle", port: 1521 },
  mssql: { glyph: "Ms", label: "SQL Server", port: 1433 },
  mongodb: { glyph: "Mo", label: "MongoDB", port: 27017 },
  redis: { glyph: "Rd", label: "Redis", port: 6379 },
  dragonfly: { glyph: "Df", label: "Dragonfly", port: 6379 },
  clickhouse: { glyph: "Ch", label: "ClickHouse", port: 8123 },
};

/** Human label for each environment color — shown on the workbench pill. */
export const COLOR_LABEL: Record<ConnectionColor, string> = {
  red: "Production",
  orange: "Staging",
  yellow: "QA",
  green: "Dev",
  blue: "Local",
  purple: "Analytics",
  gray: "Other",
};

export const KIND_ORDER: DbKind[] = ["postgres", "mysql", "mssql", "oracle", "clickhouse", "mongodb", "redis", "dragonfly"];
