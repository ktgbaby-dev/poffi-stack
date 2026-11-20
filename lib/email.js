// Resend REST client (https://resend.com/docs). Never throws: returns { ok, retryable, error, data }.
import { emailConfig } from "./config.js";

const TIMEOUT_MS = 8000;

export function senderAddress(settings) {
  const cfg = emailConfig();
  return cfg.from || `${settings?.business?.name || "Poffi Stack"} <onboarding@resend.dev>`;
}

export async function resend(path, { method = "POST", body, idempotencyKey } = {}) {
  const cfg = emailConfig();
  if (!cfg.configured) return { ok: false, off: true, retryable: false, error: "RESEND_API_KEY is not set" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 256) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const raw = await res.text().catch(() => "");
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
    if (res.ok) return { ok: true, status: res.status, data };
    const detail = String(data?.message || raw || "").slice(0, 300);
    return { ok: false, status: res.status, data, error: `Resend answered ${res.status}${detail ? `: ${detail}` : ""}`, retryable: res.status === 429 || res.status === 408 || res.status >= 500 };
  } catch (err) {
    return { ok: false, status: 0, retryable: true, error: err?.name === "AbortError" ? "Resend did not answer in time" : `Could not reach Resend (${err?.message})` };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendEmail({ to, subject, html, text, scheduledAt, idempotencyKey, settings }) {
  const cfg = emailConfig();
  const body = { from: senderAddress(settings), to: Array.isArray(to) ? to : [to], subject, html, text };
  if (cfg.replyTo) body.reply_to = cfg.replyTo;
  else if (settings?.business?.email) body.reply_to = settings.business.email;
  if (scheduledAt) body.scheduled_at = new Date(scheduledAt).toISOString();
  return resend("/emails", { body, idempotencyKey });
}

export const cancelScheduledEmail = (id) => resend(`/emails/${encodeURIComponent(id)}/cancel`, { method: "POST" });
