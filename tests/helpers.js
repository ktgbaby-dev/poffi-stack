// Test harness: one in-memory Postgres (PGlite), the local Paystack + Resend test doubles, and a tiny HTTP
// server around the real router (so the Paystack double can deliver webhooks to it).
import { createServer } from "node:http";
import { startMockPaystack } from "../dev/mock-paystack.js";
import { startMockResend } from "../dev/mock-resend.js";

export const SK = "sk_test_unit_double_0000000000000";
export const WHSEC = "whsec_unit_double_000000000000000";

export async function startHarness({ reminderDelivery = "resend-scheduled" } = {}) {
  Object.assign(process.env, {
    DATABASE_URL: "pglite:memory",
    SESSION_SECRET: "test-session-secret-0123456789abcdefghij",
    CRON_SECRET: "test-cron-secret-0123456789",
    ADMIN_SETUP_TOKEN: "test-setup-token-0123456789",
    PAYSTACK_SECRET_KEY: SK,
    PAYSTACK_WEBHOOK_SECRET: WHSEC,
    RESEND_API_KEY: "re_test_double",
    EMAIL_FROM: "Poffi Stack <orders@poffi.test>",
    REMINDER_DELIVERY: reminderDelivery,
    OWNER_NOTIFICATION_EMAIL: "",
  });
  const { handle } = await import("../lib/router.js");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const response = await handle(request);
    const headers = {};
    for (const [k, v] of response.headers) if (k !== "set-cookie") headers[k] = v;
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.SITE_URL = base;
  const paystack = await startMockPaystack({ secretKey: SK, webhookSecret: WHSEC, webhookUrl: `${base}/api/paystack/webhook` });
  const resend = await startMockResend({ apiKey: "re_test_double" });
  process.env.PAYSTACK_BASE_URL = paystack.url;
  process.env.RESEND_BASE_URL = resend.url;

  const { getDb, closeDb } = await import("../lib/db.js");
  await getDb(); // migrate once

  let cookie = "";
  async function api(method, path, { body, headers = {}, admin = false, raw = false, cookie: c } = {}) {
    const h = { ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (admin) h["X-Requested-With"] = "poffi-admin";
    const useCookie = c !== undefined ? c : admin ? cookie : "";
    if (useCookie) h.Cookie = useCookie;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }

  async function reset() {
    const db = await getDb();
    await db.query(`TRUNCATE notifications, payment_events, refunds, payments, order_status_history, order_item_customisations, order_items, orders, customers,
      schedule_closures, addons, addon_groups, product_variations, products, categories, media, settings, rate_limits, job_runs, admin_users RESTART IDENTITY CASCADE`);
    await db.query(`ALTER SEQUENCE order_number_seq RESTART WITH 1`);
    resend.state.emails.length = 0; resend.state.byKey.clear(); resend.state.failNext = 0; resend.state.rejectAll = false;
    paystack.state.amountOverride = null; paystack.state.currencyOverride = null; paystack.state.failNextInit = 0; paystack.state.webhookMode = "both"; paystack.state.webhooks.length = 0;
    cookie = "";
  }

  async function signInOwner() {
    const { createUser } = await import("../lib/auth.js");
    await createUser({ email: "owner@poffi.test", name: "Owner", role: "owner", password: "owner-password-123" }).catch(() => {});
    const r = await api("POST", "/api/admin/login", { body: { email: "owner@poffi.test", password: "owner-password-123" } });
    cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    return r;
  }
  const setCookie = (c) => { cookie = c; };

  async function close() {
    await new Promise((r) => server.close(r));
    await paystack.close();
    await resend.close();
    await closeDb();
  }
  return { base, api, reset, signInOwner, setCookie, paystack, resend, close, getDb };
}

// A fixed "today" well in the future so no test depends on the real date, weekday or time of day.
export function lagosInstant(daysFromNow, hhmm) {
  const real = new Date();
  const d = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate() + daysFromNow));
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 1, m); // Lagos is UTC+1 all year
}
export const lagosDate = (ms) => new Date(ms + 3_600_000).toISOString().slice(0, 10);

export async function configureShop(api, overrides = {}) {
  const hours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: true, from: "08:00", to: "18:00" }]));
  const put = (section, body) => api("PUT", `/api/admin/settings/${section}`, { body, admin: true });
  const r1 = await put("ordering", { enabled: true, pickup: true, delivery: true, hours, slot_minutes: 30, slot_capacity: 3, lead_time_minutes: 60, same_day: true, cutoff: { enabled: false, time: "16:00", days_before: 1 }, max_days_ahead: 14, hold_minutes: 30, min_order_kobo: 0, ...overrides.ordering });
  if (r1.status !== 200) throw new Error(`ordering settings: ${JSON.stringify(r1.data)}`);
  await put("delivery", { zones: [{ id: "zone-a", name: "Zone A", fee_kobo: 150000, active: true }], note: "" });
  await put("notifications", { owner_email: "owner@poffi.test", new_order: true, cancellation: true, reminder_offsets: [60, 30], customer_confirmation: true, customer_status: { confirmed: true, preparing: false, ready: true, out_for_delivery: true, completed: false, cancelled: true }, ...overrides.notifications });
  await put("business", { name: "Poffi Stack", tagline: "Freshly made. Packed with love.", whatsapp: "+2348000000000", pickup_address: "Test pickup point" });
  const cat = await api("POST", "/api/admin/categories", { body: { name: "Pancakes" }, admin: true });
  const p1 = await api("POST", "/api/admin/products", { admin: true, body: {
    name: "Test stack", category_id: cat.data.id, description: "Test item", price: "3000",
    variations: [{ name: "Small", price: "3000" }, { name: "Large", price: "5000" }],
    addon_groups: [{ name: "Toppings", min_select: 0, max_select: 2, addons: [{ name: "Berries", price: "500" }, { name: "Syrup", price: "200" }, { name: "Nuts", price: "300" }] }],
  } });
  const p2 = await api("POST", "/api/admin/products", { admin: true, body: { name: "Plain item", category_id: cat.data.id, price: "2000" } });
  return { categoryId: cat.data.id, stack: p1.data.product, plain: p2.data.product };
}
