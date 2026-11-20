// Applies database migrations: DATABASE_URL=postgres://... node scripts/migrate.mjs
// (The app also migrates automatically on first use; this lets you do it ahead of a deployment.)
import { getDb, closeDb } from "../lib/db.js";

try {
  const db = await getDb();
  const { rows } = await db.query(`SELECT version, name, applied_at FROM schema_migrations ORDER BY version`);
  for (const r of rows) console.log(`applied  ${String(r.version).padStart(3, "0")}  ${r.name}  ${new Date(r.applied_at).toISOString()}`);
  console.log("Database is up to date.");
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
