// Owner dashboard API. Every route requires a signed-in dashboard user; owner-only routes say so.
import { getDb } from "../db.js";
import { HttpError, bad, clientIp, int, isDate, isTime, json, readJson, str } from "../http.js";
import { emailConfig, paystackConfig, siteUrl } from "../config.js";
import { changePassword, clearCookie, countUsers, createUser, listUsers, login, requireAdmin, resetUserPassword, sessionCookie, setUserActive, setupTokenMatches, validatePassword } from "../auth.js";
import { limit } from "../ratelimit.js";
import { addNote, adminOrderDetail, changeStatus, listOrders, overview } from "../orders.js";
import { refreshRefund, refundOrder, verifyAndApply } from "../payments.js";
import { adminMenu, deleteCategory, deleteProduct, getProduct, saveCategory, saveProduct, setArchived, setProductStatus } from "../menu.js";
import { saveImage } from "../media.js";
import { getSettings, isOrderingReady, ownerRecipients, saveSection } from "../settings.js";
import { listClosures } from "../schedule.js";
import { processDue, retryNotification, sendTestEmail, syncReminders } from "../notifications.js";
import { loadOrderRow } from "../order-data.js";
import { runAutomation } from "./system.js";
import { partsIn } from "../time.js";
import { now } from "../clock.js";

const idParam = (v) => { const n = int(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "not_found", "Not found."); return n; };
const actorOf = (u) => `${u.name} <${u.email}>`;

// ---------- auth ----------
async function doLogin(request) {
  const body = await readJson(request);
  await limit("login-ip", clientIp(request), 20, 900);
  await limit("login-email", str(body.email, 254).toLowerCase(), 8, 900);
  const user = await login(body.email, String(body.password ?? ""));
  if (!user) {
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, "bad_login", "That email and password don't match.");
  }
  return json({ user: { id: Number(user.id), name: user.name, email: user.email, role: user.role, must_change_password: user.must_change_password } }, 200, { "Set-Cookie": sessionCookie(user) });
}

const doLogout = async () => json({ ok: true }, 200, { "Set-Cookie": clearCookie() });

async function me(request) {
  const user = await requireAdmin(request, { allowMustChange: true });
  return json({ user });
}

async function doChangePassword(request) {
  const user = await requireAdmin(request, { allowMustChange: true });
  const body = await readJson(request);
  const updated = await changePassword(user.id, String(body.current ?? ""), String(body.password ?? ""));
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(updated) });
}

// First owner login, allowed only while there are no logins at all and only with ADMIN_SETUP_TOKEN.
async function setup(request) {
  await limit("setup", clientIp(request), 10, 900);
  const body = await readJson(request);
  if (!setupTokenMatches(body.token)) throw new HttpError(403, "bad_token", "That setup code isn't right.");
  if ((await countUsers()) > 0) throw new HttpError(409, "already_setup", "The dashboard already has a login. Sign in instead.");
  validatePassword(body.password);
  const { user } = await createUser({ email: body.email, name: body.name, role: "owner", password: body.password });
  return json({ user });
}

async function setupStatus() {
  return json({ needs_setup: (await countUsers()) === 0 });
}

// ---------- overview & orders ----------
async function getOverview(request) {
  await requireAdmin(request);
  const s = await getSettings();
  const ready = isOrderingReady(s);
  const data = await overview();
  const p = paystackConfig();
  return json({
    ...data,
    now: new Date(now()).toISOString(),
    today: partsIn(now()).date,
    system: {
      ordering_open: ready.ready, ordering_switch: s.ordering.enabled, hours_set: ready.anyDay, method_set: ready.method,
      paystack: p.mode, email: emailConfig().configured, owner_email_set: ownerRecipients(s).length > 0, reminders: emailConfig().reminderDelivery,
    },
  });
}

async function getOrders(request) {
  await requireAdmin(request);
  const u = new URL(request.url).searchParams;
  return json(await listOrders({ view: u.get("view") || "upcoming", status: u.get("status") || "", payment: u.get("payment") || "", dateFrom: u.get("from") || "", dateTo: u.get("to") || "", q: u.get("q") || "", page: u.get("page") || 1, sort: u.get("sort") || "" }));
}

async function getOrder(request, { id }) {
  await requireAdmin(request);
  return json(await adminOrderDetail(idParam(id)));
}

async function postStatus(request, { id }) {
  const user = await requireAdmin(request);
  const body = await readJson(request);
  const to = str(body.to, 30);
  await changeStatus(idParam(id), to, { actor: actorOf(user), note: body.note, reason: body.reason });
  await processDue({ origin: siteUrl(request), orderId: idParam(id) }).catch(() => {});
  return json(await adminOrderDetail(idParam(id)));
}

async function postNote(request, { id }) {
  const user = await requireAdmin(request);
  const body = await readJson(request);
  await addNote(idParam(id), body.note, actorOf(user));
  return json(await adminOrderDetail(idParam(id)));
}

async function postVerify(request, { id }) {
  await requireAdmin(request);
  const { query } = await getDb();
  const { rows } = await query(`SELECT reference FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [idParam(id)]);
  if (!rows.length) throw new HttpError(409, "no_payment", "This order has no payment attempt to check.");
  const out = await verifyAndApply(rows[0].reference, { origin: siteUrl(request), source: "dashboard" });
  return json({ result: out.status, ...(await adminOrderDetail(idParam(id))) });
}

async function postRefund(request, { id }) {
  const user = await requireAdmin(request, { role: "owner" });
  const body = await readJson(request);
  if (body.confirm !== true) throw bad("confirm_required", "Confirm the refund first.");
  const out = await refundOrder(idParam(id), { actorId: user.id, actor: actorOf(user) });
  return json({ refund: out, ...(await adminOrderDetail(idParam(id))) });
}

async function postRefundCheck(request, { id }) {
  await requireAdmin(request);
  const out = await refreshRefund(idParam(id));
  return json({ refund: out, ...(await adminOrderDetail(idParam(id))) });
}

async function clearAttention(request, { id }) {
  const user = await requireAdmin(request);
  const { query } = await getDb();
  const r = await query(`UPDATE orders SET needs_attention = NULL, updated_at = now() WHERE id = $1 AND needs_attention IS NOT NULL RETURNING id`, [idParam(id)]);
  if (r.rowCount) await query(`INSERT INTO order_status_history (order_id, kind, note, actor) VALUES ($1, 'note', 'Marked as checked', $2)`, [idParam(id), actorOf(user)]);
  return json(await adminOrderDetail(idParam(id)));
}

// ---------- menu ----------
async function getMenu(request) { await requireAdmin(request); return json(await adminMenu()); }

async function postCategory(request) {
  await requireAdmin(request, { role: "owner" });
  const id = await saveCategory(await readJson(request));
  return json({ id, ...(await adminMenu()) });
}
async function putCategory(request, { id }) {
  await requireAdmin(request, { role: "owner" });
  await saveCategory(await readJson(request), idParam(id));
  return json(await adminMenu());
}
async function delCategory(request, { id }) {
  await requireAdmin(request, { role: "owner" });
  await deleteCategory(idParam(id));
  return json(await adminMenu());
}
async function postProduct(request) {
  await requireAdmin(request, { role: "owner" });
  return json({ product: await saveProduct(await readJson(request)) });
}
async function putProduct(request, { id }) {
  await requireAdmin(request, { role: "owner" });
  return json({ product: await saveProduct(await readJson(request), idParam(id)) });
}
async function patchProductStatus(request, { id }) {
  await requireAdmin(request); // staff may mark items sold out
  const body = await readJson(request);
  await setProductStatus(idParam(id), body.status);
  return json({ product: await getProduct(idParam(id)) });
}
async function postArchive(request, { id }) {
  await requireAdmin(request, { role: "owner" });
  const body = await readJson(request);
  await setArchived(idParam(id), body.archived !== false);
  return json({ product: await getProduct(idParam(id)) });
}
async function delProduct(request, { id }) {
  await requireAdmin(request, { role: "owner" });
  return json(await deleteProduct(idParam(id)));
}
async function postMedia(request) {
  const user = await requireAdmin(request, { role: "owner" });
  const body = await readJson(request, 4.2 * 1024 * 1024);
  return json(await saveImage(body.data, user.id));
}

// ---------- settings ----------
async function getAllSettings(request) {
  await requireAdmin(request);
  const s = await getSettings();
  const today = partsIn(now()).date;
  return json({ settings: s, closures: await listClosures(today), env: { owner_email_env: !!emailConfig().ownerEmailEnv, email: emailConfig().configured, paystack: paystackConfig().mode, site_url: siteUrl(request) } });
}

async function putSettings(request, { section }) {
  const user = await requireAdmin(request, { role: "owner" });
  const body = await readJson(request, 64 * 1024);
  const db = await getDb();
  const saved = await saveSection(section, body, user.id);
  if (section === "notifications") {
    // Reminder times or the owner address changed: bring every upcoming order's reminders in line.
    const s = await getSettings();
    const { rows } = await db.query(`SELECT id FROM orders WHERE payment_status = 'paid' AND status IN ('new','confirmed','preparing','ready','out_for_delivery') AND scheduled_at > $1`, [new Date(now()).toISOString()]);
    for (const r of rows) {
      await db.tx(async (q) => { const o = await loadOrderRow(q, "o.id = $1", [r.id], { lock: true }); if (o) await syncReminders(q, o, s, now()); });
    }
    await processDue({ origin: siteUrl(request) }).catch(() => {});
  }
  return json({ section, value: saved });
}

async function postClosure(request) {
  const user = await requireAdmin(request, { role: "owner" });
  const body = await readJson(request);
  if (!isDate(body.date)) throw bad("invalid_closure", "Choose a date.", { field: "date" });
  const slot = body.slot_time ? str(body.slot_time, 5) : null;
  if (slot && !isTime(slot)) throw bad("invalid_closure", "That time doesn't look right.", { field: "slot_time" });
  const { query } = await getDb();
  try {
    await query(`INSERT INTO schedule_closures (date, slot_time, reason, created_by) VALUES ($1::date, $2, $3, $4)`, [body.date, slot, str(body.reason, 120), user.id]);
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "exists", "That day or time is already closed.");
    throw err;
  }
  return json({ closures: await listClosures(partsIn(now()).date) });
}

async function delClosure(request, { id }) {
  await requireAdmin(request, { role: "owner" });
  const { query } = await getDb();
  await query(`DELETE FROM schedule_closures WHERE id = $1`, [idParam(id)]);
  return json({ closures: await listClosures(partsIn(now()).date) });
}

// ---------- team ----------
async function getUsers(request) { await requireAdmin(request, { role: "owner" }); return json({ users: await listUsers() }); }
async function postUser(request) {
  await requireAdmin(request, { role: "owner" });
  const body = await readJson(request);
  const out = await createUser({ email: body.email, name: body.name, role: body.role });
  return json({ ...out, users: await listUsers() });
}
async function postUserReset(request, { id }) {
  await requireAdmin(request, { role: "owner" });
  const temp = await resetUserPassword(idParam(id));
  return json({ temporaryPassword: temp, users: await listUsers() });
}
async function postUserActive(request, { id }) {
  const user = await requireAdmin(request, { role: "owner" });
  const body = await readJson(request);
  await setUserActive(idParam(id), body.active === true, user.id);
  return json({ users: await listUsers() });
}

// ---------- emails & automation ----------
async function getNotifications(request) {
  await requireAdmin(request);
  const u = new URL(request.url).searchParams;
  const status = u.get("status") || "";
  const { query } = await getDb();
  const { rows } = await query(
    `SELECT n.id, n.kind, n.recipient, n.subject, n.status, n.attempts, n.max_attempts, n.send_at, n.sent_at, n.last_error, n.created_at, o.reference AS order_reference, o.id AS order_id
     FROM notifications n LEFT JOIN orders o ON o.id = n.order_id
     WHERE ($1 = '' OR n.status = $1) ORDER BY n.send_at DESC, n.id DESC LIMIT 100`, [status]);
  const { rows: runs } = await query(`SELECT job, started_at, finished_at, ok, result FROM job_runs ORDER BY started_at DESC LIMIT 5`);
  return json({ notifications: rows.map((r) => ({ ...r, id: Number(r.id), order_id: r.order_id === null ? null : Number(r.order_id) })), runs });
}
async function postRetryNotification(request, { id }) {
  await requireAdmin(request);
  if (!(await retryNotification(idParam(id)))) throw new HttpError(409, "not_retryable", "Only failed or skipped emails can be retried.");
  await processDue({ origin: siteUrl(request) });
  return json({ ok: true });
}
async function postTestEmail(request) {
  await requireAdmin(request, { role: "owner" });
  await limit("test-email", clientIp(request), 5, 600);
  const out = await sendTestEmail(siteUrl(request));
  if (!out.ok) throw new HttpError(400, "email_failed", out.error);
  return json(out);
}
async function postRunAutomation(request) {
  await requireAdmin(request, { role: "owner" });
  return json(await runAutomation(siteUrl(request), "manual"));
}

export const adminRoutes = [
  ["GET", "/api/admin/setup", setupStatus],
  ["POST", "/api/admin/setup", setup],
  ["POST", "/api/admin/login", doLogin],
  ["POST", "/api/admin/logout", doLogout],
  ["GET", "/api/admin/me", me],
  ["POST", "/api/admin/password", doChangePassword],
  ["GET", "/api/admin/overview", getOverview],
  ["GET", "/api/admin/orders", getOrders],
  ["GET", "/api/admin/orders/:id", getOrder],
  ["POST", "/api/admin/orders/:id/status", postStatus],
  ["POST", "/api/admin/orders/:id/note", postNote],
  ["POST", "/api/admin/orders/:id/verify-payment", postVerify],
  ["POST", "/api/admin/orders/:id/refund", postRefund],
  ["POST", "/api/admin/orders/:id/refund-check", postRefundCheck],
  ["POST", "/api/admin/orders/:id/clear-attention", clearAttention],
  ["GET", "/api/admin/menu", getMenu],
  ["POST", "/api/admin/categories", postCategory],
  ["PUT", "/api/admin/categories/:id", putCategory],
  ["DELETE", "/api/admin/categories/:id", delCategory],
  ["POST", "/api/admin/products", postProduct],
  ["PUT", "/api/admin/products/:id", putProduct],
  ["POST", "/api/admin/products/:id/availability", patchProductStatus],
  ["POST", "/api/admin/products/:id/archive", postArchive],
  ["DELETE", "/api/admin/products/:id", delProduct],
  ["POST", "/api/admin/media", postMedia],
  ["GET", "/api/admin/settings", getAllSettings],
  ["PUT", "/api/admin/settings/:section", putSettings],
  ["POST", "/api/admin/closures", postClosure],
  ["DELETE", "/api/admin/closures/:id", delClosure],
  ["GET", "/api/admin/users", getUsers],
  ["POST", "/api/admin/users", postUser],
  ["POST", "/api/admin/users/:id/reset", postUserReset],
  ["POST", "/api/admin/users/:id/active", postUserActive],
  ["GET", "/api/admin/notifications", getNotifications],
  ["POST", "/api/admin/notifications/:id/retry", postRetryNotification],
  ["POST", "/api/admin/test-email", postTestEmail],
  ["POST", "/api/admin/run-automation", postRunAutomation],
];
