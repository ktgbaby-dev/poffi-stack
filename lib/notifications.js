// Outgoing email: order confirmations, owner alerts, status updates and owner reminders.
//
// The `notifications` table is the single source of truth. Every message has a dedupe_key, so it can only
// exist once. Sending always starts with a conditional "claim" (pending/failed -> sending) in the database,
// so two workers (the webhook, the return page, the cron job) can never send the same message twice.
//
// Reminders: with REMINDER_DELIVERY=resend-scheduled (default) a reminder is handed to Resend with
// `scheduled_at` as soon as the order is paid, so it arrives on time even on Vercel Hobby (one cron a day).
// With REMINDER_DELIVERY=cron the processor sends reminders when they fall due; run it every few minutes.
// Either way the cron job is a safety net: it retries failures, cancels reminders that no longer apply
// and checks what happened to scheduled ones.
import { getDb } from "./db.js";
import { emailConfig } from "./config.js";
import { cancelScheduledEmail, resend, sendEmail } from "./email.js";
import { getSettings, ownerRecipients } from "./settings.js";
import { loadItems, loadOrderRow } from "./order-data.js";
import * as T from "./templates.js";
import { now } from "./clock.js";

export const BACKOFF_MIN = [2, 10, 30, 120, 360];
const CLAIM_STALE_MS = 5 * 60_000;
const SCHEDULE_MIN_LEAD_MS = 2 * 60_000; // closer than this: just send now
const RESEND_MAX_AHEAD_MS = 29 * 24 * 3_600_000;
const log = (event) => console.log(JSON.stringify({ event: "notification", ...event }));

export async function enqueue(q, { orderId = null, kind, recipient, dedupeKey, sendAt = null, payload = {} }) {
  const { rows } = await q(
    `INSERT INTO notifications (order_id, kind, recipient, dedupe_key, send_at, payload)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6::text::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [orderId, kind, recipient, dedupeKey, sendAt ? new Date(sendAt).toISOString() : null, JSON.stringify(payload)]);
  return rows[0] ? Number(rows[0].id) : null;
}

// Called in the payment transaction the moment an order becomes paid.
export async function queuePaidOrder(q, order, settings, nowMs) {
  if (settings.notifications.customer_confirmation) {
    await enqueue(q, { orderId: order.id, kind: "customer_confirmation", recipient: order.customer_email, dedupeKey: `customer_confirmation:${order.id}` });
  }
  const owners = ownerRecipients(settings);
  if (settings.notifications.new_order && owners.length) {
    await enqueue(q, { orderId: order.id, kind: "owner_new_order", recipient: owners.join(", "), dedupeKey: `owner_new_order:${order.id}` });
  }
  await syncReminders(q, order, settings, nowMs);
}

export async function queueOwnerAlert(q, order, settings, key, alert) {
  const owners = ownerRecipients(settings);
  if (!owners.length) return null;
  return enqueue(q, { orderId: order.id, kind: "owner_alert", recipient: owners.join(", "), dedupeKey: `owner_alert:${order.id}:${key}`, payload: alert });
}

export async function queueStatusChange(q, order, settings, status) {
  if (settings.notifications.customer_status?.[status]) {
    await enqueue(q, { orderId: order.id, kind: "customer_status", recipient: order.customer_email, dedupeKey: `customer_status:${order.id}:${status}`, payload: { status } });
  }
  if (status === "cancelled" && settings.notifications.cancellation) {
    const owners = ownerRecipients(settings);
    if (owners.length) await enqueue(q, { orderId: order.id, kind: "owner_cancellation", recipient: owners.join(", "), dedupeKey: `owner_cancellation:${order.id}` });
  }
}

const reminderValid = (o) => o.payment_status === "paid" && !["completed", "cancelled", "awaiting_payment"].includes(o.status);

// Makes the order's reminders match the rules: one per configured offset that is still in the future,
// only while the order is paid and not completed/cancelled. Reminders that no longer apply are cancelled
// (a reminder already handed to Resend is flagged so its cancellation is sent to Resend after commit).
export async function syncReminders(q, order, settings, nowMs) {
  const atMs = new Date(order.scheduled_at).getTime();
  const owners = ownerRecipients(settings);
  const want = new Map();
  if (reminderValid(order) && owners.length) {
    for (const off of settings.notifications.reminder_offsets || []) {
      const sendAt = atMs - off * 60_000;
      if (sendAt > nowMs + 60_000) want.set(`owner_reminder:${order.id}:${off}:${atMs}`, { off, sendAt });
    }
  }
  const { rows: existing } = await q(
    `SELECT id, dedupe_key, status, provider_id FROM notifications WHERE order_id = $1 AND kind = 'owner_reminder' AND status IN ('pending', 'failed', 'scheduled', 'sending')`, [order.id]);
  let cancelled = 0;
  for (const n of existing) {
    if (want.has(n.dedupe_key)) { want.delete(n.dedupe_key); continue; }
    const pendingAtResend = n.status === "scheduled" || n.status === "sending";
    await q(
      `UPDATE notifications SET status = 'cancelled', updated_at = now(), last_error = NULL,
         payload = payload || $2::text::jsonb WHERE id = $1`,
      [n.id, JSON.stringify({ cancel_pending: pendingAtResend && !!n.provider_id, cancelled_reason: reminderValid(order) ? "time or settings changed" : `order is ${order.status}` })]);
    cancelled++;
  }
  for (const [key, { off, sendAt }] of want) {
    await enqueue(q, { orderId: order.id, kind: "owner_reminder", recipient: owners.join(", "), dedupeKey: key, sendAt, payload: { offset_minutes: off, scheduled_at_ms: atMs } });
  }
  return { cancelled, created: want.size };
}

function render(n, order, items, settings, origin) {
  switch (n.kind) {
    case "customer_confirmation": return T.customerConfirmation(order, items, settings, origin);
    case "owner_new_order": return T.ownerNewOrder(order, items, settings, origin);
    case "owner_reminder": return T.ownerReminder(order, items, settings, origin, n.payload.offset_minutes);
    case "owner_cancellation": return T.ownerCancellation(order, items, settings, origin);
    case "customer_status": return T.customerStatus(order, items, settings, origin, n.payload.status);
    case "owner_alert": return T.ownerAlert(order, settings, origin, n.payload);
    case "test": return T.testEmail(settings, origin);
    default: throw new Error(`unknown notification kind ${n.kind}`);
  }
}

// Why a claimed notification should not go out any more (null = send it).
function skipReason(n, order, nowMs) {
  if (n.order_id && !order) return "order no longer exists";
  if (n.kind === "owner_reminder") {
    if (!reminderValid(order)) return `order is ${order.status === "awaiting_payment" ? "unpaid" : order.status}`;
    if (Number(n.payload.scheduled_at_ms) !== new Date(order.scheduled_at).getTime()) return "order time changed";
    if (nowMs > new Date(order.scheduled_at).getTime()) return "fulfilment time has passed";
  }
  if (n.kind === "customer_status" && order.status !== n.payload.status) return `order moved on to ${order.status}`;
  return null;
}

const nextAttempt = (attempts, nowMs) => new Date(nowMs + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000).toISOString();

// Claims and sends (or schedules) one notification. Safe to call from anywhere, any number of times.
export async function deliver(id, { origin, nowMs = now() } = {}) {
  const db = await getDb();
  const { rows } = await db.query(
    `UPDATE notifications SET status = 'sending', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'failed') AND attempts < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
     RETURNING *`, [id, new Date(nowMs).toISOString()]);
  if (!rows.length) return { id, result: "not_claimable" };
  const n = { ...rows[0], id: Number(rows[0].id), order_id: rows[0].order_id === null ? null : Number(rows[0].order_id) };
  const finish = async (status, fields = {}) => {
    await db.query(
      `UPDATE notifications SET status = $2, provider_id = COALESCE($3, provider_id), last_error = $4, next_attempt_at = $5, sent_at = $6, subject = COALESCE($7, subject),
         attempts = CASE WHEN $8 THEN max_attempts ELSE attempts END, updated_at = now() WHERE id = $1`,
      [n.id, status, fields.providerId ?? null, fields.error ?? null, fields.nextAttemptAt ?? null, fields.sentAt ?? null, fields.subject ?? null, !!fields.dead]);
    log({ id: n.id, kind: n.kind, order_id: n.order_id, status, error: fields.error });
    return { id: n.id, result: status, error: fields.error };
  };
  try {
    const settings = await getSettings();
    const order = n.order_id ? await loadOrderRow(db.query, "o.id = $1", [n.order_id]) : null;
    const reason = skipReason(n, order, nowMs);
    if (reason) return finish("skipped", { error: reason });
    const cfg = emailConfig();
    if (!cfg.configured) return finish("skipped", { error: "email is not set up (RESEND_API_KEY missing)" });
    const to = n.recipient.split(",").map((s) => s.trim()).filter(Boolean);
    if (!to.length) return finish("skipped", { error: "no recipient" });
    const items = order ? await loadItems(db.query, order.id) : [];
    const msg = render(n, order, items, settings, origin || n.payload.origin || "");
    const sendAtMs = new Date(n.send_at).getTime();
    const scheduleIt = n.kind === "owner_reminder" && cfg.reminderDelivery === "resend-scheduled" && sendAtMs > nowMs + SCHEDULE_MIN_LEAD_MS;
    if (n.kind === "owner_reminder" && !scheduleIt && sendAtMs > nowMs + SCHEDULE_MIN_LEAD_MS) {
      // cron mode, not due yet: give the claim back untouched
      await db.query(`UPDATE notifications SET status = 'pending', attempts = attempts - 1, updated_at = now() WHERE id = $1`, [n.id]);
      return { id: n.id, result: "not_due" };
    }
    if (scheduleIt && sendAtMs > nowMs + RESEND_MAX_AHEAD_MS) {
      await db.query(`UPDATE notifications SET status = 'pending', attempts = attempts - 1, updated_at = now() WHERE id = $1`, [n.id]);
      return { id: n.id, result: "too_far_ahead" };
    }
    const res = await sendEmail({ to, subject: msg.subject, html: msg.html, text: msg.text, settings, scheduledAt: scheduleIt ? sendAtMs : null, idempotencyKey: `poffi-notification-${n.id}` });
    if (res.ok) {
      return scheduleIt
        ? finish("scheduled", { providerId: res.data?.id, subject: msg.subject })
        : finish("sent", { providerId: res.data?.id, sentAt: new Date(nowMs).toISOString(), subject: msg.subject });
    }
    if (res.retryable && n.attempts < n.max_attempts) return finish("failed", { error: res.error, nextAttemptAt: nextAttempt(n.attempts, nowMs), subject: msg.subject });
    return finish("failed", { error: res.error, dead: true, subject: msg.subject });
  } catch (err) {
    return finish("failed", { error: `internal error: ${err.message}`, nextAttemptAt: nextAttempt(n.attempts, nowMs) });
  }
}

// Sends Resend cancellations for reminders that were cancelled after being handed over.
async function flushCancellations(db) {
  const { rows } = await db.query(`SELECT id, provider_id FROM notifications WHERE status = 'cancelled' AND provider_id IS NOT NULL AND payload->>'cancel_pending' = 'true' LIMIT 50`);
  let done = 0;
  for (const r of rows) {
    const res = await cancelScheduledEmail(r.provider_id);
    // 404/422 means Resend no longer has it scheduled (already sent or cancelled): nothing left to do.
    const settled = res.ok || res.status === 404 || res.status === 422;
    await db.query(`UPDATE notifications SET payload = payload || $2::text::jsonb, last_error = $3, updated_at = now() WHERE id = $1`,
      [r.id, JSON.stringify({ cancel_pending: !settled, resend_cancel: settled ? (res.ok ? "cancelled" : `not needed (${res.status})`) : "retrying" }), settled ? null : res.error]);
    if (settled) done++;
  }
  return done;
}

// After its send time, ask Resend what became of a scheduled reminder.
async function checkScheduled(db, nowMs) {
  const { rows } = await db.query(
    `SELECT id, provider_id FROM notifications WHERE status = 'scheduled' AND send_at < $1 AND provider_id IS NOT NULL ORDER BY send_at LIMIT 30`,
    [new Date(nowMs - 10 * 60_000).toISOString()]);
  let checked = 0;
  for (const r of rows) {
    const res = await resend(`/emails/${encodeURIComponent(r.provider_id)}`, { method: "GET" });
    if (!res.ok) continue;
    const ev = String(res.data?.last_event || "");
    const status = ["delivered", "sent", "opened", "clicked", "delivery_delayed"].includes(ev) ? "sent"
      : ev === "canceled" || ev === "cancelled" ? "cancelled"
      : ["bounced", "failed", "complained"].includes(ev) ? "failed" : null;
    if (!status) continue;
    await db.query(`UPDATE notifications SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN COALESCE(sent_at, send_at) ELSE sent_at END, attempts = CASE WHEN $2 = 'failed' THEN max_attempts ELSE attempts END, last_error = CASE WHEN $2 = 'failed' THEN $3 ELSE last_error END, updated_at = now() WHERE id = $1 AND status = 'scheduled'`,
      [r.id, status, `Resend reported ${ev}`]);
    checked++;
  }
  return checked;
}

// Cancels reminders whose order is no longer active (normally done at status change; this is the safety net).
async function reconcileReminders(db, nowMs) {
  const { rows } = await db.query(
    `SELECT DISTINCT n.order_id FROM notifications n JOIN orders o ON o.id = n.order_id
     WHERE n.kind = 'owner_reminder' AND n.status IN ('pending', 'failed', 'scheduled')
       AND (o.status IN ('completed', 'cancelled', 'awaiting_payment') OR o.payment_status <> 'paid' OR (n.payload->>'scheduled_at_ms')::bigint <> (extract(epoch FROM o.scheduled_at) * 1000)::bigint)
     LIMIT 50`);
  if (!rows.length) return 0;
  const settings = await getSettings();
  for (const r of rows) {
    await db.tx(async (q) => {
      const order = await loadOrderRow(q, "o.id = $1", [r.order_id], { lock: true });
      if (order) await syncReminders(q, order, settings, nowMs);
    });
  }
  return rows.length;
}

// The safety-net processor. Runs from the cron endpoint and right after important events.
export async function processDue({ origin, nowMs = now(), orderId = null, limit = 50 } = {}) {
  const db = await getDb();
  const summary = { stale_reset: 0, delivered: {}, cancellations: 0, scheduled_checked: 0, reconciled: 0 };
  const stale = await db.query(
    `UPDATE notifications SET status = 'failed', last_error = 'interrupted while sending', next_attempt_at = $1, updated_at = now()
     WHERE status = 'sending' AND updated_at < $2 AND attempts < max_attempts`,
    [new Date(nowMs).toISOString(), new Date(nowMs - CLAIM_STALE_MS).toISOString()]);
  summary.stale_reset = stale.rowCount;
  if (!orderId) summary.reconciled = await reconcileReminders(db, nowMs);
  summary.cancellations = await flushCancellations(db);

  const horizonMs = emailConfig().reminderDelivery === "resend-scheduled" ? RESEND_MAX_AHEAD_MS : SCHEDULE_MIN_LEAD_MS;
  const { rows } = await db.query(
    `SELECT id FROM notifications
     WHERE status IN ('pending', 'failed') AND attempts < max_attempts
       AND (next_attempt_at IS NULL OR next_attempt_at <= $1) AND send_at <= $2 AND ($3::bigint IS NULL OR order_id = $3)
     ORDER BY send_at, id LIMIT $4`,
    [new Date(nowMs).toISOString(), new Date(nowMs + horizonMs).toISOString(), orderId, limit]);
  for (const r of rows) {
    const out = await deliver(Number(r.id), { origin, nowMs });
    summary.delivered[out.result] = (summary.delivered[out.result] || 0) + 1;
  }
  if (!orderId) summary.scheduled_checked = await checkScheduled(db, nowMs);
  return summary;
}

export async function listForOrder(q, orderId) {
  const { rows } = await q(`SELECT id, kind, recipient, subject, status, attempts, max_attempts, send_at, sent_at, last_error, provider_id, payload, created_at, updated_at FROM notifications WHERE order_id = $1 ORDER BY send_at, id`, [orderId]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function retryNotification(id) {
  const { query } = await getDb();
  const r = await query(`UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1 AND status IN ('failed', 'skipped') RETURNING id`, [id]);
  return r.rowCount > 0;
}

export async function sendTestEmail(origin) {
  const settings = await getSettings();
  const owners = ownerRecipients(settings);
  if (!owners.length) return { ok: false, error: "Set a notification email first." };
  if (!emailConfig().configured) return { ok: false, error: "Email isn't set up yet (RESEND_API_KEY is missing)." };
  const db = await getDb();
  const id = await enqueue(db.query, { kind: "test", recipient: owners.join(", "), dedupeKey: `test:${now()}:${Math.random().toString(36).slice(2)}`, payload: { origin } });
  const out = await deliver(id, { origin });
  return out.result === "sent" ? { ok: true, to: owners } : { ok: false, error: out.error || out.result };
}
