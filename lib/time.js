// Calendar maths in the business timezone (Africa/Lagos). Dates are "YYYY-MM-DD", times "HH:MM".
import { TZ } from "./config.js";

const partsFmt = new Map();
function fmt(tz) {
  if (!partsFmt.has(tz)) {
    partsFmt.set(tz, new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
    }));
  }
  return partsFmt.get(tz);
}

// Wall-clock parts of an instant in a timezone.
export function partsIn(epochMs, tz = TZ) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(epochMs))) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday)],
  };
}

// The instant at which the wall clock in `tz` shows date+time (handles any UTC offset, incl. DST zones).
export function zonedToEpoch(date, time, tz = TZ) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(t, tz);
    const [py, pm, pd] = p.date.split("-").map(Number);
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    const diff = shown - guess;
    if (diff === 0) break;
    t -= diff;
  }
  return t;
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export const toMinutes = (time) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
export const fromMinutes = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

export function clock12(time) {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

export function longDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function shortDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function slotLabel(date, time, slotMinutes) {
  const end = fromMinutes(Math.min(toMinutes(time) + (slotMinutes || 0), 24 * 60 - 1));
  return `${longDate(date)}, ${clock12(time)}${slotMinutes ? `–${clock12(end)}` : ""}`;
}

export function dateTimeIn(epochMs, tz = TZ) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(new Date(epochMs));
}
