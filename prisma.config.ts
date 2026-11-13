import "dotenv/config";
import { defineConfig } from "prisma/config";

function getDatasourceUrl(): string | undefined {
  const raw = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) return undefined;
  if (!raw.includes("connect_timeout=")) {
    const separator = raw.includes("?") ? "&" : "?";
    return `${raw}${separator}connect_timeout=30`;
  }
  return raw;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: getDatasourceUrl(),
  },
});
