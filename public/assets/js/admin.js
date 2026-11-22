// Poffi Stack owner dashboard (single page, hash routes).
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const naira = (k) => "₦" + (Math.round(Number(k) || 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });
const toNaira = (k) => (Math.round(Number(k) || 0) / 100).toString();
const TZ = "Africa/Lagos";
let me = null;
let skew = 0; // server time minus browser time
const nowMs = () => Date.now() + skew;

const STATUS = { awaiting_payment: "Awaiting payment", new: "New", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed", cancelled: "Cancelled" };
const PAY = { pending: "Pending payment", paid: "Paid", failed: "Payment failed", refund_pending: "Refund in progress", refunded: "Refunded" };
const ACTION = { confirmed: "Confirm order", preparing: "Start preparing", ready: "Mark ready", out_for_delivery: "Out for delivery", completed: "Mark completed", cancelled: "Cancel order" };
const KIND = { customer_confirmation: "Customer confirmation", owner_new_order: "New-order alert", owner_reminder: "Reminder", owner_cancellation: "Cancellation alert", customer_status: "Status update", owner_alert: "Needs-attention alert", test: "Test email" };

const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/></svg>',
  orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .9 3.5 3 3.5 5.5"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>',
};

// ---------------- API ----------------
class ApiError extends Error { constructor(s, d) { super(d?.message || "Something went wrong."); this.status = s; this.data = d || {}; } }
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (method !== "GET") headers["X-Requested-With"] = "poffi-admin";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" }); }
  catch { throw new ApiError(0, { message: "Can't reach the server. Check your connection." }); }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.endsWith("/login") && !path.endsWith("/password")) { me = null; renderLogin(); throw new ApiError(401, data); }
  if (res.status === 403 && data?.error === "must_change_password") { renderMustChange(); throw new ApiError(403, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let toastT;
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2800);
}

// ---------------- time ----------------
const fmtDate = (d) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(d + "T12:00:00Z"));
const clock12 = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; };
const stamp = (iso) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ }).format(new Date(iso));
const lagosToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs()));

function urgency(o) {
  if (["completed", "cancelled", "awaiting_payment"].includes(o.status)) return null;
  const mins = Math.round((new Date(o.scheduled_at).getTime() - nowMs()) / 60000);
  if (mins < 0) return { cls: "overdue", text: `Overdue ${fmtMins(-mins)}` };
  if (mins <= 60) return { cls: "soon", text: `Due in ${fmtMins(mins)}` };
  if (mins <= 24 * 60) return { cls: "later", text: `In ${fmtMins(mins)}` };
  return null;
}
const fmtMins = (m) => (m < 60 ? `${m} min` : m < 24 * 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${Math.floor(m / 1440)} d`);
const pill = (status) => `<span class="pill s-${status}">${STATUS[status] || status}</span>`;
const ppill = (ps) => `<span class="pill p-${ps}">${PAY[ps] || ps}</span>`;

// ---------------- shell ----------------
const NAV = [
  ["#/", "Overview", I.home, "all"], ["#/orders", "Orders", I.orders, "all"], ["#/menu", "Menu", I.menu, "all"],
  ["#/settings/ordering", "Settings", I.settings, "all"], ["#/team", "Team", I.team, "owner"], ["#/emails", "Emails", I.mail, "all"], ["#/account", "Account", I.user, "all"],
];
function shell(active, content) {
  const nav = NAV.filter((n) => n[3] === "all" || me.role === "owner");
  const isActive = (href) => (href === "#/" ? active === "overview" : active === href.slice(2).split("/")[0]);
  app.innerHTML = `<div class="admin-shell">
    <aside class="side" aria-label="Dashboard">
      <div class="brand-row"><img src="/assets/img/logo-disc-96.png" alt=""><div><b>Poffi Stack</b><small>Orders dashboard</small></div></div>
      ${nav.map(([h, l, i]) => `<a href="${h}" class="${isActive(h) ? "active" : ""}">${i}${l}</a>`).join("")}
      <div class="grow"></div>
      <div class="who"><b>${esc(me.name)}</b>${esc(me.email)} · ${me.role === "owner" ? "Owner" : "Staff"}<br><button class="link-btn" data-logout style="color:#ffb08a;padding:0;min-height:36px">Sign out</button>
        <a class="powered" href="https://kal-s-digital.vercel.app" target="_blank" rel="noopener" style="padding:0;min-height:36px;color:#b9a69c;font-weight:500;font-size:12px">Powered by <img src="/assets/img/kals-digital-white.svg" alt="Kal’s Digital" style="height:24px"></a></div>
    </aside>
    <header class="topbar"><img src="/assets/img/logo-disc-96.png" alt=""><b>Poffi Stack</b><a class="btn btn-sm btn-light" href="#/account">${esc(me.name.split(" ")[0])}</a></header>
    <main class="main" id="view">${content}</main>
    <nav class="bottomnav" aria-label="Dashboard">${[NAV[0], NAV[1], NAV[2], NAV[3], NAV[5]].map(([h, l, i]) => `<a href="${h}" class="${isActive(h) ? "active" : ""}">${i}${l}</a>`).join("")}</nav>
  </div>`;
  app.querySelector("[data-logout]")?.addEventListener("click", logout);
  return app.querySelector("#view");
}
const loading = () => `<div class="loading"><div class="spinner" aria-label="Loading"></div></div>`;
const errorBox = (e) => `<div class="alert"><span>${I.alert}</span><div>${esc(e.message)}</div></div>`;

async function logout() { await api("/api/admin/logout", { method: "POST" }).catch(() => {}); me = null; renderLogin(); }

// ---------------- auth screens ----------------
function authCard(inner) {
  app.innerHTML = `<div class="login-wrap"><div class="login-card"><img class="logo" src="/assets/img/logo-disc-192.png" alt="Poffi Stack">${inner}
    <p class="small muted" style="text-align:center;margin-top:18px">Powered by Kal’s Digital</p></div></div>`;
}

async function renderLogin() {
  let needsSetup = false;
  try { needsSetup = (await api("/api/admin/setup")).needs_setup; } catch { /* keep login */ }
  if (needsSetup) return renderSetup();
  authCard(`<h1>Dashboard</h1><p class="sub">Sign in to manage orders.</p>
    <form data-f novalidate>
      <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
      <p class="form-error" data-err hidden role="alert"></p>
      <button class="btn btn-primary btn-block">Sign in</button></form>`);
  const f = app.querySelector("[data-f]");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = f.querySelector("[data-err]");
    err.hidden = true;
    try {
      const out = await api("/api/admin/login", { method: "POST", body: { email: f.querySelector("#em").value.trim(), password: f.querySelector("#pw").value } });
      me = out.user;
      if (me.must_change_password) return renderMustChange();
      route();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  f.querySelector("#em").focus();
}

function renderSetup() {
  authCard(`<h1>Set up the dashboard</h1><p class="sub">Create the owner login. You need the setup code from your Kal’s Digital handover.</p>
    <form data-f novalidate>
      <div class="field"><label for="tk">Setup code</label><input id="tk" autocomplete="off" required></div>
      <div class="field"><label for="nm">Your name</label><input id="nm" autocomplete="name" required></div>
      <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="new-password" minlength="10" required><span class="hint">At least 10 characters.</span></div>
      <p class="form-error" data-err hidden role="alert"></p>
      <button class="btn btn-primary btn-block">Create owner login</button></form>`);
  const f = app.querySelector("[data-f]");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = f.querySelector("[data-err]");
    try {
      const body = { token: f.querySelector("#tk").value.trim(), name: f.querySelector("#nm").value.trim(), email: f.querySelector("#em").value.trim(), password: f.querySelector("#pw").value };
      await api("/api/admin/setup", { method: "POST", body });
      const out = await api("/api/admin/login", { method: "POST", body: { email: body.email, password: body.password } });
      me = out.user; location.hash = "#/settings/ordering"; route();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

function renderMustChange() {
  authCard(`<h1>Choose your password</h1><p class="sub">You signed in with a temporary password. Choose your own to continue.</p>
    <form data-f novalidate>
      <div class="field"><label for="cur">Temporary password</label><input id="cur" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pw">New password</label><input id="pw" type="password" autocomplete="new-password" minlength="10" required><span class="hint">At least 10 characters.</span></div>
      <p class="form-error" data-err hidden role="alert"></p>
      <button class="btn btn-primary btn-block">Save password</button></form>`);
  const f = app.querySelector("[data-f]");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = f.querySelector("[data-err]");
    try {
      await api("/api/admin/password", { method: "POST", body: { current: f.querySelector("#cur").value, password: f.querySelector("#pw").value } });
      me = (await api("/api/admin/me")).user; toast("Password saved"); route();
    } catch (ex) { if (ex.status !== 403) { err.textContent = ex.message; err.hidden = false; } }
  });
}

// ---------------- overview ----------------
function orderRow(o) {
  const u = urgency(o);
  return `<a class="orow ${u?.cls === "overdue" ? "overdue" : u?.cls === "soon" ? "soon" : ""}" href="#/orders/${o.id}">
    <span class="ref">${esc(o.reference)}</span>
    <span class="when">${fmtDate(o.scheduled_date)}, ${clock12(o.scheduled_time)}<small>${o.fulfilment_method === "delivery" ? "Delivery" : "Pickup"}</small></span>
    <span class="items">${esc(o.items_summary || "")}</span>
    <span class="meta"><b>${esc(o.customer_name)}</b> <span>${esc(o.customer_phone)}</span> <b>${naira(o.total_kobo)}</b> ${ppill(o.payment_status)} ${pill(o.status)} ${u ? `<span class="urg ${u.cls}">${u.text}</span>` : o.needs_attention ? `<span class="urg overdue">Check</span>` : ""}</span>
  </a>`;
}
const listHead = `<div class="olist-head"><span>Order</span><span>When</span><span>Items</span><span>Customer</span><span>Phone</span><span>Total</span><span>Status</span></div>`;

async function viewOverview() {
  const v = shell("overview", loading());
  let d;
  try { d = await api("/api/admin/overview"); } catch (e) { v.innerHTML = errorBox(e); return; }
  skew = new Date(d.now).getTime() - Date.now();
  const s = d.system;
  const alerts = [];
  if (!s.ordering_open) alerts.push(`<div class="alert hot"><span>${I.alert}</span><div><b>Online ordering is closed.</b> ${!s.hours_set ? "Set your opening hours" : !s.method_set ? "Switch on pickup or delivery (with a delivery area)" : "Switch ordering on"} in <a href="#/settings/ordering" style="color:#fff">Settings → Ordering</a>.</div></div>`);
  if (s.paystack === "off") alerts.push(`<div class="alert"><span>${I.alert}</span><div><b>Payments aren't connected.</b> Customers can't pay until Paystack keys are added to the hosting settings.</div></div>`);
  else if (s.paystack === "test") alerts.push(`<div class="alert soft"><span>${I.alert}</span><div><b>Paystack is in test mode.</b> No real money is taken. Switch to live keys when you're ready to launch.</div></div>`);
  if (!s.email) alerts.push(`<div class="alert"><span>${I.alert}</span><div><b>Emails are off.</b> Order emails and reminders need a Resend API key in the hosting settings.</div></div>`);
  else if (!s.owner_email_set) alerts.push(`<div class="alert"><span>${I.alert}</span><div><b>No notification email.</b> Add one in <a href="#/settings/notifications">Settings → Notifications</a> to get new-order alerts and reminders.</div></div>`);
  if (d.failed_emails) alerts.push(`<div class="alert"><span>${I.alert}</span><div><b>${d.failed_emails} email${d.failed_emails === 1 ? "" : "s"} couldn't be sent.</b> <a href="#/emails">See the email log</a>.</div></div>`);
  const c = d.counts;
  const attention = d.upcoming.filter((o) => urgency(o)?.cls === "overdue" || urgency(o)?.cls === "soon" || o.needs_attention);
  v.innerHTML = `<div class="page-head"><div><h1>Good ${greeting()}, ${esc(me.name.split(" ")[0])}</h1><p>${fmtDate(lagosToday())} · Lagos time</p></div><a class="btn btn-primary" href="#/orders">All orders</a></div>
    <div class="alerts">${alerts.join("")}</div>
    <div class="stats">
      <a class="stat orange" href="#/orders?view=upcoming&status=new"><b>${c.new}</b><span>New, to confirm</span></a>
      <a class="stat" href="#/orders?view=upcoming&status=preparing"><b>${c.preparing}</b><span>Preparing</span></a>
      <a class="stat" href="#/orders?view=upcoming&status=ready"><b>${c.ready}</b><span>Ready / out</span></a>
      <a class="stat dark" href="#/orders?view=attention"><b>${c.overdue + c.needs_attention}</b><span>Need attention</span></a>
      <a class="stat" href="#/orders?view=awaiting_payment"><b>${c.pending_payment}</b><span>Awaiting payment</span></a>
      <a class="stat" href="#/orders?view=completed"><b>${c.completed}</b><span>Completed</span></a>
      <div class="stat wide"><b>${naira(d.revenue_kobo)}</b><span>Revenue from verified payments${d.refunded_kobo ? ` (after ${naira(d.refunded_kobo)} refunded)` : ""}</span></div>
      <div class="stat"><b>${naira(d.revenue_today_kobo)}</b><span>Paid today</span></div>
      <div class="stat"><b>${c.paid}</b><span>Paid orders</span></div>
      <div class="stat"><b>${c.cancelled}</b><span>Cancelled</span></div>
      <div class="stat"><b>${c.total}</b><span>All orders</span></div>
    </div>
    ${attention.length ? `<div class="box"><h2>Needs attention now</h2><div class="olist">${listHead}${attention.map(orderRow).join("")}</div></div>` : ""}
    <div class="box"><h2>Coming up <a class="btn btn-sm btn-ghost" href="#/orders">See all</a></h2>
      ${d.upcoming.length ? `<div class="olist">${listHead}${d.upcoming.map(orderRow).join("")}</div>` : `<div class="empty-box">No upcoming paid orders.</div>`}</div>
    <p class="small muted" style="margin-top:14px">Automation last ran: ${d.last_automation_run ? `${stamp(d.last_automation_run.started_at)} (${d.last_automation_run.ok ? "OK" : "with errors"})` : "not yet"} · Reminders: ${s.reminders === "cron" ? "sent by the scheduler" : "scheduled with Resend"}</p>`;
}
const greeting = () => { const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: TZ }).format(new Date(nowMs()))); return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"; };

// ---------------- orders list ----------------
async function viewOrders(query) {
  const q = new URLSearchParams(query);
  const view = q.get("view") || "upcoming";
  const v = shell("orders", "");
  const tabs = [["upcoming", "Upcoming"], ["attention", "Needs attention"], ["awaiting_payment", "Awaiting payment"], ["completed", "Completed"], ["cancelled", "Cancelled"], ["all", "All"]];
  v.innerHTML = `<div class="page-head"><div><h1>Orders</h1><p>Sorted by fulfilment time. Times are Lagos time.</p></div><button class="btn btn-sm btn-ghost" data-refresh>Refresh</button></div>
    <nav class="tabs-row">${tabs.map(([k, l]) => `<a href="#/orders?view=${k}" class="${k === view ? "active" : ""}">${l}</a>`).join("")}</nav>
    <details class="filters-wrap" ${["q", "status", "payment", "from", "to"].some((k) => q.get(k)) || matchMedia("(min-width: 900px)").matches ? "open" : ""}><summary class="btn btn-sm btn-ghost">Search &amp; filter</summary>
    <form class="filters" data-filters style="margin-top:12px">
      <div class="field search"><label for="fq">Search</label><input id="fq" name="q" placeholder="Order number, name, phone or email" value="${esc(q.get("q") || "")}"></div>
      <div class="field"><label for="fs">Status</label><select id="fs" name="status"><option value="">Any</option>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${q.get("status") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="fp">Payment</label><select id="fp" name="payment"><option value="">Any</option>${Object.entries(PAY).map(([k, l]) => `<option value="${k}" ${q.get("payment") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="ff">From</label><input id="ff" type="date" name="from" value="${esc(q.get("from") || "")}"></div>
      <div class="field"><label for="ft">To</label><input id="ft" type="date" name="to" value="${esc(q.get("to") || "")}"></div>
      <button class="btn btn-dark btn-sm" style="min-height:44px">Filter</button>
    </form></details>
    <div data-list>${loading()}</div>`;
  v.querySelector("[data-filters]").addEventListener("submit", (e) => {
    e.preventDefault();
    const p = new URLSearchParams({ view });
    for (const [k, val] of new FormData(e.target)) if (val) p.set(k, val);
    location.hash = `#/orders?${p}`;
  });
  v.querySelector("[data-refresh]").addEventListener("click", () => route());
  try {
    const p = new URLSearchParams(q);
    p.set("view", view);
    const d = await api(`/api/admin/orders?${p}`);
    v.querySelector("[data-list]").innerHTML = d.orders.length
      ? `<div class="olist">${listHead}${d.orders.map(orderRow).join("")}</div>${d.has_more ? `<p style="margin-top:14px"><a class="btn btn-ghost btn-sm" href="#/orders?${new URLSearchParams({ ...Object.fromEntries(p), page: String(d.page + 1) })}">Next page</a></p>` : ""}`
      : `<div class="box empty-box">No orders here.</div>`;
  } catch (e) { v.querySelector("[data-list]").innerHTML = errorBox(e); }
}

// ---------------- order detail ----------------
async function viewOrder(id) {
  const v = shell("orders", loading());
  let d;
  try { d = await api(`/api/admin/orders/${id}`); } catch (e) { v.innerHTML = errorBox(e); return; }
  renderOrder(v, d);
}

function renderOrder(v, d) {
  const o = d.order;
  const u = urgency(o);
  const paid = o.payment_status === "paid";
  const wa = String(o.customer_phone).replace(/\D/g, "").replace(/^0/, "234");
  const items = d.items.map((it) => `<div class="cart-line" style="padding:10px 0"><div><h3 style="font-size:17px">${it.quantity} × ${esc(it.product_name)}${it.variation_name ? ` (${esc(it.variation_name)})` : ""}</h3>
      ${it.customisations.length ? `<div class="meta">${it.customisations.map((c) => esc(`${c.group_name}: ${c.option_name}${c.price_kobo ? ` (+${naira(c.price_kobo)})` : ""}`)).join("<br>")}</div>` : ""}
      <div class="meta">${naira(it.unit_price_kobo)} each</div></div><div class="line-total">${naira(it.line_total_kobo)}</div></div>`).join("");
  const actions = d.allowed_next.filter((s) => s !== "cancelled").map((s, i) => `<button class="btn ${i === 0 ? "btn-primary" : "btn-ghost"}" data-to="${s}">${s === "ready" && o.fulfilment_method === "pickup" ? "Ready for collection" : ACTION[s]}</button>`).join("");
  v.innerHTML = `<a class="back" href="#/orders">${I.back} Orders</a>
    <div class="page-head"><div><h1>${esc(o.reference)}</h1><p>${pill(o.status)} ${ppill(o.payment_status)} ${u ? `<span class="urg ${u.cls}">${u.text}</span>` : ""}</p></div></div>
    ${o.needs_attention ? `<div class="alert hot" style="margin-bottom:16px"><span>${I.alert}</span><div><b>Needs attention:</b> ${esc(o.needs_attention)}<br><button class="btn btn-sm btn-light" data-clear style="margin-top:8px">Mark as checked</button></div></div>` : ""}
    ${o.status === "awaiting_payment" ? `<div class="alert soft" style="margin-bottom:16px"><span>${I.alert}</span><div>This order hasn't been paid. Don't prepare it until the payment shows as <b>Paid</b>.</div></div>` : ""}
    <div class="cols"><div>
      ${d.allowed_next.length ? `<div class="box"><h2>Next step</h2><div class="actions">${actions}${d.allowed_next.includes("cancelled") ? `<button class="btn btn-ghost" data-cancel>Cancel order</button>` : ""}</div><p class="form-error" data-act-err hidden></p></div>` : ""}
      <div class="box"><h2>Fulfilment</h2><dl class="kv">
        <div><dt>Method</dt><dd><b>${o.fulfilment_method === "delivery" ? "Delivery" : "Pickup"}</b></dd></div>
        <div><dt>Date</dt><dd><b>${fmtDate(o.scheduled_date)}</b></dd></div>
        <div><dt>Time</dt><dd><b>${clock12(o.scheduled_time)}</b> (${o.slot_minutes}-minute slot, Lagos time)</dd></div>
        ${o.fulfilment_method === "delivery" ? `<div><dt>Address</dt><dd>${esc(o.delivery_address)}<br><span class="muted">${esc(o.delivery_zone_name || "")}</span></dd></div>` : ""}
        <div><dt>Instructions</dt><dd>${o.notes ? esc(o.notes) : '<span class="muted">None</span>'}</dd></div>
      </dl></div>
      <div class="box"><h2>Items</h2>${items}
        <div style="margin-top:10px"><div class="sum-row"><span>Subtotal</span><b>${naira(o.subtotal_kobo)}</b></div>
        ${o.fulfilment_method === "delivery" ? `<div class="sum-row"><span>Delivery</span><b>${naira(o.delivery_fee_kobo)}</b></div>` : ""}
        <div class="sum-row total"><span>Total</span><span>${naira(o.total_kobo)}</span></div></div></div>
      <div class="box"><h2>History</h2><ul class="hist">${d.history.map((h) => `<li class="k-${h.kind}"><div>${h.kind === "note" ? `<b>Note:</b> ${esc(h.note)}` : `${h.kind === "payment" ? "Payment" : "Status"}${h.from_value ? `: ${esc(STATUS[h.from_value] || PAY[h.from_value] || h.from_value)} →` : ":"} <b>${esc(STATUS[h.to_value] || PAY[h.to_value] || h.to_value || "")}</b>${h.note ? ` · ${esc(h.note)}` : ""}`}<small>${stamp(h.created_at)} · ${esc(h.actor)}</small></div></li>`).join("")}</ul>
        <form data-note style="margin-top:14px;display:flex;gap:8px"><input class="field" style="flex:1;min-height:44px;border-radius:12px;border:2px solid var(--line-strong);padding:8px 12px;margin:0" name="note" placeholder="Add an internal note" maxlength="1000"><button class="btn btn-sm btn-dark">Add</button></form></div>
    </div><div>
      <div class="box"><h2>Customer</h2><dl class="kv">
        <div><dt>Name</dt><dd><b>${esc(o.customer_name)}</b></dd></div>
        <div><dt>Phone</dt><dd><a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a> · <a href="https://wa.me/${esc(wa)}?text=${encodeURIComponent(`Hi ${o.customer_name.split(" ")[0]}, it's Poffi Stack about your order ${o.reference}.`)}" target="_blank" rel="noopener">WhatsApp</a></dd></div>
        <div><dt>Email</dt><dd><a href="mailto:${esc(o.customer_email)}">${esc(o.customer_email)}</a></dd></div>
        <div><dt>Ordered</dt><dd>${stamp(o.created_at)}</dd></div>
      </dl></div>
      <div class="box"><h2>Payment ${ppill(o.payment_status)}</h2>
        ${d.payments.length ? `<div class="scroll-x"><table class="ntable"><tr><th>Reference</th><th>Status</th><th>Amount</th></tr>${d.payments.map((p) => `<tr><td style="word-break:break-all">${esc(p.reference)}<br><small class="muted">${stamp(p.created_at)}${p.channel ? ` · ${esc(p.channel)}` : ""}</small></td><td>${esc(p.status)}${p.gateway_response ? `<br><small class="muted">${esc(p.gateway_response)}</small>` : ""}</td><td>${naira(p.paid_amount_kobo ?? p.amount_kobo)}</td></tr>`).join("")}</table></div>` : `<p class="muted">No payment attempts yet.</p>`}
        ${d.refunds.length ? `<p style="margin-top:10px"><b>Refunds:</b> ${d.refunds.map((r) => `${esc(r.reference)} · ${esc(r.status)}${r.last_error ? ` (${esc(r.last_error)})` : ""}`).join("<br>")}</p>` : ""}
        <div class="actions" style="margin-top:12px">
          ${!paid && o.status !== "cancelled" && d.payments.length ? `<button class="btn btn-sm btn-ghost" data-verify>Check payment with Paystack</button>` : ""}
          ${paid && me.role === "owner" ? `<button class="btn btn-sm btn-ghost" data-refund>Refund ${naira(o.total_kobo)}</button>` : ""}
          ${o.payment_status === "refund_pending" ? `<button class="btn btn-sm btn-ghost" data-refund-check>Check refund status</button>` : ""}
        </div><p class="form-error" data-pay-err hidden></p></div>
      <div class="box"><h2>Emails</h2>${d.notifications.length ? `<div class="scroll-x"><table class="ntable"><tr><th>Email</th><th>Status</th></tr>${d.notifications.map((n) => `<tr><td>${esc(KIND[n.kind] || n.kind)}${n.kind === "owner_reminder" ? ` (${n.payload.offset_minutes} min)` : n.kind === "customer_status" ? ` (${esc(STATUS[n.payload.status] || "")})` : ""}<br><small class="muted">${esc(n.recipient)} · ${stamp(n.sent_at || n.send_at)}</small>${n.last_error && n.status !== "sent" ? `<br><small class="muted">${esc(n.last_error)}</small>` : ""}</td><td>${esc(n.status)}${["failed", "skipped"].includes(n.status) && n.kind !== "owner_reminder" ? `<br><button class="link-btn" data-retry="${n.id}" style="min-height:32px;padding:0">Retry</button>` : ""}</td></tr>`).join("")}</table></div>` : `<p class="muted">No emails yet.</p>`}</div>
    </div></div>`;

  const act = async (fn) => {
    try { const out = await fn(); renderOrder(v, out); } catch (e) {
      const el = v.querySelector("[data-act-err]") || v.querySelector("[data-pay-err]");
      if (el) { el.textContent = e.message; el.hidden = false; } else toast(e.message);
    }
  };
  v.querySelectorAll("[data-to]").forEach((b) => b.addEventListener("click", () => { b.disabled = true; act(async () => { const out = await api(`/api/admin/orders/${o.id}/status`, { method: "POST", body: { to: b.dataset.to } }); toast(`${o.reference}: ${STATUS[b.dataset.to]}`); return out; }); }));
  v.querySelector("[data-cancel]")?.addEventListener("click", () => {
    const reason = prompt(`Cancel ${o.reference}? Give a short reason (the customer will see it).`);
    if (reason === null) return;
    act(async () => { const out = await api(`/api/admin/orders/${o.id}/status`, { method: "POST", body: { to: "cancelled", reason } }); toast("Order cancelled"); if (out.order.payment_status === "paid" && me.role === "owner") toast("Cancelled. Refund it below if the customer should get their money back."); return out; });
  });
  v.querySelector("[data-clear]")?.addEventListener("click", () => act(() => api(`/api/admin/orders/${o.id}/clear-attention`, { method: "POST", body: {} })));
  v.querySelector("[data-verify]")?.addEventListener("click", () => act(async () => { const out = await api(`/api/admin/orders/${o.id}/verify-payment`, { method: "POST", body: {} }); toast(`Paystack says: ${out.result}`); return out; }));
  v.querySelector("[data-refund]")?.addEventListener("click", () => {
    if (!confirm(`Refund ${naira(o.total_kobo)} to ${o.customer_name} through Paystack? This can't be undone.`)) return;
    act(async () => { const out = await api(`/api/admin/orders/${o.id}/refund`, { method: "POST", body: { confirm: true } }); toast("Refund started"); return out; });
  });
  v.querySelector("[data-refund-check]")?.addEventListener("click", () => act(() => api(`/api/admin/orders/${o.id}/refund-check`, { method: "POST", body: {} })));
  v.querySelector("[data-note]").addEventListener("submit", (e) => { e.preventDefault(); const note = e.target.note.value.trim(); if (note) act(() => api(`/api/admin/orders/${o.id}/note`, { method: "POST", body: { note } })); });
  v.querySelectorAll("[data-retry]").forEach((b) => b.addEventListener("click", async () => { try { await api(`/api/admin/notifications/${b.dataset.retry}/retry`, { method: "POST", body: {} }); toast("Retried"); viewOrder(o.id); } catch (e) { toast(e.message); } }));
}

// ---------------- menu ----------------
let menuCache = null;
async function viewMenu(query) {
  const v = shell("menu", loading());
  const showArchived = new URLSearchParams(query).get("archived") === "1";
  try { menuCache = await api("/api/admin/menu"); } catch (e) { v.innerHTML = errorBox(e); return; }
  const owner = me.role === "owner";
  const { categories, products } = menuCache;
  const thumb = (p) => (p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : `<img class="illus" src="/assets/img/stack-illustration.svg" alt="">`);
  const priceText = (p) => (p.variations.length ? `${p.variations.map((x) => `${esc(x.name)} ${naira(x.price_kobo)}`).join(" · ")}` : naira(p.price_kobo));
  const groups = [...categories.map((c) => ({ ...c, items: products.filter((p) => p.category_id === c.id) })), { id: null, name: "No category", items: products.filter((p) => p.category_id === null) }]
    .map((g) => ({ ...g, items: g.items.filter((p) => showArchived || !p.archived) })).filter((g) => g.id !== null || g.items.length);
  v.innerHTML = `<div class="page-head"><div><h1>Menu</h1><p>Changes show on the website within a few seconds.</p></div>
      <div class="actions">${owner ? `<a class="btn btn-primary" href="#/menu/product/new">Add product</a>` : ""}<a class="btn btn-sm btn-ghost" href="#/menu${showArchived ? "" : "?archived=1"}">${showArchived ? "Hide" : "Show"} archived</a></div></div>
    ${!products.length ? `<div class="alert hot" style="margin-bottom:16px"><span>${I.alert}</span><div><b>Your menu is empty.</b> ${owner ? "Add a category, then your products with their real prices and photos." : "Ask the owner to add the menu."}</div></div>` : ""}
    <div class="cols"><div>${groups.map((g) => `<div class="box"><h2>${esc(g.name)}${g.id && g.active === false ? ' <span class="pill s-cancelled">Hidden</span>' : ""}</h2>
        ${g.items.length ? g.items.map((p) => `<div class="mitem ${p.archived ? "archived" : ""}"><div class="thumb">${thumb(p)}</div><div>
          <b>${esc(p.name)}</b>${p.featured ? ' <span class="pill s-new" style="font-size:11px">Featured</span>' : ""}${p.archived ? ' <span class="pill s-cancelled" style="font-size:11px">Archived</span>' : ""}
          <div class="muted small">${priceText(p)}${p.addon_groups.length ? ` · ${p.addon_groups.length} add-on group${p.addon_groups.length === 1 ? "" : "s"}` : ""}</div>
          <div class="row2">${p.archived ? "" : `<label class="small muted">Availability <select data-avail="${p.id}"><option value="available" ${p.status === "available" ? "selected" : ""}>Available</option><option value="sold_out" ${p.status === "sold_out" ? "selected" : ""}>Sold out</option><option value="hidden" ${p.status === "hidden" ? "selected" : ""}>Hidden</option></select></label>`}
          ${owner ? `<a class="btn btn-sm btn-ghost" href="#/menu/product/${p.id}">Edit</a>` : ""}</div></div></div>`).join("") : `<p class="muted">No products yet.</p>`}</div>`).join("")}</div>
    <div>${owner ? `<div class="box"><h2>Categories</h2>
        ${categories.map((c) => `<form class="rowedit" data-cat="${c.id}" style="grid-template-columns:1fr 64px;padding-bottom:10px;border-bottom:1px solid var(--line)"><input name="name" value="${esc(c.name)}" aria-label="Category name" style="min-width:0;min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 10px"><input name="sort" type="number" value="${c.sort}" aria-label="Position" title="Position" style="min-width:0;min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 8px"><div style="grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px"><label class="mini-check"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> Show on menu</label><button class="btn btn-sm btn-dark">Save</button><button type="button" class="link-btn" data-del-cat="${c.id}">Delete</button></div></form>`).join("") || `<p class="muted">No categories yet.</p>`}
        <form data-new-cat style="display:flex;gap:8px;margin-top:12px"><input name="name" placeholder="New category, e.g. Pancakes" required style="flex:1;min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 10px"><button class="btn btn-sm btn-primary">Add</button></form>
        <p class="form-error" data-cat-err hidden></p></div>` : ""}</div></div>`;
  v.querySelectorAll("[data-avail]").forEach((sel) => sel.addEventListener("change", async () => {
    try { await api(`/api/admin/products/${sel.dataset.avail}/availability`, { method: "POST", body: { status: sel.value } }); toast("Availability updated"); } catch (e) { toast(e.message); }
  }));
  const catErr = (e) => { const el = v.querySelector("[data-cat-err]"); el.textContent = e.message; el.hidden = false; };
  v.querySelector("[data-new-cat]")?.addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/api/admin/categories", { method: "POST", body: { name: e.target.name.value, sort: categories.length + 1 } }); toast("Category added"); viewMenu(query); } catch (ex) { catErr(ex); } });
  v.querySelectorAll("[data-cat]").forEach((f) => f.addEventListener("submit", async (e) => { e.preventDefault(); try { await api(`/api/admin/categories/${f.dataset.cat}`, { method: "PUT", body: { name: f.name.value, sort: Number(f.sort.value) || 0, active: f.active.checked } }); toast("Category saved"); viewMenu(query); } catch (ex) { catErr(ex); } }));
  v.querySelectorAll("[data-del-cat]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Delete this category?")) return; try { await api(`/api/admin/categories/${b.dataset.delCat}`, { method: "DELETE" }); toast("Category deleted"); viewMenu(query); } catch (ex) { catErr(ex); } }));
}

// resize an image in the browser before upload (max 1600px, WebP or JPEG)
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const type = c.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
  return c.toDataURL(type, 0.85);
}

async function viewProduct(id) {
  if (me.role !== "owner") { location.hash = "#/menu"; return; }
  const v = shell("menu", loading());
  try { menuCache = await api("/api/admin/menu"); } catch (e) { v.innerHTML = errorBox(e); return; }
  const isNew = id === "new";
  const p = isNew ? { name: "", description: "", price_kobo: 0, category_id: menuCache.categories[0]?.id ?? null, status: "available", featured: false, sort: 0, max_per_order: null, image_id: null, image_url: null, variations: [], addon_groups: [] } : menuCache.products.find((x) => x.id === Number(id));
  if (!p) { v.innerHTML = errorBox(new Error("That product doesn't exist.")); return; }
  const input = (attrs) => `style="min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 10px;background:var(--paper);width:100%" ${attrs}`;
  const varRow = (x = {}) => `<div class="rowedit" data-var data-id="${x.id ?? ""}"><input ${input(`data-n value="${esc(x.name || "")}" placeholder="Option name, e.g. Large" aria-label="Option name"`)}><input ${input(`data-p inputmode="decimal" value="${x.price_kobo !== undefined ? toNaira(x.price_kobo) : ""}" placeholder="₦ price" aria-label="Option price"`)}><label class="mini-check"><input type="checkbox" data-a ${x.available === false ? "" : "checked"}> On</label><button type="button" class="link-btn" data-rm>Remove</button></div>`;
  const addonRow = (a = {}) => `<div class="rowedit" data-addon data-id="${a.id ?? ""}"><input ${input(`data-n value="${esc(a.name || "")}" placeholder="Add-on name" aria-label="Add-on name"`)}><input ${input(`data-p inputmode="decimal" value="${a.price_kobo !== undefined ? toNaira(a.price_kobo) : ""}" placeholder="₦ extra" aria-label="Add-on price"`)}><label class="mini-check"><input type="checkbox" data-a ${a.available === false ? "" : "checked"}> On</label><button type="button" class="link-btn" data-rm>Remove</button></div>`;
  const groupBox = (g = { addons: [{}] }) => `<div class="group-box" data-group data-id="${g.id ?? ""}">
      <div class="two"><div class="field"><label>Group name</label><input ${input(`data-gn value="${esc(g.name || "")}" placeholder="e.g. Toppings"`)}></div>
      <div style="display:flex;gap:10px"><div class="field" style="flex:1"><label>Min choices</label><input ${input(`data-min type="number" min="0" value="${g.min_select ?? 0}"`)}></div><div class="field" style="flex:1"><label>Max choices</label><input ${input(`data-max type="number" min="1" value="${g.max_select ?? 1}"`)}></div></div></div>
      <div data-addons>${(g.addons || []).map(addonRow).join("")}</div>
      <button type="button" class="btn btn-sm btn-ghost" data-add-addon>Add an add-on</button> <button type="button" class="link-btn" data-rm-group>Remove group</button></div>`;
  v.innerHTML = `<a class="back" href="#/menu">${I.back} Menu</a>
    <div class="page-head"><div><h1>${isNew ? "New product" : esc(p.name)}</h1><p>Enter the real name, description and price. Customers see exactly this.</p></div></div>
    <form data-pf novalidate><div class="cols"><div>
      <div class="box"><h2>Details</h2>
        <div class="field"><label for="pn">Name</label><input id="pn" ${input(`value="${esc(p.name)}" maxlength="120" required`)}></div>
        <div class="field"><label for="pd">Description</label><textarea id="pd" maxlength="1000" style="min-height:96px;border-radius:10px;border:2px solid var(--line-strong);padding:10px;background:var(--paper);width:100%">${esc(p.description)}</textarea></div>
        <div class="two"><div class="field"><label for="pc">Category</label><select id="pc" ${input("")}><option value="">No category</option>${menuCache.categories.map((c) => `<option value="${c.id}" ${c.id === p.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="pp">Price (₦)</label><input id="pp" inputmode="decimal" ${input(`value="${isNew ? "" : toNaira(p.price_kobo)}" placeholder="e.g. 3500"`)}><span class="hint">If you add size options below, each option's price is used instead.</span></div></div>
        <div class="two"><div class="field"><label for="ps">Availability</label><select id="ps" ${input("")}><option value="available" ${p.status === "available" ? "selected" : ""}>Available</option><option value="sold_out" ${p.status === "sold_out" ? "selected" : ""}>Sold out</option><option value="hidden" ${p.status === "hidden" ? "selected" : ""}>Hidden</option></select></div>
        <div class="field"><label for="pm">Max per order (optional)</label><input id="pm" type="number" min="1" ${input(`value="${p.max_per_order ?? ""}"`)}></div></div>
        <div class="two"><label class="switch"><input type="checkbox" id="pf" ${p.featured ? "checked" : ""}> Feature on the homepage</label><div class="field"><label for="po">Position</label><input id="po" type="number" ${input(`value="${p.sort}"`)}></div></div>
      </div>
      <div class="box"><h2>Options <small class="muted" style="font-family:var(--font-body);font-size:14px">e.g. sizes. The customer must choose one.</small></h2><div data-vars>${p.variations.map(varRow).join("")}</div><button type="button" class="btn btn-sm btn-ghost" data-add-var>Add an option</button></div>
      <div class="box"><h2>Add-ons <small class="muted" style="font-family:var(--font-body);font-size:14px">e.g. toppings or extras, in groups</small></h2><div data-groups>${p.addon_groups.map(groupBox).join("")}</div><button type="button" class="btn btn-sm btn-ghost" data-add-group>Add an add-on group</button></div>
    </div><div>
      <div class="box"><h2>Photo</h2><div class="pm-media" style="margin-bottom:12px"><img data-img src="${esc(p.image_url || "/assets/img/stack-illustration.svg")}" class="${p.image_url ? "" : "illus"}" alt=""></div>
        <label class="btn btn-sm btn-ghost" style="cursor:pointer">Upload photo<input type="file" accept="image/jpeg,image/png,image/webp" data-file hidden></label>
        ${p.image_url ? `<button type="button" class="link-btn" data-noimg>Remove photo</button>` : ""}
        <p class="small muted" style="margin-top:8px">Use a real photo of this item. Large photos are resized automatically.</p><p class="form-error" data-img-err hidden></p></div>
      ${isNew ? "" : `<div class="box"><h2>Remove</h2><div class="actions">${p.archived ? `<button type="button" class="btn btn-sm btn-ghost" data-restore>Restore to menu</button>` : `<button type="button" class="btn btn-sm btn-ghost" data-archive>Archive</button>`}<button type="button" class="btn btn-sm btn-ghost" data-delete>Delete</button></div><p class="small muted" style="margin-top:8px">Products that have been ordered are archived instead of deleted, so old orders keep their details.</p></div>`}
    </div></div>
    <div class="save-bar"><p class="form-error" data-err hidden role="alert" style="margin:0"></p><a class="btn btn-ghost" href="#/menu">Cancel</a><button class="btn btn-primary">${isNew ? "Add to menu" : "Save changes"}</button></div></form>`;
  let imageId = p.image_id;
  const f = v.querySelector("[data-pf]");
  const wireRows = (root) => root.addEventListener("click", (e) => {
    if (e.target.matches("[data-rm]")) e.target.closest(".rowedit").remove();
    if (e.target.matches("[data-rm-group]")) e.target.closest("[data-group]").remove();
    if (e.target.matches("[data-add-addon]")) e.target.closest("[data-group]").querySelector("[data-addons]").insertAdjacentHTML("beforeend", addonRow());
  });
  wireRows(f);
  f.querySelector("[data-add-var]").addEventListener("click", () => f.querySelector("[data-vars]").insertAdjacentHTML("beforeend", varRow()));
  f.querySelector("[data-add-group]").addEventListener("click", () => f.querySelector("[data-groups]").insertAdjacentHTML("beforeend", groupBox()));
  f.querySelector("[data-file]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const err = f.querySelector("[data-img-err]");
    err.hidden = true;
    try {
      const data = await shrinkImage(file);
      const out = await api("/api/admin/media", { method: "POST", body: { data } });
      imageId = out.id;
      const img = f.querySelector("[data-img]");
      img.src = out.url; img.className = "";
      toast("Photo uploaded. Save to keep it.");
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  f.querySelector("[data-noimg]")?.addEventListener("click", () => { imageId = null; const img = f.querySelector("[data-img]"); img.src = "/assets/img/stack-illustration.svg"; img.className = "illus"; });
  const after = async (fn, msg) => { try { await fn(); toast(msg); location.hash = "#/menu"; } catch (e) { toast(e.message); } };
  f.querySelector("[data-archive]")?.addEventListener("click", () => after(() => api(`/api/admin/products/${p.id}/archive`, { method: "POST", body: { archived: true } }), "Archived"));
  f.querySelector("[data-restore]")?.addEventListener("click", () => after(() => api(`/api/admin/products/${p.id}/archive`, { method: "POST", body: { archived: false } }), "Back on the menu"));
  f.querySelector("[data-delete]")?.addEventListener("click", () => { if (confirm(`Delete ${p.name}?`)) after(async () => { const r = await api(`/api/admin/products/${p.id}`, { method: "DELETE" }); if (r.archived) toast("It has been ordered before, so it was archived instead."); }, "Done"); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = f.querySelector("[data-err]");
    err.hidden = true;
    const body = {
      name: f.querySelector("#pn").value, description: f.querySelector("#pd").value, category_id: f.querySelector("#pc").value || null,
      price: f.querySelector("#pp").value || (f.querySelectorAll("[data-var]").length ? "0" : ""), status: f.querySelector("#ps").value, max_per_order: f.querySelector("#pm").value || null,
      featured: f.querySelector("#pf").checked, sort: Number(f.querySelector("#po").value) || 0, image_id: imageId,
      variations: [...f.querySelectorAll("[data-var]")].map((r) => ({ id: r.dataset.id || null, name: r.querySelector("[data-n]").value, price: r.querySelector("[data-p]").value, available: r.querySelector("[data-a]").checked })),
      addon_groups: [...f.querySelectorAll("[data-group]")].map((g) => ({ id: g.dataset.id || null, name: g.querySelector("[data-gn]").value, min_select: Number(g.querySelector("[data-min]").value), max_select: Number(g.querySelector("[data-max]").value),
        addons: [...g.querySelectorAll("[data-addon]")].map((r) => ({ id: r.dataset.id || null, name: r.querySelector("[data-n]").value, price: r.querySelector("[data-p]").value || "0", available: r.querySelector("[data-a]").checked })) })),
    };
    try {
      await api(isNew ? "/api/admin/products" : `/api/admin/products/${p.id}`, { method: isNew ? "POST" : "PUT", body });
      toast(isNew ? "Added to the menu" : "Saved");
      location.hash = "#/menu";
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

// ---------------- settings ----------------
const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const SECTIONS = [["ordering", "Ordering & hours"], ["delivery", "Delivery"], ["closures", "Closed days"], ["notifications", "Notifications"], ["business", "Business & contact"], ["content", "Website text"]];

async function viewSettings(section = "ordering") {
  const v = shell("settings", loading());
  let d;
  try { d = await api("/api/admin/settings"); } catch (e) { v.innerHTML = errorBox(e); return; }
  const s = d.settings;
  const owner = me.role === "owner";
  const fld = (id, label, val, attrs = "", hint = "") => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(val ?? "")}" ${attrs}>${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  const sw = (id, label, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}> ${label}</label>`;
  const forms = {
    ordering: () => { const o = s.ordering; return `
      <div class="box"><h2>Online ordering</h2>${sw("o-enabled", "Take online orders", o.enabled)}
        <p class="small muted" style="margin:6px 0 12px">Customers can only order when this is on, at least one day is open, and pickup or delivery is available.</p>
        <div style="display:flex;gap:18px;flex-wrap:wrap">${sw("o-pickup", "Pickup", o.pickup)}${sw("o-delivery", "Delivery", o.delivery)}</div></div>
      <div class="box"><h2>Opening hours (Lagos time)</h2><p class="small muted">Customers choose a time slot within these hours.</p>
        ${DAYS.map(([k, l]) => `<div class="hours-row"><label class="mini-check"><input type="checkbox" data-day-open="${k}" ${o.hours[k].open ? "checked" : ""}> ${l}</label><div class="times"><input type="time" data-day-from="${k}" value="${o.hours[k].from}" aria-label="${l} opens"> to <input type="time" data-day-to="${k}" value="${o.hours[k].to === "24:00" ? "23:59" : o.hours[k].to}" aria-label="${l} closes"></div></div>`).join("")}</div>
      <div class="box"><h2>Time slots and preparation</h2><div class="two">
        ${fld("o-slot", "Slot length (minutes)", o.slot_minutes, 'type="number" min="10" max="240"', "e.g. 30 gives 9:00, 9:30, 10:00…")}
        ${fld("o-cap", "Orders per slot (maximum)", o.slot_capacity, 'type="number" min="1" max="500"', "How many orders you can fulfil in one slot.")}
        ${fld("o-lead", "Preparation time (minutes)", o.lead_time_minutes, 'type="number" min="0"', "Earliest slot is at least this far from the time of ordering.")}
        ${fld("o-days", "Book up to (days ahead)", o.max_days_ahead, 'type="number" min="0" max="60"')}
        ${fld("o-hold", "Hold a slot while paying (minutes)", o.hold_minutes, 'type="number" min="10" max="180"', "An unpaid order keeps its place this long.")}
        ${fld("o-min", "Minimum order (₦)", toNaira(o.min_order_kobo), 'inputmode="decimal"', "0 for no minimum.")}
      </div>${sw("o-same", "Allow same-day orders", o.same_day)}
        <div class="group-box" style="margin-top:12px">${sw("o-cut", "Use an order cut-off", o.cutoff.enabled)}<div class="two" style="margin-top:8px">
          ${fld("o-cut-time", "Cut-off time", o.cutoff.time, 'type="time"')}
          ${fld("o-cut-days", "Days before", o.cutoff.days_before, 'type="number" min="0" max="7"', "1 = order by the cut-off time the day before. 0 = same day.")}</div></div></div>`; },
    delivery: () => `<div class="box"><h2>Delivery areas and fees</h2><p class="small muted">Customers choose one of these at checkout. Turn on Delivery in Ordering too.</p>
        <div data-zones>${s.delivery.zones.map((z) => zoneRow(z)).join("")}</div><button type="button" class="btn btn-sm btn-ghost" data-add-zone>Add an area</button>
        <div class="field" style="margin-top:14px"><label for="d-note">Delivery note (shown at checkout)</label><input id="d-note" value="${esc(s.delivery.note)}" maxlength="400"></div></div>`,
    closures: () => `<div class="box"><h2>Close a day or a time</h2><p class="small muted">For holidays or when you're fully booked. Leave the time empty to close the whole day.</p>
        <div class="two">${fld("c-date", "Date", "", `type="date" min="${lagosToday()}"`)}${fld("c-time", "Time (optional)", "", 'type="time"')}</div>${fld("c-reason", "Reason (customers see it)", "", 'maxlength="120" placeholder="e.g. Public holiday"')}
        <button type="button" class="btn btn-sm btn-dark" data-add-closure ${owner ? "" : "disabled"}>Close it</button><p class="form-error" data-c-err hidden></p></div>
      <div class="box"><h2>Upcoming closures</h2>${d.closures.length ? `<table class="ntable">${d.closures.map((c) => `<tr><td><b>${fmtDate(c.date)}</b>${c.slot_time ? ` at ${clock12(c.slot_time)}` : " (whole day)"}<br><small class="muted">${esc(c.reason)}</small></td><td style="text-align:right">${owner ? `<button class="link-btn" data-del-closure="${c.id}">Reopen</button>` : ""}</td></tr>`).join("")}</table>` : `<p class="muted">None.</p>`}</div>`,
    notifications: () => { const n = s.notifications; return `
      <div class="box"><h2>Where alerts go</h2>${fld("n-email", "Notification email(s)", n.owner_email, 'type="email" multiple placeholder="you@example.com"', d.env.owner_email_env ? "Leave empty to use the address set by Kal’s Digital in the hosting settings." : "Separate several addresses with commas.")}
        <button type="button" class="btn btn-sm btn-ghost" data-test-email ${owner ? "" : "disabled"}>Send a test email</button> <span class="small muted">${d.env.email ? "" : "Email isn't connected yet (needs a Resend key)."}</span></div>
      <div class="box"><h2>Owner emails</h2><div style="display:grid;gap:4px">${sw("n-new", "New paid order", n.new_order)}${sw("n-cancel", "Order cancelled", n.cancellation)}</div>
        <h3 style="margin:16px 0 8px;font-size:17px">Reminders before each order is due</h3><div class="offsets" data-offsets>${n.reminder_offsets.map(offsetChip).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><input type="number" min="5" max="1440" placeholder="Minutes" data-new-offset style="width:120px;min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 10px"><button type="button" class="btn btn-sm btn-ghost" data-add-offset>Add reminder</button></div></div>
      <div class="box"><h2>Customer emails</h2><div style="display:grid;gap:4px">${sw("n-confirm", "Order confirmation (after payment)", n.customer_confirmation)}
        ${Object.entries({ confirmed: "Order confirmed", preparing: "Being prepared", ready: "Ready / ready for collection", out_for_delivery: "Out for delivery", completed: "Completed", cancelled: "Cancelled" }).map(([k, l]) => sw(`n-s-${k}`, `Status update: ${l}`, n.customer_status[k])).join("")}</div></div>`; },
    business: () => { const b = s.business; return `<div class="box"><h2>Business</h2><div class="two">${fld("b-name", "Business name", b.name, 'maxlength="80"')}${fld("b-tag", "Tagline", b.tagline, 'maxlength="140"')}</div></div>
      <div class="box"><h2>Contact (shown to customers)</h2><div class="two">${fld("b-wa", "WhatsApp number", b.whatsapp, 'type="tel"')}${fld("b-phone", "Phone number", b.phone, 'type="tel"')}${fld("b-email", "Contact email", b.email, 'type="email"')}${fld("b-ig", "Instagram handle", b.instagram, 'placeholder="without @"')}${fld("b-tt", "TikTok handle", b.tiktok, 'placeholder="without @"')}</div></div>
      <div class="box"><h2>Pickup</h2>${fld("b-addr", "Pickup address", b.pickup_address, 'maxlength="400"')}${fld("b-pinst", "Pickup instructions", b.pickup_instructions, 'maxlength="400"')}</div>`; },
    content: () => { const c = s.content; return `<div class="box"><h2>Homepage</h2>${fld("t-hero", "Headline", c.hero_title, 'maxlength="120"', "Two sentences work best: the second one shows in orange.")}${fld("t-heroText", "Intro line", c.hero_text, 'maxlength="300"')}${fld("t-ann", "Announcement bar (optional)", c.announcement, 'maxlength="200"')}</div>
      <div class="box"><h2>About section (optional)</h2>${fld("t-aboutT", "Title", c.about_title, 'maxlength="120"')}<div class="field"><label for="t-about">Text</label><textarea id="t-about" maxlength="1500" style="min-height:120px;border-radius:12px;border:2px solid var(--line-strong);padding:10px;background:var(--paper)">${esc(c.about_text)}</textarea></div></div>
      <div class="box"><h2>Customer reviews</h2><p class="small muted">Only add real reviews you have permission to use. Only ones ticked "Verified" appear on the website.</p><div data-quotes>${c.testimonials.map(quoteRow).join("")}</div><button type="button" class="btn btn-sm btn-ghost" data-add-quote>Add a review</button></div>`; },
  };
  v.innerHTML = `<div class="page-head"><div><h1>Settings</h1><p>${owner ? "Changes apply to the website as soon as you save." : "Only the owner can change settings."}</p></div></div>
    <nav class="tabs-row">${SECTIONS.map(([k, l]) => `<a href="#/settings/${k}" class="${k === section ? "active" : ""}">${l}</a>`).join("")}</nav>
    <form data-sf novalidate>${forms[section]()}${section !== "closures" ? `<div class="save-bar"><span class="saved-note" data-saved></span><p class="form-error" data-err hidden role="alert" style="margin:0"></p><button class="btn btn-primary" ${owner ? "" : "disabled"}>Save</button></div>` : ""}</form>`;
  const f = v.querySelector("[data-sf]");
  const $ = (sel) => f.querySelector(sel);
  const val = (id) => $("#" + id)?.value ?? "";
  const on = (id) => !!$("#" + id)?.checked;
  f.addEventListener("click", (e) => {
    if (e.target.matches("[data-rm]")) e.target.closest(".rowedit").remove();
    if (e.target.matches("[data-rm-offset]")) e.target.closest(".chip").remove();
  });
  $("[data-add-zone]")?.addEventListener("click", () => $("[data-zones]").insertAdjacentHTML("beforeend", zoneRow({ active: true })));
  $("[data-add-quote]")?.addEventListener("click", () => $("[data-quotes]").insertAdjacentHTML("beforeend", quoteRow({})));
  $("[data-add-offset]")?.addEventListener("click", () => { const n = Number($("[data-new-offset]").value); if (n >= 5 && n <= 1440) { $("[data-offsets]").insertAdjacentHTML("beforeend", offsetChip(n)); $("[data-new-offset]").value = ""; } else toast("Use 5 to 1440 minutes."); });
  $("[data-test-email]")?.addEventListener("click", async () => { try { const r = await api("/api/admin/test-email", { method: "POST", body: {} }); toast(`Test email sent to ${r.to.join(", ")}`); } catch (e) { toast(e.message); } });
  $("[data-add-closure]")?.addEventListener("click", async () => {
    const err = $("[data-c-err]"); err.hidden = true;
    try { await api("/api/admin/closures", { method: "POST", body: { date: val("c-date"), slot_time: val("c-time") || null, reason: val("c-reason") } }); toast("Closed"); viewSettings("closures"); } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  f.querySelectorAll("[data-del-closure]").forEach((b) => b.addEventListener("click", async () => { try { await api(`/api/admin/closures/${b.dataset.delClosure}`, { method: "DELETE" }); toast("Reopened"); viewSettings("closures"); } catch (e) { toast(e.message); } }));

  const collect = {
    ordering: () => ({
      enabled: on("o-enabled"), pickup: on("o-pickup"), delivery: on("o-delivery"),
      hours: Object.fromEntries(DAYS.map(([k]) => [k, { open: !!f.querySelector(`[data-day-open=${k}]`).checked, from: f.querySelector(`[data-day-from=${k}]`).value || "09:00", to: (f.querySelector(`[data-day-to=${k}]`).value === "23:59" ? "24:00" : f.querySelector(`[data-day-to=${k}]`).value) || "17:00" }])),
      slot_minutes: Number(val("o-slot")), slot_capacity: Number(val("o-cap")), lead_time_minutes: Number(val("o-lead")), max_days_ahead: Number(val("o-days")), hold_minutes: Number(val("o-hold")),
      min_order: val("o-min") || "0", same_day: on("o-same"), cutoff: { enabled: on("o-cut"), time: val("o-cut-time") || "16:00", days_before: Number(val("o-cut-days")) },
    }),
    delivery: () => ({ zones: [...f.querySelectorAll("[data-zone]")].map((r) => ({ id: r.dataset.id, name: r.querySelector("[data-n]").value, fee: r.querySelector("[data-p]").value, active: r.querySelector("[data-a]").checked })), note: val("d-note") }),
    notifications: () => ({
      owner_email: val("n-email"), new_order: on("n-new"), cancellation: on("n-cancel"), customer_confirmation: on("n-confirm"),
      reminder_offsets: [...f.querySelectorAll("[data-offset]")].map((x) => Number(x.dataset.offset)),
      customer_status: Object.fromEntries(["confirmed", "preparing", "ready", "out_for_delivery", "completed", "cancelled"].map((k) => [k, on(`n-s-${k}`)])),
    }),
    business: () => ({ name: val("b-name"), tagline: val("b-tag"), whatsapp: val("b-wa"), phone: val("b-phone"), email: val("b-email"), instagram: val("b-ig"), tiktok: val("b-tt"), pickup_address: val("b-addr"), pickup_instructions: val("b-pinst") }),
    content: () => ({ hero_title: val("t-hero"), hero_text: val("t-heroText"), announcement: val("t-ann"), about_title: val("t-aboutT"), about_text: $("#t-about").value, testimonials: [...f.querySelectorAll("[data-quote]")].map((r) => ({ quote: r.querySelector("[data-q]").value, name: r.querySelector("[data-n]").value, verified: r.querySelector("[data-v]").checked })) }),
  };
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("[data-err]"); err.hidden = true;
    try {
      await api(`/api/admin/settings/${section}`, { method: "PUT", body: collect[section]() });
      $("[data-saved]").textContent = `Saved ${new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date())}`;
      toast("Settings saved");
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}
const zoneRow = (z) => `<div class="rowedit" data-zone data-id="${esc(z.id || "zone-" + Math.random().toString(36).slice(2, 8))}"><input data-n value="${esc(z.name || "")}" placeholder="Area name" aria-label="Area name" style="min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 10px"><input data-p inputmode="decimal" value="${z.fee_kobo !== undefined ? toNaira(z.fee_kobo) : ""}" placeholder="₦ fee" aria-label="Delivery fee" style="min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 10px"><label class="mini-check"><input type="checkbox" data-a ${z.active === false ? "" : "checked"}> On</label><button type="button" class="link-btn" data-rm>Remove</button></div>`;
const quoteRow = (t) => `<div class="group-box rowedit" data-quote style="grid-template-columns:1fr"><textarea data-q maxlength="400" placeholder="What the customer said" style="min-height:70px;border-radius:10px;border:2px solid var(--line-strong);padding:8px">${esc(t.quote || "")}</textarea><input data-n value="${esc(t.name || "")}" placeholder="Customer name" style="min-height:44px;border-radius:10px;border:2px solid var(--line-strong);padding:6px 10px"><div><label class="mini-check"><input type="checkbox" data-v ${t.verified ? "checked" : ""}> Verified (real, with permission)</label> <button type="button" class="link-btn" data-rm>Remove</button></div></div>`;
const offsetChip = (n) => `<span class="chip" data-offset="${n}">${n >= 60 && n % 60 === 0 ? `${n / 60} hour${n === 60 ? "" : "s"}` : `${n} min`} before<button type="button" data-rm-offset aria-label="Remove">×</button></span>`;

// ---------------- team ----------------
async function viewTeam() {
  if (me.role !== "owner") { location.hash = "#/"; return; }
  const v = shell("team", loading());
  let d;
  try { d = await api("/api/admin/users"); } catch (e) { v.innerHTML = errorBox(e); return; }
  const render = (users, temp) => {
    v.innerHTML = `<div class="page-head"><div><h1>Team</h1><p>Owners can do everything. Staff can manage orders and mark items sold out.</p></div></div>
      ${temp ? `<div class="alert soft" style="margin-bottom:16px"><span>${I.alert}</span><div><b>Temporary password for ${esc(temp.email)}:</b><br><span class="temp-pass">${esc(temp.password)}</span><br><span class="small">Share it privately. It's shown once; they choose their own at first sign-in.</span></div></div>` : ""}
      <div class="cols"><div class="box"><h2>Logins</h2><div class="scroll-x"><table class="ntable"><tr><th>Name</th><th>Role</th><th></th></tr>
        ${users.map((u) => `<tr><td><b>${esc(u.name)}</b><br><small class="muted">${esc(u.email)}${u.active ? "" : " · switched off"}${u.must_change_password ? " · temporary password" : ""}</small></td><td>${u.role === "owner" ? "Owner" : "Staff"}</td>
          <td style="text-align:right;white-space:nowrap">${u.id !== me.id ? `<button class="link-btn" data-reset="${u.id}" data-email="${esc(u.email)}">Reset password</button> <button class="link-btn" data-active="${u.id}" data-on="${u.active ? "0" : "1"}">${u.active ? "Switch off" : "Switch on"}</button>` : `<span class="small muted">You</span>`}</td></tr>`).join("")}</table></div></div>
      <div class="box"><h2>Add a login</h2><form data-add novalidate>
        <div class="field"><label for="u-name">Name</label><input id="u-name" required></div>
        <div class="field"><label for="u-email">Email</label><input id="u-email" type="email" required></div>
        <div class="field"><label for="u-role">Role</label><select id="u-role"><option value="staff">Staff</option><option value="owner">Owner</option></select></div>
        <p class="form-error" data-err hidden></p><button class="btn btn-primary">Create login</button></form></div></div>`;
    v.querySelector("[data-add]").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { const r = await api("/api/admin/users", { method: "POST", body: { name: v.querySelector("#u-name").value, email: v.querySelector("#u-email").value, role: v.querySelector("#u-role").value } }); render(r.users, { email: r.user.email, password: r.temporaryPassword }); }
      catch (ex) { const el = v.querySelector("[data-err]"); el.textContent = ex.message; el.hidden = false; }
    });
    v.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Reset this password? Their current sessions end.")) return; try { const r = await api(`/api/admin/users/${b.dataset.reset}/reset`, { method: "POST", body: {} }); render(r.users, { email: b.dataset.email, password: r.temporaryPassword }); } catch (e) { toast(e.message); } }));
    v.querySelectorAll("[data-active]").forEach((b) => b.addEventListener("click", async () => { try { const r = await api(`/api/admin/users/${b.dataset.active}/active`, { method: "POST", body: { active: b.dataset.on === "1" } }); render(r.users); } catch (e) { toast(e.message); } }));
  };
  render(d.users);
}

// ---------------- emails ----------------
async function viewEmails(query) {
  const status = new URLSearchParams(query).get("status") || "";
  const v = shell("emails", loading());
  let d;
  try { d = await api(`/api/admin/notifications?status=${encodeURIComponent(status)}`); } catch (e) { v.innerHTML = errorBox(e); return; }
  v.innerHTML = `<div class="page-head"><div><h1>Emails</h1><p>Every order email and reminder, newest first.</p></div>${me.role === "owner" ? `<button class="btn btn-sm btn-dark" data-run>Run automation now</button>` : ""}</div>
    <nav class="tabs-row">${[["", "All"], ["failed", "Failed"], ["scheduled", "Scheduled"], ["sent", "Sent"], ["skipped", "Skipped"], ["cancelled", "Cancelled"]].map(([k, l]) => `<a href="#/emails${k ? `?status=${k}` : ""}" class="${k === status ? "active" : ""}">${l}</a>`).join("")}</nav>
    <div class="box">${d.notifications.length ? `<div class="scroll-x"><table class="ntable"><tr><th>Email</th><th>Order</th><th>When</th><th>Status</th></tr>${d.notifications.map((n) => `<tr><td>${esc(KIND[n.kind] || n.kind)}<br><small class="muted">${esc(n.recipient)}</small></td><td>${n.order_id ? `<a href="#/orders/${n.order_id}">${esc(n.order_reference)}</a>` : "—"}</td><td>${stamp(n.sent_at || n.send_at)}</td><td>${esc(n.status)}${n.last_error && n.status !== "sent" ? `<br><small class="muted">${esc(n.last_error)}</small>` : ""}${["failed", "skipped"].includes(n.status) && n.kind !== "owner_reminder" ? `<br><button class="link-btn" data-retry="${n.id}" style="min-height:32px;padding:0">Retry</button>` : ""}</td></tr>`).join("")}</table></div>` : `<div class="empty-box">Nothing here.</div>`}</div>
    <div class="box"><h2>Automation runs</h2>${d.runs.length ? `<table class="ntable">${d.runs.map((r) => `<tr><td>${stamp(r.started_at)}</td><td>${esc(r.job)}</td><td>${r.ok ? "OK" : r.ok === false ? "Errors" : "Running"}</td></tr>`).join("")}</table>` : `<p class="muted">Not run yet.</p>`}</div>`;
  v.querySelector("[data-run]")?.addEventListener("click", async () => { try { await api("/api/admin/run-automation", { method: "POST", body: {} }); toast("Automation ran"); viewEmails(query); } catch (e) { toast(e.message); } });
  v.querySelectorAll("[data-retry]").forEach((b) => b.addEventListener("click", async () => { try { await api(`/api/admin/notifications/${b.dataset.retry}/retry`, { method: "POST", body: {} }); toast("Retried"); viewEmails(query); } catch (e) { toast(e.message); } }));
}

// ---------------- account ----------------
function viewAccount() {
  const v = shell("account", "");
  v.innerHTML = `<div class="page-head"><div><h1>Account</h1><p>${esc(me.name)} · ${esc(me.email)} · ${me.role === "owner" ? "Owner" : "Staff"}</p></div><button class="btn btn-ghost" data-logout2>Sign out</button></div>
    <div class="box" style="max-width:520px"><h2>Change password</h2><form data-pw novalidate>
      <div class="field"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="npw">New password</label><input id="npw" type="password" autocomplete="new-password" minlength="10"><span class="hint">At least 10 characters. Your other devices are signed out.</span></div>
      <p class="form-error" data-err hidden></p><button class="btn btn-primary">Save password</button></form></div>
    <div class="box" style="max-width:520px"><h2>Shortcuts</h2><div class="actions">${me.role === "owner" ? `<a class="btn btn-sm btn-ghost" href="#/team">Team</a>` : ""}<a class="btn btn-sm btn-ghost" href="#/emails">Email log</a><a class="btn btn-sm btn-ghost" href="/" target="_blank">Open the website</a></div></div>`;
  v.querySelector("[data-logout2]").addEventListener("click", logout);
  v.querySelector("[data-pw]").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/api/admin/password", { method: "POST", body: { current: v.querySelector("#cur").value, password: v.querySelector("#npw").value } }); toast("Password changed"); e.target.reset(); }
    catch (ex) { const el = v.querySelector("[data-err]"); el.textContent = ex.message; el.hidden = false; }
  });
}

// ---------------- router ----------------
let refreshTimer = null;
async function route() {
  clearInterval(refreshTimer);
  if (!me) {
    try { me = (await api("/api/admin/me")).user; } catch { return; }
    if (me.must_change_password) return renderMustChange();
  }
  const [path, query = ""] = (location.hash.slice(1) || "/").split("?");
  const parts = path.split("/").filter(Boolean);
  window.scrollTo(0, 0);
  if (!parts.length) { await viewOverview(); refreshTimer = setInterval(() => { if (!document.hidden && location.hash.replace(/^#\/?$/, "") === "") viewOverview(); }, 60_000); return; }
  if (parts[0] === "orders" && parts[1]) return viewOrder(parts[1]);
  if (parts[0] === "orders") { await viewOrders(query); refreshTimer = setInterval(() => { if (!document.hidden && !document.activeElement?.closest("form")) viewOrders(query); }, 60_000); return; }
  if (parts[0] === "menu" && parts[1] === "product") return viewProduct(parts[2]);
  if (parts[0] === "menu") return viewMenu(query);
  if (parts[0] === "settings") return viewSettings(SECTIONS.some(([k]) => k === parts[1]) ? parts[1] : "ordering");
  if (parts[0] === "team") return viewTeam();
  if (parts[0] === "emails") return viewEmails(query);
  if (parts[0] === "account") return viewAccount();
  location.hash = "#/";
}
window.addEventListener("hashchange", route);
route();
