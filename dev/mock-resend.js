// LOCAL RESEND TEST DOUBLE — development and tests only. It is NOT Resend and delivers nothing.
// It copies the parts of the Resend API the app uses: POST /emails (with scheduled_at and
// Idempotency-Key), GET /emails/:id, POST /emails/:id/cancel. Open its root URL to read captured emails.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export async function startMockResend({ port = 0, apiKey } = {}) {
  const state = { emails: [], byKey: new Map(), failNext: 0, failStatus: 500, rejectAll: false };
  const send = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString("utf8"); };
  const lastEvent = (e) => (e.cancelled ? "canceled" : e.scheduled_at && Date.parse(e.scheduled_at) > Date.now() ? "scheduled" : "delivered");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/view")) {
      const id = url.searchParams.get("id");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (id) { const e = state.emails.find((x) => x.id === id); return res.end(e ? e.html : "not found"); }
      return res.end(`<!doctype html><title>Local Resend test double</title><body style="font-family:system-ui;padding:16px">
<p style="background:#fff3cd;padding:8px;border-radius:6px"><b>LOCAL TEST DOUBLE — not Resend.</b> Nothing is delivered. ${state.emails.length} captured.</p>
<table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px"><tr><th>When</th><th>To</th><th>Subject</th><th>Scheduled</th><th>Status</th></tr>
${state.emails.slice().reverse().map((e) => `<tr><td>${e.created_at}</td><td>${e.to.join(", ")}</td><td><a href="/view?id=${e.id}">${e.subject}</a></td><td>${e.scheduled_at || ""}</td><td>${lastEvent(e)}</td></tr>`).join("")}</table></body>`);
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(res, 401, { statusCode: 401, message: "API key is invalid", name: "validation_error" });
    if (req.method === "POST" && url.pathname === "/emails") {
      if (state.rejectAll) return send(res, 422, { statusCode: 422, message: "Invalid `to` field (test double)", name: "validation_error" });
      if (state.failNext > 0) { state.failNext--; return send(res, state.failStatus, { statusCode: state.failStatus, message: "Temporary failure (test double)", name: "application_error" }); }
      const body = JSON.parse(await readBody(req) || "{}");
      const key = req.headers["idempotency-key"];
      if (key && state.byKey.has(key)) return send(res, 200, { id: state.byKey.get(key) });
      if (!body.from || !body.to || !body.subject) return send(res, 422, { statusCode: 422, message: "Missing required field", name: "validation_error" });
      const email = { id: randomUUID(), from: body.from, to: [].concat(body.to), subject: body.subject, html: body.html, text: body.text, reply_to: body.reply_to, scheduled_at: body.scheduled_at || null, idempotency_key: key || null, created_at: new Date().toISOString(), cancelled: false };
      state.emails.push(email);
      if (key) state.byKey.set(key, email.id);
      return send(res, 200, { id: email.id });
    }
    const m = /^\/emails\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m) {
      const e = state.emails.find((x) => x.id === decodeURIComponent(m[1]));
      if (!e) return send(res, 404, { statusCode: 404, message: "Email not found", name: "not_found" });
      if (req.method === "GET" && !m[2]) return send(res, 200, { object: "email", id: e.id, to: e.to, subject: e.subject, scheduled_at: e.scheduled_at, last_event: lastEvent(e) });
      if (req.method === "POST" && m[2]) {
        if (lastEvent(e) !== "scheduled") return send(res, 422, { statusCode: 422, message: "Email is not scheduled", name: "validation_error" });
        e.cancelled = true;
        return send(res, 200, { object: "email", id: e.id });
      }
    }
    send(res, 404, { statusCode: 404, message: "Not found", name: "not_found" });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, server, close: () => new Promise((r) => server.close(r)) };
}
