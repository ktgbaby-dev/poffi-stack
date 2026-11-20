// Email content. Plain, mobile-friendly HTML (single column, inline styles) plus a text version.
import { esc } from "./http.js";
import { naira } from "./money.js";
import { clock12, fromMinutes, longDate, toMinutes } from "./time.js";

const ORANGE = "#F34902";
const INK = "#16100D";
const MUTED = "#5A4840";
const CREAM = "#FFECE2";

export const STATUS_LABELS = {
  awaiting_payment: "Awaiting payment", new: "New", confirmed: "Confirmed", preparing: "Preparing",
  ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed", cancelled: "Cancelled",
};
export const PAYMENT_LABELS = { pending: "Pending payment", paid: "Paid", failed: "Payment failed", refund_pending: "Refund in progress", refunded: "Refunded" };

export function whenText(order) {
  const end = fromMinutes(Math.min(toMinutes(order.scheduled_time) + (order.slot_minutes || 0), 1439));
  return `${longDate(order.scheduled_date)}, ${clock12(order.scheduled_time)}${order.slot_minutes ? `–${clock12(end)}` : ""} (Lagos time)`;
}

const methodText = (o) => (o.fulfilment_method === "delivery" ? "Delivery" : "Pickup");

function itemsRows(items) {
  return items.map((it) => {
    const name = `${it.quantity} × ${it.product_name}${it.variation_name ? ` (${it.variation_name})` : ""}`;
    const extras = (it.customisations || []).map((c) => `${c.group_name}: ${c.option_name}${c.price_kobo ? ` (+${naira(c.price_kobo)})` : ""}`);
    return { name, extras, total: naira(it.line_total_kobo) };
  });
}

function itemsHtml(items) {
  return `<table role="presentation" width="100%" style="border-collapse:collapse;margin:8px 0 4px">${itemsRows(items).map((r) => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #f1d9cc;vertical-align:top">
      <div style="font-weight:600;color:${INK}">${esc(r.name)}</div>
      ${r.extras.map((e) => `<div style="font-size:13px;color:${MUTED};margin-top:2px">${esc(e)}</div>`).join("")}
    </td><td style="padding:10px 0;border-bottom:1px solid #f1d9cc;text-align:right;vertical-align:top;white-space:nowrap;color:${INK}">${esc(r.total)}</td></tr>`).join("")}
  </table>`;
}

function itemsText(items) {
  return itemsRows(items).map((r) => [`- ${r.name}: ${r.total}`, ...r.extras.map((e) => `    ${e}`)].join("\n")).join("\n");
}

function totalsRows(o) {
  return [
    ["Subtotal", naira(o.subtotal_kobo)],
    ...(o.fulfilment_method === "delivery" ? [["Delivery", o.delivery_fee_kobo ? naira(o.delivery_fee_kobo) : "Free"]] : []),
    ["Total", naira(o.total_kobo)],
  ];
}

function detailTable(rows) {
  return `<table role="presentation" width="100%" style="border-collapse:collapse;margin:6px 0">${rows.map(([k, v]) => `
    <tr><td style="padding:7px 12px 7px 0;color:${MUTED};vertical-align:top;white-space:nowrap;font-size:14px">${esc(k)}</td>
    <td style="padding:7px 0;color:${INK};font-size:14px">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>`;
}

function layout({ settings, eyebrow, heading, intro, body, button, footer }) {
  const name = settings.business.name || "Poffi Stack";
  const html = `<!doctype html><html><body style="margin:0;background:${CREAM};padding:16px 0">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:${INK}">
    <div style="background:#000000;padding:18px 24px"><span style="display:inline-block;color:${CREAM};font-size:18px;font-weight:700;letter-spacing:.5px">${esc(name)}</span></div>
    <div style="padding:24px">
      ${eyebrow ? `<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${ORANGE};font-weight:700;margin-bottom:6px">${esc(eyebrow)}</div>` : ""}
      <h1 style="font-size:22px;line-height:1.25;margin:0 0 10px">${esc(heading)}</h1>
      ${intro ? `<p style="margin:0 0 16px;color:${MUTED};font-size:15px;line-height:1.5">${esc(intro)}</p>` : ""}
      ${body}
      ${button ? `<p style="margin:22px 0 4px"><a href="${esc(button.href)}" style="background:${ORANGE};color:#ffffff;padding:13px 22px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:700">${esc(button.label)}</a></p>` : ""}
    </div>
    <div style="padding:16px 24px;background:#fff8f4;color:${MUTED};font-size:12px;line-height:1.5">${footer || esc(name)}</div>
  </div></body></html>`;
  return html;
}

function contactLine(settings) {
  const b = settings.business;
  const bits = [b.whatsapp && `WhatsApp ${b.whatsapp}`, b.phone && `Call ${b.phone}`, b.email && b.email].filter(Boolean);
  return bits.length ? `Questions about your order? ${bits.join(" · ")}` : "";
}

const orderLink = (origin, o) => `${origin}/order?ref=${encodeURIComponent(o.reference)}&t=${encodeURIComponent(o.access_token)}`;
const deskLink = (origin, o) => `${origin}/admin#/orders/${o.id}`;

function fulfilmentRows(o, settings) {
  const rows = [["Method", methodText(o)], ["When", whenText(o)]];
  if (o.fulfilment_method === "delivery") {
    rows.push(["Deliver to", `${o.delivery_address}${o.delivery_zone_name ? `\n${o.delivery_zone_name}` : ""}`]);
  } else if (settings.business.pickup_address) {
    rows.push(["Pickup from", settings.business.pickup_address]);
    if (settings.business.pickup_instructions) rows.push(["Pickup notes", settings.business.pickup_instructions]);
  }
  return rows;
}

// ---------- customer ----------
export function customerConfirmation(o, items, settings, origin) {
  const subject = `Order ${o.reference} confirmed · ${settings.business.name}`;
  const rows = [["Order number", o.reference], ["Name", o.customer_name], ["Payment", `Paid ${naira(o.total_kobo)}`], ...fulfilmentRows(o, settings), ...(o.notes ? [["Your notes", o.notes]] : [])];
  const body = `${detailTable(rows)}<h2 style="font-size:16px;margin:18px 0 0">Your order</h2>${itemsHtml(items)}${detailTable(totalsRows(o))}`;
  const contact = contactLine(settings);
  const html = layout({ settings, eyebrow: "Order confirmed", heading: `Thank you, ${o.customer_name.split(" ")[0]}! Your order is in.`, intro: "We've received your payment. Here are your order details.", body, button: { href: orderLink(origin, o), label: "View your order" }, footer: esc(contact || settings.business.name) });
  const text = [`Thank you, ${o.customer_name}! Your order ${o.reference} is confirmed and paid.`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", "Items:", itemsText(items), "", ...totalsRows(o).map(([k, v]) => `${k}: ${v}`), "", `View your order: ${orderLink(origin, o)}`, contact].filter((l) => l !== undefined).join("\n");
  return { subject, html, text };
}

const STATUS_COPY = {
  confirmed: { heading: "Your order is confirmed", intro: "We've confirmed your order and it's in our schedule." },
  preparing: { heading: "We're preparing your order", intro: "Your order is being freshly made right now." },
  ready: { heading: (o) => (o.fulfilment_method === "pickup" ? "Your order is ready for collection" : "Your order is ready"), intro: (o) => (o.fulfilment_method === "pickup" ? "Your order is packed and ready. See you soon!" : "Your order is packed and will be on its way shortly.") },
  out_for_delivery: { heading: "Your order is on its way", intro: "Your order has left us and is on its way to you." },
  completed: { heading: "Thank you for your order", intro: "Your order is complete. We hope you enjoy it!" },
  cancelled: { heading: "Your order has been cancelled", intro: (o) => (o.cancel_reason ? `Reason: ${o.cancel_reason}` : "Your order has been cancelled.") },
};

export function customerStatus(o, items, settings, origin, status) {
  const c = STATUS_COPY[status];
  const pick = (x) => (typeof x === "function" ? x(o) : x);
  const heading = pick(c.heading);
  let intro = pick(c.intro);
  if (status === "cancelled") {
    if (o.payment_status === "refund_pending") intro += " Your refund has been started and will reach you through Paystack.";
    else if (o.payment_status === "refunded") intro += " Your payment has been refunded.";
    else if (o.payment_status === "paid") intro += " We'll be in touch about your payment.";
  }
  const rows = [["Order number", o.reference], ["Status", STATUS_LABELS[status]], ...fulfilmentRows(o, settings)];
  const contact = contactLine(settings);
  const subject = `${heading} · ${o.reference}`;
  const html = layout({ settings, eyebrow: `Order ${o.reference}`, heading, intro, body: detailTable(rows), button: { href: orderLink(origin, o), label: "View your order" }, footer: esc(contact || settings.business.name) });
  const text = [heading, intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `View your order: ${orderLink(origin, o)}`, contact].join("\n");
  return { subject, html, text };
}

// ---------- owner ----------
function ownerRows(o) {
  return [
    ["Order", o.reference],
    ["Customer", o.customer_name],
    ["Phone", o.customer_phone],
    ["Email", o.customer_email],
    ["Total", naira(o.total_kobo)],
    ["Payment", PAYMENT_LABELS[o.payment_status] || o.payment_status],
    ["Method", methodText(o)],
    ...(o.fulfilment_method === "delivery" ? [["Address", `${o.delivery_address}${o.delivery_zone_name ? `\n${o.delivery_zone_name}` : ""}`]] : []),
    ["Date", longDate(o.scheduled_date)],
    ["Time", `${clock12(o.scheduled_time)} (Lagos time)`],
    ["Instructions", o.notes || "None"],
  ];
}

export function ownerNewOrder(o, items, settings, origin) {
  const subject = `NEW PAID ORDER — ${settings.business.name.toUpperCase()} #${o.reference}`;
  const rows = ownerRows(o);
  const body = `${detailTable(rows)}<h2 style="font-size:16px;margin:18px 0 0">Items</h2>${itemsHtml(items)}${detailTable(totalsRows(o))}`;
  const html = layout({ settings, eyebrow: "New paid order", heading: `${o.reference} · ${naira(o.total_kobo)}`, intro: `Payment verified with Paystack. Due ${whenText(o)}.`, body, button: { href: deskLink(origin, o), label: "Open in dashboard" } });
  const text = [`New paid order ${o.reference}`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", "Items:", itemsText(items), "", ...totalsRows(o).map(([k, v]) => `${k}: ${v}`), "", `Dashboard: ${deskLink(origin, o)}`].join("\n");
  return { subject, html, text };
}

// Written when the reminder is scheduled and read later, so it only states things that stay true.
export function ownerReminder(o, items, settings, origin, offsetMinutes) {
  const inText = offsetMinutes >= 60 && offsetMinutes % 60 === 0 ? `${offsetMinutes / 60} hour${offsetMinutes === 60 ? "" : "s"}` : `${offsetMinutes} minutes`;
  const subject = `Reminder: ${o.reference} due at ${clock12(o.scheduled_time)} (in ${inText}) · ${o.customer_name}`;
  const rows = ownerRows(o).filter(([k]) => k !== "Payment");
  const body = `${detailTable(rows)}<h2 style="font-size:16px;margin:18px 0 0">Items</h2>${itemsHtml(items)}`;
  const html = layout({ settings, eyebrow: `Due in ${inText}`, heading: `${o.reference} is due at ${clock12(o.scheduled_time)}`, intro: `${methodText(o)} for ${o.customer_name}. Open the dashboard for the order's latest status.`, body, button: { href: deskLink(origin, o), label: "Open in dashboard" } });
  const text = [`Reminder: ${o.reference} is due at ${clock12(o.scheduled_time)} (in ${inText}).`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", "Items:", itemsText(items), "", `Dashboard: ${deskLink(origin, o)}`].join("\n");
  return { subject, html, text };
}

export function ownerCancellation(o, items, settings, origin) {
  const subject = `Order cancelled — ${settings.business.name} #${o.reference}`;
  const payNote = o.payment_status === "paid" ? "Paid. Refund it from the dashboard if the customer should get their money back."
    : o.payment_status === "refund_pending" ? "Refund in progress through Paystack."
    : o.payment_status === "refunded" ? "Refunded." : PAYMENT_LABELS[o.payment_status] || o.payment_status;
  const rows = [["Order", o.reference], ["Customer", `${o.customer_name} (${o.customer_phone})`], ["Was due", whenText(o)], ["Total", naira(o.total_kobo)], ["Reason", o.cancel_reason || "No reason given"], ["Payment", payNote]];
  const html = layout({ settings, eyebrow: "Order cancelled", heading: `${o.reference} was cancelled`, intro: "", body: detailTable(rows), button: { href: deskLink(origin, o), label: "Open in dashboard" } });
  const text = [`Order ${o.reference} was cancelled.`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `Dashboard: ${deskLink(origin, o)}`].join("\n");
  return { subject, html, text };
}

export function ownerAlert(o, settings, origin, { title, message }) {
  const subject = `Needs attention — ${settings.business.name} #${o.reference}: ${title}`;
  const rows = [["Order", o.reference], ["Customer", `${o.customer_name} (${o.customer_phone})`], ["Total", naira(o.total_kobo)], ["Due", whenText(o)], ["What happened", message]];
  const html = layout({ settings, eyebrow: "Needs attention", heading: title, intro: message, body: detailTable(rows), button: { href: deskLink(origin, o), label: "Open in dashboard" } });
  const text = [title, message, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `Dashboard: ${deskLink(origin, o)}`].join("\n");
  return { subject, html, text };
}

export function testEmail(settings, origin) {
  const subject = `Test email · ${settings.business.name} ordering`;
  const html = layout({ settings, eyebrow: "Test", heading: "Email notifications are working", intro: "This test was sent from your ordering dashboard. New-order alerts and reminders will arrive at this address.", body: "", button: { href: `${origin}/admin`, label: "Open dashboard" } });
  return { subject, html, text: "Email notifications are working. New-order alerts and reminders will arrive at this address." };
}
