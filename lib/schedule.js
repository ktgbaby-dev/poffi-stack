// Fulfilment scheduling: which dates and time slots customers may choose, in Africa/Lagos time.
//
// A slot is bookable only when ALL of these hold:
//   ordering is switched on · the weekday is open · the slot starts within opening hours
//   · the date/slot is not closed by the owner · same-day rule · preparation lead time
//   · order cut-off (e.g. "by 4pm the day before") · not beyond the booking horizon
//   · fewer active orders in the slot than its capacity.
// Capacity is enforced inside the order transaction under a per-slot advisory lock, so two customers
// can never both take the last place.
import { getDb } from "./db.js";
import { TZ } from "./config.js";
import { HttpError } from "./http.js";
import { addDays, clock12, fromMinutes, partsIn, shortDate, toMinutes, weekdayOf, zonedToEpoch } from "./time.js";

// Orders that occupy a place: paid ones, and unpaid ones still inside their payment hold.
export const OCCUPYING_SQL = `status <> 'cancelled' AND (payment_status IN ('paid', 'refund_pending') OR (payment_status IN ('pending', 'failed') AND hold_expires_at > $NOW))`;

export function slotTimes(settings, date) {
  const o = settings.ordering;
  const h = o.hours[weekdayOf(date)];
  if (!h?.open) return [];
  const start = toMinutes(h.from);
  const end = h.to === "24:00" ? 24 * 60 : toMinutes(h.to);
  const out = [];
  for (let t = start; t < end; t += o.slot_minutes) out.push(fromMinutes(t));
  return out;
}

// Why a whole day can't be booked (null = it can, subject to per-slot checks).
export function dayReason(settings, date, nowMs, closures) {
  const o = settings.ordering;
  const today = partsIn(nowMs, TZ).date;
  if (!o.enabled) return "Online ordering is paused";
  if (date < today) return "In the past";
  if (date > addDays(today, o.max_days_ahead)) return "Too far ahead";
  if (!o.hours[weekdayOf(date)]?.open) return "Closed";
  if (closures.some((c) => c.date === date && !c.slot_time)) return closures.find((c) => c.date === date && !c.slot_time).reason || "Closed";
  if (!o.same_day && date === today) return "No same-day orders";
  if (o.cutoff.enabled) {
    const deadline = zonedToEpoch(addDays(date, -o.cutoff.days_before), o.cutoff.time, TZ);
    if (nowMs >= deadline) return o.cutoff.days_before === 0 ? `Orders for today close at ${clock12(o.cutoff.time)}` : "Past the order cut-off";
  }
  return null;
}

export function slotReason(settings, date, time, nowMs, closures, used = 0) {
  const o = settings.ordering;
  const dr = dayReason(settings, date, nowMs, closures);
  if (dr) return dr;
  if (!slotTimes(settings, date).includes(time)) return "Not an available time";
  if (closures.some((c) => c.date === date && c.slot_time === time)) return "Closed";
  if (zonedToEpoch(date, time, TZ) < nowMs + o.lead_time_minutes * 60_000) return "Not enough preparation time";
  if (used >= o.slot_capacity) return "Fully booked";
  return null;
}

async function loadClosures(q, from, to) {
  const { rows } = await q(`SELECT date::text AS date, slot_time, reason FROM schedule_closures WHERE date BETWEEN $1::date AND $2::date`, [from, to]);
  return rows;
}

async function loadUsage(q, from, to, nowMs, excludeOrderId = null) {
  const { rows } = await q(
    `SELECT scheduled_date::text AS date, scheduled_time AS time, count(*)::int AS n FROM orders
     WHERE scheduled_date BETWEEN $1::date AND $2::date AND ($4::bigint IS NULL OR id <> $4)
       AND ${OCCUPYING_SQL.replace("$NOW", "$3")}
     GROUP BY 1, 2`, [from, to, new Date(nowMs).toISOString(), excludeOrderId]);
  const map = new Map();
  for (const r of rows) map.set(`${r.date}|${r.time}`, r.n);
  return map;
}

export async function availability(settings, nowMs) {
  const { query } = await getDb();
  const o = settings.ordering;
  const today = partsIn(nowMs, TZ).date;
  const last = addDays(today, o.max_days_ahead);
  const closures = await loadClosures(query, today, last);
  const usage = await loadUsage(query, today, last, nowMs);
  const days = [];
  for (let d = today; d <= last; d = addDays(d, 1)) {
    const reason = dayReason(settings, d, nowMs, closures);
    const slots = reason ? [] : slotTimes(settings, d).map((t) => {
      const used = usage.get(`${d}|${t}`) || 0;
      const r = slotReason(settings, d, t, nowMs, closures, used);
      return { time: t, label: `${clock12(t)}–${clock12(fromMinutes(Math.min(toMinutes(t) + o.slot_minutes, 1439)))}`, available: !r, remaining: Math.max(0, o.slot_capacity - used), reason: r };
    });
    const open = !reason && slots.some((s) => s.available);
    days.push({ date: d, label: shortDate(d), open, reason: reason || (open ? null : slots.length ? "Fully booked" : "Closed"), slots });
  }
  return { timezone: TZ, slot_minutes: o.slot_minutes, days };
}

// Inside the order transaction: lock the slot, re-check every rule with fresh counts, or throw 409.
export async function lockAndCheckSlot(q, settings, date, time, nowMs, excludeOrderId = null) {
  await q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`slot:${date}|${time}`]);
  const closures = await loadClosures(q, date, date);
  const usage = await loadUsage(q, date, date, nowMs, excludeOrderId);
  const reason = slotReason(settings, date, time, nowMs, closures, usage.get(`${date}|${time}`) || 0);
  if (reason) throw new HttpError(409, "slot_unavailable", `That time isn't available any more (${reason.toLowerCase()}). Please choose another time.`, { field: "slot", reason });
  return { scheduledAt: zonedToEpoch(date, time, TZ) };
}

export async function listClosures(fromDate) {
  const { query } = await getDb();
  const { rows } = await query(`SELECT id, date::text AS date, slot_time, reason, created_at FROM schedule_closures WHERE date >= $1::date ORDER BY date, slot_time NULLS FIRST`, [fromDate]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
