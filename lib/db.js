// Database access. Production: PostgreSQL (Neon) through `pg`. Local dev and tests: PGlite (Postgres in WASM)
// when DATABASE_URL starts with "pglite:" ("pglite:memory" or "pglite:./path/to/dir").
//
//   const db = await getDb();
//   await db.query(sql, params)              -> { rows, rowCount }
//   await db.tx(async (q) => { await q(sql, params) ... })   one transaction, rolled back on throw
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
let dbPromise = null;

export function getDb() {
  if (!dbPromise) dbPromise = open().catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

// Tests: drop the cached handle so the next getDb() opens a fresh database.
export async function closeDb() {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  dbPromise = null;
  await db?.close?.();
}

async function open() {
  const url = env("DATABASE_URL");
  if (!url) {
    const err = new Error("DATABASE_URL is not set");
    err.code = "db_not_configured";
    throw err;
  }
  const db = url.startsWith("pglite:") ? await openPglite(url.slice(7)) : await openPg(url);
  await migrate(db);
  return db;
}

async function openPg(url) {
  const { default: pg } = await import("pg");
  // Return BIGINT/NUMERIC counts as JS numbers (ids and counts here are far below 2^53).
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1082, (v) => v); // DATE stays "YYYY-MM-DD" (never a local-midnight Date)
  const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true };
  const pool = new pg.Pool({ connectionString: url, ssl, max: Number(env("DB_POOL_MAX", "3")), idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error(JSON.stringify({ event: "db_pool_error", message: err.message })));
  const query = async (text, params = []) => {
    const r = await pool.query(text, params);
    return { rows: r.rows, rowCount: r.rowCount ?? 0 };
  };
  return {
    kind: "pg",
    query,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q = async (text, params = []) => { const r = await client.query(text, params); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; };
        const out = await fn(q);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(location) {
  // Built from parts so Vercel's bundler never pulls the (dev-only) WASM package into the function.
  const pkg = ["@electric-sql", "pglite"].join("/");
  const { PGlite } = await import(pkg);
  const parsers = { 1082: (v) => v, 20: (v) => Number(v) };
  const inst = location === "memory" || location === "" ? new PGlite({ parsers }) : new PGlite(location, { parsers });
  await inst.waitReady;
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows?.length ?? 0 });
  const numeric = (rows) => rows; // PGlite already returns int8 as number for safe values
  return {
    kind: "pglite",
    query: async (text, params = []) => { const r = norm(await inst.query(text, params)); r.rows = numeric(r.rows); return r; },
    async tx(fn) {
      return inst.transaction(async (t) => fn(async (text, params = []) => norm(await t.query(text, params))));
    },
    close: () => inst.close(),
    raw: inst,
  };
}

// Versioned migrations: lib/migrations/NNN_name.sql, applied once each, in order, under a lock.
async function migrate(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(migrationsDir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const { rows } = await db.query(`SELECT version FROM schema_migrations`);
  const done = new Set(rows.map((r) => Number(r.version)));
  const pending = files.filter((f) => !done.has(Number(f.slice(0, 3))));
  if (!pending.length) return;
  await db.tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(727274)`);
    const again = new Set((await q(`SELECT version FROM schema_migrations`)).rows.map((r) => Number(r.version)));
    for (const f of pending) {
      const version = Number(f.slice(0, 3));
      if (again.has(version)) continue;
      const sql = await readFile(join(migrationsDir, f), "utf8");
      for (const stmt of splitSql(sql)) await q(stmt);
      await q(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [version, f]);
      console.log(JSON.stringify({ event: "migration_applied", file: f }));
    }
  });
}

// Splits a migration file on semicolons that end a line (no functions with $$ bodies are used).
function splitSql(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
