import { createDb, runMigrations } from "./index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, pool } = createDb(url);
await runMigrations(db);
console.log("migrations applied");
await pool.end();
