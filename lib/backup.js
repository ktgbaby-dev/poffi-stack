// Full logical backup of the database to one JSON file, and restore into an EMPTY database.
// Covers every business table (orders, payments, menu, images, settings, logins, email log).
// Rate-limit counters are left out on purpose.

export const TABLES = [
  "admin_users", "settings", "media", "categories", "products", "product_variations", "addon_groups", "addons",
  "customers", "schedule_closures", "orders", "order_items", "order_item_customisations", "payments",
  "payment_events", "refunds", "order_status_history", "notifications", "job_runs",
];

const encode = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString("base64") };
  return v;
};
const decode = (v) => (v && typeof v === "object" && typeof v.$bytes === "string" ? Buffer.from(v.$bytes, "base64") : v);

export async function exportAll(db) {
  const { rows: mig } = await db.query(`SELECT version, name FROM schema_migrations ORDER BY version`);
  const tables = {};
  for (const t of TABLES) {
    const { rows } = await db.query(`SELECT * FROM ${t} ORDER BY 1`);
    tables[t] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encode(v)])));
  }
  return { format: "poffi-stack-backup", version: 1, created_at: new Date().toISOString(), migrations: mig, tables, counts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])) };
}

export async function restoreAll(db, backup, { force = false } = {}) {
  if (backup?.format !== "poffi-stack-backup") throw new Error("That file isn't a Poffi Stack backup.");
  const { rows: mig } = await db.query(`SELECT max(version)::int AS v FROM schema_migrations`);
  const backupMax = Math.max(0, ...backup.migrations.map((m) => Number(m.version)));
  if ((mig[0].v || 0) < backupMax) throw new Error(`The database is older than the backup (migration ${mig[0].v} < ${backupMax}). Deploy the latest code first.`);
  const { rows: busy } = await db.query(`SELECT (SELECT count(*) FROM orders)::int + (SELECT count(*) FROM products)::int + (SELECT count(*) FROM admin_users)::int AS n`);
  if (busy[0].n > 0 && !force) throw new Error("The target database already has data. Restore only into an empty database (or pass --force to wipe it first).");
  return db.tx(async (q) => {
    if (force) await q(`TRUNCATE ${[...TABLES, "rate_limits"].join(", ")} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      for (const row of backup.tables[t] || []) {
        const cols = Object.keys(row);
        await q(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => decode(row[c])));
      }
      if (t !== "settings") await q(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT max(id) FROM ${t}), 0), 1), (SELECT count(*) > 0 FROM ${t}))`);
    }
    await q(`SELECT setval('order_number_seq', GREATEST(COALESCE((SELECT max(order_number) FROM orders), 0), 1), (SELECT count(*) > 0 FROM orders))`);
    const counts = {};
    for (const t of TABLES) counts[t] = (await q(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    return counts;
  });
}
