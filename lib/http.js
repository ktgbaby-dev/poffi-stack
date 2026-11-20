// HTTP helpers for the Web-standard (Request/Response) handlers.

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code, message, extra) => new HttpError(400, code, message, extra);
export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message, ...err.extra }, err.status);
  }
  console.error(JSON.stringify({ event: "server_error", message: err?.message, stack: err?.stack?.split("\n").slice(0, 6).join(" | ") }));
  return json({ error: "server_error", message: "Something went wrong on our side. Please try again." }, 500);
}

// Reads a JSON object body. Requiring application/json means a plain cross-site form cannot post here.
export async function readJson(request, maxBytes = 64 * 1024) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Send the request as JSON.");
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "too_large", "That request is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, "too_large", "That request is too large.");
  try {
    const data = JSON.parse(text || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    return data;
  } catch {
    throw bad("bad_json", "The request couldn't be read.");
  }
}

export function clientIp(request) {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "local";
}

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// --- small validators -------------------------------------------------------
export const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const int = (v) => (Number.isInteger(v) ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN);
export const bool = (v) => v === true || v === "true" || v === 1;
export const isEmail = (v) => typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
export function normPhone(v) {
  const raw = str(v, 40).replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(raw)) return "";
  return raw;
}
export const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
export const isTime = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
