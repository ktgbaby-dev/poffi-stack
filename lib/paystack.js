// Paystack REST client and webhook signature checks (https://paystack.com/docs/, checked 16 Nov 2026).
// The secret key never leaves the server.
import { createHmac, timingSafeEqual } from "node:crypto";
import { paystackConfig } from "./config.js";

const TIMEOUT_MS = 15_000;
export const SIGNATURE_TOLERANCE_S = 300;

export class PaystackError extends Error {
  constructor(message, { status = 0, retryable = false, data = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.data = data;
  }
}

async function call(method, path, body) {
  const cfg = paystackConfig();
  if (!cfg.configured) throw new PaystackError("Paystack isn't set up yet (PAYSTACK_SECRET_KEY is missing).", { status: 503 });
  if (cfg.mode === "live" && !cfg.liveAllowed) throw new PaystackError("Live Paystack payments are not switched on (PAYSTACK_ALLOW_LIVE).", { status: 503 });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok || data?.status === false) {
      throw new PaystackError(data?.message || `Paystack answered ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500, data });
    }
    return data;
  } catch (err) {
    if (err instanceof PaystackError) throw err;
    throw new PaystackError(err?.name === "AbortError" ? "Paystack did not answer in time." : `Could not reach Paystack (${err?.message}).`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// amountKobo is the amount in the currency's subunit, as Paystack requires.
export async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  const r = await call("POST", "/transaction/initialize", {
    email, amount: String(amountKobo), currency: "NGN", reference, callback_url: callbackUrl,
    metadata: JSON.stringify(metadata || {}),
  });
  return { authorizationUrl: r.data.authorization_url, accessCode: r.data.access_code, reference: r.data.reference };
}

export async function verifyTransaction(reference) {
  const r = await call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
  return r.data;
}

export async function createRefund({ transaction, reference, amountKobo }) {
  const body = { transaction, reference };
  if (amountKobo) body.amount = amountKobo;
  const r = await call("POST", "/refund", body);
  return r.data;
}

export async function fetchRefund(reference) {
  const r = await call("GET", `/refund?reference=${encodeURIComponent(reference)}`);
  return Array.isArray(r.data) ? r.data[0] || null : r.data;
}

// ---------- webhook signatures ----------
const isHex128 = (s) => /^[0-9a-f]{128}$/.test(s);

// Current scheme: "Paystack-Signature: t=<unix>,v1=<kid>:<hex>[,v1=...]", HMAC-SHA512 of `${t}.${rawBody}`
// with the webhook signing secret (whsec_...). Returns the matching key id, or null.
export function verifyPaystackSignature(rawBody, header, secrets, nowS = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== "string" || !secrets?.length) return null;
  let t = null;
  const entries = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") {
      if (t !== null || !/^\d+$/.test(value)) return null;
      t = Number(value);
    } else if (key === "v1") {
      const j = value.indexOf(":");
      if (j !== -1) entries.push({ kid: value.slice(0, j), hex: value.slice(j + 1) });
    }
  }
  if (t === null || !entries.length) return null;
  if (Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return null;
  for (const secret of secrets) {
    const expected = createHmac("sha512", secret).update(`${t}.`).update(rawBody).digest();
    for (const { kid, hex } of entries) {
      if (!isHex128(hex)) continue;
      if (timingSafeEqual(expected, Buffer.from(hex, "hex"))) return kid;
    }
  }
  return null;
}

// Legacy scheme: "x-paystack-signature: <hex>", HMAC-SHA512 of the raw body with the secret key.
export function verifyLegacySignature(rawBody, header, secretKey) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== "string" || !secretKey || !isHex128(header)) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(header, "hex"));
}

// Accepts an event when the current header verifies against a configured whsec_ secret, or — only when
// the event carries no current header — when the legacy header verifies against the secret key.
export function verifyWebhook(rawBody, headers, nowS) {
  const cfg = paystackConfig();
  const current = headers.get("paystack-signature");
  if (current && cfg.webhookSecrets.length) {
    return verifyPaystackSignature(rawBody, current, cfg.webhookSecrets, nowS) ? { ok: true, scheme: "paystack-signature" } : { ok: false };
  }
  const legacy = headers.get("x-paystack-signature");
  if (legacy && cfg.secret && verifyLegacySignature(rawBody, legacy, cfg.secret)) return { ok: true, scheme: "x-paystack-signature" };
  return { ok: false };
}

// Test helpers (also used by the local Paystack test double).
export function signCurrent(rawBody, secret, kid = "whk_local", t = Math.floor(Date.now() / 1000)) {
  const hex = createHmac("sha512", secret).update(`${t}.`).update(rawBody).digest("hex");
  return `t=${t},v1=${kid}:${hex}`;
}
export const signLegacy = (rawBody, secretKey) => createHmac("sha512", secretKey).update(rawBody).digest("hex");
