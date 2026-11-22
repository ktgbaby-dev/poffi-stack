// Restores a backup file into an EMPTY database (e.g. a new Neon branch or project).
//   DATABASE_URL=postgres://... node scripts/restore.mjs backups/poffi-backup-....json
// Refuses to touch a database that already has orders, products or logins unless --force is given.
import { readFileSync } from "node:fs";
import { closeDb, getDb } from "../lib/db.js";
import { restoreAll } from "../lib/backup.js";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) { console.error("Usage: node scripts/restore.mjs <backup.json> [--force]"); process.exit(1); }
try {
  const counts = await restoreAll(await getDb(), JSON.parse(readFileSync(file, "utf8")), { force: process.argv.includes("--force") });
  console.log("Restored:");
  console.log(Object.entries(counts).filter(([, n]) => n).map(([t, n]) => `  ${t}: ${n}`).join("\n"));
} catch (err) {
  console.error(`Restore failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
