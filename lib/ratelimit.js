// Fixed-window rate limits stored in Postgres (works across serverless instances). Fails open on DB errors
// for the counter only; the request itself still needs the database.
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { HttpError } from "./http.js";
import { now } from "./clock.js";

export async function limit(name, identity, max, windowSeconds) {
  const key = `${name}:${createHash("sha256").update(String(identity)).digest("hex").slice(0, 24)}`;
  const start = new Date(Math.floor(now() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
  try {
    const { query } = await getDb();
    const { rows } = await query(
      `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`, [key, start]);
    if (rows[0].count > max) throw new HttpError(429, "too_many_requests", "Too many attempts. Please wait a few minutes and try again.");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(JSON.stringify({ event: "ratelimit_error", message: err.message }));
  }
}

export async function pruneRateLimits() {
  const { query } = await getDb();
  const r = await query(`DELETE FROM rate_limits WHERE window_start < $1`, [new Date(now() - 2 * 24 * 3_600_000).toISOString()]);
  return r.rowCount;
}
