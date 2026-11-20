// Money is stored and calculated in kobo (integer). Display is in Naira.
export const naira = (kobo) => "₦" + (Math.round(Number(kobo) || 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Accepts naira as number or string ("2,500" / "2500.50") and returns kobo, or NaN.
export function nairaToKobo(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : NaN;
  if (typeof v !== "string") return NaN;
  const s = v.replace(/[₦,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

export const MAX_KOBO = 100_000_000_00; // ₦100m: a sanity ceiling for any single price
export const validKobo = (k) => Number.isInteger(k) && k >= 0 && k <= MAX_KOBO;
