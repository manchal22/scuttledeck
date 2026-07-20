import { createDb, type Db } from "@scuttledeck/db";

let cached: Db | undefined;

export function db(): Db {
  if (!cached) {
    const url =
      process.env.DATABASE_URL ??
      "postgres://scuttledeck:scuttledeck@localhost:5432/scuttledeck";
    cached = createDb(url).db;
  }
  return cached;
}
