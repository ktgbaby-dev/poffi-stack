// Loading orders with their lines, payments and history. Shared by orders, payments and notifications.

const ORDER_COLS = `o.*, o.scheduled_date::text AS scheduled_date`;

export async function loadOrderRow(q, where, params, { lock = false } = {}) {
  const { rows } = await q(`SELECT ${ORDER_COLS} FROM orders o WHERE ${where} LIMIT 1${lock ? " FOR UPDATE" : ""}`, params);
  return rows[0] ? normalise(rows[0]) : null;
}

export function normalise(o) {
  return { ...o, id: Number(o.id), customer_id: Number(o.customer_id) };
}

export async function loadItems(q, orderId) {
  const { rows: items } = await q(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [orderId]);
  if (!items.length) return [];
  const { rows: cust } = await q(`SELECT * FROM order_item_customisations WHERE order_item_id = ANY($1::bigint[]) ORDER BY id`, [items.map((i) => Number(i.id))]);
  return items.map((i) => ({
    id: Number(i.id),
    product_id: i.product_id === null ? null : Number(i.product_id),
    variation_id: i.variation_id === null ? null : Number(i.variation_id),
    product_name: i.product_name, variation_name: i.variation_name,
    base_price_kobo: i.base_price_kobo, unit_price_kobo: i.unit_price_kobo, quantity: i.quantity, line_total_kobo: i.line_total_kobo,
    customisations: cust.filter((c) => Number(c.order_item_id) === Number(i.id)).map((c) => ({ addon_id: c.addon_id === null ? null : Number(c.addon_id), group_name: c.group_name, option_name: c.option_name, price_kobo: c.price_kobo })),
  }));
}

export async function addHistory(q, orderId, { kind = "status", from = null, to = null, note = "", actor = "system" }) {
  await q(`INSERT INTO order_status_history (order_id, kind, from_value, to_value, note, actor) VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, kind, from, to, note, actor]);
}

// What a customer may see about their own order (no internal notes, no other customers' data).
export function customerView(o, items, settings, payments = []) {
  const lastPayment = payments[payments.length - 1];
  return {
    reference: o.reference,
    customer_name: o.customer_name,
    customer_email: o.customer_email,
    customer_phone: o.customer_phone,
    fulfilment_method: o.fulfilment_method,
    delivery_address: o.delivery_address,
    delivery_zone_name: o.delivery_zone_name,
    scheduled_date: o.scheduled_date,
    scheduled_time: o.scheduled_time,
    slot_minutes: o.slot_minutes,
    notes: o.notes,
    items: items.map(({ id, product_id, variation_id, ...rest }) => rest),
    subtotal_kobo: o.subtotal_kobo,
    delivery_fee_kobo: o.delivery_fee_kobo,
    total_kobo: o.total_kobo,
    payment_status: o.payment_status,
    status: o.status,
    paid_at: o.paid_at,
    cancel_reason: o.status === "cancelled" ? o.cancel_reason : null,
    hold_expires_at: o.hold_expires_at,
    last_payment_status: lastPayment?.status || null,
    pickup: o.fulfilment_method === "pickup" ? { address: settings.business.pickup_address, instructions: settings.business.pickup_instructions } : null,
    contact: { phone: settings.business.phone, whatsapp: settings.business.whatsapp, email: settings.business.email, name: settings.business.name },
  };
}
