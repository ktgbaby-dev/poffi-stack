// End-to-end API tests on a real Postgres engine (PGlite) with the local Paystack + Resend test doubles.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, configureShop, lagosInstant, lagosDate, WHSEC, SK } from "./helpers.js";
import { setNow, resetClock, advance, now } from "../lib/clock.js";
import { signCurrent, signLegacy } from "../lib/paystack.js";

let h;
before(async () => { h = await startHarness(); });
after(async () => { resetClock(); await h.close(); });
beforeEach(async () => { resetClock(); await h.reset(); });

const T0 = () => lagosInstant(3, "07:00"); // "now" in tests: 07:00 Lagos, three days ahead of the real date
const customer = (over = {}) => ({ name: "Ada Test", phone: "08012345678", email: "ada@example.test", fulfilment_method: "pickup", notes: "", ...over });

async function setup(over) {
  setNow(T0());
  await h.signInOwner();
  return configureShop(h.api, over);
}

async function place(shop, { date, time = "10:00", items, extra = {} } = {}) {
  const d = date || lagosDate(now());
  const body = { ...customer(), date: d, time, confirmed: true, items: items || [{ product_id: shop.stack.id, variation_id: shop.stack.variations[1].id, addon_ids: [shop.stack.addon_groups[0].addons[0].id], quantity: 2 }], ...extra };
  return h.api("POST", "/api/public/orders", { body });
}

const paystackRef = (url) => [...h.paystack.state.transactions.values()].find((t) => url.endsWith(t.access_code))?.reference;
const emailsTo = (addr) => h.resend.state.emails.filter((e) => e.to.includes(addr));
const ownerEmails = () => emailsTo("owner@poffi.test");

async function payAndVerify(placed, outcome = "pay", { webhook = true } = {}) {
  const ref = paystackRef(placed.data.authorization_url);
  await h.paystack.complete(ref, outcome, { webhook });
  const v = await h.api("POST", `/api/public/orders/${placed.data.order_reference}/verify`, { body: { t: placed.data.access_token, payment_reference: ref } });
  return { ref, verify: v };
}

// ---------------------------------------------------------------------------------------------
test("defaults: ordering is closed until the owner configures it; no invented hours", async () => {
  const cfg = await h.api("GET", "/api/public/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.ordering.open, false);
  assert.ok(Object.values(cfg.data.ordering.hours).every((d) => d.open === false));
  const r = await h.api("POST", "/api/public/orders", { body: { ...customer(), date: "2030-01-01", time: "10:00", confirmed: true, items: [{ product_id: 1, quantity: 1 }] } });
  assert.equal(r.status, 503);
  assert.equal(r.data.error, "ordering_closed");
});

test("admin auth: setup token, login, CSRF header, roles, session revocation", async () => {
  assert.equal((await h.api("GET", "/api/admin/setup")).data.needs_setup, true);
  assert.equal((await h.api("POST", "/api/admin/setup", { body: { token: "wrong", email: "a@b.test", name: "A", password: "long-enough-pw-1" } })).status, 403);
  const ok = await h.api("POST", "/api/admin/setup", { body: { token: "test-setup-token-0123456789", email: "boss@poffi.test", name: "Boss", password: "long-enough-pw-1" } });
  assert.equal(ok.status, 200);
  assert.equal((await h.api("POST", "/api/admin/setup", { body: { token: "test-setup-token-0123456789", email: "x@poffi.test", name: "X", password: "long-enough-pw-1" } })).status, 409);
  assert.equal((await h.api("POST", "/api/admin/login", { body: { email: "boss@poffi.test", password: "nope-nope-nope" } })).status, 401);
  const login = await h.api("POST", "/api/admin/login", { body: { email: "boss@poffi.test", password: "long-enough-pw-1" } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
  h.setCookie(cookie);
  assert.equal((await h.api("GET", "/api/admin/me", { admin: true })).data.user.role, "owner");
  // state change without the dashboard header is refused
  assert.equal((await h.api("POST", "/api/admin/categories", { body: { name: "X" }, cookie })).status, 403);
  // anonymous
  assert.equal((await h.api("GET", "/api/admin/orders", { cookie: "" })).status, 401);
  // staff login cannot change settings or refund
  const staff = await h.api("POST", "/api/admin/users", { admin: true, body: { email: "staff@poffi.test", name: "Staff", role: "staff" } });
  assert.equal(staff.status, 200);
  assert.ok(staff.data.temporaryPassword);
  const sl = await h.api("POST", "/api/admin/login", { body: { email: "staff@poffi.test", password: staff.data.temporaryPassword } });
  const staffCookie = sl.headers.get("set-cookie").split(";")[0];
  assert.equal((await h.api("GET", "/api/admin/orders", { cookie: staffCookie })).data.error, "must_change_password");
  const pw = await h.api("POST", "/api/admin/password", { cookie: staffCookie, headers: { "X-Requested-With": "poffi-admin" }, body: { current: staff.data.temporaryPassword, password: "staff-new-password-9" } });
  assert.equal(pw.status, 200);
  const staffCookie2 = pw.headers.get("set-cookie").split(";")[0];
  assert.equal((await h.api("GET", "/api/admin/orders", { cookie: staffCookie })).status, 401, "old session ended by password change");
  assert.equal((await h.api("GET", "/api/admin/orders", { cookie: staffCookie2 })).status, 200);
  assert.equal((await h.api("PUT", "/api/admin/settings/business", { cookie: staffCookie2, headers: { "X-Requested-With": "poffi-admin" }, body: { name: "X" } })).status, 403);
  // login rate limit
  let last;
  for (let i = 0; i < 10; i++) last = await h.api("POST", "/api/admin/login", { body: { email: "boss@poffi.test", password: "wrong-password-x" } });
  assert.equal(last.status, 429);
});

test("menu management reflects on the public menu (hidden, sold out, archived)", async () => {
  const shop = await setup();
  let menu = (await h.api("GET", "/api/public/menu")).data;
  assert.equal(menu.products.length, 2);
  const stack = menu.products.find((p) => p.name === "Test stack");
  assert.equal(stack.variations.length, 2);
  assert.equal(stack.addon_groups[0].addons.length, 3);
  await h.api("POST", `/api/admin/products/${shop.plain.id}/availability`, { admin: true, body: { status: "sold_out" } });
  menu = (await h.api("GET", "/api/public/menu")).data;
  assert.equal(menu.products.find((p) => p.id === shop.plain.id).status, "sold_out");
  await h.api("POST", `/api/admin/products/${shop.plain.id}/availability`, { admin: true, body: { status: "hidden" } });
  menu = (await h.api("GET", "/api/public/menu")).data;
  assert.equal(menu.products.some((p) => p.id === shop.plain.id), false);
  await h.api("POST", `/api/admin/products/${shop.stack.id}/archive`, { admin: true, body: { archived: true } });
  menu = (await h.api("GET", "/api/public/menu")).data;
  assert.equal(menu.products.length, 0);
  // image upload: a real 1x1 PNG
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const up = await h.api("POST", "/api/admin/media", { admin: true, body: { data: png } });
  assert.equal(up.status, 200);
  assert.equal(up.data.width, 1);
  const img = await fetch(h.base + up.data.url);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(img.headers.get("cache-control"), /immutable/);
  const bad = await h.api("POST", "/api/admin/media", { admin: true, body: { data: Buffer.from("<svg></svg>").toString("base64") } });
  assert.equal(bad.data.error, "not_an_image");
});

test("trusted pricing: client prices ignored; variations and add-on rules enforced", async () => {
  const shop = await setup();
  const q = (items) => h.api("POST", "/api/public/quote", { body: { items } });
  const good = await q([{ product_id: shop.stack.id, variation_id: shop.stack.variations[1].id, addon_ids: [shop.stack.addon_groups[0].addons[0].id, shop.stack.addon_groups[0].addons[1].id], quantity: 2, price: 1, unit_price_kobo: 1 }]);
  assert.equal(good.data.subtotal_kobo, (500000 + 50000 + 20000) * 2);
  assert.equal((await q([{ product_id: shop.stack.id, quantity: 1 }])).data.problems[0].code, "choose_variation");
  const tooMany = await q([{ product_id: shop.stack.id, variation_id: shop.stack.variations[0].id, addon_ids: shop.stack.addon_groups[0].addons.map((a) => a.id), quantity: 1 }]);
  assert.equal(tooMany.data.problems[0].code, "too_many_addons");
  assert.equal((await q([{ product_id: shop.plain.id, quantity: 0 }])).data.problems[0].code, "bad_quantity");
  assert.equal((await q([{ product_id: shop.plain.id, quantity: 51 }])).data.problems[0].code, "too_many");
  assert.equal((await q([{ product_id: 99999, quantity: 1 }])).data.problems[0].code, "unavailable");
  // placing an order with a stale cart is refused (409), never silently re-priced
  const r = await place(shop, { items: [{ product_id: shop.stack.id, quantity: 1 }] });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "cart_changed");
});

test("scheduling rules: closed days, lead time, same-day, cut-off, closures, horizon, capacity", async () => {
  const shop = await setup();
  const today = lagosDate(now());
  // lead time 60 min at 07:00 -> 08:00 is the earliest slot
  let av = (await h.api("GET", "/api/public/availability")).data;
  const d0 = av.days.find((d) => d.date === today);
  assert.equal(d0.slots.find((s) => s.time === "08:00").available, true);
  setNow(lagosInstant(3, "07:31"));
  av = (await h.api("GET", "/api/public/availability")).data;
  assert.equal(av.days.find((d) => d.date === today).slots.find((s) => s.time === "08:00").reason, "Not enough preparation time");
  assert.equal(av.days.length, 15, "today + 14 days");
  // too far ahead / past
  assert.equal((await place(shop, { date: lagosDate(now() + 20 * 86_400_000) })).data.error, "slot_unavailable");
  assert.equal((await place(shop, { time: "07:00" })).data.error, "slot_unavailable");
  // same-day off
  await h.api("PUT", "/api/admin/settings/ordering", { admin: true, body: { ...(await h.api("GET", "/api/admin/settings", { admin: true })).data.settings.ordering, same_day: false } });
  assert.equal((await place(shop, { time: "12:00" })).data.reason, "No same-day orders");
  // cut-off: orders for tomorrow close at 07:00 today
  const s = { ...(await h.api("GET", "/api/admin/settings", { admin: true })).data.settings.ordering, same_day: true };
  await h.api("PUT", "/api/admin/settings/ordering", { admin: true, body: { ...s, cutoff: { enabled: true, time: "07:00", days_before: 1 } } });
  const tomorrow = lagosDate(now() + 86_400_000);
  assert.equal((await place(shop, { date: tomorrow })).data.reason, "Past the order cut-off");
  await h.api("PUT", "/api/admin/settings/ordering", { admin: true, body: { ...s, cutoff: { enabled: false, time: "16:00", days_before: 1 } } });
  // closures: whole day and single slot
  await h.api("POST", "/api/admin/closures", { admin: true, body: { date: tomorrow, reason: "Holiday" } });
  assert.equal((await place(shop, { date: tomorrow })).data.reason, "Holiday");
  await h.api("POST", "/api/admin/closures", { admin: true, body: { date: today, slot_time: "11:00" } });
  assert.equal((await place(shop, { time: "11:00" })).data.reason, "Closed");
  // closed weekday
  const day2 = lagosDate(now() + 2 * 86_400_000);
  const wd = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(day2 + "T12:00:00Z").getUTCDay()];
  await h.api("PUT", "/api/admin/settings/ordering", { admin: true, body: { ...s, hours: { ...s.hours, [wd]: { open: false, from: "08:00", to: "18:00" } } } });
  assert.equal((await place(shop, { date: day2 })).data.reason, "Closed");
  // capacity 3 per slot
  for (let i = 0; i < 3; i++) assert.equal((await place(shop, { time: "13:00" })).status, 200);
  const full = await place(shop, { time: "13:00" });
  assert.equal(full.status, 409);
  assert.equal(full.data.reason, "Fully booked");
});

test("capacity holds under a burst of simultaneous checkouts", async () => {
  const shop = await setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => place(shop, { time: "15:00" })));
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  const db = await h.getDb();
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM orders WHERE scheduled_time = '15:00'`);
  assert.equal(rows[0].n, 3);
});

test("successful payment: verified server-side, order paid, emails and reminders, Lagos time kept", async () => {
  const shop = await setup();
  const placed = await place(shop, { time: "10:00" });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.match(placed.data.authorization_url, /^http:\/\/127\.0\.0\.1:\d+\/checkout\//);
  const tx = [...h.paystack.state.transactions.values()][0];
  assert.equal(tx.amount, (500000 + 50000) * 2, "Paystack asked for the server-computed total in kobo");
  assert.equal(tx.currency, "NGN");
  assert.match(tx.reference, /^PS-0001-[0-9a-f]{10}$/);
  // before payment: order is awaiting payment
  let st = await h.api("GET", `/api/public/orders/PS-0001?t=${placed.data.access_token}`);
  assert.equal(st.data.payment_status, "pending");
  assert.equal((await h.api("GET", `/api/public/orders/PS-0001?t=wrong`)).status, 404, "order page needs its token");

  const { verify } = await payAndVerify(placed);
  assert.equal(verify.data.status, "success");
  st = await h.api("GET", `/api/public/orders/PS-0001?t=${placed.data.access_token}`);
  assert.equal(st.data.payment_status, "paid");
  assert.equal(st.data.status, "new");

  const owner = ownerEmails();
  const newOrder = owner.filter((e) => e.subject === "NEW PAID ORDER — POFFI STACK #PS-0001");
  assert.equal(newOrder.length, 1, "exactly one new-order email");
  assert.match(newOrder[0].html, /08012345678/);
  assert.match(newOrder[0].html, /Berries/);
  assert.match(newOrder[0].html, /10:00am/);
  assert.equal(emailsTo("ada@example.test").filter((e) => /confirmed/.test(e.subject)).length, 1);
  // reminders handed to Resend for exactly 60 and 30 minutes before 10:00 Lagos (09:00Z)
  const reminders = owner.filter((e) => e.subject.startsWith("Reminder:")).map((e) => e.scheduled_at).sort();
  const at = Date.parse(`${lagosDate(now())}T09:00:00Z`);
  assert.deepEqual(reminders, [new Date(at - 60 * 60_000).toISOString(), new Date(at - 30 * 60_000).toISOString()]);
  // dashboard view
  const list = await h.api("GET", "/api/admin/orders?view=upcoming", { admin: true });
  assert.equal(list.data.orders[0].reference, "PS-0001");
  assert.equal(list.data.orders[0].scheduled_time, "10:00");
  assert.equal(new Date(list.data.orders[0].scheduled_at).toISOString(), new Date(at).toISOString());
  const ov = await h.api("GET", "/api/admin/overview", { admin: true });
  assert.equal(ov.data.revenue_kobo, 1100000);
  assert.equal(ov.data.counts.paid, 1);
});

test("idempotency: webhook + callback + repeated webhooks + repeated callbacks process once", async () => {
  const shop = await setup();
  const placed = await place(shop);
  const { ref } = await payAndVerify(placed);
  await h.paystack.resendWebhook(ref);
  await h.paystack.resendWebhook(ref);
  for (let i = 0; i < 3; i++) await h.api("POST", `/api/public/orders/PS-0001/verify`, { body: { t: placed.data.access_token, payment_reference: ref } });
  await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  assert.equal(ownerEmails().filter((e) => e.subject.startsWith("NEW PAID ORDER")).length, 1);
  assert.equal(emailsTo("ada@example.test").length, 1);
  const db = await h.getDb();
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM order_status_history WHERE to_value = 'paid'`)).rows[0].n, 1);
  assert.ok(h.paystack.state.webhooks.every((w) => w.status === 200));
  // the same checkout submitted twice (double tap) gives the same order
  const key = "checkout-key-abcdefghijklmnop";
  const a = await place(shop, { extra: { client_key: key }, time: "12:00" });
  const b = await place(shop, { extra: { client_key: key }, time: "12:00" });
  assert.equal(a.data.order_reference, b.data.order_reference);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n, 2);
});

test("webhook signatures: bad or stale signatures are refused; legacy header accepted", async () => {
  await setup();
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "nope", id: 1 } }));
  const post = (headers) => fetch(`${h.base}/api/paystack/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ "Paystack-Signature": signCurrent(body, "whsec_wrong") })).status, 401);
  assert.equal((await post({ "Paystack-Signature": signCurrent(body, WHSEC, "whk_1", Math.floor(Date.now() / 1000) - 600) })).status, 401, "older than 5 minutes");
  assert.equal((await post({ "Paystack-Signature": signCurrent(body, WHSEC) })).status, 200);
  assert.equal((await post({ "x-paystack-signature": signLegacy(body, SK) })).status, 200);
  assert.equal((await post({ "x-paystack-signature": signLegacy(body, "sk_test_wrong") })).status, 401);
  // when the new header is present it must verify, even if the legacy one does
  assert.equal((await post({ "Paystack-Signature": signCurrent(body, "whsec_wrong"), "x-paystack-signature": signLegacy(body, SK) })).status, 401);
});

test("amount mismatch is never marked paid and alerts the owner", async () => {
  const shop = await setup();
  const placed = await place(shop);
  const ref = paystackRef(placed.data.authorization_url);
  h.paystack.state.amountOverride = { reference: ref, amount: 100 };
  const { verify } = await payAndVerify(placed);
  assert.equal(verify.data.status, "mismatch");
  const st = await h.api("GET", `/api/public/orders/PS-0001?t=${placed.data.access_token}`);
  assert.notEqual(st.data.payment_status, "paid");
  assert.equal(ownerEmails().filter((e) => e.subject.startsWith("NEW PAID ORDER")).length, 0);
  assert.equal(ownerEmails().filter((e) => /Needs attention/.test(e.subject)).length, 1);
  const detail = await h.api("GET", "/api/admin/orders/1", { admin: true });
  assert.match(detail.data.order.needs_attention, /order total/);
});

test("failed and abandoned payments: retry uses a new reference on the same order", async () => {
  const shop = await setup();
  const placed = await place(shop);
  const { verify } = await payAndVerify(placed, "fail");
  assert.equal(verify.data.status, "failed");
  let st = await h.api("GET", `/api/public/orders/PS-0001?t=${placed.data.access_token}`);
  assert.equal(st.data.payment_status, "failed");
  const retry = await h.api("POST", "/api/public/orders/PS-0001/pay", { body: { t: placed.data.access_token } });
  assert.equal(retry.status, 200);
  const ref2 = paystackRef(retry.data.authorization_url);
  assert.notEqual(ref2, paystackRef(placed.data.authorization_url));
  await h.paystack.complete(ref2, "cancel");
  const v2 = await h.api("POST", "/api/public/orders/PS-0001/verify", { body: { t: placed.data.access_token, payment_reference: ref2 } });
  assert.equal(v2.data.status, "abandoned");
  const retry2 = await h.api("POST", "/api/public/orders/PS-0001/pay", { body: { t: placed.data.access_token } });
  const ref3 = paystackRef(retry2.data.authorization_url);
  await h.paystack.complete(ref3, "pay");
  const v3 = await h.api("POST", "/api/public/orders/PS-0001/verify", { body: { t: placed.data.access_token, payment_reference: ref3 } });
  assert.equal(v3.data.status, "success");
  st = await h.api("GET", `/api/public/orders/PS-0001?t=${placed.data.access_token}`);
  assert.equal(st.data.payment_status, "paid");
  const db = await h.getDb();
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n, 3);
  // paying again for a paid order is refused
  assert.equal((await h.api("POST", "/api/public/orders/PS-0001/pay", { body: { t: placed.data.access_token } })).data.error, "already_paid");
  // an unknown payment reference is refused
  assert.equal((await h.api("POST", "/api/public/orders/PS-0001/verify", { body: { t: placed.data.access_token, payment_reference: "PS-0001-ffffffffff" } })).status, 404);
});

test("Paystack outage at checkout: order kept, customer can retry, nothing duplicated", async () => {
  const shop = await setup();
  h.paystack.state.failNextInit = 1;
  const placed = await place(shop);
  assert.equal(placed.status, 502);
  assert.equal(placed.data.order_reference, "PS-0001");
  const retry = await h.api("POST", "/api/public/orders/PS-0001/pay", { body: { t: placed.data.access_token } });
  assert.equal(retry.status, 200);
  assert.ok(retry.data.authorization_url);
});

test("cron safety net: a payment whose customer never came back is found and verified", async () => {
  const shop = await setup();
  const placed = await place(shop);
  const ref = paystackRef(placed.data.authorization_url);
  h.paystack.state.webhookMode = "none";
  await h.paystack.complete(ref, "pay", { webhook: false });
  assert.equal((await h.api("GET", "/api/cron/run")).status, 401);
  advance(11 * 60_000);
  const run = await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  assert.equal(run.status, 200);
  assert.equal(run.data.result.payments.results.success, 1);
  const st = await h.api("GET", `/api/public/orders/PS-0001?t=${placed.data.access_token}`);
  assert.equal(st.data.payment_status, "paid");
});

test("unpaid orders expire after their hold, freeing the slot", async () => {
  const shop = await setup();
  for (let i = 0; i < 3; i++) await place(shop, { time: "16:00" });
  assert.equal((await place(shop, { time: "16:00" })).status, 409);
  advance(31 * 60_000); // holds lapse after 30 minutes
  assert.equal((await place(shop, { time: "16:00" })).status, 200, "slot free again once holds lapse");
  advance(25 * 3_600_000);
  await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  const db = await h.getDb();
  assert.ok((await db.query(`SELECT count(*)::int AS n FROM orders WHERE status = 'cancelled' AND cancel_reason = 'Payment was not completed'`)).rows[0].n >= 3);
});

test("fulfilment status: unpaid can't progress; status emails once; completion cancels reminders", async () => {
  const shop = await setup();
  const unpaid = await place(shop, { time: "11:00" });
  const r = await h.api("POST", "/api/admin/orders/1/status", { admin: true, body: { to: "confirmed" } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "not_paid");
  const paidOrder = await place(shop, { time: "12:00" });
  await payAndVerify(paidOrder);
  const id = 2;
  assert.equal((await h.api("POST", `/api/admin/orders/${id}/status`, { admin: true, body: { to: "ready_for_lunch" } })).status, 409);
  for (const to of ["confirmed", "confirmed", "preparing", "ready"]) {
    const s = await h.api("POST", `/api/admin/orders/${id}/status`, { admin: true, body: { to } });
    assert.equal(s.status, 200, JSON.stringify(s.data));
  }
  assert.equal((await h.api("POST", `/api/admin/orders/${id}/status`, { admin: true, body: { to: "out_for_delivery" } })).status, 409, "pickup orders don't go out for delivery");
  assert.equal((await h.api("POST", `/api/admin/orders/${id}/status`, { admin: true, body: { to: "preparing" } })).status, 409, "no going backwards");
  const cust = emailsTo("ada@example.test").map((e) => e.subject);
  assert.equal(cust.filter((s) => s.startsWith("Your order is confirmed")).length, 1);
  assert.equal(cust.filter((s) => /preparing/i.test(s)).length, 0, "preparing email off by default");
  assert.equal(cust.filter((s) => s.startsWith("Your order is ready for collection")).length, 1);
  await h.api("POST", `/api/admin/orders/${id}/status`, { admin: true, body: { to: "completed" } });
  const reminders = ownerEmails().filter((e) => e.subject.startsWith("Reminder:"));
  assert.equal(reminders.length, 2);
  await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  assert.ok(reminders.every((e) => e.cancelled), "scheduled reminders cancelled at Resend when the order completed");
  const detail = await h.api("GET", `/api/admin/orders/${id}`, { admin: true });
  assert.ok(detail.data.history.some((x) => x.to_value === "completed"));
  assert.deepEqual(detail.data.allowed_next, []);
});

test("cancellation: reason required, owner + customer told, reminders cancelled, refund through Paystack", async () => {
  const shop = await setup();
  const placed = await place(shop, { time: "14:00" });
  await payAndVerify(placed);
  assert.equal((await h.api("POST", "/api/admin/orders/1/status", { admin: true, body: { to: "cancelled" } })).data.error, "reason_required");
  const c = await h.api("POST", "/api/admin/orders/1/status", { admin: true, body: { to: "cancelled", reason: "Customer asked to cancel" } });
  assert.equal(c.status, 200);
  assert.equal(ownerEmails().filter((e) => e.subject.startsWith("Order cancelled")).length, 1);
  assert.equal(emailsTo("ada@example.test").filter((e) => /cancelled/.test(e.subject)).length, 1);
  await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  assert.ok(ownerEmails().filter((e) => e.subject.startsWith("Reminder:")).every((e) => e.cancelled));
  // refund: needs confirmation, owner only
  assert.equal((await h.api("POST", "/api/admin/orders/1/refund", { admin: true, body: {} })).data.error, "confirm_required");
  const rf = await h.api("POST", "/api/admin/orders/1/refund", { admin: true, body: { confirm: true } });
  assert.equal(rf.status, 200, JSON.stringify(rf.data));
  assert.equal(rf.data.order.payment_status, "refund_pending");
  await new Promise((r) => setTimeout(r, 300)); // the test double sends refund.processed shortly after
  const after = await h.api("GET", "/api/admin/orders/1", { admin: true });
  assert.equal(after.data.order.payment_status, "refunded");
  assert.equal((await h.api("POST", "/api/admin/orders/1/refund", { admin: true, body: { confirm: true } })).data.error, "not_refundable");
});

test("historical orders keep the price and name charged, after menu edits", async () => {
  const shop = await setup();
  const placed = await place(shop);
  await payAndVerify(placed);
  await h.api("PUT", `/api/admin/products/${shop.stack.id}`, { admin: true, body: { ...shop.stack, name: "Renamed stack", price: "9999", variations: [{ id: shop.stack.variations[1].id, name: "Large", price: "8000" }], addon_groups: [] } });
  const d = await h.api("GET", "/api/admin/orders/1", { admin: true });
  assert.equal(d.data.items[0].product_name, "Test stack");
  assert.equal(d.data.items[0].unit_price_kobo, 550000);
  assert.equal(d.data.items[0].customisations[0].option_name, "Berries");
  // a product that has been ordered is archived, not deleted
  const del = await h.api("DELETE", `/api/admin/products/${shop.stack.id}`, { admin: true });
  assert.deepEqual(del.data, { archived: true });
});

test("email failures are retried with backoff, permanent failures stop, and the log shows them", async () => {
  const shop = await setup();
  h.resend.state.failNext = 2;
  const placed = await place(shop);
  await payAndVerify(placed);
  const db = await h.getDb();
  const failing = (await db.query(`SELECT kind, status, attempts, last_error FROM notifications WHERE status = 'failed'`)).rows;
  assert.ok(failing.length >= 1);
  assert.match(failing[0].last_error, /500/);
  advance(3 * 60_000);
  await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  advance(15 * 60_000);
  await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM notifications WHERE status = 'failed'`)).rows[0].n, 0);
  assert.equal(ownerEmails().filter((e) => e.subject.startsWith("NEW PAID ORDER")).length, 1);
  // a refused message is not retried forever
  h.resend.state.rejectAll = true;
  await h.api("POST", "/api/admin/orders/1/status", { admin: true, body: { to: "confirmed" } });
  const dead = (await db.query(`SELECT attempts, max_attempts FROM notifications WHERE kind = 'customer_status'`)).rows[0];
  assert.equal(dead.attempts, dead.max_attempts);
  const log = await h.api("GET", "/api/admin/notifications?status=failed", { admin: true });
  assert.equal(log.data.notifications.length, 1);
  h.resend.state.rejectAll = false;
  assert.equal((await h.api("POST", `/api/admin/notifications/${log.data.notifications[0].id}/retry`, { admin: true })).status, 200);
  assert.equal((await db.query(`SELECT status FROM notifications WHERE kind = 'customer_status'`)).rows[0].status, "sent", "retried by hand once the cause was fixed");
});

test("cron-mode reminders: sent when due, once each, never for cancelled or completed orders", async () => {
  process.env.REMINDER_DELIVERY = "cron";
  try {
    const shop = await setup();
    const a = await place(shop, { time: "12:00" });
    await payAndVerify(a);
    const b = await place(shop, { time: "12:00" });
    await payAndVerify(b);
    const run = () => h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
    const reminders = () => ownerEmails().filter((e) => e.subject.startsWith("Reminder:"));
    await run();
    assert.equal(reminders().length, 0, "nothing before it is due");
    // order B is cancelled before its reminders fall due
    await h.api("POST", "/api/admin/orders/2/status", { admin: true, body: { to: "cancelled", reason: "Test" } });
    setNow(lagosInstant(3, "11:00")); // 60 minutes before 12:00
    await run();
    await run();
    assert.deepEqual(reminders().map((e) => e.subject), ["Reminder: PS-0001 due at 12:00pm (in 1 hour) · Ada Test"]);
    assert.ok(reminders().every((e) => !e.scheduled_at), "sent immediately, not scheduled");
    setNow(lagosInstant(3, "11:30"));
    await run();
    assert.equal(reminders().length, 2);
    await h.api("POST", "/api/admin/orders/1/status", { admin: true, body: { to: "completed" } });
    setNow(lagosInstant(3, "11:59"));
    await run();
    assert.equal(reminders().length, 2, "no extra reminders");
    const db = await h.getDb();
    const rows = (await db.query(`SELECT o.reference, n.status FROM notifications n JOIN orders o ON o.id = n.order_id WHERE n.kind = 'owner_reminder' ORDER BY o.id, n.send_at`)).rows;
    assert.deepEqual(rows.map((r) => `${r.reference}:${r.status}`), ["PS-0001:sent", "PS-0001:sent", "PS-0002:cancelled", "PS-0002:cancelled"]);
  } finally {
    process.env.REMINDER_DELIVERY = "resend-scheduled";
  }
});

test("changing reminder times reschedules upcoming orders' reminders", async () => {
  const shop = await setup();
  const a = await place(shop, { time: "15:00" });
  await payAndVerify(a);
  const settings = (await h.api("GET", "/api/admin/settings", { admin: true })).data.settings.notifications;
  const r = await h.api("PUT", "/api/admin/settings/notifications", { admin: true, body: { ...settings, reminder_offsets: [120] } });
  assert.equal(r.status, 200);
  await h.api("GET", "/api/cron/run", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  const db = await h.getDb();
  const rows = (await db.query(`SELECT payload->>'offset_minutes' AS off, status FROM notifications WHERE kind = 'owner_reminder' ORDER BY id`)).rows;
  assert.deepEqual(rows.map((x) => `${x.off}:${x.status}`), ["60:cancelled", "30:cancelled", "120:scheduled"]);
  const old = ownerEmails().filter((e) => e.subject.startsWith("Reminder:") && /in 1 hour|in 30 minutes/.test(e.subject));
  assert.ok(old.every((e) => e.cancelled));
});
