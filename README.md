# Poffi Stack: online ordering and management platform

The online ordering system for **Poffi Stack** (pancakes, breakfast and sweet treats). Built by **Kal’s Digital**.

- **Customer website.** Menu with sizes and add-ons, a cart, scheduled pickup or delivery (Lagos time), secure payment with **Paystack**, and an order confirmation and status page.
- **Owner dashboard (`/admin`).** Incoming and upcoming orders sorted by fulfilment time with urgency labels, order actions, refunds, menu management with photos, business settings, staff logins and an email log.
- **Automation.** Customer and owner emails through **Resend**, owner reminders before each order, retries, and a daily safety-net job.

## Documents

| | |
|---|---|
| [docs/GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md) | What's left to go live, and who does it |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel, Neon, Paystack, Resend, reminders, backups, monitoring |
| [docs/OWNER_MANUAL.md](docs/OWNER_MANUAL.md) | Plain-English guide to the dashboard |
| [docs/TESTING.md](docs/TESTING.md) | What is tested, and what still needs the real services |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Architecture decisions |
| [.env.example](.env.example) | Every environment variable, explained |

## Quick start (local)

```bash
npm install
node scripts/seed-demo.mjs               # sample menu marked "(demo)" + local logins in .data/DEV-CREDENTIALS.txt
node dev/server.js --mocks --cron=60     # http://localhost:5680  ·  dashboard: /admin
npm test && npm run test:e2e
```

`--mocks` uses local **test doubles** for Paystack and Resend. Nothing is charged or emailed.

## Stack

- **Runtime:** Node 20+ with no framework, deployed on Vercel as static files plus one serverless function.
- **Database:** PostgreSQL (Neon) in production; PGlite (Postgres in WASM) for local development and tests.
- **Payments and email:** Paystack REST API with signed webhooks, and the Resend REST API.
- **Front end:** hand-written HTML, CSS and JS with no build step. Fonts are self-hosted (Fredoka, DM Sans).

## Content rules

- The live database starts empty. Online ordering is **off** until the owner sets real hours and switches it on.
- No menu items, prices, opening hours, delivery fees, email addresses or reviews are invented in the code.
- The sample menu in `scripts/seed-demo.mjs` only goes into local databases, and every item in it is marked "(demo)".
