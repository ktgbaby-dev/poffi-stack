# Deployment and operations

This guide covers hosting on **Vercel** with a **Neon Postgres** database, **Paystack** for payments and **Resend** for email.

## 1. How it is put together

```
public/            static website (customer pages + /admin dashboard), served by Vercel's CDN
api/index.js       ONE serverless function; vercel.json rewrites /api/* and /media/* to it
lib/               the application: database, menu, scheduling, pricing, orders, payments, email, auth
lib/migrations/    database schema (applied automatically on first request, or with npm run db:migrate)
scripts/           admin and maintenance commands (create-admin, migrate, backup, restore, seed-demo)
dev/               local server and the local Paystack/Resend test doubles (never deployed)
tests/, tests-e2e/ automated tests (never deployed)
```

- **One function.** Everything runs through a single function, which keeps the project well inside the Vercel Hobby function limit.
- **Region.** The function runs in `lhr1` (London). Create the database in the matching Neon region (AWS eu-west-2) so database calls stay fast.

## 2. Create the Vercel project

1. Go to Vercel → **Add New → Project** and import `ktgbaby-dev/poffi-stack`.
   - Framework preset: **Other**.
   - Leave the build command empty. The output directory is `public` (already set in `vercel.json`).
2. Go to **Storage → Create Database → Neon (Postgres)** and connect it to the project.
   - This adds `DATABASE_URL`. Make sure it is the **pooled** connection string (the host name contains `-pooler`).
3. Go to **Settings → Environment Variables** and add the variables below. Mark secrets as **Sensitive**.

| Variable | Value |
|---|---|
| `SITE_URL` | `https://<your-vercel-or-own-domain>` (no trailing slash) |
| `SESSION_SECRET` | a random string, 32+ characters |
| `CRON_SECRET` | a random string, 32+ characters (Vercel Cron sends it automatically) |
| `ADMIN_SETUP_TOKEN` | a random string. Give it to the owner once, then delete the variable. |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` first |
| `PAYSTACK_WEBHOOK_SECRET` | `whsec_…` from Paystack |
| `PAYSTACK_ALLOW_LIVE` | `false` until go-live |
| `RESEND_API_KEY` | `re_…` |
| `EMAIL_FROM` | `Poffi Stack <orders@your-verified-domain>` |
| `OWNER_NOTIFICATION_EMAIL` | optional fallback. The dashboard setting takes priority. |
| `REMINDER_DELIVERY` | `resend-scheduled` (default) |

To generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

4. **Deploy.** The database tables are created on the first request. To create them ahead of time instead:

```bash
DATABASE_URL="postgres://..." npm run db:migrate
```

5. **Check.** `https://<site>/api/health` should return `{"ok":true,"database":"ok",...}`.

## 3. First owner login

You can create the first login in either of two ways.

- **In the browser (easiest).** Open `https://<site>/admin`. With no logins in the database, it shows **Set up the dashboard**. Enter the `ADMIN_SETUP_TOKEN`, the owner's name, email and password. Then remove `ADMIN_SETUP_TOKEN` from Vercel.
- **From a computer**, using the production `DATABASE_URL`:

  ```bash
  DATABASE_URL="postgres://..." npm run admin:create -- --email owner@example.com --name "Owner Name"
  ```

  It prints a one-time password. The owner must choose their own at first sign-in.

More logins (owner or staff) are added in the dashboard under **Team**.

## 4. Paystack

Paystack documentation was checked on 16 November 2026.

- **How payment works.** The server creates the order, then calls `POST /transaction/initialize` with the server-computed amount in kobo and a unique reference, and sends the customer to Paystack's page. The order is only marked paid after `GET /transaction/verify/:reference` confirms:
  - status is `success`
  - the currency is `NGN`
  - the amount matches the order total

  A successful redirect on its own is never trusted.
- **Webhook.** In the Paystack dashboard, set the URL to `https://<site>/api/paystack/webhook`. The endpoint checks every event's signature:
  - **Current scheme.** The `Paystack-Signature` header (`t=…,v1=whk_…:…`) is verified with `PAYSTACK_WEBHOOK_SECRET`, and events more than 5 minutes old are rejected.
  - **Legacy scheme.** The `x-paystack-signature` header (HMAC-SHA512 of the body with the secret key) is used only when the current header is missing.
  - **Repeats.** Each event is processed once. Repeats and resends are ignored safely.
- **Safety nets.** Abandoned and failed payments can be retried by the customer. Each retry gets a new reference on the same order, so there is never a second order. The daily cron also re-checks payments started more than 10 minutes earlier, so an order is still marked paid even if both the webhook and the customer's return were lost.
- **Refunds.** The dashboard (owner only) calls `POST /refund` with our own refund reference. `refund.*` webhook events, or the **Check refund status** button, update the order.
- **Test mode.** Use Paystack's published test cards. Keep `PAYSTACK_ALLOW_LIVE=false`.
- **Going live.** See the go-live checklist, step 4. Live keys are refused until `PAYSTACK_ALLOW_LIVE=true`.
- **Optional extra protection.** Allow only Paystack's webhook IPs (52.31.139.75, 52.49.173.169, 52.214.14.220) with the Vercel Firewall.

## 5. Email (Resend)

1. Add and verify your sending domain in Resend (DNS records). Until the domain is verified, Resend's test sender can only deliver to the Resend account's own address.
2. Set `RESEND_API_KEY` and `EMAIL_FROM` (an address on the verified domain).
3. In the dashboard: **Settings → Notifications**, set the owner email, then press **Send a test email**.

Emails sent:

- **To the customer:** order confirmation, and status updates (confirmed, ready, out for delivery, cancelled by default; preparing and completed can be switched on).
- **To the owner:** new paid order, reminders before each order, cancellations, and "needs attention" alerts (amount mismatch, double payment, paid after the slot filled).

Every email is recorded in the `notifications` table with a unique key, so none is sent twice. Failures are retried with back-off (2, 10, 30, 120 and 360 minutes) and shown in **Dashboard → Emails**, where they can be retried by hand.

## 6. Reminders and the scheduled job

Reminder times are set in the dashboard (for example 60 and 30 minutes before the order is due). Two delivery modes are available:

- **`REMINDER_DELIVERY=resend-scheduled` (default).**
  - **How it sends.** As soon as an order is paid, each reminder is handed to Resend with `scheduled_at` (up to 30 days ahead), so it arrives on time on Vercel Hobby.
  - **Cancellations.** Cancelling or completing the order, or changing reminder times, cancels the scheduled emails at Resend.
  - **Daily safety net.** The Vercel cron (`0 5 * * *` UTC, which is 6am Lagos time) retries anything that failed, re-checks payments, cancels reminders that no longer apply and closes unpaid orders whose hold ended more than 24 hours ago.
- **`REMINDER_DELIVERY=cron`.** Reminders are sent by the scheduled job itself, so it must run every few minutes. On Vercel Pro, change the cron to `*/5 * * * *`. Or use any external scheduler (for example cron-job.org) to call:

  ```
  GET https://<site>/api/cron/run
  Authorization: Bearer <CRON_SECRET>
  ```

  An external 5-minute call is also a good extra safety net in the default mode.

Nothing depends on a browser being open. The owner can also press **Emails → Run automation now**.

## 7. Backups and recovery

- **Built-in (Neon).** Neon keeps a restore window (point-in-time restore and branching). The length depends on the Neon plan, so check it in the Neon console. To recover from a mistake, create a branch at a time before the problem and point `DATABASE_URL` at it, or restore the main branch.
- **Your own copies.** Take these weekly, and before any big change. Store them privately: they contain customer contact details.

  ```bash
  DATABASE_URL="postgres://..." npm run backup -- --out backups/
  ```

  This writes one JSON file with every table, including menu photos.
- **Restore into an empty database** (for example a fresh Neon project or branch):

  ```bash
  DATABASE_URL="postgres://<empty-db>" npm run restore -- backups/poffi-backup-<date>.json
  ```

  It refuses to write over a database that already has orders, products or logins, unless `--force` is given. Order numbers continue after the restored ones.
- **Code.** Everything is in GitHub. Every push to `main` redeploys.

## 8. Local development

```bash
npm install
node scripts/seed-demo.mjs                 # local demo menu + logins (.data/DEV-CREDENTIALS.txt)
node dev/server.js --mocks --cron=60       # http://localhost:5680 , dashboard at /admin
npm test                                   # API tests (PGlite + local Paystack/Resend test doubles)
npm run test:e2e                           # browser tests, phone and desktop (needs Chrome)
```

- **Test doubles.** `--mocks` starts the **local Paystack and Resend test doubles**. They copy the real APIs but are not Paystack or Resend, and no money or email moves. Captured emails can be read at http://127.0.0.1:5682.
- **Real test mode.** To try the real Paystack test mode locally, put the real `sk_test_…` key in `.env.local` and leave out `--mocks`. Webhooks can't reach localhost, but the return page and the safety-net check still verify the payment.

## 9. Monitoring

- **Health.** `GET /api/health` shows the database, Paystack mode (`off`/`test`/`live`) and whether email is configured.
- **Logs.** Vercel → Logs. Payment, notification and automation steps are logged as one-line JSON. Secrets and card data are never logged.
- **Dashboard warnings.** The overview warns when ordering is closed, Paystack is in test mode or off, email is off, no notification address is set, or emails have failed.
