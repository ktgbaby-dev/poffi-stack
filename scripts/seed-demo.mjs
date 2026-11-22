// LOCAL DEMO DATA ONLY. Fills a local (PGlite) database with clearly-labelled sample menu items and
// settings so the site can be clicked through before the real menu exists. Every product is marked
// "(demo)"; prices are placeholders, not Poffi Stack prices. Refuses to touch a real Postgres database
// unless --force-demo is given.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getDb } from "../lib/db.js";
import { saveSection } from "../lib/settings.js";
import { saveCategory, saveProduct } from "../lib/menu.js";
import { createUser } from "../lib/auth.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.env.DATABASE_URL ??= "pglite:" + join(root, ".data", "dev");

export async function seedDemo({ adminPassword } = {}) {
  if (!process.env.DATABASE_URL.startsWith("pglite:") && !process.argv.includes("--force-demo")) {
    throw new Error("Refusing to put demo data in a real database. Use --force-demo if you really mean it.");
  }
  const db = await getDb();
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM products`);
  if (rows[0].n > 0) return { skipped: true };

  const hours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: true, from: "08:00", to: "18:00" }]));
  await saveSection("business", { name: "Poffi Stack", tagline: "Freshly made. Packed with love.", phone: "", whatsapp: "", email: "", instagram: "", tiktok: "poffi.stack", pickup_address: "Demo pickup address (replace in Settings)", pickup_instructions: "" });
  await saveSection("ordering", { enabled: true, pickup: true, delivery: true, hours, slot_minutes: 30, slot_capacity: 3, lead_time_minutes: 60, same_day: true, cutoff: { enabled: false, time: "16:00", days_before: 1 }, max_days_ahead: 14, hold_minutes: 30, min_order_kobo: 0 });
  await saveSection("delivery", { zones: [{ id: "alimosho", name: "Alimosho (demo fee)", fee_kobo: 150000, active: true }, { id: "ota", name: "Ota (demo fee)", fee_kobo: 250000, active: true }], note: "" });
  await saveSection("notifications", { owner_email: "owner@poffi.test", new_order: true, cancellation: true, reminder_offsets: [60, 30], customer_confirmation: true, customer_status: { confirmed: true, preparing: false, ready: true, out_for_delivery: true, completed: false, cancelled: true } });
  await saveSection("content", { hero_title: "Freshly made. Packed with love.", hero_text: "Pancakes, breakfast and sweet treats. Order online for pickup or delivery.", about_title: "", about_text: "", announcement: "Demo data: this local menu is a sample for testing, not Poffi Stack's real menu.", testimonials: [] });

  const pancakes = await saveCategory({ name: "Pancakes", sort: 1 });
  const breakfast = await saveCategory({ name: "Breakfast", sort: 2 });
  const treats = await saveCategory({ name: "Sweet Treats", sort: 3 });
  const demo = "Sample item for testing the ordering flow. Replace with the real menu.";
  await saveProduct({ name: "Demo pancake stack", category_id: pancakes, description: demo, price: "3500", featured: true,
    variations: [{ name: "Small (demo)", price: "3500" }, { name: "Large (demo)", price: "5500" }],
    addon_groups: [{ name: "Toppings", min_select: 0, max_select: 3, addons: [{ name: "Demo topping A", price: "500" }, { name: "Demo topping B", price: "700" }, { name: "Demo topping C", price: "0" }] }] });
  await saveProduct({ name: "Demo stack with a sauce choice", category_id: pancakes, description: demo, price: "4200", featured: true,
    addon_groups: [{ name: "Sauce", min_select: 1, max_select: 1, addons: [{ name: "Demo sauce 1", price: "0" }, { name: "Demo sauce 2", price: "300" }] }] });
  await saveProduct({ name: "Demo breakfast plate", category_id: breakfast, description: demo, price: "6000", featured: true });
  await saveProduct({ name: "Demo sold-out item", category_id: breakfast, description: "Shows how a sold-out item looks.", price: "2500", status: "sold_out" });
  await saveProduct({ name: "Demo sweet treat", category_id: treats, description: demo, price: "2000" });

  const password = adminPassword || process.env.DEMO_ADMIN_PASSWORD || "demo-owner-password-123";
  await createUser({ email: "owner@poffi.test", name: "Demo Owner", role: "owner", password }).catch(() => {});
  await createUser({ email: "staff@poffi.test", name: "Demo Staff", role: "staff", password }).catch(() => {});
  return { skipped: false, password };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = await seedDemo();
    if (out.skipped) console.log("The database already has products; demo data not added.");
    else {
      mkdirSync(join(root, ".data"), { recursive: true });
      writeFileSync(join(root, ".data", "DEV-CREDENTIALS.txt"), `LOCAL DEMO ONLY\nDashboard: http://localhost:5680/admin\nowner@poffi.test / ${out.password}\nstaff@poffi.test / ${out.password}\n`);
      console.log("Demo data added. Local logins are in .data/DEV-CREDENTIALS.txt");
    }
  } finally {
    await closeDb();
  }
}
