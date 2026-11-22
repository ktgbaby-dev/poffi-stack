import { cart, esc, getMenu, initChrome } from "./app.js";
import { productCard, wireCards } from "./cards.js";

const cfg = await initChrome();
if (cfg && !cfg.ordering.open) document.querySelector("[data-closed]").hidden = false;

const cta = document.querySelector("[data-checkout-cta]");
const syncCta = () => { cta.hidden = cart.count() === 0; };
syncCta();
cart.subscribe(syncCta);

const root = document.querySelector("[data-menu]");
try {
  const menu = await getMenu();
  const groups = menu.categories.map((c) => ({ ...c, items: menu.products.filter((p) => p.category_id === c.id) })).filter((g) => g.items.length);
  const loose = menu.products.filter((p) => p.category_id === null || !menu.categories.some((c) => c.id === p.category_id));
  if (loose.length) groups.push({ id: 0, name: "More", slug: "more", description: "", items: loose });
  if (!groups.length) {
    root.innerHTML = `<div class="empty"><p><b>The menu is being updated.</b></p><p class="muted">Please check back soon.</p></div>`;
  } else {
    document.querySelector("[data-tabs]").innerHTML = groups.map((g, i) => `<a href="#${esc(g.slug)}" class="${i === 0 ? "active" : ""}" data-tab="${esc(g.slug)}">${esc(g.name)}</a>`).join("");
    root.innerHTML = groups.map((g) => `<section class="menu-cat" id="${esc(g.slug)}" aria-labelledby="h-${esc(g.slug)}">
        <h2 id="h-${esc(g.slug)}">${esc(g.name)}</h2>${g.description ? `<p>${esc(g.description)}</p>` : ""}
        <div class="grid">${g.items.map(productCard).join("")}</div></section>`).join("");
    wireCards(root, menu.products);
    // highlight the tab of the section in view
    const tabs = [...document.querySelectorAll("[data-tab]")];
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === en.target.id));
        tabs.find((t) => t.dataset.tab === en.target.id)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
      }
    }, { rootMargin: "-160px 0px -60% 0px" });
    document.querySelectorAll(".menu-cat").forEach((s) => io.observe(s));
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }
} catch (e) {
  root.innerHTML = `<p class="form-error" style="padding:30px 0">${esc(e.message)}</p>`;
}
