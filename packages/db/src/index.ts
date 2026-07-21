/**
 * Typed read layer for the dashboard. The schema's source of truth is the
 * Go migrations in internal/db/migrations — when those change, update
 * schema.ts to match. The Go ingest service applies migrations on boot;
 * nothing in this package writes DDL.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export * from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
