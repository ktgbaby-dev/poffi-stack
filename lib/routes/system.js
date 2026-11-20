// Paystack webhook, the automation cron, product images and a health check.
import { createHash, timingSafeEqual } from "node:crypto";
import { getDb } from "../db.js";
import { HttpError, json } from "../http.js";
import { emailConfig, env, paystackConfig, siteUrl } from "../config.js";
import { verifyWebhook } from "../paystack.js";
import { expireUnpaid, handleWebhookEvent, reconcilePending } from "../payments.js";
import { processDue } from "../notifications.js";
import { pruneRateLimits } from "../ratelimit.js";
import { serveMedia } from "../media.js";
import { now } from "../clock.js";

async function webhook(request) {
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > 256 * 1024) return json({ error: "too_large" }, 413);
  const check = verifyWebhook(raw, request.headers);
  if (!check.ok) {
    console.warn(JSON.stringify({ event: "webhook_rejected", reason: "bad signature" }));
    return json({ error: "invalid_signature" }, 401);
  }
  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return json({ error: "bad_json" }, 400); }
  const out = await handleWebhookEvent(event, { origin: siteUrl(request) });
  return json({ received: true, duplicate: out.duplicate });
}

function cronAuthorised(request) {
  const secret = env("CRON_SECRET");
  if (secret.length < 16) throw new HttpError(503, "not_configured", "CRON_SECRET is not set.");
  const header = request.headers.get("authorization") || "";
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, "unauthorised", "Not allowed.");
}

// Runs every safety net once. Called by Vercel Cron (with the CRON_SECRET bearer) or any external scheduler.
export async function runAutomation(origin, job = "cron") {
  const db = await getDb();
  const { rows } = await db.query(`INSERT INTO job_runs (job) VALUES ($1) RETURNING id`, [job]);
  const runId = rows[0].id;
  const result = {};
  let ok = true;
  for (const [name, fn] of [
    ["payments", () => reconcilePending({ origin })],
    ["notifications", () => processDue({ origin })],
    ["expired_orders", () => expireUnpaid({})],
    ["rate_limits_pruned", () => pruneRateLimits()],
  ]) {
    try { result[name] = await fn(); } catch (err) { ok = false; result[name] = { error: err.message }; console.error(JSON.stringify({ event: "automation_step_failed", step: name, message: err.message })); }
  }
  await db.query(`UPDATE job_runs SET finished_at = now(), ok = $2, result = $3::text::jsonb WHERE id = $1`, [runId, ok, JSON.stringify(result)]);
  await db.query(`DELETE FROM job_runs WHERE started_at < $1`, [new Date(now() - 30 * 24 * 3_600_000).toISOString()]);
  return { ok, result };
}

async function cron(request) {
  cronAuthorised(request);
  const out = await runAutomation(siteUrl(request));
  return json(out, out.ok ? 200 : 500);
}

async function media(request, { file }) {
  return serveMedia(file, request);
}

async function health() {
  let database = "ok";
  try { await (await getDb()).query("SELECT 1"); } catch (err) { database = err.code === "db_not_configured" ? "not_configured" : "error"; }
  const p = paystackConfig();
  return json({ ok: database === "ok", database, paystack: p.mode, email: emailConfig().configured ? "configured" : "off", reminders: emailConfig().reminderDelivery });
}

export const systemRoutes = [
  ["POST", "/api/paystack/webhook", webhook],
  ["GET", "/api/cron/run", cron],
  ["POST", "/api/cron/run", cron],
  ["GET", "/media/:file", media],
  ["GET", "/api/health", health],
];
