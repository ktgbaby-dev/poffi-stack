// Browser end-to-end test: the whole customer journey and the owner dashboard, on desktop and phone,
// against a fresh in-memory database with the LOCAL Paystack and Resend test doubles (not the real services).
//   npm run test:e2e        (screenshots go to test-results/e2e/)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const shots = join(root, "test-results", "e2e");
mkdirSync(shots, { recursive: true });
const PORT = 5690, PS = 5691, RS = 5692;
const BASE = `http://localhost:${PORT}`;
const OWNER = { email: "owner@poffi.test", password: "e2e-owner-password-1" };

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`); };

// ---------- server ----------
const server = spawn(process.execPath, ["dev/server.js", "--mocks", "--seed-demo", `--port=${PORT}`, `--paystack-port=${PS}`, `--resend-port=${RS}`], {
  cwd: root, env: { ...process.env, DATABASE_URL: "pglite:memory", DEMO_ADMIN_PASSWORD: OWNER.password, SITE_URL: BASE, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
await new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error("server did not start\n" + serverLog)), 90_000);
  const iv = setInterval(() => { if (serverLog.includes("Poffi Stack ordering:")) { clearTimeout(t); clearInterval(iv); ok(); } }, 200);
});

const emails = async () => {
  const html = await (await fetch(`http://127.0.0.1:${RS}/`)).text();
  return [...html.matchAll(/<td>([^<]*)<\/td><td><a href="\/view\?id=[^"]+">([^<]*)<\/a><\/td><td>([^<]*)<\/td>/g)].map((m) => ({ to: m[1], subject: m[2].replace(/&amp;/g, "&"), scheduled: !!m[3] }));
};

const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
const pageErrors = [];
async function newPage(opts) {
  const ctx = await browser.newContext({ baseURL: BASE, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${page.url()}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (401|404)/.test(m.text())) pageErrors.push(`${page.url()}: console ${m.text()}`); });
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
// On a phone the sticky header can sit over a control that was scrolled to the top edge; centre it first,
// as a person scrolling would.
const tap = async (loc) => { await loc.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })); await loc.click(); };
const text = async (loc) => (await loc.textContent())?.replace(/\s+/g, " ").trim() || "";

try {
  // ================= customer, desktop =================
  const { ctx: dctx, page } = await newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("/");
  await page.waitForSelector("[data-featured] .card");
  check("home: featured products load", (await page.locator("[data-featured] .card").count()) >= 3);
  check("home: Powered by Kal's Digital in footer", await page.locator(".site-footer .powered img[alt='Kal’s Digital']").isVisible());
  check("home: logo shown", await page.locator(".brand img").isVisible());
  await shot(page, "01-home-desktop");

  await page.goto("/menu");
  await page.waitForSelector(".menu-cat .card");
  check("menu: categories rendered", (await page.locator(".menu-cat").count()) === 3);
  check("menu: sold-out item can't be added", await page.locator("article:has-text('Demo sold-out item') [data-add]").isDisabled());
  await shot(page, "02-menu-desktop");

  // product with size + toppings
  await page.locator("article:has-text('Demo pancake stack') [data-add]").click();
  await page.waitForSelector(".sheet.modal.open");
  await page.locator(".sheet label:has-text('Large (demo)')").click();
  await page.locator(".sheet label:has-text('Demo topping A')").click();
  await page.locator(".sheet label:has-text('Demo topping B')").click();
  await page.locator(".sheet [data-q='1']").click();
  check("options dialog: live price (2 × Large + A + B)", (await text(page.locator(".sheet [data-add]"))).includes("₦13,400"), await text(page.locator(".sheet [data-add]")));
  await shot(page, "03-product-dialog-desktop");
  await page.locator(".sheet [data-add]").click();
  await page.waitForSelector(".sheet", { state: "detached" });
  // quick add
  await page.locator("article:has-text('Demo breakfast plate') [data-add]").click();
  // required choice
  await page.locator("article:has-text('Demo stack with a sauce choice') [data-add]").click();
  await page.waitForSelector(".sheet.modal.open");
  await page.locator(".sheet [data-add]").click();
  check("options dialog: required choice enforced", (await text(page.locator(".sheet .form-error"))).startsWith("Choose"));
  await page.locator(".sheet label:has-text('Demo sauce 2')").click();
  await page.locator(".sheet [data-add]").click();
  await page.waitForSelector(".sheet", { state: "detached" });
  check("header: cart count is 4", (await text(page.locator("[data-cart-count]").first())) === "4");

  // cart drawer
  await page.locator(".cart-btn").click();
  await page.waitForSelector(".sheet.drawer.open .sum-row");
  const subtotal = async () => text(page.locator(".sheet.drawer .sum-row b"));
  check("cart: subtotal from server prices", (await subtotal()) === "₦23,900", await subtotal());
  await page.locator(".cart-line:has-text('Demo breakfast plate') [data-act='inc']").click();
  await page.waitForFunction(() => document.querySelector(".sheet.drawer .sum-row b")?.textContent === "₦29,900");
  check("cart: quantity change re-prices", true);
  await page.locator(".cart-line:has-text('Demo pancake stack') [data-act='edit']").click();
  await page.waitForSelector(".sheet.modal.open");
  check("cart: edit keeps the chosen options", await page.locator(".sheet input[name=variation]:checked + .opt-name:has-text('Large')").count() === 1);
  await page.locator(".sheet label:has-text('Small (demo)')").click();
  await page.locator(".sheet [data-add]").click();
  await page.waitForFunction(() => document.querySelector(".sheet.drawer .sum-row b")?.textContent === "₦25,900");
  check("cart: edited line re-priced", true);
  await page.locator(".cart-line:has-text('sauce') [data-act='remove']").click();
  await page.waitForFunction(() => document.querySelector(".sheet.drawer .sum-row b")?.textContent === "₦21,400");
  check("cart: remove line", true);
  await shot(page, "04-cart-drawer-desktop");
  await page.locator(".sheet.drawer a:has-text('Checkout')").click();

  // checkout
  await page.waitForURL("**/checkout");
  await page.waitForSelector("[data-form]:not([hidden])");
  await page.locator("[data-pay]").click();
  check("checkout: validation stops an incomplete form", (await page.locator(".field.invalid").count()) >= 3);
  await page.fill("#name", "Ada Customer");
  await page.fill("#phone", "08031234567");
  await page.fill("#email", "ada@example.test");
  await page.locator(".method-card:has-text('Delivery')").click();
  await page.selectOption("#zone", "alimosho");
  await page.fill("#address", "12 Test Street, near the market, Alimosho");
  const openDays = page.locator(".day:not([disabled])");
  await openDays.nth(1).click(); // tomorrow-ish, so reminders are in the future
  await page.locator(".slot:not([disabled])").first().click();
  await page.fill("#notes", "Please knock twice");
  check("checkout: total includes delivery fee", (await text(page.locator("[data-total]"))) === "₦22,900", await text(page.locator("[data-total]")));
  await page.locator("[data-confirm]").check();
  await shot(page, "05-checkout-desktop");
  await page.locator("[data-pay]").click();
  await page.waitForURL(`http://127.0.0.1:${PS}/checkout/**`);
  check("payment: customer sent to the (local) Paystack page", (await page.content()).includes("NGN 22,900"));
  await page.locator("#pay-success").click();
  await page.waitForURL("**/order?**");
  await page.waitForSelector(".order-hero h1:has-text('Thank you')", { timeout: 20_000 });
  check("confirmation: thank-you page after verified payment", true);
  check("confirmation: shows order number", (await text(page.locator(".ref-pill"))).includes("PS-0001"));
  check("confirmation: shows amount paid", (await text(page.locator(".sum-row.total"))).includes("₦22,900"));
  check("confirmation: payment confirmed by Paystack", await page.locator("text=Payment confirmed by Paystack").isVisible());
  check("confirmation: payment reference removed from the address bar", !page.url().includes("reference="));
  check("confirmation: cart emptied", (await text(page.locator("[data-cart-count]").first())) === "0");
  await shot(page, "06-confirmation-desktop");

  let mail = await emails();
  check("email: owner new-order alert", mail.some((m) => m.subject === "NEW PAID ORDER — POFFI STACK #PS-0001" && m.to.includes(OWNER.email)), JSON.stringify(mail.map((m) => m.subject)));
  check("email: customer confirmation", mail.some((m) => m.subject === "Order PS-0001 confirmed · Poffi Stack" && m.to.includes("ada@example.test")));
  check("email: two owner reminders scheduled", mail.filter((m) => m.subject.startsWith("Reminder: PS-0001") && m.scheduled).length === 2);

  // ================= customer, phone: failed then retried payment =================
  const { ctx: mctx, page: m } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await m.goto("/menu");
  await m.waitForSelector(".menu-cat .card");
  await shot(m, "07-menu-phone");
  await m.locator("article:has-text('Demo sweet treat') [data-add]").click();
  await m.locator("article:has-text('Demo breakfast plate') [data-add]").click();
  await m.locator(".cart-btn").click();
  await m.waitForSelector(".sheet.drawer.open .sum-row");
  await shot(m, "08-cart-phone");
  await m.locator(".sheet.drawer a:has-text('Checkout')").click();
  await m.waitForSelector("[data-form]:not([hidden])");
  await m.fill("#name", "Bola Phone");
  await m.fill("#phone", "+2348051112222");
  await m.fill("#email", "bola@example.test");
  await tap(m.locator(".method-card:has-text('Pickup')"));
  await tap(m.locator(".day:not([disabled])").nth(1));
  await tap(m.locator(".slot:not([disabled])").nth(1));
  await tap(m.locator("[data-confirm]"));
  await shot(m, "09-checkout-phone");
  const wide = await m.evaluate(() => [...document.querySelectorAll(".panel, .field input, .field select, .field textarea")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length);
  check("phone: checkout fits the screen (no panel or field wider than it)", wide === 0, `${wide} too wide`);
  await m.locator("[data-pay]").click();
  await m.waitForURL(`http://127.0.0.1:${PS}/checkout/**`);
  await m.locator("#pay-fail").click();
  await m.waitForSelector(".order-hero h1:has-text('Payment not completed')", { timeout: 20_000 });
  check("failed payment: clear message and retry button", await m.locator("[data-retry]").isVisible());
  await shot(m, "10-payment-failed-phone");
  await m.locator("[data-retry]").click();
  await m.waitForURL(`http://127.0.0.1:${PS}/checkout/**`);
  await m.locator("#pay-success").click();
  await m.waitForSelector(".order-hero h1:has-text('Thank you')", { timeout: 20_000 });
  check("retry: same order paid on the second attempt", (await text(m.locator(".ref-pill"))).includes("PS-0002"));
  await shot(m, "11-confirmation-phone");

  // ================= owner dashboard =================
  const { ctx: actx, page: a } = await newPage({ viewport: { width: 1366, height: 900 } });
  await a.goto("/admin");
  await a.fill("#em", OWNER.email);
  await a.fill("#pw", OWNER.password);
  await a.locator("button:has-text('Sign in')").click();
  await a.waitForSelector(".stats");
  check("dashboard: sign in", true);
  check("dashboard: two new orders to confirm", (await text(a.locator(".stat.orange b"))) === "2");
  check("dashboard: revenue from verified payments", (await text(a.locator(".stat.wide b"))) === `₦${(22900 + 8000).toLocaleString("en-NG")}`, await text(a.locator(".stat.wide b")));
  await shot(a, "12-dashboard-overview-desktop");

  await a.goto("/admin#/orders");
  await a.waitForSelector(".orow");
  const refs = await a.locator(".orow .ref").allTextContents();
  check("orders: upcoming list has both orders", refs.includes("PS-0001") && refs.includes("PS-0002"), refs.join(","));
  await shot(a, "13-orders-desktop");
  await a.locator(".orow:has-text('PS-0001')").click();
  await a.waitForSelector("h1:has-text('PS-0001')");
  check("order detail: delivery address and notes", (await text(a.locator(".main"))).includes("12 Test Street") && (await text(a.locator(".main"))).includes("Please knock twice"));
  check("order detail: customisations listed", (await text(a.locator(".main"))).includes("Toppings: Demo topping A"));
  for (const label of ["Confirm order", "Start preparing", "Mark ready", "Out for delivery", "Mark completed"]) {
    await a.locator(`[data-to]:has-text('${label}')`).first().click();
    await a.waitForTimeout(300);
    await a.waitForSelector(".main h1:has-text('PS-0001')");
  }
  check("order detail: walked through to Completed", (await text(a.locator(".page-head"))).includes("Completed"));
  await shot(a, "14-order-detail-desktop");
  mail = await emails();
  check("email: customer told confirmed / ready / on its way", ["Your order is confirmed · PS-0001", "Your order is ready · PS-0001", "Your order is on its way · PS-0001"].every((s) => mail.some((x) => x.subject === s)), JSON.stringify(mail.map((x) => x.subject)));

  // cancel + refund PS-0002
  await a.goto("/admin#/orders?view=all");
  await a.waitForSelector(".orow");
  await a.locator(".orow:has-text('PS-0002')").click();
  await a.waitForSelector("h1:has-text('PS-0002')");
  a.once("dialog", (d) => d.accept("Customer can't make it"));
  await a.locator("[data-cancel]").click();
  await a.waitForSelector(".page-head .pill.s-cancelled");
  check("cancel: order cancelled with a reason", (await text(a.locator(".main"))).includes("Customer can't make it"));
  a.once("dialog", (d) => d.accept());
  await a.locator("[data-refund]").click();
  await a.waitForSelector(".page-head .pill.p-refund_pending, .page-head .pill.p-refunded");
  await a.waitForTimeout(600);
  await a.reload();
  await a.waitForSelector("h1:has-text('PS-0002')");
  check("refund: shows Refunded after Paystack (test double) confirms", (await text(a.locator(".page-head"))).includes("Refunded"));
  mail = await emails();
  check("email: owner told about the cancellation", mail.some((x) => x.subject === "Order cancelled — Poffi Stack #PS-0002"));

  // menu: add a product with a photo, then mark it sold out
  await a.goto("/admin#/menu/product/new");
  await a.waitForSelector("#pn");
  await a.fill("#pn", "E2E test waffle");
  await a.fill("#pd", "Added by the automated test.");
  await a.selectOption("#pc", { label: "Breakfast" });
  await a.fill("#pp", "2500");
  await a.setInputFiles("[data-file]", join(root, "public/assets/img/logo-disc-512.png"));
  await a.waitForFunction(() => document.querySelector("[data-img]")?.src.includes("/media/"));
  check("menu editor: photo uploaded", true);
  await a.locator("button:has-text('Add to menu')").click();
  await a.waitForSelector(".mitem:has-text('E2E test waffle')");
  await shot(a, "15-menu-admin-desktop");
  await page.goto("/menu");
  await page.waitForSelector("article:has-text('E2E test waffle') img.photo");
  check("public menu: new product with photo appears", true);
  await a.locator(".mitem:has-text('E2E test waffle') select").selectOption("sold_out");
  await a.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector("article:has-text('E2E test waffle') .badge:has-text('Sold out')");
  check("public menu: availability change shows as Sold out", true);

  // settings
  await a.goto("/admin#/settings/ordering");
  await a.waitForSelector("#o-cap");
  await a.fill("#o-cap", "4");
  await a.locator(".save-bar button:has-text('Save')").click();
  await a.waitForSelector("[data-saved]:has-text('Saved')");
  check("settings: ordering saved", true);
  await shot(a, "16-settings-desktop");
  await a.goto("/admin#/settings/notifications");
  await a.waitForSelector("[data-new-offset]");
  await a.fill("[data-new-offset]", "120");
  await a.locator("[data-add-offset]").click();
  await a.locator(".save-bar button:has-text('Save')").click();
  await a.waitForSelector("[data-saved]:has-text('Saved')");
  check("settings: reminder times saved", true);

  // team: staff login with forced password change and limited rights
  await a.goto("/admin#/team");
  await a.waitForSelector("#u-name");
  await a.fill("#u-name", "Tola Staff");
  await a.fill("#u-email", "tola@poffi.test");
  await a.locator("button:has-text('Create login')").click();
  await a.waitForSelector(".temp-pass");
  const temp = (await text(a.locator(".temp-pass")));
  check("team: temporary password shown once", temp.length >= 12);
  const { ctx: sctx, page: s } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await s.goto("/admin");
  await s.fill("#em", "tola@poffi.test");
  await s.fill("#pw", temp);
  await s.locator("button:has-text('Sign in')").click();
  await s.waitForSelector("h1:has-text('Choose your password')");
  await s.fill("#cur", temp);
  await s.fill("#pw", "tola-own-password-1");
  await s.locator("button:has-text('Save password')").click();
  await s.waitForSelector(".stats");
  check("staff: must choose own password, then signs in", true);
  check("staff: no Team page in navigation", (await s.locator(".side a:has-text('Team')").count()) === 0);
  await shot(s, "17-dashboard-overview-phone");
  await s.goto("/admin#/settings/ordering");
  await s.waitForSelector(".save-bar button");
  check("staff: can't save settings", await s.locator(".save-bar button").isDisabled());
  await s.goto("/admin#/orders?view=all");
  await s.waitForSelector(".orow");
  await shot(s, "18-orders-phone");
  const wideAdmin = await s.evaluate(() => [...document.querySelectorAll(".box, .orow, .stat")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length);
  check("phone: dashboard fits the screen", wideAdmin === 0, `${wideAdmin} too wide`);
  await s.locator(".orow").first().click();
  await s.waitForSelector(".main h1");
  const wideDetail = await s.evaluate(() => [...document.querySelectorAll(".box")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length);
  check("phone: order detail fits the screen", wideDetail === 0, `${wideDetail} too wide`);
  await shot(s, "19-order-detail-phone");

  check("no JavaScript errors on any page", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
  await Promise.all([dctx.close(), mctx.close(), actx.close(), sctx.close()]);
} catch (err) {
  check("e2e run completed without a crash", false, err.stack?.split("\n").slice(0, 16).join(" | "));
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`);
if (failed.length) { console.log("Server log tail:\n" + serverLog.split("\n").slice(-25).join("\n")); process.exitCode = 1; }
