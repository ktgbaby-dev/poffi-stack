import { ApiError, api, cart, esc, initChrome, lineSummary, naira, quoteCart } from "./app.js";

const $ = (s) => document.querySelector(s);
const form = $("[data-form]");
const state = $("[data-state]");
const DRAFT = "poffi_checkout_draft";
const KEYS = "poffi_checkout_key";

const cfg = await initChrome();
let quote = null;
let avail = null;
let method = null;
let date = null;
let time = null;

function showState(html) { state.innerHTML = html; state.hidden = false; form.hidden = true; }

const clock12 = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; };
const longDate = (d) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(d + "T12:00:00Z"));

async function load() {
  if (!cfg) return showState(`<p class="form-error" style="padding:30px 0">We couldn't load the shop. Check your connection and refresh.</p>`);
  if (!cart.count()) return showState(`<div class="empty"><img src="/assets/img/stack-illustration.svg" alt=""><p><b>Your order is empty.</b></p><p style="margin-top:16px"><a class="btn btn-primary" href="/menu">See the menu</a></p></div>`);
  if (!cfg.ordering.open) return showState(`<div class="notice" style="max-width:none;margin:30px 0"><div><b>We're not taking online orders right now.</b><span class="muted">Your items are saved on this device. Please check back soon.</span></div></div>`);
  if (!cfg.payments.available) return showState(`<div class="notice" style="max-width:none;margin:30px 0"><div><b>Online payment isn't available right now.</b><span class="muted">Please check back soon.</span></div></div>`);
  try {
    [quote, avail] = await Promise.all([quoteCart(), api("/api/public/availability")]);
  } catch (e) {
    return showState(`<p class="form-error" style="padding:30px 0">${esc(e.message)}</p>`);
  }
  state.hidden = true;
  form.hidden = false;
  renderMethods();
  renderDays();
  restoreDraft();
  renderSummary();
}

// ---------- fulfilment ----------
function renderMethods() {
  const o = cfg.ordering;
  const zones = cfg.delivery.zones;
  const opts = [];
  if (o.pickup) opts.push({ id: "pickup", title: "Pickup", text: cfg.business.pickup_address ? `From ${cfg.business.pickup_address}` : "Collect it from us" });
  if (o.delivery && zones.length) {
    const fees = zones.map((z) => z.fee_kobo);
    opts.push({ id: "delivery", title: "Delivery", text: `${Math.min(...fees) === Math.max(...fees) ? naira(fees[0]) : `${naira(Math.min(...fees))}–${naira(Math.max(...fees))}`} delivery fee` });
  }
  $("[data-methods]").innerHTML = opts.map((m) => `<label class="method-card"><input type="radio" name="method" value="${m.id}"><b>${m.title}</b><span>${esc(m.text)}</span></label>`).join("");
  $("#zone").innerHTML = `<option value="">Choose your area</option>` + zones.map((z) => `<option value="${esc(z.id)}">${esc(z.name)} · ${naira(z.fee_kobo)}</option>`).join("");
  if (cfg.delivery.note) { $("[data-delivery-note]").textContent = cfg.delivery.note; $("[data-delivery-note]").hidden = false; }
  if (opts.length === 1) { method = opts[0].id; $(`input[name=method][value=${method}]`).checked = true; }
  $("[data-methods]").addEventListener("change", (e) => { method = e.target.value; $("[data-method-err]").hidden = true; syncMethod(); renderSummary(); saveDraft(); });
  $("#zone").addEventListener("change", () => { renderSummary(); saveDraft(); });
  syncMethod();
}

function syncMethod() {
  $("[data-delivery-fields]").hidden = method !== "delivery";
  const pi = $("[data-pickup-info]");
  const b = cfg.business;
  pi.hidden = method !== "pickup" || !(b.pickup_address || b.pickup_instructions);
  pi.textContent = [b.pickup_address && `Pickup from ${b.pickup_address}.`, b.pickup_instructions].filter(Boolean).join(" ");
}

// ---------- date and time ----------
function renderDays() {
  const days = avail.days;
  const firstOpen = days.find((d) => d.open);
  if (!firstOpen) {
    $("[data-days]").innerHTML = "";
    $("[data-slots]").innerHTML = `<p class="muted" style="grid-column:1/-1">There are no times available to order right now. Please check back soon.</p>`;
    return;
  }
  $("[data-days]").innerHTML = days.map((d) => {
    const [, , dd] = d.date.split("-");
    const [wd, , mon] = d.label.split(" ");
    const free = d.slots.filter((s) => s.available).length;
    return `<button type="button" class="day" data-date="${d.date}" aria-pressed="false" ${d.open ? "" : "disabled"} aria-label="${esc(longDate(d.date))}${d.open ? "" : `, ${esc(d.reason || "unavailable")}`}"><span>${esc(wd.replace(",", ""))}</span><b>${Number(dd)}</b><small>${d.open ? `${free} time${free === 1 ? "" : "s"}` : esc(d.reason || "Closed")}</small></button>`;
  }).join("");
  $("[data-days]").addEventListener("click", (e) => {
    const b = e.target.closest("[data-date]");
    if (!b || b.disabled) return;
    selectDate(b.dataset.date);
    saveDraft();
  });
  selectDate(date && days.find((d) => d.date === date && d.open) ? date : firstOpen.date, false);
}

function selectDate(d, clearTime = true) {
  date = d;
  if (clearTime) time = null;
  document.querySelectorAll("[data-date]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.date === d)));
  const day = avail.days.find((x) => x.date === d);
  $("[data-slots]").innerHTML = day.slots.map((s) => `<button type="button" class="slot" data-time="${s.time}" aria-pressed="${s.time === time}" ${s.available ? "" : "disabled"} aria-label="${esc(s.label)}${s.available ? "" : `, ${esc(s.reason || "unavailable")}`}">${esc(s.label)}${s.available ? (s.remaining <= 2 ? `<small>${s.remaining} left</small>` : "") : `<small>${esc(s.reason || "")}</small>`}</button>`).join("");
  $("[data-slots]").onclick = (e) => {
    const b = e.target.closest("[data-time]");
    if (!b || b.disabled) return;
    time = b.dataset.time;
    document.querySelectorAll("[data-time]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.time === time)));
    $("[data-slot-err]").hidden = true;
    renderSummary();
    saveDraft();
  };
  renderSummary();
}

// ---------- summary ----------
function fee() {
  if (method !== "delivery") return 0;
  return cfg.delivery.zones.find((z) => z.id === $("#zone").value)?.fee_kobo || 0;
}

function renderSummary() {
  const lines = cart.lines();
  const priced = new Map((quote?.lines || []).map((q) => [q.index, q]));
  const problems = new Map((quote?.problems || []).map((q) => [q.index, q]));
  $("[data-lines]").innerHTML = lines.map((l, i) => `<div class="cart-line" style="padding:10px 0">
      <div><h3 style="font-size:16px">${l.quantity} × ${esc(l.name)}</h3>${lineSummary(l) ? `<div class="meta">${esc(lineSummary(l))}</div>` : ""}</div>
      <div class="line-total">${priced.get(i) ? naira(priced.get(i).line_total_kobo) : "—"}</div>
      ${problems.get(i) ? `<div class="problem">${esc(problems.get(i).message)} <a href="/menu">Update your order</a></div>` : ""}
    </div>`).join("");
  const sub = quote?.subtotal_kobo || 0;
  $("[data-subtotal]").textContent = naira(sub);
  $("[data-fee-row]").hidden = method !== "delivery";
  $("[data-fee]").textContent = $("#zone").value ? naira(fee()) : "Choose an area";
  $("[data-total]").textContent = naira(sub + fee());
  const rows = [
    ["Method", method === "delivery" ? "Delivery" : method === "pickup" ? "Pickup" : "Not chosen yet"],
    ["When", date && time ? `${longDate(date)}, ${clock12(time)}` : "Not chosen yet"],
  ];
  $("[data-review]").innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  const pay = $("[data-pay]");
  pay.textContent = `Pay ${naira(sub + fee())} securely`;
  pay.disabled = (quote?.problems || []).length > 0;
}

// ---------- draft (kept on this device so a refresh doesn't lose typing) ----------
function saveDraft() {
  try { sessionStorage.setItem(DRAFT, JSON.stringify({ name: $("#name").value, phone: $("#phone").value, email: $("#email").value, method, zone: $("#zone").value, address: $("#address").value, notes: $("#notes").value, date, time })); } catch { /* ignore */ }
}
function restoreDraft() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem(DRAFT) || "null"); } catch { /* ignore */ }
  if (!d) return;
  ["name", "phone", "email", "notes"].forEach((k) => { if (d[k]) $("#" + k).value = d[k]; });
  if (d.address) $("#address").value = d.address;
  if (d.method && document.querySelector(`input[name=method][value=${d.method}]`)) { method = d.method; document.querySelector(`input[name=method][value=${d.method}]`).checked = true; syncMethod(); }
  if (d.zone) $("#zone").value = d.zone;
  const day = avail.days.find((x) => x.date === d.date && x.open);
  if (day) { selectDate(d.date); if (day.slots.some((s) => s.time === d.time && s.available)) { time = d.time; document.querySelector(`[data-time="${d.time}"]`)?.setAttribute("aria-pressed", "true"); } }
}
form.addEventListener("input", saveDraft);

// ---------- validation + submit ----------
function fieldError(id, msg) {
  const f = $("#" + id).closest(".field");
  f.classList.toggle("invalid", !!msg);
  const e = f.querySelector(".err");
  e.textContent = msg || "";
  e.hidden = !msg;
}

function validate() {
  let first = null;
  const set = (id, msg) => { fieldError(id, msg); if (msg && !first) first = $("#" + id); };
  set("name", $("#name").value.trim().length < 2 ? "Please enter your full name." : "");
  set("phone", /^\+?\d{7,15}$/.test($("#phone").value.replace(/[\s()-]/g, "")) ? "" : "Please enter a valid phone number.");
  set("email", /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($("#email").value.trim()) ? "" : "Please enter a valid email address.");
  if (!method) { $("[data-method-err]").textContent = "Choose pickup or delivery."; $("[data-method-err]").hidden = false; first ??= $("[data-methods]"); }
  if (method === "delivery") {
    set("zone", $("#zone").value ? "" : "Choose your delivery area.");
    set("address", $("#address").value.trim().length < 8 ? "Please enter your full delivery address." : "");
  }
  if (!date || !time) { $("[data-slot-err]").textContent = "Choose a date and time."; $("[data-slot-err]").hidden = false; first ??= $("[data-days]"); }
  if (!first && !$("[data-confirm]").checked) { $("[data-submit-err]").textContent = "Please tick the box to confirm your order details."; $("[data-submit-err]").hidden = false; first = $("[data-confirm]"); }
  if (first) first.focus({ preventScroll: false });
  return !first;
}

// The same checkout sent twice (double tap, slow network) must give one order: the key only changes
// when what is being ordered changes.
function clientKey(payload) {
  const fp = JSON.stringify(payload);
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(KEYS) || "null"); } catch { /* ignore */ }
  if (saved?.fp === fp) return saved.key;
  const key = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem(KEYS, JSON.stringify({ fp, key })); } catch { /* ignore */ }
  return key;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("[data-submit-err]").hidden = true;
  if (!validate()) return;
  const payload = {
    name: $("#name").value.trim(), phone: $("#phone").value.trim(), email: $("#email").value.trim(),
    fulfilment_method: method, delivery_zone_id: method === "delivery" ? $("#zone").value : null,
    delivery_address: method === "delivery" ? $("#address").value.trim() : null,
    date, time, notes: $("#notes").value.trim(), items: cart.payload(),
  };
  const pay = $("[data-pay]");
  pay.disabled = true;
  pay.textContent = "Opening secure payment…";
  try {
    const out = await api("/api/public/orders", { method: "POST", body: { ...payload, confirmed: true, client_key: clientKey(payload) } });
    try { localStorage.setItem("poffi_last_order", JSON.stringify({ ref: out.order_reference, t: out.access_token })); } catch { /* ignore */ }
    if (out.already_paid) { location.href = `/order?ref=${encodeURIComponent(out.order_reference)}&t=${encodeURIComponent(out.access_token)}`; return; }
    location.href = out.authorization_url;
  } catch (err) {
    renderSummary();
    const d = err instanceof ApiError ? err.data : {};
    if (d.error === "slot_unavailable") {
      avail = await api("/api/public/availability").catch(() => avail);
      renderDays();
      $("[data-slot-err]").textContent = d.message; $("[data-slot-err]").hidden = false;
      $("[data-days]").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (d.error === "cart_changed") { quote = await quoteCart().catch(() => quote); renderSummary(); }
    const fid = { delivery_zone_id: "zone", delivery_address: "address" }[d.field] || d.field;
    if (fid && document.getElementById(fid)?.closest(".field")) fieldError(fid, d.message);
    if (d.order_reference && d.access_token) {
      // The order was saved but the payment page couldn't open: send them to the order page to retry.
      $("[data-submit-err]").innerHTML = `${esc(d.message)} <a href="/order?ref=${encodeURIComponent(d.order_reference)}&t=${encodeURIComponent(d.access_token)}">Go to your order</a>`;
    } else {
      $("[data-submit-err]").textContent = err.message;
    }
    $("[data-submit-err]").hidden = false;
  }
});

load();
