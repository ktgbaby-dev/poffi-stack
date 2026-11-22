# Go-live checklist

The code is finished and tested locally. These are the steps left to make it live, in order, and who does each one.

**Who:**
- **KD** = Kal’s Digital.
- **PS** = Poffi Stack.
- **KD + you** = Kal’s Digital, but only with your go-ahead.

## 1. Accounts and keys (nothing can go live without these)

| # | What | Who | Where |
|---|---|---|---|
| 1 | GitHub repository | KD | Done: `ktgbaby-dev/poffi-stack` |
| 2 | Vercel project linked to the repo | KD | **Done 22 Nov 2026.** Project `poffi-stack` (`prj_pAfLFFMbIifvxmdvczZTPAhWosZS`) in team ktg5. Production address: https://poffi-stack.vercel.app. Functions run in London (`lhr1`). First deployment built and checked: the pages load, `/api/health` answers, and the security headers are on. |
| 2b | Automatic deploys from GitHub | KD | **Working.** Every push to `main` redeploys production in about 10 seconds. The only exception was one push made while the project was still being linked. |
| 3 | Neon Postgres database | You | Vercel project → Storage → Create Database → Neon. Pick the region closest to London (AWS eu-west-2), because the site's functions run in London (`lhr1`). Vercel adds `DATABASE_URL` for you. |
| 4 | Paystack **test** secret key (`sk_test_…`) | PS | Paystack dashboard → Settings → API Keys & Webhooks |
| 5 | Paystack webhook URL and signing secret (`whsec_…`) | PS / KD | Set the webhook URL to `https://<site>/api/paystack/webhook`. Copy the signing secret from Developers → API configuration. |
| 6 | Resend API key | KD or PS | resend.com → API Keys |
| 7 | A domain to send email from, verified in Resend | PS + KD | Resend → Domains (needs DNS records on the domain) |
| 8 | Secrets: `SESSION_SECRET`, `CRON_SECRET`, `ADMIN_SETUP_TOKEN` | KD | **Done 22 Nov 2026.** Generated and stored in Vercel as Sensitive variables (production and preview). `PAYSTACK_ALLOW_LIVE=false` and `REMINDER_DELIVERY=resend-scheduled` are set too. A copy is kept on the build computer in `poffi-stack-ordering/.data/VERCEL-SECRETS.json`, which git ignores. It holds the one-time `ADMIN_SETUP_TOKEN` for the first owner login. |
| 9 | `SITE_URL` | KD | Set it at launch to the final address (`https://poffi-stack.vercel.app` or the custom domain). Until then the site uses whatever address each request comes in on. |

> **Visibility:** Vercel counts `poffi-stack.vercel.app` as the project's own domain, so it is **publicly reachable now**, even though deployment-specific URLs need a Vercel login. Until the database is connected, the site shows "We're getting things ready" and takes no orders.

## 2. Business information (set in the dashboard, not in code)

The owner signs in at `/admin`, then:

- [ ] **Menu → Categories**: e.g. Pancakes, Breakfast, Sweet Treats.
- [ ] **Menu → Add product**: the real names, descriptions, prices, sizes, add-ons and **real photos**.
- [ ] **Settings → Ordering & hours**: opening hours per day, slot length, orders per slot, preparation time, cut-off, same-day rule and how many days ahead customers can book.
- [ ] **Settings → Delivery**: delivery areas and fees, if delivering.
- [ ] **Settings → Business & contact**: WhatsApp, phone, email, Instagram, TikTok, pickup address.
- [ ] **Settings → Notifications**: the email that gets new orders and reminders. Then press **Send a test email**.
- [ ] **Settings → Website text**: the homepage line and the About section. Add reviews only if they're real and you have permission.
- [ ] **Settings → Ordering**: switch **Take online orders** on.

Ordering stays off until the hours are set and the switch is on. Nothing made up can reach customers.

## 3. Test run on the live site, in Paystack test mode

- [ ] Place an order on a phone and pay with a Paystack test card. Test card details are in Paystack's docs.
- [ ] Confirm the customer confirmation email and the owner's "NEW PAID ORDER" email both arrive.
- [ ] In the dashboard, move the order through Confirm → Preparing → Ready → Completed.
- [ ] Place a second order and decline the card. Confirm the order page offers **Try paying again**, and that retrying works.
- [ ] Cancel and refund a test order.
- [ ] Check a reminder email arrives at the configured time before a test order.
- [ ] Open `https://<site>/api/health`. It should show `"ok": true`.

## 4. Switch to real payments

- [ ] In Vercel, replace `PAYSTACK_SECRET_KEY` with the **live** key (`sk_live_…`).
- [ ] Set the **live** webhook URL and signing secret in Paystack, and update `PAYSTACK_WEBHOOK_SECRET`.
- [ ] Set `PAYSTACK_ALLOW_LIVE=true`. Until this is set, live keys are refused on purpose.
- [ ] Redeploy. Make one small real order and refund it.
- [ ] Remove `ADMIN_SETUP_TOKEN` from Vercel once the owner login exists.

## 5. After launch

- [ ] Point the domain at Vercel, then update `SITE_URL`.
- [ ] Take a backup each week: `npm run backup` (see DEPLOYMENT.md → Backups).
- [ ] Optional: get a reminder safety check every 5 minutes, either with Vercel Pro or a free external scheduler (see DEPLOYMENT.md → Reminders).
