import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export * from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

export async function runMigrations(db: Db, migrationsFolder = MIGRATIONS_DIR) {
  await migrate(db, { migrationsFolder });
}
