import { esc, fromPrice, naira, needsOptions, openProduct, productImage, quickAdd } from "./app.js";

export function productCard(p) {
  const price = fromPrice(p);
  const sold = p.status === "sold_out";
  return `<article class="card ${sold ? "sold-out" : ""}" data-product="${p.id}">
    <div class="card-media">${productImage(p)}${sold ? `<span class="badge">Sold out</span>` : p.featured ? `<span class="badge featured">Popular</span>` : ""}</div>
    <div class="card-body">
      <h3>${esc(p.name)}</h3>
      ${p.description ? `<p>${esc(p.description)}</p>` : ""}
      <div class="card-foot">
        <span class="price">${price.from ? "<small>from</small>" : ""}${naira(price.kobo)}</span>
        <button class="btn btn-primary btn-sm add-btn" data-add="${p.id}" ${sold ? "disabled" : ""} aria-label="${sold ? `${esc(p.name)} is sold out` : `Add ${esc(p.name)}`}">${sold ? "Sold out" : needsOptions(p) ? "Choose" : "Add"}</button>
      </div>
    </div>
  </article>`;
}

export function wireCards(root, products) {
  root.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    const card = e.target.closest("[data-product]");
    if (!card) return;
    const p = products.find((x) => x.id === Number(card.dataset.product));
    if (!p) return;
    if (add && !needsOptions(p) && p.status !== "sold_out") return quickAdd(p);
    if (add || e.target.closest(".card-media, h3")) openProduct(p, { trigger: add || card });
  });
}
