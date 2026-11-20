// Local development server: serves public/ like Vercel (clean URLs) and sends /api/* and /media/* to the
// same router the Vercel function uses. Not deployed.
//
//   node dev/server.js                  uses .env.local (DATABASE_URL defaults to pglite:./.data/dev)
//   node dev/server.js --mocks          also starts the local Paystack + Resend test doubles
//   node dev/server.js --mocks --cron=60  and runs the automation every 60 s, like a scheduler would
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(root, "public");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));

// .env.local (never committed) for local settings.
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const port = Number(args.port || process.env.PORT || 5680);
process.env.DATABASE_URL ??= "pglite:" + join(root, ".data", "dev");
process.env.SESSION_SECRET ??= "dev-only-session-secret-change-me-0123456789";
process.env.CRON_SECRET ??= "dev-only-cron-secret-0123456789";
process.env.SITE_URL ??= `http://localhost:${port}`;

let mocks = null;
if (args.mocks) {
  const { startMockPaystack } = await import("./mock-paystack.js");
  const { startMockResend } = await import("./mock-resend.js");
  const sk = "sk_test_local_double_000000000000";
  const whsec = "whsec_local_double_000000000000";
  const paystack = await startMockPaystack({ port: Number(args["paystack-port"] || 5681), secretKey: sk, webhookSecret: whsec, webhookUrl: `http://127.0.0.1:${port}/api/paystack/webhook` });
  const resend = await startMockResend({ port: Number(args["resend-port"] || 5682), apiKey: "re_local_double" });
  Object.assign(process.env, {
    PAYSTACK_SECRET_KEY: sk, PAYSTACK_BASE_URL: paystack.url, PAYSTACK_WEBHOOK_SECRET: whsec,
    RESEND_API_KEY: "re_local_double", RESEND_BASE_URL: resend.url, EMAIL_FROM: "Poffi Stack <orders@localhost.test>",
  });
  mocks = { paystack, resend };
  console.log(`Local Paystack test double: ${paystack.url}   Local Resend test double (captured emails): ${resend.url}`);
}

const { handle } = await import("../lib/router.js");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
const CLEAN = { "/": "index.html", "/menu": "menu.html", "/checkout": "checkout.html", "/order": "order.html", "/admin": "admin/index.html", "/admin/": "admin/index.html" };
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY" };

async function readBody(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); }

async function serveStatic(req, res, pathname) {
  let rel = CLEAN[pathname] || pathname.replace(/^\/+/, "");
  if (rel.endsWith(".html") && !CLEAN[pathname] && rel !== "404.html") rel = rel; // direct .html access still works
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir)) { res.writeHead(403).end(); return; }
  try {
    const s = await stat(file);
    if (s.isDirectory()) throw new Error("dir");
    const type = MIME[extname(file)] || "application/octet-stream";
    const cache = /\/assets\/(fonts|img)\//.test(file.replace(/\\/g, "/")) ? "public, max-age=86400" : "no-cache";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, ...SECURITY });
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...SECURITY });
    res.end(await readFile(join(publicDir, "404.html")).catch(() => "Not found"));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: hasBody ? await readBody(req) : undefined });
      const response = await handle(request);
      const headers = {};
      for (const [k, v] of response.headers) if (k !== "set-cookie") headers[k] = v;
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, { ...SECURITY, ...headers });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Poffi Stack ordering: http://localhost:${port}  (dashboard: /admin)`));

if (args.cron) {
  const every = Math.max(10, Number(args.cron === true ? 60 : args.cron)) * 1000;
  const { runAutomation } = await import("../lib/routes/system.js");
  setInterval(() => runAutomation(process.env.SITE_URL, "dev-cron").catch((e) => console.error("dev cron:", e.message)), every);
  console.log(`Automation runs every ${every / 1000}s (dev scheduler).`);
}

export { server, mocks };
