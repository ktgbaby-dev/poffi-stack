# What has been tested, and what still needs testing

Last full run: 22 November 2026.

## Automated tests (all passing)

### `npm test`: 21 API tests

These run on a real Postgres engine (PGlite) with local Paystack and Resend test doubles. They cover:

**Ordering and the menu**
- Ordering is closed by default, and no hours are invented.
- Menu changes show on the public menu: hidden, sold out and archived items behave correctly, and image uploads are checked by their actual file type.
- Pricing is server-side only: prices sent by the browser are ignored, and option and add-on rules are enforced.
- Scheduling rules: lead time, same-day ordering, cut-off, whole-day and single-slot closures, closed weekdays, booking horizon and slot capacity.
- Capacity holds when 8 checkouts hit the same slot at once: exactly 3 succeed when the limit is 3.

**Payments**
- A successful payment is verified on the server. The order is marked paid, the customer and owner emails go out, and both reminders are scheduled for the exact Lagos time.
- Nothing is processed twice: webhook plus return page, repeated webhooks, repeated returns, and a double-tapped checkout.
- Webhook signatures: wrong, stale and missing signatures are refused. The current and legacy schemes both work, and the current one takes priority.
- An amount mismatch is never marked paid, and the owner is alerted.
- Failed and abandoned payments: a retry gets a new reference on the same order, and an unknown reference is refused.
- A Paystack outage during checkout keeps the order, and the customer can retry.
- The cron safety net finds a paid order whose webhook and return were both lost.
- Unpaid orders release their slot when the hold ends and are closed after 24 hours.

**Orders and emails**
- Order status rules: unpaid orders can't move forward, there's no going backwards, and "out for delivery" is only for delivery orders. Customer emails go out once per status. Completing an order cancels its scheduled reminders.
- Cancellation needs a reason and tells the owner and customer. A Paystack refund ends with the order marked refunded.
- Old orders keep the names and prices charged, even after the menu is edited.
- Email failures are retried with back-off. Permanent failures stop and show in the log, and a manual retry works.
- Reminder modes: in cron mode each reminder is sent once when due, and never for cancelled or completed orders. Changing reminder times reschedules the reminders on upcoming orders.

**Sign-in, staff and backups**
- Dashboard sign-in: setup token, login, rate limit, CSRF header, staff restrictions, forced password change, and sessions ending after a password change.
- A backup restores into an empty database, and restore refuses to write over live data.

### `npm run test:e2e`: 51 browser checks, desktop and phone, in Chrome

These run with the production security headers. They cover:

**Customer journey**
- **Menu:** home → menu → size and toppings dialog with a live price → required choice enforced.
- **Cart:** quick add → cart drawer with server prices → change quantity → edit options → remove.
- **Checkout:** validation → delivery fee → the (local) Paystack page → paid → confirmation page.
- **Emails:** owner and customer emails, plus two scheduled reminders.
- **Phone:** checkout fits the screen, and a declined card can be retried successfully.

**Dashboard**
- **Orders:** sign in → overview counts and revenue → orders list → walk an order from Confirm to Completed (customer emails checked) → cancel with a reason → refund.
- **Menu:** add a product with a photo (it appears on the website) → mark it sold out (it shows as sold out).
- **Settings:** save ordering settings and reminder times.
- **Staff:** add a staff login → staff must change password → staff can't see Team or change settings.
- **Phone layout:** the dashboard and the order page fit a phone screen.
- **Errors:** no JavaScript errors on any page.

Screenshots of every step are saved to `test-results/e2e/`.

## Not yet tested against the real services

These need Poffi Stack's accounts. See `GO_LIVE_CHECKLIST.md` step 3.

- A real Paystack **test-mode** transaction on the deployed site, with Paystack's real webhook delivery and signature. So far the flow has only been tested against the local test double, which copies the documented API.
- Real email delivery through Resend, including a scheduled reminder arriving at its time.
- The real Neon Postgres database. The SQL is standard Postgres and runs unchanged on PGlite, but it hasn't been run on Neon itself yet.
- Live payments. These are blocked in code until `PAYSTACK_ALLOW_LIVE=true`.
