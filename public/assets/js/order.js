import { api, cart, esc, initChrome, naira, waLink } from "./app.js";

const $ = (s) => document.querySelector(s);
await initChrome();
const params = new URLSearchParams(location.search);
const ref = params.get("ref");
const token = params.get("t");
const payRef = params.get("reference") || params.get("trxref");

const ICON_OK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 7v6M12 17v.01"/><circle cx="12" cy="12" r="9.5"/></svg>`;
const clock12 = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; };
const longDate = (d) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(d + "T12:00:00Z"));
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hero({ icon = ICON_OK, warn = false, title, text }) {
  $("[data-hero]").innerHTML = `<div class="seal ${warn ? "warn" : ""}">${icon}</div><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ""}${ref ? `<span class="ref-pill">Order ${esc(ref)}</span>` : ""}`;
}

async function verifyIfReturning() {
  if (!payRef) return null;
  $("[data-hero]").innerHTML = `<div class="spinner" aria-label="Confirming"></div><h1>Confirming your payment…</h1><p>This only takes a moment. Please don't close this page.</p>`;
  for (let i = 0; i < 12; i++) {
    try {
      const v = await api(`/api/public/orders/${encodeURIComponent(ref)}/verify`, { method: "POST", body: { t: token, payment_reference: payRef } });
      if (v.status !== "pending") return v.status;
    } catch (e) {
      if (e.status === 404) return "not_found";
    }
    await sleep(i < 4 ? 2000 : 4000);
  }
  return "pending";
}

function contactButtons(o) {
  const c = o.contact || {};
  const text = `Hi ${c.name || "Poffi Stack"}, it's ${o.customer_name} about order ${o.reference}.`;
  return [
    c.whatsapp && `<a class="btn btn-primary" href="${esc(waLink(c.whatsapp, text))}" target="_blank" rel="noopener">WhatsApp us about this order</a>`,
    c.phone && `<a class="btn btn-dark" href="tel:${esc(c.phone)}">Call ${esc(c.phone)}</a>`,
    c.email && `<a class="btn btn-ghost" href="mailto:${esc(c.email)}?subject=${encodeURIComponent(`Order ${o.reference}`)}">Email us</a>`,
  ].filter(Boolean).join("");
}

function timeline(o) {
  const steps = [["new", "Order received"], ["confirmed", "Confirmed"], ["preparing", "Being freshly made"], ["ready", o.fulfilment_method === "pickup" ? "Ready for collection" : "Ready"], ...(o.fulfilment_method === "delivery" ? [["out_for_delivery", "Out for delivery"]] : []), ["completed", "Completed"]];
  const at = steps.findIndex(([k]) => k === o.status);
  return `<ol class="timeline">${steps.map(([k, label], i) => `<li class="${i <= at ? "done" : ""} ${i === at ? "current" : ""}"><span class="dot">${i <= at ? "✓" : ""}</span><b>${label}</b></li>`).join("")}</ol>`;
}

function render(o, payState) {
  const when = `${longDate(o.scheduled_date)}, ${clock12(o.scheduled_time)}–${clock12(fromMin(Math.min(toMin(o.scheduled_time) + (o.slot_minutes || 0), 1439)))}`;
  const paid = o.payment_status === "paid" || o.payment_status === "refund_pending" || o.payment_status === "refunded";
  if (o.status === "cancelled") hero({ icon: ICON_WARN, warn: true, title: "This order was cancelled", text: [o.cancel_reason, o.payment_status === "refunded" ? "Your payment has been refunded." : o.payment_status === "refund_pending" ? "Your refund is on its way through Paystack." : ""].filter(Boolean).join(" ") });
  else if (paid) hero({ title: `Thank you, ${o.customer_name.split(" ")[0]}!`, text: `Your payment is confirmed and your order is ${o.status === "new" ? "in" : o.status.replace(/_/g, " ")}. A confirmation has been sent to ${o.customer_email}.` });
  else if (payState === "mismatch") hero({ icon: ICON_WARN, warn: true, title: "We need to check your payment", text: "Something didn't match when we confirmed your payment. We'll be in touch; you can also contact us below." });
  else if (payState === "pending") hero({ icon: ICON_WARN, warn: true, title: "Your payment is still processing", text: "This can take a few minutes with bank transfers. This page will update; you'll also get an email once it's confirmed." });
  else hero({ icon: ICON_WARN, warn: true, title: "Payment not completed", text: "Your order is saved but hasn't been paid yet. You can try paying again below." });

  const canRetry = !paid && o.status !== "cancelled" && payState !== "mismatch" && payState !== "pending";
  const items = o.items.map((it) => `<div class="cart-line" style="padding:10px 0"><div><h3 style="font-size:16px">${it.quantity} × ${esc(it.product_name)}${it.variation_name ? ` (${esc(it.variation_name)})` : ""}</h3>${it.customisations.length ? `<div class="meta">${it.customisations.map((c) => esc(`${c.group_name}: ${c.option_name}`)).join(" · ")}</div>` : ""}</div><div class="line-total">${naira(it.line_total_kobo)}</div></div>`).join("");
  const where = o.fulfilment_method === "delivery"
    ? `<div><dt>Deliver to</dt><dd>${esc(o.delivery_address)}${o.delivery_zone_name ? `<br><span class="muted">${esc(o.delivery_zone_name)}</span>` : ""}</dd></div>`
    : o.pickup?.address ? `<div><dt>Pickup from</dt><dd>${esc(o.pickup.address)}${o.pickup.instructions ? `<br><span class="muted">${esc(o.pickup.instructions)}</span>` : ""}</dd></div>` : "";
  $("[data-body]").innerHTML = `
    <div>
      ${canRetry ? `<section class="panel"><h2>Finish paying</h2><p class="muted">Total ${naira(o.total_kobo)}. You'll go back to Paystack's secure page.</p><p class="form-error" data-retry-err hidden></p><button class="btn btn-primary" data-retry style="margin-top:14px">Try paying again</button></section>` : ""}
      ${paid && o.status !== "cancelled" ? `<section class="panel"><h2>Order progress</h2>${timeline(o)}</section>` : ""}
      <section class="panel"><h2>Details</h2><dl class="review-list">
        <div><dt>Name</dt><dd>${esc(o.customer_name)}</dd></div>
        <div><dt>Method</dt><dd>${o.fulfilment_method === "delivery" ? "Delivery" : "Pickup"}</dd></div>
        <div><dt>When</dt><dd>${esc(when)} <span class="muted">(Lagos time)</span></dd></div>
        ${where}
        ${o.notes ? `<div><dt>Your notes</dt><dd>${esc(o.notes)}</dd></div>` : ""}
      </dl></section>
      ${contactButtons(o) ? `<section class="panel"><h2>Questions about your order?</h2><div class="contact-list" style="margin-top:0">${contactButtons(o)}</div></section>` : ""}
    </div>
    <aside class="summary-col"><section class="panel"><h2>Your order</h2>${items}
      <div style="margin-top:12px"><div class="sum-row"><span>Subtotal</span><b>${naira(o.subtotal_kobo)}</b></div>
      ${o.fulfilment_method === "delivery" ? `<div class="sum-row"><span>Delivery</span><b>${o.delivery_fee_kobo ? naira(o.delivery_fee_kobo) : "Free"}</b></div>` : ""}
      <div class="sum-row total"><span>${paid ? "Paid" : "Total"}</span><span>${naira(o.total_kobo)}</span></div></div>
      ${paid ? `<p class="secure" style="justify-content:flex-start"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Payment confirmed by Paystack</p>` : ""}
      <p style="margin-top:16px"><a class="btn btn-ghost btn-block" href="/menu">Back to the menu</a></p>
    </section></aside>`;
  $("[data-body]").hidden = false;
  $("[data-retry]")?.addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Opening secure payment…";
    try {
      const out = await api(`/api/public/orders/${encodeURIComponent(ref)}/pay`, { method: "POST", body: { t: token } });
      location.href = out.authorization_url;
    } catch (err) {
      const el = $("[data-retry-err]"); el.textContent = err.message; el.hidden = false;
      e.target.disabled = false; e.target.textContent = "Try paying again";
    }
  });
}

if (!ref || !token) {
  hero({ icon: ICON_WARN, warn: true, title: "We couldn't find that order", text: "Open the link in your confirmation email, or contact us with your order number." });
} else {
  const payState = await verifyIfReturning();
  if (payRef) history.replaceState(null, "", `/order?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`);
  try {
    const o = await api(`/api/public/orders/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`);
    if (o.payment_status === "paid") cart.clear(); // the order is safely paid: empty the cart
    render(o, payState);
    // a bank transfer can take a while: keep checking quietly, then show the confirmation
    if (payState === "pending" && o.payment_status !== "paid") {
      let tries = 0;
      const timer = setInterval(async () => {
        if (++tries > 18) return clearInterval(timer);
        try {
          const v = await api(`/api/public/orders/${encodeURIComponent(ref)}/verify`, { method: "POST", body: { t: token } });
          if (v.status !== "pending") { clearInterval(timer); location.reload(); }
        } catch { /* try again */ }
      }, 10_000);
    }
    // keep the progress live while the order is moving
    if (o.payment_status === "paid" && !["completed", "cancelled"].includes(o.status)) {
      setInterval(async () => {
        try { const n = await api(`/api/public/orders/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`); if (n.status !== o.status) { o.status = n.status; render(n, payState); } } catch { /* offline: try again later */ }
      }, 45_000);
    }
  } catch (e) {
    hero({ icon: ICON_WARN, warn: true, title: "We couldn't find that order", text: e.message });
  }
}
