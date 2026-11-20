// Menu: categories, products, variations (choose one) and add-on groups (choose 0..n).
import { getDb } from "./db.js";
import { HttpError, bad, bool, int, notFound, str } from "./http.js";
import { nairaToKobo, validKobo } from "./money.js";
import { mediaUrl } from "./media.js";

export const PRODUCT_STATUSES = ["available", "sold_out", "hidden"];

export const slugify = (s) => str(s, 120).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";

async function uniqueSlug(q, table, base, exceptId = null) {
  let slug = base;
  for (let i = 2; i < 500; i++) {
    const { rows } = await q(`SELECT id FROM ${table} WHERE slug = $1 AND ($2::bigint IS NULL OR id <> $2)`, [slug, exceptId]);
    if (!rows.length) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ---------- reading ----------
function shapeProduct(p, variations, groups, addons) {
  return {
    id: Number(p.id),
    category_id: p.category_id === null ? null : Number(p.category_id),
    name: p.name,
    slug: p.slug,
    description: p.description,
    price_kobo: p.price_kobo,
    image_url: p.image_id ? mediaUrl(p.image_id, p.image_sha) : null,
    image_id: p.image_id ? Number(p.image_id) : null,
    status: p.status,
    featured: p.featured,
    archived: p.archived,
    sort: p.sort,
    max_per_order: p.max_per_order,
    variations: variations.filter((v) => Number(v.product_id) === Number(p.id)).map((v) => ({ id: Number(v.id), name: v.name, price_kobo: v.price_kobo, available: v.available, sort: v.sort })),
    addon_groups: groups.filter((g) => Number(g.product_id) === Number(p.id)).map((g) => ({
      id: Number(g.id), name: g.name, min_select: g.min_select, max_select: g.max_select, sort: g.sort,
      addons: addons.filter((a) => Number(a.group_id) === Number(g.id)).map((a) => ({ id: Number(a.id), name: a.name, price_kobo: a.price_kobo, available: a.available, sort: a.sort })),
    })),
  };
}

async function loadProducts(q, where, params) {
  const { rows: products } = await q(
    `SELECT p.*, m.sha256 AS image_sha FROM products p LEFT JOIN media m ON m.id = p.image_id WHERE ${where} ORDER BY p.sort, p.name`, params);
  if (!products.length) return [];
  const ids = products.map((p) => Number(p.id));
  const { rows: variations } = await q(`SELECT * FROM product_variations WHERE product_id = ANY($1::bigint[]) AND NOT archived ORDER BY sort, id`, [ids]);
  const { rows: groups } = await q(`SELECT * FROM addon_groups WHERE product_id = ANY($1::bigint[]) AND NOT archived ORDER BY sort, id`, [ids]);
  const gids = groups.map((g) => Number(g.id));
  const { rows: addons } = gids.length ? await q(`SELECT * FROM addons WHERE group_id = ANY($1::bigint[]) AND NOT archived ORDER BY sort, id`, [gids]) : { rows: [] };
  return products.map((p) => shapeProduct(p, variations, groups, addons));
}

// What customers see: active categories, products that are not archived or hidden (sold-out ones stay visible).
export async function publicMenu() {
  const { query } = await getDb();
  const { rows: cats } = await query(`SELECT id, name, slug, description, sort FROM categories WHERE active ORDER BY sort, name`);
  const products = await loadProducts(query, `NOT p.archived AND p.status <> 'hidden' AND (p.category_id IS NULL OR p.category_id IN (SELECT id FROM categories WHERE active))`, []);
  const strip = (p) => ({ ...p, archived: undefined, image_id: undefined, sort: undefined,
    addon_groups: p.addon_groups.map((g) => ({ ...g, sort: undefined, addons: g.addons.map((a) => ({ ...a, sort: undefined })) })),
    variations: p.variations.map((v) => ({ ...v, sort: undefined })) });
  return {
    categories: cats.map((c) => ({ id: Number(c.id), name: c.name, slug: c.slug, description: c.description })),
    products: products.map(strip),
  };
}

export async function adminMenu() {
  const { query } = await getDb();
  const { rows: cats } = await query(`SELECT c.*, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND NOT p.archived) AS product_count FROM categories c ORDER BY sort, name`);
  const products = await loadProducts(query, `true`, []);
  return {
    categories: cats.map((c) => ({ id: Number(c.id), name: c.name, slug: c.slug, description: c.description, sort: c.sort, active: c.active, product_count: c.product_count })),
    products,
  };
}

export async function getProduct(id, q) {
  const run = q || (await getDb()).query;
  const list = await loadProducts(run, `p.id = $1`, [id]);
  if (!list.length) throw notFound("That product doesn't exist.");
  return list[0];
}

// ---------- categories ----------
export async function saveCategory(input, id = null) {
  const db = await getDb();
  const name = str(input.name, 80);
  if (!name) throw bad("invalid_category", "Category name is required.", { field: "name" });
  const description = str(input.description, 300);
  const sort = Number.isInteger(int(input.sort)) ? int(input.sort) : 0;
  const active = input.active === undefined ? true : bool(input.active);
  return db.tx(async (q) => {
    const slug = await uniqueSlug(q, "categories", slugify(name), id);
    if (id) {
      const { rows } = await q(`UPDATE categories SET name=$1, slug=$2, description=$3, sort=$4, active=$5, updated_at=now() WHERE id=$6 RETURNING id`, [name, slug, description, sort, active, id]);
      if (!rows.length) throw notFound("That category doesn't exist.");
      return Number(rows[0].id);
    }
    const { rows } = await q(`INSERT INTO categories (name, slug, description, sort, active) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name, slug, description, sort, active]);
    return Number(rows[0].id);
  });
}

export async function deleteCategory(id) {
  const { query } = await getDb();
  const { rows } = await query(`SELECT count(*)::int AS n FROM products WHERE category_id = $1 AND NOT archived`, [id]);
  if (rows[0].n > 0) throw new HttpError(409, "category_not_empty", "Move or archive this category's products first, or switch the category off instead.");
  await query(`UPDATE products SET category_id = NULL WHERE category_id = $1`, [id]);
  const r = await query(`DELETE FROM categories WHERE id = $1`, [id]);
  if (!r.rowCount) throw notFound("That category doesn't exist.");
}

// ---------- products ----------
function cleanProduct(input) {
  const name = str(input.name, 120);
  if (!name) throw bad("invalid_product", "Product name is required.", { field: "name" });
  const price = typeof input.price_kobo === "number" ? input.price_kobo : nairaToKobo(String(input.price ?? ""));
  if (!validKobo(price)) throw bad("invalid_product", "Price doesn't look right.", { field: "price" });
  const status = PRODUCT_STATUSES.includes(input.status) ? input.status : "available";
  const maxPer = input.max_per_order === null || input.max_per_order === "" || input.max_per_order === undefined ? null : int(input.max_per_order);
  if (maxPer !== null && (!Number.isInteger(maxPer) || maxPer < 1 || maxPer > 999)) throw bad("invalid_product", "Maximum per order must be 1–999, or empty.", { field: "max_per_order" });
  const categoryId = input.category_id === null || input.category_id === "" || input.category_id === undefined ? null : int(input.category_id);
  if (categoryId !== null && !Number.isInteger(categoryId)) throw bad("invalid_product", "Pick a category.", { field: "category_id" });
  const imageId = input.image_id === null || input.image_id === "" || input.image_id === undefined ? null : int(input.image_id);

  const variations = (Array.isArray(input.variations) ? input.variations : []).slice(0, 30).map((v, i) => {
    const vn = str(v.name, 80);
    if (!vn) throw bad("invalid_product", `Option ${i + 1} needs a name.`, { field: `variations.${i}` });
    const vp = typeof v.price_kobo === "number" ? v.price_kobo : nairaToKobo(String(v.price ?? ""));
    if (!validKobo(vp)) throw bad("invalid_product", `Price for "${vn}" doesn't look right.`, { field: `variations.${i}` });
    return { id: Number.isInteger(int(v.id)) ? int(v.id) : null, name: vn, price_kobo: vp, available: v.available === undefined ? true : bool(v.available), sort: i };
  });

  const groups = (Array.isArray(input.addon_groups) ? input.addon_groups : []).slice(0, 12).map((g, gi) => {
    const gn = str(g.name, 80);
    if (!gn) throw bad("invalid_product", `Add-on group ${gi + 1} needs a name.`, { field: `addon_groups.${gi}` });
    const addons = (Array.isArray(g.addons) ? g.addons : []).slice(0, 40).map((a, ai) => {
      const an = str(a.name, 80);
      if (!an) throw bad("invalid_product", `An add-on in "${gn}" needs a name.`, { field: `addon_groups.${gi}.addons.${ai}` });
      const ap = typeof a.price_kobo === "number" ? a.price_kobo : nairaToKobo(String(a.price ?? "0"));
      if (!validKobo(ap)) throw bad("invalid_product", `Price for "${an}" doesn't look right.`, { field: `addon_groups.${gi}.addons.${ai}` });
      return { id: Number.isInteger(int(a.id)) ? int(a.id) : null, name: an, price_kobo: ap, available: a.available === undefined ? true : bool(a.available), sort: ai };
    });
    if (!addons.length) throw bad("invalid_product", `Add-on group "${gn}" needs at least one option.`, { field: `addon_groups.${gi}` });
    const min = Number.isInteger(int(g.min_select)) ? int(g.min_select) : 0;
    const max = Number.isInteger(int(g.max_select)) ? int(g.max_select) : 1;
    if (min < 0 || max < 1 || min > max || min > addons.length) throw bad("invalid_product", `Choice limits for "${gn}" don't add up.`, { field: `addon_groups.${gi}` });
    return { id: Number.isInteger(int(g.id)) ? int(g.id) : null, name: gn, min_select: min, max_select: Math.min(max, addons.length), sort: gi, addons };
  });

  return {
    name, price, status, maxPer, categoryId, imageId: Number.isInteger(imageId) ? imageId : null,
    description: str(input.description, 1000), featured: bool(input.featured),
    sort: Number.isInteger(int(input.sort)) ? int(input.sort) : 0, variations, groups,
  };
}

// Saves a product and its options. Option rows that disappear are archived (old orders keep their names
// and prices anyway, because order lines store snapshots).
export async function saveProduct(input, id = null) {
  const p = cleanProduct(input);
  const db = await getDb();
  const productId = await db.tx(async (q) => {
    if (p.categoryId !== null) {
      const { rows } = await q(`SELECT id FROM categories WHERE id = $1`, [p.categoryId]);
      if (!rows.length) throw bad("invalid_product", "That category doesn't exist.", { field: "category_id" });
    }
    if (p.imageId !== null) {
      const { rows } = await q(`SELECT id FROM media WHERE id = $1`, [p.imageId]);
      if (!rows.length) throw bad("invalid_product", "That image wasn't found. Upload it again.", { field: "image_id" });
    }
    let pid = id;
    if (id) {
      const slug = await uniqueSlug(q, "products", slugify(p.name), id);
      const { rows } = await q(
        `UPDATE products SET category_id=$1, name=$2, slug=$3, description=$4, price_kobo=$5, image_id=$6, status=$7, featured=$8, sort=$9, max_per_order=$10, updated_at=now()
         WHERE id=$11 RETURNING id`,
        [p.categoryId, p.name, slug, p.description, p.price, p.imageId, p.status, p.featured, p.sort, p.maxPer, id]);
      if (!rows.length) throw notFound("That product doesn't exist.");
    } else {
      const slug = await uniqueSlug(q, "products", slugify(p.name));
      const { rows } = await q(
        `INSERT INTO products (category_id, name, slug, description, price_kobo, image_id, status, featured, sort, max_per_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [p.categoryId, p.name, slug, p.description, p.price, p.imageId, p.status, p.featured, p.sort, p.maxPer]);
      pid = Number(rows[0].id);
    }

    // variations
    const keepV = [];
    for (const v of p.variations) {
      if (v.id) {
        const { rows } = await q(`UPDATE product_variations SET name=$1, price_kobo=$2, available=$3, sort=$4, archived=false WHERE id=$5 AND product_id=$6 RETURNING id`, [v.name, v.price_kobo, v.available, v.sort, v.id, pid]);
        if (rows.length) { keepV.push(v.id); continue; }
      }
      const { rows } = await q(`INSERT INTO product_variations (product_id, name, price_kobo, available, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [pid, v.name, v.price_kobo, v.available, v.sort]);
      keepV.push(Number(rows[0].id));
    }
    await q(`UPDATE product_variations SET archived = true WHERE product_id = $1 AND NOT (id = ANY($2::bigint[]))`, [pid, keepV]);

    // add-on groups
    const keepG = [];
    for (const g of p.groups) {
      let gid = null;
      if (g.id) {
        const { rows } = await q(`UPDATE addon_groups SET name=$1, min_select=$2, max_select=$3, sort=$4, archived=false WHERE id=$5 AND product_id=$6 RETURNING id`, [g.name, g.min_select, g.max_select, g.sort, g.id, pid]);
        if (rows.length) gid = g.id;
      }
      if (!gid) {
        const { rows } = await q(`INSERT INTO addon_groups (product_id, name, min_select, max_select, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [pid, g.name, g.min_select, g.max_select, g.sort]);
        gid = Number(rows[0].id);
      }
      keepG.push(gid);
      const keepA = [];
      for (const a of g.addons) {
        if (a.id) {
          const { rows } = await q(`UPDATE addons SET name=$1, price_kobo=$2, available=$3, sort=$4, archived=false WHERE id=$5 AND group_id=$6 RETURNING id`, [a.name, a.price_kobo, a.available, a.sort, a.id, gid]);
          if (rows.length) { keepA.push(a.id); continue; }
        }
        const { rows } = await q(`INSERT INTO addons (group_id, name, price_kobo, available, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [gid, a.name, a.price_kobo, a.available, a.sort]);
        keepA.push(Number(rows[0].id));
      }
      await q(`UPDATE addons SET archived = true WHERE group_id = $1 AND NOT (id = ANY($2::bigint[]))`, [gid, keepA]);
    }
    await q(`UPDATE addon_groups SET archived = true WHERE product_id = $1 AND NOT (id = ANY($2::bigint[]))`, [pid, keepG]);
    return pid;
  });
  return getProduct(productId);
}

export async function setProductStatus(id, status) {
  if (!PRODUCT_STATUSES.includes(status)) throw bad("invalid_status", "Unknown availability.");
  const { query } = await getDb();
  const r = await query(`UPDATE products SET status=$1, updated_at=now() WHERE id=$2 RETURNING id`, [status, id]);
  if (!r.rowCount) throw notFound("That product doesn't exist.");
}

export async function setArchived(id, archived) {
  const { query } = await getDb();
  const r = await query(`UPDATE products SET archived=$1, featured = CASE WHEN $1 THEN false ELSE featured END, updated_at=now() WHERE id=$2 RETURNING id`, [archived, id]);
  if (!r.rowCount) throw notFound("That product doesn't exist.");
}

// A product that has ever been ordered is archived instead of deleted (its id stays on old order lines).
export async function deleteProduct(id) {
  const { query } = await getDb();
  const { rows } = await query(`SELECT count(*)::int AS n FROM order_items WHERE product_id = $1`, [id]);
  if (rows[0].n > 0) {
    await setArchived(id, true);
    return { archived: true };
  }
  const r = await query(`DELETE FROM products WHERE id = $1`, [id]);
  if (!r.rowCount) throw notFound("That product doesn't exist.");
  return { deleted: true };
}
