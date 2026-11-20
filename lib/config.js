// Environment configuration. Nothing secret is ever sent to the browser.

export const TZ = "Africa/Lagos";

export function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const isProd = () => env("VERCEL_ENV") === "production" || env("NODE_ENV") === "production";

// The public address of the site, used in Paystack callback URLs and email links.
export function siteUrl(request) {
  const configured = env("SITE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  if (request) {
    const u = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || u.host;
    const proto = request.headers.get("x-forwarded-proto") || u.protocol.replace(":", "");
    return `${proto}://${host}`;
  }
  return "http://localhost:5680";
}

export function paystackConfig() {
  const secret = env("PAYSTACK_SECRET_KEY");
  return {
    secret,
    configured: !!secret,
    mode: secret.startsWith("sk_live_") ? "live" : secret.startsWith("sk_test_") ? "test" : secret ? "custom" : "off",
    liveAllowed: env("PAYSTACK_ALLOW_LIVE") === "true",
    baseUrl: env("PAYSTACK_BASE_URL", "https://api.paystack.co").replace(/\/+$/, ""),
    // whsec_... signing secrets for the Paystack-Signature header; comma-separated during a rotation.
    webhookSecrets: env("PAYSTACK_WEBHOOK_SECRET").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export function emailConfig() {
  return {
    apiKey: env("RESEND_API_KEY"),
    configured: !!env("RESEND_API_KEY"),
    baseUrl: env("RESEND_BASE_URL", "https://api.resend.com").replace(/\/+$/, ""),
    from: env("EMAIL_FROM"),
    replyTo: env("EMAIL_REPLY_TO"),
    ownerEmailEnv: env("OWNER_NOTIFICATION_EMAIL"),
    // resend-scheduled (default; works on Vercel Hobby) or cron (needs a frequent scheduler)
    reminderDelivery: env("REMINDER_DELIVERY", "resend-scheduled") === "cron" ? "cron" : "resend-scheduled",
  };
}
