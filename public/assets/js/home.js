import { esc, getMenu, initChrome, waLink } from "./app.js";
import { productCard, wireCards } from "./cards.js";

const clock12 = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h >= 12 ? "pm" : "am"}`; };

const cfg = await initChrome();
if (cfg) {
  const c = cfg.content;
  const o = cfg.ordering;
  if (c.hero_title) {
    // Two-tone headline: the first sentence in black, the rest in Poffi orange.
    const m = /^(.+?[.!?])\s+(.+)$/.exec(c.hero_title);
    document.querySelector("[data-hero-title]").innerHTML = m ? `${esc(m[1])} <em>${esc(m[2])}</em>` : esc(c.hero_title);
  }
  const methods = [o.pickup && "pickup", o.delivery && cfg.delivery.zones.length && "delivery"].filter(Boolean);
  document.querySelector("[data-hero-text]").textContent = c.hero_text || `Pancakes, breakfast and sweet treats. Order online${methods.length ? ` for ${methods.join(" or ")}` : ""}, choose your time and pay securely.`;
  if (!o.open) document.querySelector("[data-closed]").hidden = false;
  if (c.about_text) {
    document.querySelector("[data-about]").hidden = false;
    document.querySelector("[data-about-title]").textContent = c.about_title || `About ${cfg.business.name}`;
    document.querySelector("[data-about-text]").textContent = c.about_text;
  }
  // How it works, in the business's own rules
  const timeBits = [];
  if (o.cutoff?.enabled) timeBits.push(o.cutoff.days_before === 0 ? `Same-day orders close at ${clock12(o.cutoff.time)}.` : `Order by ${clock12(o.cutoff.time)} ${o.cutoff.days_before === 1 ? "the day before" : `${o.cutoff.days_before} days before`}.`);
  else if (o.lead_time_minutes >= 60) timeBits.push(`Allow at least ${Math.round(o.lead_time_minutes / 60 * 10) / 10} hour${o.lead_time_minutes === 60 ? "" : "s"} for us to make it fresh.`);
  document.querySelector("[data-step-time]").textContent = `Choose a date and time that works for you. ${timeBits.join(" ")}`.trim();
  const s4t = document.querySelector("[data-step-4-title]");
  const s4 = document.querySelector("[data-step-4]");
  if (methods.length === 1 && methods[0] === "pickup") { s4t.textContent = "Pick it up"; s4.textContent = "We make it fresh and have it packed and ready at your chosen time."; }
  if (methods.length === 1 && methods[0] === "delivery") { s4t.textContent = "We deliver"; s4.textContent = `We make it fresh and deliver it at your chosen time${cfg.delivery.zones.length ? ` to ${cfg.delivery.zones.map((z) => z.name).join(", ")}` : ""}.`; }
  if (methods.length === 2) { s4.textContent = `Collect it or get it delivered${cfg.delivery.zones.length ? ` (${cfg.delivery.zones.map((z) => z.name).join(", ")})` : ""}. We make it fresh for your chosen time.`; }
  document.querySelector("[data-hero-sticker]").textContent = methods.length === 2 ? "Pickup or delivery" : methods[0] === "delivery" ? "We deliver" : "Order online";
  // testimonials (only ones the owner marked as verified are served)
  if (c.testimonials?.length) {
    document.querySelector("[data-reviews]").hidden = false;
    document.querySelector("[data-quotes]").innerHTML = c.testimonials.map((t) => `<blockquote class="quote"><p>“${esc(t.quote)}”</p><footer>${esc(t.name)}</footer></blockquote>`).join("");
  }
  const b = cfg.business;
  const links = [
    b.whatsapp && `<a class="btn btn-primary" href="${esc(waLink(b.whatsapp, `Hi ${b.name}!`))}" target="_blank" rel="noopener">WhatsApp us</a>`,
    b.phone && `<a class="btn btn-dark" href="tel:${esc(b.phone)}">Call ${esc(b.phone)}</a>`,
    b.email && `<a class="btn btn-ghost" href="mailto:${esc(b.email)}">Email us</a>`,
    b.instagram && `<a class="btn btn-ghost" href="https://instagram.com/${esc(b.instagram)}" target="_blank" rel="noopener">Instagram</a>`,
    b.tiktok && `<a class="btn btn-ghost" href="https://www.tiktok.com/@${esc(b.tiktok)}" target="_blank" rel="noopener">TikTok</a>`,
  ].filter(Boolean);
  document.querySelector("[data-contact]").innerHTML = links.join("") || `<a class="btn btn-primary" href="/menu">Order online</a>`;
  if (b.pickup_address && o.pickup) document.querySelector("[data-contact-sub]").textContent = `Pickup from ${b.pickup_address}.`;
}

try {
  const menu = await getMenu();
  const grid = document.querySelector("[data-featured]");
  const featured = menu.products.filter((p) => p.featured && p.status !== "sold_out");
  const show = (featured.length ? featured : menu.products.filter((p) => p.status !== "sold_out")).slice(0, 6);
  // A photo from the menu becomes the hero picture once the owner has uploaded one.
  const withPhoto = show.find((p) => p.image_url);
  if (withPhoto) {
    const art = document.querySelector(".hero-art");
    art.querySelector("[data-hero-art]").remove();
    art.insertAdjacentHTML("afterbegin", `<div class="photo"><img src="${esc(withPhoto.image_url)}" alt="${esc(withPhoto.name)}"></div>`);
  }
  if (!show.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><p><b>The menu is being updated.</b></p><p class="muted">Please check back soon.</p></div>`;
  } else {
    grid.innerHTML = show.map(productCard).join("");
    wireCards(grid, menu.products);
  }
  document.querySelector("[data-categories]").innerHTML = menu.categories
    .filter((c) => menu.products.some((p) => p.category_id === c.id))
    .map((c) => `<a class="chip" href="/menu#${esc(c.slug)}">${esc(c.name)}</a>`).join("");
} catch (e) {
  document.querySelector("[data-featured]").innerHTML = `<p class="form-error" style="grid-column:1/-1">${esc(e.message)}</p>`;
}
