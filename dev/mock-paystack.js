// LOCAL PAYSTACK TEST DOUBLE — for development and automated tests only. It is NOT Paystack.
// It copies the documented contract of the endpoints this app uses (transaction initialize/verify,
// refund create/fetch, webhooks signed with both Paystack-Signature and x-paystack-signature), so the
// whole order flow can be exercised without network access or Paystack keys.
// A real Paystack test-mode run needs the business's sk_test_ key: see docs/DEPLOYMENT.md.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { signCurrent, signLegacy } from "../lib/paystack.js";

export async function startMockPaystack({ port = 0, secretKey, webhookSecret, webhookUrl } = {}) {
  const state = {
    transactions: new Map(), // reference -> tx
    byCode: new Map(),
    refunds: new Map(),
    webhooks: [],
    // knobs for tests
    failNextInit: 0,
    amountOverride: null, // { reference, amount } to simulate a mismatch
    currencyOverride: null,
    webhookMode: "both", // both | current | legacy | none
    webhookUrl,
    autoProcessRefunds: true,
  };
  let nextId = 5_000_000_000;

  const send = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString("utf8"); };
  const authed = (req) => req.headers.authorization === `Bearer ${secretKey}`;

  async function postWebhook(event) {
    if (!state.webhookUrl || state.webhookMode === "none") return null;
    const raw = Buffer.from(JSON.stringify(event));
    const headers = { "Content-Type": "application/json" };
    if (state.webhookMode !== "legacy" && webhookSecret) headers["Paystack-Signature"] = signCurrent(raw, webhookSecret, "whk_local");
    if (state.webhookMode !== "current") headers["x-paystack-signature"] = signLegacy(raw, secretKey);
    try {
      const r = await fetch(state.webhookUrl, { method: "POST", headers, body: raw });
      state.webhooks.push({ event: event.event, status: r.status });
      return r.status;
    } catch (err) {
      state.webhooks.push({ event: event.event, error: err.message });
      return 0;
    }
  }

  const txData = (tx) => ({
    id: tx.id, domain: "test", status: tx.status, reference: tx.reference, receipt_number: null,
    amount: state.amountOverride?.reference === tx.reference ? state.amountOverride.amount : tx.amount,
    requested_amount: state.amountOverride?.reference === tx.reference ? state.amountOverride.amount : tx.amount,
    message: null, gateway_response: tx.status === "success" ? "Successful" : tx.status === "failed" ? "Declined" : tx.status === "abandoned" ? "The transaction was not completed" : "",
    paid_at: tx.paid_at, paidAt: tx.paid_at, created_at: tx.created_at, channel: "card",
    currency: state.currencyOverride?.reference === tx.reference ? state.currencyOverride.currency : "NGN",
    metadata: tx.metadata, customer: { email: tx.email }, authorization: { last4: "4081", bank: "TEST BANK", channel: "card" },
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      // ---- API ----
      if (req.method === "POST" && url.pathname === "/transaction/initialize") {
        if (!authed(req)) return send(res, 401, { status: false, message: "Invalid key" });
        if (state.failNextInit > 0) { state.failNextInit--; return send(res, 503, { status: false, message: "Service unavailable (test double)" }); }
        const body = JSON.parse(await readBody(req) || "{}");
        const amount = Number(body.amount);
        if (!body.email || !Number.isInteger(amount) || amount < 1) return send(res, 400, { status: false, message: "Invalid amount or email" });
        const reference = body.reference || randomBytes(6).toString("hex");
        if (!/^[A-Za-z0-9.=-]+$/.test(reference)) return send(res, 400, { status: false, message: "Invalid reference" });
        if (state.transactions.has(reference)) return send(res, 400, { status: false, message: "Duplicate Transaction Reference" });
        const code = randomBytes(8).toString("hex");
        const tx = { id: nextId++, reference, amount, email: body.email, currency: body.currency || "NGN", callback_url: body.callback_url, metadata: body.metadata, status: "ongoing", access_code: code, created_at: new Date().toISOString(), paid_at: null };
        state.transactions.set(reference, tx);
        state.byCode.set(code, tx);
        return send(res, 200, { status: true, message: "Authorization URL created", data: { authorization_url: `${baseUrl}/checkout/${code}`, access_code: code, reference } });
      }
      if (req.method === "GET" && url.pathname.startsWith("/transaction/verify/")) {
        if (!authed(req)) return send(res, 401, { status: false, message: "Invalid key" });
        const ref = decodeURIComponent(url.pathname.slice("/transaction/verify/".length));
        const tx = state.transactions.get(ref);
        if (!tx) return send(res, 400, { status: false, message: "Transaction reference not found" });
        return send(res, 200, { status: true, message: "Verification successful", data: txData(tx) });
      }
      if (req.method === "POST" && url.pathname === "/refund") {
        if (!authed(req)) return send(res, 401, { status: false, message: "Invalid key" });
        const body = JSON.parse(await readBody(req) || "{}");
        const tx = state.transactions.get(body.transaction) || [...state.transactions.values()].find((t) => String(t.id) === String(body.transaction));
        if (!tx || tx.status !== "success") return send(res, 400, { status: false, message: "Transaction not found or not successful" });
        if (body.reference && state.refunds.has(body.reference)) return send(res, 409, { status: false, message: `A refund with reference ${body.reference} already exists` });
        const refund = { id: nextId++, reference: body.reference || randomBytes(6).toString("hex"), transaction_reference: tx.reference, amount: body.amount || tx.amount, status: "pending", currency: "NGN" };
        state.refunds.set(refund.reference, refund);
        if (state.autoProcessRefunds) {
          setTimeout(async () => {
            refund.status = "processed";
            tx.status = "reversed";
            await postWebhook({ event: "refund.processed", data: { id: refund.id, status: "processed", refund_reference: refund.reference, transaction_reference: tx.reference, amount: refund.amount, currency: "NGN" } });
          }, 50);
        }
        return send(res, 200, { status: true, message: "Refund has been queued for processing", data: { ...refund, transaction: { reference: tx.reference, id: tx.id } } });
      }
      if (req.method === "GET" && url.pathname === "/refund") {
        if (!authed(req)) return send(res, 401, { status: false, message: "Invalid key" });
        const r = state.refunds.get(url.searchParams.get("reference") || "");
        return send(res, 200, { status: true, message: "Refunds retrieved", data: r ? [r] : [] });
      }

      // ---- hosted checkout page (stands in for checkout.paystack.com) ----
      const m = /^\/checkout\/([a-f0-9]+)(?:\/(pay|fail|cancel))?$/.exec(url.pathname);
      if (m) {
        const tx = state.byCode.get(m[1]);
        if (!tx) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Unknown checkout"); }
        if (req.method === "GET" && !m[2]) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Paystack test double</title>
<body style="font-family:system-ui;margin:0;background:#0b1e2d;color:#fff;display:grid;place-items:center;min-height:100vh">
<main style="background:#fff;color:#111;border-radius:14px;padding:28px;max-width:360px;width:calc(100% - 32px)">
<p style="background:#fff3cd;color:#664d03;padding:8px 10px;border-radius:8px;font-size:13px;margin:0 0 14px"><b>LOCAL TEST DOUBLE — not Paystack.</b> No real money moves.</p>
<p style="margin:0;color:#555">${tx.email}</p><h1 style="margin:6px 0 18px">Pay NGN ${(tx.amount / 100).toLocaleString("en-NG")}</h1>
<p style="font-size:13px;color:#555;margin:0 0 16px">Reference: <code>${tx.reference}</code></p>
<form method="post" action="/checkout/${m[1]}/pay"><button id="pay-success" style="width:100%;padding:13px;border:0;border-radius:8px;background:#0ba4db;color:#fff;font-size:16px;margin-bottom:8px">Pay (test success)</button></form>
<form method="post" action="/checkout/${m[1]}/fail"><button id="pay-fail" style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;background:#fff;margin-bottom:8px">Decline card (test failure)</button></form>
<form method="post" action="/checkout/${m[1]}/cancel"><button id="pay-cancel" style="width:100%;padding:12px;border:0;background:none;color:#555">Cancel payment</button></form>
</main></body>`);
        }
        if (req.method === "POST" && m[2]) {
          if (tx.status === "ongoing") {
            if (m[2] === "pay") {
              tx.status = "success"; tx.paid_at = new Date().toISOString();
              await postWebhook({ event: "charge.success", data: txData(tx) });
            } else if (m[2] === "fail") tx.status = "failed";
            else tx.status = "abandoned";
          }
          const back = new URL(tx.callback_url);
          back.searchParams.set("trxref", tx.reference);
          back.searchParams.set("reference", tx.reference);
          res.writeHead(302, { Location: back.toString() });
          return res.end();
        }
      }
      send(res, 404, { status: false, message: "Not found (test double)" });
    } catch (err) {
      send(res, 500, { status: false, message: err.message });
    }
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    url: baseUrl, state, server,
    // Test helpers: drive a transaction as if the customer acted on the hosted page.
    async complete(reference, outcome = "pay", { webhook = true } = {}) {
      const tx = state.transactions.get(reference);
      if (!tx) throw new Error(`unknown reference ${reference}`);
      if (outcome === "pay") { tx.status = "success"; tx.paid_at = new Date().toISOString(); if (webhook) return postWebhook({ event: "charge.success", data: txData(tx) }); }
      else tx.status = outcome === "fail" ? "failed" : "abandoned";
      return null;
    },
    resendWebhook: (reference) => postWebhook({ event: "charge.success", data: txData(state.transactions.get(reference)) }),
    close: () => new Promise((r) => server.close(r)),
  };
}
