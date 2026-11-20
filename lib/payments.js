// Paystack payment flow.
//
//   start   order (pending) -> payments row (unique reference) -> Paystack initialize -> authorization_url
//   verify  ONLY a server-side call to Paystack's verify endpoint can mark a payment successful. The amount
//           and currency must match what we asked for. The switch to "paid" is a conditional update, so
//           the return page, the webhook and the cron safety net can all run it and it still happens once.
//   retry   a failed or abandoned attempt gets a NEW reference on the SAME order (never a second order).
//   webhook signature checked on the raw body; each event recorded once (payment_events.event_key).
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { paystackConfig } from "./config.js";
import { HttpError, notFound } from "./http.js";
import { addHistory, loadOrderRow } from "./order-data.js";
import { getSettings } from "./settings.js";
import { lockAndCheckSlot } from "./schedule.js";
import { processDue, queueOwnerAlert, queuePaidOrder, syncReminders } from "./notifications.js";
import { PaystackError, createRefund, fetchRefund, initializeTransaction, verifyTransaction } from "./paystack.js";
import { naira } from "./money.js";
import { now } from "./clock.js";

const newPaymentRef = (order) => `${order.reference}-${randomBytes(5).toString("hex")}`; // only -, letters, digits
const log = (event) => console.log(JSON.stringify({ event: "payment", ...event }));

// Starts (or restarts) payment for an unpaid order and returns where to send the customer.
export async function startPayment(orderId, { origin, nowMs = now() } = {}) {
  const db = await getDb();
  const settings = await getSettings();
  const prepared = await db.tx(async (q) => {
    const order = await loadOrderRow(q, "o.id = $1", [orderId], { lock: true });
    if (!order) throw notFound("That order doesn't exist.");
    if (order.payment_status === "paid" || order.payment_status === "refund_pending" || order.payment_status === "refunded") throw new HttpError(409, "already_paid", "This order has already been paid.");
    if (order.status === "cancelled") throw new HttpError(409, "order_cancelled", "This order was cancelled. Please place a new order.");
    // A payment attempt already in progress and fresh: reuse its checkout link instead of opening another.
    const { rows: open } = await q(`SELECT * FROM payments WHERE order_id = $1 AND status = 'initialized' AND authorization_url IS NOT NULL AND created_at > $2 ORDER BY id DESC LIMIT 1`,
      [order.id, new Date(nowMs - 20 * 60_000).toISOString()]);
    if (open.length) return { order, reuse: open[0] };
    // The place in the slot is only held for a while: re-check it if the hold has run out.
    if (!order.hold_expires_at || new Date(order.hold_expires_at).getTime() <= nowMs) {
      await lockAndCheckSlot(q, settings, order.scheduled_date, order.scheduled_time, nowMs, order.id);
    }
    const holdUntil = new Date(nowMs + settings.ordering.hold_minutes * 60_000).toISOString();
    await q(`UPDATE orders SET hold_expires_at = $2, payment_status = 'pending', updated_at = now() WHERE id = $1`, [order.id, holdUntil]);
    const reference = newPaymentRef(order);
    const { rows } = await q(`INSERT INTO payments (order_id, reference, amount_kobo) VALUES ($1, $2, $3) RETURNING *`, [order.id, reference, order.total_kobo]);
    return { order, payment: rows[0] };
  });

  if (prepared.reuse) return { authorizationUrl: prepared.reuse.authorization_url, reference: prepared.reuse.reference, reused: true };
  const { order, payment } = prepared;
  const callbackUrl = `${origin}/order?ref=${encodeURIComponent(order.reference)}&t=${encodeURIComponent(order.access_token)}`;
  try {
    const init = await initializeTransaction({
      email: order.customer_email, amountKobo: order.total_kobo, reference: payment.reference, callbackUrl,
      metadata: { order_reference: order.reference, custom_fields: [{ display_name: "Order", variable_name: "order_reference", value: order.reference }] },
    });
    await db.query(`UPDATE payments SET authorization_url = $2, access_code = $3, updated_at = now() WHERE id = $1`, [payment.id, init.authorizationUrl, init.accessCode]);
    log({ action: "initialized", order: order.reference, reference: payment.reference, amount: order.total_kobo });
    return { authorizationUrl: init.authorizationUrl, reference: payment.reference, reused: false };
  } catch (err) {
    await db.query(`UPDATE payments SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [payment.id, String(err.message).slice(0, 300)]);
    log({ action: "initialize_failed", order: order.reference, reference: payment.reference, error: err.message });
    throw new HttpError(502, "payment_unavailable", "We couldn't open the payment page just now. Your order is saved; please try paying again in a moment.", { order_reference: order.reference });
  }
}

// Asks Paystack for the truth about one payment reference and applies it. Idempotent.
export async function verifyAndApply(reference, { origin, source = "callback", nowMs = now() } = {}) {
  const db = await getDb();
  const { rows } = await db.query(`SELECT * FROM payments WHERE reference = $1`, [reference]);
  if (!rows.length) throw notFound("We don't recognise that payment reference.");
  const payment = rows[0];
  if (payment.status === "success" || payment.status === "mismatch") return { status: payment.status, already: true, orderId: Number(payment.order_id) };

  let tx;
  try {
    tx = await verifyTransaction(reference);
  } catch (err) {
    if (err instanceof PaystackError && err.status === 400) {
      // Paystack doesn't know this reference (the customer never reached the payment page).
      return { status: "not_found", orderId: Number(payment.order_id) };
    }
    log({ action: "verify_failed", reference, source, error: err.message });
    throw new HttpError(502, "verify_unavailable", "We couldn't confirm the payment with Paystack just now. Please refresh in a moment.");
  }

  const settings = await getSettings();
  const expected = Number(payment.amount_kobo);
  const requested = Number(tx.requested_amount ?? tx.amount);
  const paidAmount = Number(tx.amount);
  const outcome = tx.status;

  if (outcome === "success") {
    const amountOk = String(tx.currency).toUpperCase() === "NGN" && requested === expected && paidAmount >= expected && tx.reference === reference;
    const result = await db.tx(async (q) => {
      const { rows: claimed } = await q(
        `UPDATE payments SET status = $2, paid_amount_kobo = $3, paid_at = $4, verified_at = now(), provider_transaction_id = $5,
           gateway_response = $6, channel = $7, raw = $8::text::jsonb, updated_at = now()
         WHERE id = $1 AND status NOT IN ('success', 'mismatch') RETURNING id`,
        [payment.id, amountOk ? "success" : "mismatch", paidAmount, tx.paid_at || tx.paidAt || new Date(nowMs).toISOString(), String(tx.id ?? ""), tx.gateway_response || null, tx.channel || null, JSON.stringify(slim(tx))]);
      if (!claimed.length) return { status: "already" };
      const order = await loadOrderRow(q, "o.id = $1", [payment.order_id], { lock: true });
      if (!amountOk) {
        await q(`UPDATE orders SET needs_attention = $2, updated_at = now() WHERE id = $1`, [order.id, `Payment ${reference}: Paystack reports ${naira(requested)} ${tx.currency}, the order total is ${naira(expected)} NGN.`]);
        await addHistory(q, order.id, { kind: "payment", from: order.payment_status, to: order.payment_status, note: `Amount mismatch on ${reference}; not marked paid`, actor: `paystack:${source}` });
        await queueOwnerAlert(q, order, settings, `mismatch:${reference}`, { title: "Payment amount didn't match", message: `Paystack reports ${naira(requested)} (${tx.currency}) for ${reference}, but the order total is ${naira(expected)}. The order was NOT marked paid. Check it in Paystack before you prepare anything.` });
        return { status: "mismatch", order };
      }
      if (order.payment_status === "paid" || order.payment_status === "refund_pending" || order.payment_status === "refunded") {
        // A second successful payment for an order that was already paid.
        await q(`UPDATE orders SET needs_attention = $2, updated_at = now() WHERE id = $1`, [order.id, `Paid twice: extra payment ${reference} (${naira(paidAmount)}). Refund one of them.`]);
        await addHistory(q, order.id, { kind: "payment", note: `Extra successful payment ${reference}`, actor: `paystack:${source}` });
        await queueOwnerAlert(q, order, settings, `duplicate:${reference}`, { title: "Order paid twice", message: `A second payment (${reference}, ${naira(paidAmount)}) succeeded for an order that was already paid. Refund the extra payment from the dashboard.` });
        return { status: "duplicate", order };
      }
      // The place in the slot may have lapsed while the customer was paying. Accept the payment, but tell the owner.
      let attention = null;
      if (order.status === "cancelled") attention = `Payment arrived after the order was cancelled (${order.cancel_reason || "no reason"}). Refund it or restore the order.`;
      else if (order.hold_expires_at && new Date(order.hold_expires_at).getTime() < nowMs) {
        try { await lockAndCheckSlot(q, settings, order.scheduled_date, order.scheduled_time, nowMs, order.id); }
        catch { attention = "Paid after the time slot filled up. Check you can still make it, or contact the customer."; }
      }
      const nextStatus = order.status === "awaiting_payment" ? "new" : order.status;
      await q(`UPDATE orders SET payment_status = 'paid', status = $2, paid_at = now(), hold_expires_at = NULL, needs_attention = COALESCE($3, needs_attention), updated_at = now() WHERE id = $1`,
        [order.id, nextStatus, attention]);
      await addHistory(q, order.id, { kind: "payment", from: order.payment_status, to: "paid", note: `Paystack ${reference} verified (${naira(paidAmount)}, ${tx.channel || "unknown channel"})`, actor: `paystack:${source}` });
      if (nextStatus !== order.status) await addHistory(q, order.id, { kind: "status", from: order.status, to: nextStatus, note: "Payment verified", actor: "system" });
      const paid = await loadOrderRow(q, "o.id = $1", [order.id]);
      if (paid.status !== "cancelled") await queuePaidOrder(q, paid, settings, nowMs);
      if (attention) await queueOwnerAlert(q, paid, settings, `attention:${reference}`, { title: "Paid order needs a check", message: attention });
      return { status: "success", order: paid };
    });
    log({ action: "verified", reference, source, result: result.status });
    if (result.order) await processDue({ origin, orderId: result.order.id, nowMs }).catch((e) => log({ action: "dispatch_failed", error: e.message }));
    if (result.status === "already") {
      // Someone else (webhook, cron) recorded this payment first: report what they recorded.
      const { rows: now2 } = await db.query(`SELECT status FROM payments WHERE id = $1`, [payment.id]);
      return { status: now2[0]?.status === "mismatch" ? "mismatch" : "success", already: true, orderId: Number(payment.order_id) };
    }
    return { ...result, orderId: Number(payment.order_id) };
  }

  if (["failed", "abandoned", "reversed"].includes(outcome)) {
    await db.tx(async (q) => {
      const { rows: upd } = await q(`UPDATE payments SET status = $2, gateway_response = $3, verified_at = now(), raw = $4::text::jsonb, updated_at = now() WHERE id = $1 AND status IN ('initialized', 'pending', 'error') RETURNING id`,
        [payment.id, outcome, tx.gateway_response || null, JSON.stringify(slim(tx))]);
      if (!upd.length) return;
      const order = await loadOrderRow(q, "o.id = $1", [payment.order_id], { lock: true });
      if (order.payment_status === "pending") {
        await q(`UPDATE orders SET payment_status = 'failed', updated_at = now() WHERE id = $1`, [order.id]);
        await addHistory(q, order.id, { kind: "payment", from: "pending", to: "failed", note: `Paystack ${reference}: ${outcome}${tx.gateway_response ? ` (${tx.gateway_response})` : ""}`, actor: `paystack:${source}` });
      }
    });
    return { status: outcome, orderId: Number(payment.order_id) };
  }

  // ongoing / pending / processing / queued: nothing final yet
  await db.query(`UPDATE payments SET status = 'pending', updated_at = now() WHERE id = $1 AND status IN ('initialized', 'error')`, [payment.id]);
  return { status: "pending", orderId: Number(payment.order_id) };
}

const slim = (tx) => ({ id: tx.id, status: tx.status, reference: tx.reference, amount: tx.amount, requested_amount: tx.requested_amount, currency: tx.currency, channel: tx.channel, paid_at: tx.paid_at, gateway_response: tx.gateway_response, domain: tx.domain });

// ---------- webhooks ----------
export async function handleWebhookEvent(event, { origin, nowMs = now() } = {}) {
  const type = String(event?.event || "");
  const data = event?.data || {};
  const key = `${type}:${data.id ?? data.reference ?? data.refund_reference ?? ""}:${data.status ?? ""}`;
  const db = await getDb();
  const reference = data.reference || data.transaction_reference || data.transaction?.reference || null;
  const { rows } = await db.query(
    `INSERT INTO payment_events (event_key, event_type, reference, payload) VALUES ($1, $2, $3, $4::text::jsonb) ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [key, type, reference, JSON.stringify(event)]);
  if (!rows.length) return { duplicate: true };
  const eventId = rows[0].id;
  let result = "ignored";
  try {
    if (type === "charge.success" && data.reference) {
      const { rows: known } = await db.query(`SELECT 1 FROM payments WHERE reference = $1`, [data.reference]);
      result = known.length ? (await verifyAndApply(data.reference, { origin, source: "webhook", nowMs })).status : "unknown_reference";
    } else if (type.startsWith("refund.")) {
      result = await applyRefundEvent(data);
    }
  } catch (err) {
    result = `error: ${err.message}`.slice(0, 300);
    // Let Paystack retry: forget the event so the retry is processed.
    await db.query(`DELETE FROM payment_events WHERE id = $1`, [eventId]);
    throw err;
  }
  await db.query(`UPDATE payment_events SET processed_at = now(), result = $2 WHERE id = $1`, [eventId, result]);
  return { duplicate: false, result };
}

// ---------- refunds ----------
const REFUND_STATUS = { pending: "pending", processing: "processing", "needs-attention": "needs_attention", failed: "failed", processed: "processed" };

async function applyRefundStatus(q, refund, status, raw) {
  const s = REFUND_STATUS[status] || status;
  await q(`UPDATE refunds SET status = $2, raw = COALESCE($3::text::jsonb, raw), updated_at = now() WHERE id = $1`, [refund.id, s, raw ? JSON.stringify(raw) : null]);
  const order = await loadOrderRow(q, "o.id = $1", [refund.order_id], { lock: true });
  if (s === "processed" && order.payment_status !== "refunded") {
    await q(`UPDATE orders SET payment_status = 'refunded', updated_at = now() WHERE id = $1`, [order.id]);
    await addHistory(q, order.id, { kind: "payment", from: order.payment_status, to: "refunded", note: `Refund ${refund.reference} processed by Paystack`, actor: "paystack" });
  } else if (s === "failed" && order.payment_status === "refund_pending") {
    await q(`UPDATE orders SET payment_status = 'paid', needs_attention = $2, updated_at = now() WHERE id = $1`, [order.id, `Refund ${refund.reference} failed at Paystack. The money is back in your Paystack balance.`]);
    await addHistory(q, order.id, { kind: "payment", from: "refund_pending", to: "paid", note: `Refund ${refund.reference} failed`, actor: "paystack" });
  } else if (s === "needs_attention") {
    await q(`UPDATE orders SET needs_attention = $2, updated_at = now() WHERE id = $1`, [order.id, `Refund ${refund.reference} needs the customer's bank details in your Paystack dashboard.`]);
  }
  return s;
}

async function applyRefundEvent(data) {
  const db = await getDb();
  const ref = data.refund_reference || data.reference;
  const txRef = data.transaction_reference || data.transaction?.reference;
  return db.tx(async (q) => {
    let { rows } = ref ? await q(`SELECT * FROM refunds WHERE reference = $1 FOR UPDATE`, [ref]) : { rows: [] };
    if (!rows.length && txRef) ({ rows } = await q(`SELECT r.* FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.reference = $1 ORDER BY r.id DESC LIMIT 1 FOR UPDATE`, [txRef]));
    if (!rows.length) return "unknown_refund";
    return `refund_${await applyRefundStatus(q, rows[0], data.status, data)}`;
  });
}

export async function refundOrder(orderId, { actorId, actor, nowMs = now() } = {}) {
  const db = await getDb();
  const settings = await getSettings(); // read before the transaction: never query outside it while it is open
  const prepared = await db.tx(async (q) => {
    const order = await loadOrderRow(q, "o.id = $1", [orderId], { lock: true });
    if (!order) throw notFound("That order doesn't exist.");
    if (order.payment_status !== "paid") throw new HttpError(409, "not_refundable", order.payment_status === "refund_pending" ? "A refund is already in progress." : "Only paid orders can be refunded.");
    const { rows: pays } = await q(`SELECT * FROM payments WHERE order_id = $1 AND status = 'success' ORDER BY id DESC LIMIT 1`, [order.id]);
    if (!pays.length) throw new HttpError(409, "no_payment", "No verified payment was found for this order.");
    const reference = `RF-${order.reference}-${randomBytes(4).toString("hex")}`.replace(/[^A-Za-z0-9_-]/g, "-");
    const { rows } = await q(`INSERT INTO refunds (order_id, payment_id, reference, amount_kobo, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [order.id, pays[0].id, reference, pays[0].paid_amount_kobo ?? pays[0].amount_kobo, actorId ?? null]);
    await q(`UPDATE orders SET payment_status = 'refund_pending', updated_at = now() WHERE id = $1`, [order.id]);
    await addHistory(q, order.id, { kind: "payment", from: "paid", to: "refund_pending", note: `Refund ${reference} requested`, actor });
    const updated = await loadOrderRow(q, "o.id = $1", [order.id]);
    await syncReminders(q, updated, settings, nowMs);
    return { order, payment: pays[0], refund: rows[0] };
  });
  try {
    const r = await createRefund({ transaction: prepared.payment.reference, reference: prepared.refund.reference });
    await db.tx(async (q) => applyRefundStatus(q, prepared.refund, r?.status || "pending", r));
    return { reference: prepared.refund.reference, status: r?.status || "pending" };
  } catch (err) {
    // Paystack refused or couldn't be reached: put the order back to paid and say why.
    await db.tx(async (q) => {
      await q(`UPDATE refunds SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [prepared.refund.id, String(err.message).slice(0, 300)]);
      await q(`UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = $1 AND payment_status = 'refund_pending'`, [prepared.order.id]);
      await addHistory(q, prepared.order.id, { kind: "payment", from: "refund_pending", to: "paid", note: `Refund request failed: ${err.message}`, actor: "system" });
    });
    throw new HttpError(502, "refund_failed", `Paystack didn't accept the refund: ${err.message}`);
  }
}

export async function refreshRefund(orderId) {
  const db = await getDb();
  const { rows } = await db.query(`SELECT * FROM refunds WHERE order_id = $1 AND status NOT IN ('processed', 'failed', 'error') ORDER BY id DESC LIMIT 1`, [orderId]);
  if (!rows.length) throw new HttpError(409, "no_open_refund", "There's no refund in progress for this order.");
  const r = await fetchRefund(rows[0].reference);
  if (!r) return { status: rows[0].status };
  const status = await db.tx(async (q) => applyRefundStatus(q, rows[0], r.status, r));
  return { status };
}

// ---------- safety nets for the cron job ----------
// Payments that started a while ago but never came back (closed tab, lost webhook): ask Paystack.
export async function reconcilePending({ origin, nowMs = now(), limit = 25 } = {}) {
  if (!paystackConfig().configured) return { checked: 0 };
  const { query } = await getDb();
  const { rows } = await query(
    `SELECT p.reference FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.status IN ('initialized', 'pending') AND p.authorization_url IS NOT NULL
       AND p.created_at < $1 AND p.created_at > $2 AND o.payment_status IN ('pending', 'failed')
     ORDER BY p.created_at LIMIT $3`,
    [new Date(nowMs - 10 * 60_000).toISOString(), new Date(nowMs - 3 * 24 * 3_600_000).toISOString(), limit]);
  const out = { checked: 0, results: {} };
  for (const r of rows) {
    try {
      const v = await verifyAndApply(r.reference, { origin, source: "reconcile", nowMs });
      out.results[v.status] = (out.results[v.status] || 0) + 1;
    } catch (e) {
      out.results.error = (out.results.error || 0) + 1;
    }
    out.checked++;
  }
  return out;
}

// Unpaid orders whose hold ran out long ago are closed, so they stop cluttering the dashboard.
export async function expireUnpaid({ nowMs = now(), graceHours = 24 } = {}) {
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT o.id FROM orders o WHERE o.status = 'awaiting_payment' AND o.payment_status IN ('pending', 'failed')
       AND COALESCE(o.hold_expires_at, o.created_at) < $1
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status IN ('success', 'mismatch'))
     LIMIT 200`, [new Date(nowMs - graceHours * 3_600_000).toISOString()]);
  for (const r of rows) {
    await db.tx(async (q) => {
      const { rowCount } = await q(`UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment was not completed', hold_expires_at = NULL, updated_at = now() WHERE id = $1 AND status = 'awaiting_payment'`, [r.id]);
      if (rowCount) await addHistory(q, r.id, { kind: "status", from: "awaiting_payment", to: "cancelled", note: "Payment was not completed", actor: "system" });
    });
  }
  return { expired: rows.length };
}
