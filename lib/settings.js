// Business settings. Stored per section in the `settings` table, merged over safe defaults.
// Defaults never invent business facts: ordering stays OFF and every day CLOSED until the owner sets them.
import { getDb } from "./db.js";
import { bad, bool, isEmail, isTime, int, normPhone, str } from "./http.js";
import { nairaToKobo, validKobo } from "./money.js";
import { emailConfig } from "./config.js";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const STATUS_EMAIL_KEYS = ["confirmed", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];

export function defaults() {
  return {
    business: {
      name: "Poffi Stack",
      tagline: "Freshly made. Packed with love.", // from Poffi Stack's own TikTok bio
      phone: "", whatsapp: "", email: "", instagram: "", tiktok: "",
      pickup_address: "", pickup_instructions: "",
    },
    notifications: {
      owner_email: "",
      new_order: true,
      cancellation: true,
      reminder_offsets: [60, 30],
      customer_confirmation: true,
      customer_status: { confirmed: true, preparing: false, ready: true, out_for_delivery: true, completed: false, cancelled: true },
    },
    ordering: {
      enabled: false,
      pickup: true,
      delivery: false,
      hours: Object.fromEntries(WEEKDAYS.map((d) => [d, { open: false, from: "09:00", to: "17:00" }])),
      slot_minutes: 30,
      slot_capacity: 5,
      lead_time_minutes: 60,
      same_day: true,
      cutoff: { enabled: false, time: "16:00", days_before: 1 },
      max_days_ahead: 14,
      hold_minutes: 30,
      min_order_kobo: 0,
    },
    delivery: { zones: [], note: "" },
    content: { hero_title: "Freshly made. Packed with love.", hero_text: "", about_title: "", about_text: "", announcement: "", testimonials: [] },
  };
}

const SECTIONS = Object.keys(defaults());

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

export async function getSettings(q) {
  const run = q || (await getDb()).query;
  const { rows } = await run(`SELECT key, value FROM settings`);
  const s = defaults();
  for (const r of rows) if (SECTIONS.includes(r.key)) s[r.key] = merge(s[r.key], r.value);
  return s;
}

export function ownerRecipients(settings) {
  const raw = settings.notifications.owner_email || emailConfig().ownerEmailEnv || "";
  return raw.split(",").map((e) => e.trim()).filter(isEmail);
}

export function isOrderingReady(settings) {
  const o = settings.ordering;
  const anyDay = WEEKDAYS.some((d) => o.hours[d]?.open);
  const method = o.pickup || (o.delivery && settings.delivery.zones.some((z) => z.active));
  return { ready: !!(o.enabled && anyDay && method), anyDay, method: !!method };
}

// ---------- validation per section ----------
const url = (v) => { const s = str(v, 300); if (!s) return ""; try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? s : ""; } catch { return ""; } };
const handle = (v) => str(v, 60).replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "");

const validators = {
  business(v) {
    const name = str(v.name, 80);
    if (!name) throw bad("invalid_settings", "Business name is required.", { field: "name" });
    const out = {
      name,
      tagline: str(v.tagline, 140),
      phone: str(v.phone, 30) ? normPhone(v.phone) : "",
      whatsapp: str(v.whatsapp, 30) ? normPhone(v.whatsapp) : "",
      email: str(v.email, 254),
      instagram: handle(v.instagram),
      tiktok: handle(v.tiktok),
      pickup_address: str(v.pickup_address, 400),
      pickup_instructions: str(v.pickup_instructions, 400),
    };
    if (str(v.phone, 30) && !out.phone) throw bad("invalid_settings", "Phone number doesn't look right.", { field: "phone" });
    if (str(v.whatsapp, 30) && !out.whatsapp) throw bad("invalid_settings", "WhatsApp number doesn't look right.", { field: "whatsapp" });
    if (out.email && !isEmail(out.email)) throw bad("invalid_settings", "Contact email doesn't look right.", { field: "email" });
    return out;
  },
  notifications(v) {
    const owner = str(v.owner_email, 600);
    const list = owner.split(",").map((e) => e.trim()).filter(Boolean);
    if (list.some((e) => !isEmail(e))) throw bad("invalid_settings", "Notification email doesn't look right.", { field: "owner_email" });
    const offsets = Array.isArray(v.reminder_offsets) ? v.reminder_offsets.map(int) : [];
    if (offsets.some((n) => !Number.isInteger(n) || n < 5 || n > 24 * 60)) throw bad("invalid_settings", "Reminder times must be between 5 minutes and 24 hours before.", { field: "reminder_offsets" });
    const cs = v.customer_status || {};
    return {
      owner_email: list.join(", "),
      new_order: bool(v.new_order),
      cancellation: bool(v.cancellation),
      reminder_offsets: [...new Set(offsets)].sort((a, b) => b - a).slice(0, 4),
      customer_confirmation: bool(v.customer_confirmation),
      customer_status: Object.fromEntries(STATUS_EMAIL_KEYS.map((k) => [k, bool(cs[k])])),
    };
  },
  ordering(v) {
    const hours = {};
    for (const d of WEEKDAYS) {
      const h = v.hours?.[d] || {};
      const open = bool(h.open);
      const from = isTime(h.from) ? h.from : "09:00";
      const to = isTime(h.to) || h.to === "24:00" ? h.to : "17:00";
      if (open && from >= to) throw bad("invalid_settings", `Opening time must be before closing time (${d}).`, { field: `hours.${d}` });
      hours[d] = { open, from, to };
    }
    const n = (key, min, max) => {
      const x = int(v[key]);
      if (!Number.isInteger(x) || x < min || x > max) throw bad("invalid_settings", `${key.replace(/_/g, " ")} must be between ${min} and ${max}.`, { field: key });
      return x;
    };
    const cutoff = v.cutoff || {};
    const cdays = int(cutoff.days_before);
    if (bool(cutoff.enabled) && (!isTime(cutoff.time) || !Number.isInteger(cdays) || cdays < 0 || cdays > 7)) {
      throw bad("invalid_settings", "Cut-off needs a time and 0–7 days before.", { field: "cutoff" });
    }
    const minOrder = typeof v.min_order_kobo === "number" ? v.min_order_kobo : nairaToKobo(String(v.min_order ?? "0"));
    if (!validKobo(minOrder)) throw bad("invalid_settings", "Minimum order amount doesn't look right.", { field: "min_order" });
    const slot = n("slot_minutes", 10, 240);
    return {
      enabled: bool(v.enabled),
      pickup: bool(v.pickup),
      delivery: bool(v.delivery),
      hours,
      slot_minutes: slot,
      slot_capacity: n("slot_capacity", 1, 500),
      lead_time_minutes: n("lead_time_minutes", 0, 7 * 24 * 60),
      same_day: bool(v.same_day),
      cutoff: { enabled: bool(cutoff.enabled), time: isTime(cutoff.time) ? cutoff.time : "16:00", days_before: Number.isInteger(cdays) ? cdays : 1 },
      max_days_ahead: n("max_days_ahead", 0, 60),
      hold_minutes: n("hold_minutes", 10, 180),
      min_order_kobo: minOrder,
    };
  },
  delivery(v) {
    const zones = (Array.isArray(v.zones) ? v.zones : []).slice(0, 40).map((z, i) => {
      const name = str(z.name, 80);
      const fee = typeof z.fee_kobo === "number" ? z.fee_kobo : nairaToKobo(String(z.fee ?? ""));
      if (!name) throw bad("invalid_settings", `Delivery area ${i + 1} needs a name.`, { field: `zones.${i}.name` });
      if (!validKobo(fee)) throw bad("invalid_settings", `Delivery fee for ${name} doesn't look right.`, { field: `zones.${i}.fee` });
      const id = str(z.id, 40).replace(/[^a-z0-9-]/gi, "") || `zone-${Date.now().toString(36)}-${i}`;
      return { id, name, fee_kobo: fee, active: z.active === undefined ? true : bool(z.active) };
    });
    if (new Set(zones.map((z) => z.id)).size !== zones.length) throw bad("invalid_settings", "Two delivery areas share an id.");
    return { zones, note: str(v.note, 400) };
  },
  content(v) {
    const testimonials = (Array.isArray(v.testimonials) ? v.testimonials : []).slice(0, 12).map((t) => ({
      quote: str(t.quote, 400), name: str(t.name, 80), verified: bool(t.verified),
    })).filter((t) => t.quote && t.name);
    return {
      hero_title: str(v.hero_title, 120),
      hero_text: str(v.hero_text, 300),
      about_title: str(v.about_title, 120),
      about_text: str(v.about_text, 1500),
      announcement: str(v.announcement, 200),
      testimonials,
    };
  },
};

export function validateSection(section, value) {
  if (!SECTIONS.includes(section)) throw bad("unknown_section", "Unknown settings section.");
  if (!value || typeof value !== "object") throw bad("invalid_settings", "Settings must be an object.");
  return validators[section](value);
}

export async function saveSection(section, value, adminId, q) {
  const clean = validateSection(section, value);
  const run = q || (await getDb()).query;
  await run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2::text::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [section, JSON.stringify(clean), adminId ?? null],
  );
  return clean;
}
