# Implementation plan: Poffi Stack ordering platform

Written by Kal’s Digital on 16 November 2026, before the build started.

## What already exists

- **No Poffi Stack codebase.** The only Poffi Stack material is the logo, the proposal in `../poffi-stack-proposal/` and the public TikTok profile. The profile says: pancakes, breakfast and sweet treats; "Freshly made. Packed with love."; order before 4pm for next-day delivery by 9am; Alimosho and Ota.
- **Glam by Oyin bookings (`../glambyoyin-bookings`) is the reference project.** It runs on Vercel as static `public/` files plus Node Web-standard functions (`export function GET(request)`). Notifications and reminders go through Resend's REST API with `scheduled_at` and idempotency keys, plus a daily safety-net cron (Vercel Hobby allows only one cron run a day). Logins use scrypt with signed, versioned session cookies.
- **Tooling on this machine:** Node 24 and npm. Playwright-core with a cached Chromium. No Postgres server. GOD'S EYE already uses Neon Postgres on Vercel.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Hosting | Vercel: static `public/` plus **one** router function `api/index.js` | Same set-up as Glam. Hobby plans cap the number of functions, so one router keeps us well under. |
| Database | **PostgreSQL** (Neon through the Vercel Marketplace) using `pg`. Tests and local dev use **PGlite**, which is real Postgres compiled to WASM. | The brief asks for a relational database with transactions, and Neon is already in use for GOD'S EYE. PGlite lets tests run the exact production SQL without a Postgres server. |
| Payments | Paystack REST API: initialize, verify, refund. Webhooks accept both `Paystack-Signature` (timestamped, `whsec_`) and the legacy `x-paystack-signature`. | Follows the current official documentation, checked on 16 Nov 2026. |
| Email | Resend REST API, as in Glam | Already proven in Glam. |
| Reminders | A `notifications` table is the single source of truth. Reminders are scheduled with Resend `scheduled_at` (up to 30 days ahead), so they arrive on time on Vercel Hobby. A cron safety net retries, reconciles and sends anything due. A `cron` mode is available for a frequent cron on Vercel Pro or an external scheduler. | Nothing depends on a browser tab being open. A conditional "claim" in the database means no email is sent twice. |
| Images | Stored in Postgres and served with immutable cache headers | No extra storage service, and images are included in database backups. |
| Front end | Hand-built HTML, CSS and JS with no build step. The customer site has several pages; the dashboard is a single page at `/admin`. | Matches the other Kal’s Digital sites and is fast on phones. |

## Missing information (built as configurable, documented for the owner)

- Menu items, prices, photos, descriptions, sizes and add-ons
- Opening hours, ordering days, slot length, capacity, preparation lead time, cut-off and same-day rules
- Pickup address, delivery areas and fees
- Contact details, social links and testimonials
- Owner notification email
- Paystack test and live keys and the webhook signing secret
- Resend API key and a verified sending domain
- Neon database and the domain name

Until the owner has set hours and switched ordering on, the public site does not take orders. No invented policy can go live.

## Build order

1. Schema and migrations, then the DB adapter (pg or PGlite).
2. Settings, menu, schedule rules and trusted pricing.
3. Orders, Paystack payments, webhooks and refunds.
4. Notifications: templates, queue, retries and the reminder processor, then the cron.
5. Admin authentication, roles and the admin API.
6. Customer website: home, menu, cart, checkout and order confirmation.
7. Admin dashboard: overview, orders, order detail, menu, settings and team.
8. Tests: API integration on PGlite with local Paystack and Resend test doubles, then browser end-to-end runs.
9. Handover docs: environment variables, migrations, admin setup, Paystack, Resend, deployment, backups and an owner manual.

## Limits of what can be tested here

A real Paystack test-mode transaction needs Poffi Stack's `sk_test_…` key, a public webhook URL and a deployed database. A real email needs a Resend API key. Until those exist, the full flow is exercised against **local test doubles that copy the official API contracts**. Every report labels this clearly, and no transaction is presented as real.
