// Shared customer-site code: API calls, cart, cart drawer, product options dialog, footer and toasts.
export const ILLUSTRATION = "/assets/img/stack-illustration.svg";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const naira = (kobo) => "₦" + (Math.round(Number(kobo) || 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });

export class ApiError extends Error {
  constructor(status, data) { super(data?.message || "Something went wrong. Please try again."); this.status = status; this.data = data || {}; }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, { message: "We couldn't reach the server. Check your connection and try again." });
  }
  const data = await res.json().catch(() => null);
  // Setup gaps and outages get a customer-friendly message, never a technical one.
  if (res.status === 503 && data?.error === "not_configured") throw new ApiError(503, { ...data, message: "We're getting things ready. Please check back soon." });
  if (res.status >= 500 && !data?.message) throw new ApiError(res.status, { message: "Something went wrong on our side. Please try again in a moment." });
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let configP = null;
export const getConfig = () => (configP ??= api("/api/public/config"));
let menuP = null;
export const getMenu = () => (menuP ??= api("/api/public/menu"));

export function waLink(number, text = "") {
  let d = String(number || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "234" + d.slice(1);
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function productImage(p, cls = "") {
  return p.image_url
    ? `<img class="photo ${cls}" src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" decoding="async">`
    : `<img class="illus ${cls}" src="${ILLUSTRATION}" alt="" loading="lazy"><span class="illus-note">Illustration</span>`;
}

export function fromPrice(p) {
  const avail = (p.variations || []).filter((v) => v.available);
  if (avail.length) {
    const min = Math.min(...avail.map((v) => v.price_kobo));
    return { kobo: min, from: avail.some((v) => v.price_kobo !== min) };
  }
  return { kobo: p.price_kobo, from: false };
}

// ---------------- cart (kept in this browser only) ----------------
const KEY = "poffi_cart_v1";
const listeners = new Set();
function read() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } }
function write(lines) { try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* storage off: cart lives for this page only */ } memory = lines; listeners.forEach((fn) => fn(lines)); }
let memory = read();

export const cart = {
  lines: () => memory.slice(),
  count: () => memory.reduce((n, l) => n + l.quantity, 0),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  lineKey: (l) => `${l.product_id}|${l.variation_id ?? ""}|${[...(l.addon_ids || [])].sort((a, b) => a - b).join(",")}`,
  add(line) {
    const lines = read();
    const k = cart.lineKey(line);
    const same = lines.find((l) => cart.lineKey(l) === k);
    if (same) same.quantity = Math.min(same.quantity + line.quantity, 50);
    else lines.push({ ...line, id: Math.random().toString(36).slice(2, 10) });
    write(lines);
  },
  replace(id, line) {
    const lines = read().map((l) => (l.id === id ? { ...line, id } : l));
    write(lines);
  },
  setQty(id, q) { write(read().map((l) => (l.id === id ? { ...l, quantity: Math.max(1, Math.min(50, q)) } : l))); },
  remove(id) { write(read().filter((l) => l.id !== id)); },
  clear() { write([]); },
  payload: () => memory.map(({ product_id, variation_id, addon_ids, quantity }) => ({ product_id, variation_id: variation_id ?? null, addon_ids: addon_ids || [], quantity })),
};
window.addEventListener("storage", (e) => { if (e.key === KEY) { memory = read(); listeners.forEach((fn) => fn(memory)); } });

export async function quoteCart() {
  if (!memory.length) return { lines: [], subtotal_kobo: 0, problems: [] };
  return api("/api/public/quote", { method: "POST", body: { items: cart.payload() } });
}

// ---------------- toast ----------------
let toastEl, toastTimer;
export function toast(msg) {
  toastEl ??= Object.assign(document.body.appendChild(document.createElement("div")), { className: "toast", role: "status" });
  toastEl.setAttribute("aria-live", "polite");
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// ---------------- sheets (dialogs) ----------------
const ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
let openSheet = null;

function makeSheet(kind, labelId) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const sheet = document.createElement("div");
  sheet.className = `sheet ${kind}`;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", labelId);
  document.body.append(overlay, sheet);
  return { overlay, sheet };
}

function showSheet(s, returnFocus) {
  if (openSheet) closeSheet(openSheet, false);
  openSheet = { ...s, returnFocus };
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => { s.overlay.classList.add("open"); s.sheet.classList.add("open"); });
  s.overlay.onclick = () => closeSheet(openSheet);
  setTimeout(() => s.sheet.querySelector("[data-autofocus], button, input, a")?.focus(), 60);
}

function closeSheet(s, restore = true) {
  if (!s) return;
  s.overlay.classList.remove("open");
  s.sheet.classList.remove("open");
  const { overlay, sheet, returnFocus } = s;
  setTimeout(() => { overlay.remove(); sheet.remove(); }, 320);
  if (openSheet && openSheet.sheet === sheet) openSheet = null;
  document.body.style.overflow = "";
  if (restore) returnFocus?.focus?.();
}

document.addEventListener("keydown", (e) => {
  if (!openSheet) return;
  if (e.key === "Escape") closeSheet(openSheet);
  if (e.key === "Tab") {
    const f = [...openSheet.sheet.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href], select, textarea")].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});

// ---------------- product options dialog ----------------
export function needsOptions(p) { return (p.variations?.length || 0) > 0 || (p.addon_groups?.length || 0) > 0; }

export function openProduct(p, { editLine = null, trigger = null } = {}) {
  const s = makeSheet("modal", "pm-title");
  const soldOut = p.status === "sold_out";
  const chosenVar = editLine?.variation_id ?? (p.variations?.find((v) => v.available)?.id ?? null);
  const chosenAdd = new Set(editLine?.addon_ids || []);
  let qty = editLine?.quantity || 1;
  const maxQty = p.max_per_order || 50;
  s.sheet.innerHTML = `
    <div class="sheet-head"><h2 id="pm-title">${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Close">${ICON_X}</button></div>
    <form class="sheet-body" novalidate>
      <div class="pm-media">${productImage(p)}</div>
      ${p.description ? `<p class="pm-desc">${esc(p.description)}</p>` : ""}
      ${p.variations?.length ? `<fieldset class="opt-group"><legend>Choose an option <small class="req">Required</small></legend>
        ${p.variations.map((v) => `<label class="opt"><input type="radio" name="variation" value="${v.id}" ${v.id === chosenVar ? "checked" : ""} ${v.available ? "" : "disabled"}><span class="opt-name">${esc(v.name)}${v.available ? "" : " (unavailable)"}</span><span class="opt-price">${naira(v.price_kobo)}</span></label>`).join("")}
      </fieldset>` : ""}
      ${(p.addon_groups || []).map((g) => {
        const single = g.max_select === 1;
        const rule = g.min_select > 0 ? (g.min_select === g.max_select ? `Choose ${g.min_select}` : `Choose ${g.min_select}–${g.max_select}`) : single ? "Optional" : `Up to ${g.max_select}`;
        return `<fieldset class="opt-group" data-group="${g.id}" data-min="${g.min_select}" data-max="${g.max_select}"><legend>${esc(g.name)} <small class="${g.min_select ? "req" : ""}">${rule}</small></legend>
          ${g.addons.map((a) => `<label class="opt"><input type="${single && g.min_select === 1 ? "radio" : "checkbox"}" name="g${g.id}" value="${a.id}" ${chosenAdd.has(a.id) ? "checked" : ""} ${a.available ? "" : "disabled"}><span class="opt-name">${esc(a.name)}${a.available ? "" : " (unavailable)"}</span><span class="opt-price">${a.price_kobo ? "+" + naira(a.price_kobo) : ""}</span></label>`).join("")}
        </fieldset>`;
      }).join("")}
      <p class="form-error" role="alert" hidden></p>
    </form>
    <div class="sheet-foot"><div class="pm-foot">
      <div class="qty" aria-label="Quantity"><button type="button" data-q="-1" aria-label="Fewer">−</button><output aria-live="polite">${qty}</output><button type="button" data-q="1" aria-label="More">+</button></div>
      <button class="btn btn-primary" data-add ${soldOut ? "disabled" : ""}>${soldOut ? "Sold out" : editLine ? "Update" : "Add"} <span data-total></span></button>
    </div></div>`;
  const form = s.sheet.querySelector("form");
  const err = s.sheet.querySelector(".form-error");
  const out = s.sheet.querySelector("output");
  const totalEl = s.sheet.querySelector("[data-total]");

  function selection() {
    const v = form.querySelector("input[name=variation]:checked");
    const addons = [...form.querySelectorAll("fieldset[data-group] input:checked")].map((i) => Number(i.value));
    return { variation_id: v ? Number(v.value) : null, addon_ids: addons };
  }
  function unitPrice() {
    const { variation_id, addon_ids } = selection();
    const base = variation_id ? p.variations.find((v) => v.id === variation_id)?.price_kobo ?? p.price_kobo : p.price_kobo;
    const extras = (p.addon_groups || []).flatMap((g) => g.addons).filter((a) => addon_ids.includes(a.id)).reduce((s2, a) => s2 + a.price_kobo, 0);
    return base + extras;
  }
  function refresh() {
    out.textContent = qty;
    s.sheet.querySelector("[data-q='-1']").disabled = qty <= 1;
    s.sheet.querySelector("[data-q='1']").disabled = qty >= maxQty;
    if (!soldOut) totalEl.textContent = `· ${naira(unitPrice() * qty)}`;
    // enforce max per group: disable unchecked boxes once the limit is reached
    form.querySelectorAll("fieldset[data-group]").forEach((fs) => {
      const max = Number(fs.dataset.max);
      const boxes = [...fs.querySelectorAll("input[type=checkbox]")];
      const n = boxes.filter((b) => b.checked).length;
      boxes.forEach((b) => { if (!b.checked) b.disabled = n >= max || b.closest(".opt").textContent.includes("(unavailable)"); });
    });
  }
  function validate() {
    if (p.variations?.length && !selection().variation_id) return "Choose an option first.";
    for (const fs of form.querySelectorAll("fieldset[data-group]")) {
      const n = fs.querySelectorAll("input:checked").length;
      const name = fs.querySelector("legend").firstChild.textContent.trim().toLowerCase();
      if (n < Number(fs.dataset.min)) return `Choose ${fs.dataset.min === "1" ? "" : `at least ${fs.dataset.min} `}${name}.`;
    }
    return "";
  }
  form.addEventListener("change", () => { err.hidden = true; refresh(); });
  s.sheet.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => { qty = Math.max(1, Math.min(maxQty, qty + Number(b.dataset.q))); refresh(); }));
  s.sheet.querySelector("[data-close]").addEventListener("click", () => closeSheet(openSheet));
  s.sheet.querySelector("[data-add]").addEventListener("click", () => {
    const problem = validate();
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const { variation_id, addon_ids } = selection();
    const v = p.variations?.find((x) => x.id === variation_id);
    const addons = (p.addon_groups || []).flatMap((g) => g.addons.map((a) => ({ ...a, group: g.name }))).filter((a) => addon_ids.includes(a.id));
    const line = { product_id: p.id, variation_id, addon_ids, quantity: qty, name: p.name, variation_name: v?.name || null, addons: addons.map((a) => ({ id: a.id, name: a.name, group: a.group })), unit_kobo: unitPrice() };
    if (editLine) cart.replace(editLine.id, line); else cart.add(line);
    closeSheet(openSheet);
    if (editLine) openCart(); else { toast(`Added ${qty} × ${p.name}`); bumpCart(); }
  });
  refresh();
  showSheet(s, trigger);
}

export function quickAdd(p) {
  cart.add({ product_id: p.id, variation_id: null, addon_ids: [], quantity: 1, name: p.name, variation_name: null, addons: [], unit_kobo: p.price_kobo });
  toast(`Added ${p.name}`);
  bumpCart();
}

function bumpCart() {
  document.querySelectorAll(".cart-btn").forEach((b) => { b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); });
}

// ---------------- cart drawer ----------------
export function lineSummary(l) {
  return [l.variation_name, ...(l.addons || []).map((a) => a.name)].filter(Boolean).join(" · ");
}

export async function openCart(trigger) {
  const s = makeSheet("drawer", "cart-title");
  s.sheet.innerHTML = `<div class="sheet-head"><h2 id="cart-title">Your order</h2><button class="icon-btn" data-close aria-label="Close">${ICON_X}</button></div>
    <div class="sheet-body" data-body><div class="spinner" aria-label="Loading"></div></div><div class="sheet-foot" data-foot hidden></div>`;
  s.sheet.querySelector("[data-close]").addEventListener("click", () => closeSheet(openSheet));
  showSheet(s, trigger || document.querySelector(".cart-btn"));
  const render = async () => {
    const body = s.sheet.querySelector("[data-body]");
    const foot = s.sheet.querySelector("[data-foot]");
    const lines = cart.lines();
    if (!lines.length) {
      body.innerHTML = `<div class="empty"><img src="${ILLUSTRATION}" alt=""><p><b>Your order is empty.</b></p><p class="muted">Pick something tasty from the menu.</p><p style="margin-top:16px"><a class="btn btn-primary" href="/menu">See the menu</a></p></div>`;
      foot.hidden = true;
      return;
    }
    let quote = null;
    try { quote = await quoteCart(); } catch (e) { body.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; return; }
    const priced = new Map(quote.lines.map((q) => [q.index, q]));
    const problems = new Map(quote.problems.map((q) => [q.index, q]));
    body.innerHTML = lines.map((l, i) => {
      const q = priced.get(i);
      const pr = problems.get(i);
      return `<div class="cart-line" data-id="${l.id}">
        <div><h3>${esc(l.name)}</h3>${lineSummary(l) ? `<div class="meta">${esc(lineSummary(l))}</div>` : ""}</div>
        <div class="line-total">${q ? naira(q.line_total_kobo) : "—"}</div>
        ${pr ? `<div class="problem" role="alert">${esc(pr.message)}</div>` : ""}
        <div class="line-actions">
          <div class="qty small"><button data-act="dec" aria-label="Fewer" ${l.quantity <= 1 ? "disabled" : ""}>−</button><output>${l.quantity}</output><button data-act="inc" aria-label="More">+</button></div>
          ${l.variation_id || l.addons?.length ? `<button class="link-btn" data-act="edit">Edit</button>` : ""}
          <button class="link-btn" data-act="remove">Remove</button>
        </div></div>`;
    }).join("");
    foot.hidden = false;
    const blocked = quote.problems.length > 0;
    foot.innerHTML = `<div class="sum-row"><span>Subtotal</span><b>${naira(quote.subtotal_kobo)}</b></div>
      <p class="small muted" style="margin:4px 0 12px">Delivery fee (if any) and time are chosen at checkout.</p>
      ${blocked ? `<p class="form-error">Fix the items marked above to continue.</p>` : ""}
      <a class="btn btn-primary btn-block" href="/checkout" ${blocked ? 'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.5"' : ""}>Checkout</a>
      <button class="link-btn" data-close2 style="display:block;margin:6px auto 0">Keep shopping</button>`;
    foot.querySelector("[data-close2]").addEventListener("click", () => closeSheet(openSheet));
    body.querySelectorAll(".cart-line").forEach((row) => {
      const id = row.dataset.id;
      row.addEventListener("click", async (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (!act) return;
        const line = cart.lines().find((l) => l.id === id);
        if (act === "inc") cart.setQty(id, line.quantity + 1);
        if (act === "dec") cart.setQty(id, line.quantity - 1);
        if (act === "remove") cart.remove(id);
        if (act === "edit") {
          const menu = await getMenu();
          const p = menu.products.find((x) => x.id === line.product_id);
          if (p) { closeSheet(openSheet, false); openProduct(p, { editLine: line }); } else toast("This item is no longer on the menu.");
          return;
        }
        render();
      });
    });
  };
  render();
}

// ---------------- page chrome ----------------
const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;

export async function initChrome() {
  const header = document.querySelector(".site-header");
  if (header) {
    const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 4);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
  const countEls = document.querySelectorAll("[data-cart-count]");
  const setCount = () => countEls.forEach((el) => { el.textContent = cart.count(); });
  setCount();
  cart.subscribe(setCount);
  document.querySelectorAll("[data-open-cart]").forEach((b) => b.addEventListener("click", () => openCart(b)));
  document.querySelectorAll("[data-year]").forEach((el) => { el.textContent = new Date().getFullYear(); });
  try {
    const cfg = await getConfig();
    const b = cfg.business;
    const ann = document.querySelector("[data-announcement]");
    if (ann && cfg.content.announcement) { ann.textContent = cfg.content.announcement; ann.hidden = false; }
    const contact = document.querySelector("[data-footer-contact]");
    if (contact) {
      const items = [
        b.whatsapp && `<li><a href="${esc(waLink(b.whatsapp))}" rel="noopener" target="_blank">WhatsApp ${esc(b.whatsapp)}</a></li>`,
        b.phone && `<li><a href="tel:${esc(b.phone)}">Call ${esc(b.phone)}</a></li>`,
        b.email && `<li><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></li>`,
        b.pickup_address && `<li class="muted" style="color:#d8c6bd;padding:6px 0">${esc(b.pickup_address)}</li>`,
      ].filter(Boolean);
      contact.innerHTML = items.join("") || `<li style="color:#d8c6bd">Order online any time the menu is open.</li>`;
    }
    const social = document.querySelector("[data-footer-social]");
    if (social) {
      const items = [b.instagram && `<li><a href="https://instagram.com/${esc(b.instagram)}" rel="noopener" target="_blank">Instagram @${esc(b.instagram)}</a></li>`, b.tiktok && `<li><a href="https://www.tiktok.com/@${esc(b.tiktok)}" rel="noopener" target="_blank">TikTok @${esc(b.tiktok)}</a></li>`].filter(Boolean);
      social.closest("[data-social-col]").hidden = !items.length;
      social.innerHTML = items.join("");
    }
    document.querySelectorAll("[data-tagline]").forEach((el) => { el.textContent = b.tagline || ""; });
    return cfg;
  } catch {
    return null;
  }
}

export { ICON_PIN };
