// One router for every /api/* request (and /media/*). Deployed as a single Vercel function.
import { HttpError, errorResponse, json } from "./http.js";
import { publicRoutes } from "./routes/public.js";
import { adminRoutes } from "./routes/admin.js";
import { systemRoutes } from "./routes/system.js";

const ROUTES = [...systemRoutes, ...publicRoutes, ...adminRoutes].map(([method, pattern, handler]) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  return { method, re, keys, handler };
});

// Vercel rewrites send everything to /api/index?__path=<original path>; locally the dev server calls us directly.
export function routePath(request) {
  const url = new URL(request.url);
  const forced = url.searchParams.get("__path");
  if (forced !== null) return "/" + forced.replace(/^\/+/, "");
  return url.pathname;
}

export async function handle(request) {
  const path = routePath(request);
  let allowed = [];
  try {
    for (const r of ROUTES) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== request.method && !(r.method === "GET" && request.method === "HEAD")) { allowed.push(r.method); continue; }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return await r.handler(request, params);
    }
    if (allowed.length) return json({ error: "method_not_allowed", message: "Method not allowed." }, 405, { Allow: [...new Set(allowed)].join(", ") });
    throw new HttpError(404, "not_found", "Not found.");
  } catch (err) {
    if (err?.code === "db_not_configured") return json({ error: "not_configured", message: "The database isn't set up yet (DATABASE_URL)." }, 503);
    return errorResponse(err);
  }
}
