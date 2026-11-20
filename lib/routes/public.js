// Customer-facing API: menu, availability, quotes, order placement, payment and order status.
import { getDb } from "../db.js";
import { HttpError, bad, clientIp, json, notFound, readJson, str } from "../http.js";
import { siteUrl, paystackConfig } from "../config.js";
import { getSettings, isOrderingReady } from "../settings.js";
import { publicMenu } from "../menu.js";
import { availability } from "../schedule.js";
import { priceCart } from "../pricing.js";
import { createOrder } from "../orders.js";
import { startPayment, verifyAndApply } from "../payments.js";
import { customerView, loadItems, loadOrderRow } from "../order-data.js";
import { limit } from "../ratelimit.js";
import { now } from "../clock.js";
import { timingSafeEqual, createHash } from "node:crypto";

const cacheShort = { "Cache-Control": "public, max-age=0, s-maxage=20, stale-while-revalidate=60" };
const sameToken = (a, b) => timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());

async function config() {
  const s = await getSettings();
  const ready = isOrderingReady(s);
  const o = s.ordering;
  return json({
    business: s.business,
    content: { ...s.content, testimonials: s.content.testimonials.filter((t) => t.verified) },
    ordering: {
      open: ready.ready,
      pickup: o.pickup,
      delivery: o.delivery,
      same_day: o.same_day,
      lead_time_minutes: o.lead_time_minutes,
      cutoff: o.cutoff,
      max_days_ahead: o.max_days_ahead,
      slot_minutes: o.slot_minutes,
      min_order_kobo: o.min_order_kobo,
      hours: o.hours,
      timezone: "Africa/Lagos",
    },
    delivery: { zones: s.delivery.zones.filter((z) => z.active).map(({ id, name, fee_kobo }) => ({ id, name, fee_kobo })), note: s.delivery.note },
    payments: { provider: "paystack", available: paystackConfig().configured },
  }, 200, cacheShort);
}

async function menu() {
  return json(await publicMenu(), 200, cacheShort);
}

async function slots() {
  const s = await getSettings();
  return json(await availability(s, now()));
}

async function quote(request) {
  const body = await readJson(request, 32 * 1024);
  const { query } = await getDb();
  const priced = await priceCart(query, body.items, { strict: false });
  return json(priced);
}

async function placeOrder(request) {
  await limit("order", clientIp(request), 15, 600);
  const body = await readJson(request, 48 * 1024);
  if (body.confirmed !== true) throw bad("confirm_required", "Please confirm your order details first.", { field: "confirmed" });
  const { order, existing } = await createOrder(body);
  const origin = siteUrl(request);
  if (existing && order.payment_status === "paid") {
    return json({ order_reference: order.reference, access_token: order.access_token, already_paid: true });
  }
  try {
    const pay = await startPayment(order.id, { origin });
    return json({ order_reference: order.reference, access_token: order.access_token, authorization_url: pay.authorizationUrl, existing });
  } catch (err) {
    if (err instanceof HttpError) err.extra = { ...err.extra, order_reference: order.reference, access_token: order.access_token };
    throw err;
  }
}

async function findOrder(reference, token) {
  const { query } = await getDb();
  const order = await loadOrderRow(query, "o.reference = $1", [str(reference, 20)]);
  if (!order || !token || !sameToken(token, order.access_token)) throw notFound("We couldn't find that order. Check the link in your email.");
  return order;
}

async function orderStatus(request, { reference }) {
  const url = new URL(request.url);
  const order = await findOrder(reference, url.searchParams.get("t"));
  const { query } = await getDb();
  const items = await loadItems(query, order.id);
  const { rows: pays } = await query(`SELECT status FROM payments WHERE order_id = $1 ORDER BY id`, [order.id]);
  return json(customerView(order, items, await getSettings(), pays));
}

async function verifyPayment(request, { reference }) {
  await limit("verify", clientIp(request), 60, 600);
  const body = await readJson(request);
  const order = await findOrder(reference, body.t);
  const payRef = str(body.payment_reference, 80);
  const { query } = await getDb();
  const { rows } = payRef
    ? await query(`SELECT reference FROM payments WHERE order_id = $1 AND reference = $2`, [order.id, payRef])
    : await query(`SELECT reference FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]);
  if (!rows.length) {
    if (payRef) throw notFound("That payment doesn't belong to this order.");
    return json({ status: order.payment_status === "paid" ? "success" : "no_payment" });
  }
  const result = await verifyAndApply(rows[0].reference, { origin: siteUrl(request), source: "callback" });
  return json({ status: result.status });
}

async function retryPayment(request, { reference }) {
  await limit("retry", clientIp(request), 10, 600);
  const body = await readJson(request);
  const order = await findOrder(reference, body.t);
  const pay = await startPayment(order.id, { origin: siteUrl(request) });
  return json({ authorization_url: pay.authorizationUrl });
}

export const publicRoutes = [
  ["GET", "/api/public/config", config],
  ["GET", "/api/public/menu", menu],
  ["GET", "/api/public/availability", slots],
  ["POST", "/api/public/quote", quote],
  ["POST", "/api/public/orders", placeOrder],
  ["GET", "/api/public/orders/:reference", orderStatus],
  ["POST", "/api/public/orders/:reference/verify", verifyPayment],
  ["POST", "/api/public/orders/:reference/pay", retryPayment],
];
