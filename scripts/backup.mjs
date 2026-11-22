// Saves a full copy of the database to a JSON file.
//   DATABASE_URL=postgres://... node scripts/backup.mjs [--out backups/]
// Keep the files somewhere safe and private: they contain customer names, phones and emails.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb } from "../lib/db.js";
import { exportAll } from "../lib/backup.js";

const i = process.argv.indexOf("--out");
const dir = i > 0 ? process.argv[i + 1] : "backups";
try {
  const data = await exportAll(await getDb());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `poffi-backup-${data.created_at.replace(/[:.]/g, "-").slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify(data));
  console.log(`Backup saved: ${file}`);
  console.log(Object.entries(data.counts).filter(([, n]) => n).map(([t, n]) => `  ${t}: ${n}`).join("\n"));
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
