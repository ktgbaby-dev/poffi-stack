// Orders: creation (trusted pricing + slot capacity in one transaction), fulfilment status changes,
// and the queries behind the owner dashboard.
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { HttpError, bad, isDate, isEmail, isTime, normPhone, notFound, str } from "./http.js";
import { priceCart } from "./pricing.js";
import { lockAndCheckSlot } from "./schedule.js";
import { getSettings, isOrderingReady } from "./settings.js";
import { addHistory, loadItems, loadOrderRow } from "./order-data.js";
import { listForOrder, queueStatusChange, syncReminders } from "./notifications.js";
import { naira } from "./money.js";
import { now } from "./clock.js";

export const FULFILMENT_STEPS = ["new", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
export const ACTIVE_STATUSES = ["new", "confirmed", "preparing", "ready", "out_for_delivery"];

export const newToken = () => randomBytes(18).toString("base64url");

function validateCustomer(input, settings) {
  const name = str(input.name, 80);
  const phone = normPhone(input.phone);
  const email = str(input.email, 254).toLowerCase();
  if (name.length < 2) throw bad("invalid_customer", "Please enter your full name.", { field: "name" });
  if (!phone) throw bad("invalid_customer", "Please enter a valid phone number.", { field: "phone" });
  if (!isEmail(email)) throw bad("invalid_customer", "Please enter a valid email address.", { field: "email" });
  const method = input.fulfilment_method;
  if (method !== "pickup" && method !== "delivery") throw bad("invalid_fulfilment", "Choose pickup or delivery.", { field: "fulfilment_method" });
  if (method === "pickup" && !settings.ordering.pickup) throw bad("invalid_fulfilment", "Pickup isn't available at the moment.", { field: "fulfilment_method" });
  if (method === "delivery" && !settings.ordering.delivery) throw bad("invalid_fulfilment", "Delivery isn't available at the moment.", { field: "fulfilment_method" });
  let zone = null;
  let address = null;
  if (method === "delivery") {
    zone = settings.delivery.zones.find((z) => z.id === input.delivery_zone_id && z.active);
    if (!zone) throw bad("invalid_fulfilment", "Choose a delivery area.", { field: "delivery_zone_id" });
    address = str(input.delivery_address, 400);
    if (address.length < 8) throw bad("invalid_fulfilment", "Please enter your full delivery address.", { field: "delivery_address" });
  }
  if (!isDate(input.date) || !isTime(input.time)) throw bad("invalid_slot", "Choose a date and time.", { field: "slot" });
  return { name, phone, email, method, zone, address, date: input.date, time: input.time, notes: str(input.notes, 500) };
}

// Creates the order and its pending payment row in ONE transaction. Paystack is called afterwards.
// A repeat of the same checkout (same client_key) returns the existing order instead of a second one.
export async function createOrder(input, { nowMs = now() } = {}) {
  const settings = await getSettings();
  if (!isOrderingReady(settings).ready) throw new HttpError(503, "ordering_closed", "We're not taking online orders right now.");
  const c = validateCustomer(input, settings);
  const clientKey = typeof input.client_key === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(input.client_key) ? input.client_key : null;
  const db = await getDb();

  if (clientKey) {
    const existing = await loadOrderRow(db.query, "o.client_key = $1", [clientKey]);
    if (existing) return { order: existing, existing: true };
  }

  return db.tx(async (q) => {
    const priced = await priceCart(q, input.items, { strict: true });
    const minOrder = settings.ordering.min_order_kobo || 0;
    if (priced.subtotal_kobo < minOrder) throw bad("below_minimum", `The minimum order is ${naira(minOrder)}.`);
    const { scheduledAt } = await lockAndCheckSlot(q, settings, c.date, c.time, nowMs);
    const fee = c.method === "delivery" ? c.zone.fee_kobo : 0;
    const total = priced.subtotal_kobo + fee;
    if (total < 100) throw bad("amount_too_small", "The order total is too small to pay online.");

    const { rows: cust } = await q(
      `INSERT INTO customers (name, phone, email) VALUES ($1, $2, $3)
       ON CONFLICT (email, phone) DO UPDATE SET name = EXCLUDED.name, updated_at = now() RETURNING id`, [c.name, c.phone, c.email]);
    const { rows: seq } = await q(`SELECT nextval('order_number_seq')::int AS n`);
    const number = seq[0].n;
    const reference = `PS-${String(number).padStart(4, "0")}`;
    const holdUntil = new Date(nowMs + settings.ordering.hold_minutes * 60_000).toISOString();
    const { rows } = await q(
      `INSERT INTO orders (order_number, reference, access_token, client_key, customer_id, customer_name, customer_phone, customer_email,
         fulfilment_method, delivery_zone_id, delivery_zone_name, delivery_address, delivery_fee_kobo,
         scheduled_date, scheduled_time, slot_minutes, scheduled_at, notes, subtotal_kobo, total_kobo, hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [number, reference, newToken(), clientKey, cust[0].id, c.name, c.phone, c.email,
        c.method, c.zone?.id ?? null, c.zone?.name ?? null, c.address, fee,
        c.date, c.time, settings.ordering.slot_minutes, new Date(scheduledAt).toISOString(), c.notes, priced.subtotal_kobo, total, holdUntil]);
    const orderId = Number(rows[0].id);
    for (const l of priced.lines) {
      const { rows: it } = await q(
        `INSERT INTO order_items (order_id, product_id, variation_id, product_name, variation_name, base_price_kobo, unit_price_kobo, quantity, line_total_kobo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [orderId, l.product_id, l.variation_id, l.product_name, l.variation_name, l.base_price_kobo, l.unit_price_kobo, l.quantity, l.line_total_kobo]);
      for (const cu of l.customisations) {
        await q(`INSERT INTO order_item_customisations (order_item_id, addon_id, group_name, option_name, price_kobo) VALUES ($1,$2,$3,$4,$5)`,
          [it[0].id, cu.addon_id, cu.group_name, cu.option_name, cu.price_kobo]);
      }
    }
    await addHistory(q, orderId, { kind: "status", from: null, to: "awaiting_payment", note: "Order placed online", actor: "customer" });
    const order = await loadOrderRow(q, "o.id = $1", [orderId]);
    return { order, existing: false };
  });
}

// ---------- fulfilment status ----------
export function allowedNext(order) {
  if (["completed", "cancelled"].includes(order.status)) return [];
  if (order.status === "awaiting_payment" || order.payment_status !== "paid") return ["cancelled"];
  const i = FULFILMENT_STEPS.indexOf(order.status);
  const forward = FULFILMENT_STEPS.slice(i + 1).filter((s) => s !== "out_for_delivery" || order.fulfilment_method === "delivery");
  return [...forward, "cancelled"];
}

export async function changeStatus(orderId, to, { actor, note = "", reason = "", nowMs = now() } = {}) {
  const db = await getDb();
  const settings = await getSettings();
  const result = await db.tx(async (q) => {
    const order = await loadOrderRow(q, "o.id = $1", [orderId], { lock: true });
    if (!order) throw notFound("That order doesn't exist.");
    if (order.status === to) return { order, changed: false };
    const allowed = allowedNext(order);
    if (!allowed.includes(to)) {
      if (order.payment_status !== "paid" && to !== "cancelled") throw new HttpError(409, "not_paid", "This order hasn't been paid, so it can't move forward. Only cancelling is possible.");
      throw new HttpError(409, "invalid_transition", `An order that is ${order.status.replace(/_/g, " ")} can't be marked ${to.replace(/_/g, " ")}.`);
    }
    if (to === "cancelled" && !str(reason, 300)) throw bad("reason_required", "Give a short reason for cancelling.", { field: "reason" });
    await q(
      `UPDATE orders SET status = $2, updated_at = now(),
         completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
         cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
         cancel_reason = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancel_reason END,
         hold_expires_at = CASE WHEN $2 = 'cancelled' THEN NULL ELSE hold_expires_at END
       WHERE id = $1`, [orderId, to, str(reason, 300) || null]);
    await addHistory(q, orderId, { kind: "status", from: order.status, to, note: to === "cancelled" ? str(reason, 300) : str(note, 300), actor });
    const updated = await loadOrderRow(q, "o.id = $1", [orderId]);
    if (order.status !== "awaiting_payment" || to !== "cancelled") await queueStatusChange(q, updated, settings, to);
    await syncReminders(q, updated, settings, nowMs);
    return { order: updated, changed: true };
  });
  return result;
}

export async function addNote(orderId, note, actor) {
  const text = str(note, 1000);
  if (!text) throw bad("empty_note", "Write a note first.");
  const db = await getDb();
  const order = await loadOrderRow(db.query, "o.id = $1", [orderId]);
  if (!order) throw notFound("That order doesn't exist.");
  await addHistory(db.query, orderId, { kind: "note", note: text, actor });
}

// ---------- dashboard queries ----------
export async function adminOrderDetail(orderId) {
  const { query } = await getDb();
  const order = await loadOrderRow(query, "o.id = $1", [orderId]);
  if (!order) throw notFound("That order doesn't exist.");
  const items = await loadItems(query, orderId);
  const { rows: payments } = await query(`SELECT id, reference, amount_kobo, paid_amount_kobo, currency, status, channel, gateway_response, provider_transaction_id, paid_at, verified_at, last_error, created_at FROM payments WHERE order_id = $1 ORDER BY id`, [orderId]);
  const { rows: refunds } = await query(`SELECT id, reference, amount_kobo, status, last_error, created_at, updated_at FROM refunds WHERE order_id = $1 ORDER BY id`, [orderId]);
  const { rows: history } = await query(`SELECT id, kind, from_value, to_value, note, actor, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id`, [orderId]);
  const notifications = await listForOrder(query, orderId);
  return {
    order: { ...order, access_token: undefined, client_key: undefined },
    items,
    payments: payments.map((p) => ({ ...p, id: Number(p.id) })),
    refunds: refunds.map((r) => ({ ...r, id: Number(r.id) })),
    history: history.map((h) => ({ ...h, id: Number(h.id) })),
    notifications,
    allowed_next: allowedNext(order),
  };
}

const VIEWS = {
  upcoming: `o.payment_status = 'paid' AND o.status IN ('new','confirmed','preparing','ready','out_for_delivery')`,
  awaiting_payment: `o.status = 'awaiting_payment'`,
  attention: `(o.needs_attention IS NOT NULL OR (o.payment_status = 'paid' AND o.status IN ('new','confirmed','preparing','ready','out_for_delivery') AND o.scheduled_at < $NOW))`,
  completed: `o.status = 'completed'`,
  cancelled: `o.status = 'cancelled'`,
  all: `true`,
};

export async function listOrders({ view = "upcoming", status, payment, dateFrom, dateTo, q: search, page = 1, sort, nowMs = now() } = {}) {
  const { query } = await getDb();
  // $1 is always referenced (typed) so Postgres never sees an unused, untyped parameter.
  const where = [`$1::timestamptz IS NOT NULL`, VIEWS[view] ? VIEWS[view].replace("$NOW", "$1") : VIEWS.upcoming.replace("$NOW", "$1")];
  const params = [new Date(nowMs).toISOString()];
  if (status) { params.push(status); where.push(`o.status = $${params.length}`); }
  if (payment) { params.push(payment); where.push(`o.payment_status = $${params.length}`); }
  if (dateFrom && isDate(dateFrom)) { params.push(dateFrom); where.push(`o.scheduled_date >= $${params.length}::date`); }
  if (dateTo && isDate(dateTo)) { params.push(dateTo); where.push(`o.scheduled_date <= $${params.length}::date`); }
  const s = str(search, 80);
  if (s) {
    params.push(`%${s.replace(/[%_\\]/g, (m) => "\\" + m)}%`);
    where.push(`(o.reference ILIKE $${params.length} OR o.customer_name ILIKE $${params.length} OR o.customer_phone ILIKE $${params.length} OR o.customer_email ILIKE $${params.length})`);
  }
  const order = sort === "newest" ? "o.created_at DESC" : ["completed", "cancelled", "all", "awaiting_payment"].includes(view) && sort !== "soonest" ? "o.scheduled_at DESC" : "o.scheduled_at ASC";
  const limit = 50;
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const { rows } = await query(
    `SELECT o.id, o.reference, o.customer_name, o.customer_phone, o.total_kobo, o.payment_status, o.status, o.fulfilment_method,
            o.scheduled_date::text AS scheduled_date, o.scheduled_time, o.scheduled_at, o.slot_minutes, o.needs_attention, o.created_at,
            (SELECT string_agg(i.quantity || ' × ' || i.product_name || COALESCE(' (' || i.variation_name || ')', ''), ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items_summary,
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS item_lines
     FROM orders o WHERE ${where.join(" AND ")} ORDER BY ${order}, o.id LIMIT ${limit + 1} OFFSET ${offset}`, params);
  return { orders: rows.slice(0, limit).map((r) => ({ ...r, id: Number(r.id) })), has_more: rows.length > limit, page: Math.max(1, Number(page) || 1) };
}

export async function overview({ nowMs = now() } = {}) {
  const { query } = await getDb();
  const nowIso = new Date(nowMs).toISOString();
  const { rows: [c] } = await query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'new')::int AS new,
       count(*) FILTER (WHERE status = 'awaiting_payment')::int AS pending_payment,
       count(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
       count(*) FILTER (WHERE status IN ('new','confirmed') AND payment_status = 'paid')::int AS pending,
       count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
       count(*) FILTER (WHERE status = 'preparing')::int AS preparing,
       count(*) FILTER (WHERE status IN ('ready','out_for_delivery'))::int AS ready,
       count(*) FILTER (WHERE status = 'completed')::int AS completed,
       count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       count(*) FILTER (WHERE needs_attention IS NOT NULL)::int AS needs_attention,
       count(*) FILTER (WHERE payment_status = 'paid' AND status IN ('new','confirmed','preparing','ready','out_for_delivery') AND scheduled_at < $1)::int AS overdue
     FROM orders`, [nowIso]);
  const { rows: [rev] } = await query(
    `SELECT COALESCE(sum(p.paid_amount_kobo), 0)::bigint AS revenue,
            COALESCE(sum(p.paid_amount_kobo) FILTER (WHERE p.paid_at >= date_trunc('day', $1::timestamptz AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'), 0)::bigint AS revenue_today
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.status = 'success' AND o.payment_status IN ('paid')`, [nowIso]);
  const { rows: refunded } = await query(`SELECT COALESCE(sum(amount_kobo),0)::bigint AS n FROM refunds WHERE status = 'processed'`);
  const urgent = await listOrders({ view: "upcoming", nowMs });
  const { rows: failed } = await query(`SELECT count(*)::int AS n FROM notifications WHERE status = 'failed' AND attempts >= max_attempts`);
  const { rows: lastRun } = await query(`SELECT job, started_at, finished_at, ok FROM job_runs ORDER BY started_at DESC LIMIT 1`);
  return {
    counts: c,
    revenue_kobo: Number(rev.revenue),
    revenue_today_kobo: Number(rev.revenue_today),
    refunded_kobo: Number(refunded[0].n),
    upcoming: urgent.orders.slice(0, 12),
    failed_emails: failed[0].n,
    last_automation_run: lastRun[0] || null,
  };
}
