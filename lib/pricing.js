// Trusted pricing. The browser only says WHAT the customer wants; every price comes from the database here.
import { HttpError, bad, int } from "./http.js";

export const MAX_LINES = 40;
export const DEFAULT_MAX_QTY = 50;

export async function priceCart(q, items, { strict = true } = {}) {
  if (!Array.isArray(items) || !items.length) throw bad("empty_cart", "Your cart is empty.");
  if (items.length > MAX_LINES) throw bad("cart_too_large", "That's a lot of items. Please split it into two orders.");

  const wanted = items.map((it) => ({
    product_id: int(it?.product_id),
    variation_id: it?.variation_id === null || it?.variation_id === undefined || it?.variation_id === "" ? null : int(it.variation_id),
    addon_ids: Array.isArray(it?.addon_ids) ? it.addon_ids.map(int) : [],
    quantity: int(it?.quantity),
  }));
  const ids = [...new Set(wanted.map((w) => w.product_id).filter(Number.isInteger))];
  const { rows: products } = ids.length ? await q(
    `SELECT p.id, p.name, p.price_kobo, p.status, p.archived, p.max_per_order, c.active AS category_active
     FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ANY($1::bigint[])`, [ids]) : { rows: [] };
  const { rows: variations } = ids.length ? await q(`SELECT id, product_id, name, price_kobo, available FROM product_variations WHERE product_id = ANY($1::bigint[]) AND NOT archived`, [ids]) : { rows: [] };
  const { rows: groups } = ids.length ? await q(`SELECT id, product_id, name, min_select, max_select FROM addon_groups WHERE product_id = ANY($1::bigint[]) AND NOT archived`, [ids]) : { rows: [] };
  const gids = groups.map((g) => Number(g.id));
  const { rows: addons } = gids.length ? await q(`SELECT id, group_id, name, price_kobo, available FROM addons WHERE group_id = ANY($1::bigint[]) AND NOT archived`, [gids]) : { rows: [] };

  const byId = new Map(products.map((p) => [Number(p.id), p]));
  const lines = [];
  const problems = [];
  let subtotal = 0;

  wanted.forEach((w, index) => {
    const fail = (code, message) => problems.push({ index, code, message });
    const p = byId.get(w.product_id);
    if (!p || p.archived || p.status === "hidden" || p.category_active === false) return fail("unavailable", "This item is no longer on the menu.");
    if (p.status === "sold_out") return fail("sold_out", `${p.name} is sold out right now.`);
    const maxQty = p.max_per_order || DEFAULT_MAX_QTY;
    if (!Number.isInteger(w.quantity) || w.quantity < 1) return fail("bad_quantity", "Choose a quantity of at least 1.");
    if (w.quantity > maxQty) return fail("too_many", `You can order up to ${maxQty} of ${p.name} at a time.`);

    const pv = variations.filter((v) => Number(v.product_id) === Number(p.id));
    let variation = null;
    if (pv.length) {
      variation = pv.find((v) => Number(v.id) === w.variation_id);
      if (!variation) return fail("choose_variation", `Choose an option for ${p.name}.`);
      if (!variation.available) return fail("variation_unavailable", `${p.name} (${variation.name}) is not available right now.`);
    } else if (w.variation_id !== null) {
      return fail("options_changed", `The options for ${p.name} have changed. Please add it again.`);
    }

    const pg = groups.filter((g) => Number(g.product_id) === Number(p.id));
    const chosen = [];
    if (new Set(w.addon_ids).size !== w.addon_ids.length) return fail("options_changed", `Please choose the extras for ${p.name} again.`);
    for (const aid of w.addon_ids) {
      const a = addons.find((x) => Number(x.id) === aid);
      const g = a && pg.find((x) => Number(x.id) === Number(a.group_id));
      if (!a || !g) return fail("options_changed", `The extras for ${p.name} have changed. Please add it again.`);
      if (!a.available) return fail("addon_unavailable", `${a.name} is not available right now.`);
      chosen.push({ addon_id: Number(a.id), group_id: Number(g.id), group_name: g.name, option_name: a.name, price_kobo: a.price_kobo });
    }
    for (const g of pg) {
      const n = chosen.filter((c) => c.group_id === Number(g.id)).length;
      if (n < g.min_select) return fail("choose_addons", g.min_select === 1 ? `Choose ${g.name.toLowerCase()} for ${p.name}.` : `Choose at least ${g.min_select} ${g.name.toLowerCase()} for ${p.name}.`);
      if (n > g.max_select) return fail("too_many_addons", `Choose up to ${g.max_select} ${g.name.toLowerCase()} for ${p.name}.`);
    }

    const base = variation ? variation.price_kobo : p.price_kobo;
    const unit = base + chosen.reduce((s, c) => s + c.price_kobo, 0);
    const total = unit * w.quantity;
    subtotal += total;
    lines.push({
      index,
      product_id: Number(p.id), variation_id: variation ? Number(variation.id) : null,
      product_name: p.name, variation_name: variation ? variation.name : null,
      base_price_kobo: base, unit_price_kobo: unit, quantity: w.quantity, line_total_kobo: total,
      customisations: chosen.map(({ group_id, ...c }) => c),
    });
  });

  if (strict && problems.length) {
    throw new HttpError(409, "cart_changed", problems[0].message, { problems });
  }
  return { lines, subtotal_kobo: subtotal, problems };
}
