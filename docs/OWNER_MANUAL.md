# Poffi Stack dashboard: owner's guide

This is your private dashboard at **yoursite/admin**. It works on your phone and your computer.

## Signing in

- Sign in with your email and password.
- The first time someone signs in with a temporary password, they must choose their own.
- To change your password, go to **Account**. Changing it signs you out on your other devices.
- Forgot your password? Ask another owner to use **Team → Reset password**, or ask Kal’s Digital.

## Your day, in three taps

1. **Overview** shows what needs you now:
   - **New, to confirm**: paid orders you haven't confirmed yet.
   - **Need attention**: orders past their time, or with a payment problem.
   - **Coming up**: the next orders, soonest first.
2. Tap an order to open it, then use the big button for the next step:
   - **Confirm order**: you've seen it and will make it.
   - **Start preparing**
   - **Mark ready** (for pickup this reads **Ready for collection**)
   - **Out for delivery** (delivery orders only)
   - **Mark completed**
3. Your customer gets an email at the important steps, so you don't need to message them separately. You can choose which steps send an email under **Settings → Notifications**.

## Reading an order

- **Payment and order status are separate.** "Paid" means Paystack confirmed the money. "Completed" means the customer has their food.
- **Awaiting payment** means the customer started checkout but hasn't paid. **Don't prepare these.** If they never pay, the order closes itself the next day.
- **Overdue / Due in 25 min** labels appear beside orders that are close to, or past, their time.
- **Needs attention** (orange banner) explains exactly what's wrong. Examples:
  - The amount paid didn't match the order total.
  - The customer paid twice.
  - A payment arrived after the time slot filled up.

  Deal with it, then press **Mark as checked**.
- **History** shows every change: who made it and when.
- **Emails** shows what was sent to the customer and to you.

## Cancelling and refunding

- **Cancel order** asks for a reason. The customer sees the reason in their email.
- For a paid order, the owner can then press **Refund**. Paystack returns the money to the customer, and the order shows **Refund in progress** and then **Refunded**. Refunds can't be undone.

## "The customer says they paid, but it says Awaiting payment"

Open the order and press **Check payment with Paystack**. It asks Paystack directly and updates the order. The system also checks this automatically every day.

## Menu

- **Menu → Add product**: name, description, price and a real photo.
  - **Options** are choices the customer must make, such as sizes. Each option has its own price.
  - **Add-ons** are extras in groups, such as toppings. Set how many the customer may choose. Add-ons can add to the price.
  - **Feature on the homepage** shows the item under "Customer favourites".
- **Availability**: **Sold out** keeps the item visible but it can't be ordered. **Hidden** removes it from the website. Staff can change availability too.
- **Archive** takes an item off the menu for good. Items that have been ordered before are archived rather than deleted, so old orders still show what was bought.
- Changing a price never changes orders that were already placed.

## Settings (owner only)

- **Ordering & hours**:
  - The **Take online orders** switch.
  - Pickup and delivery.
  - Opening hours for each day.
  - **Slot length** (e.g. 30 minutes) and **Orders per slot**, which stops you getting more orders at one time than you can make.
  - **Preparation time**: the earliest time a customer can choose.
  - **Order cut-off** (e.g. "by 4pm the day before") and same-day orders.
  - How far ahead customers can book.
- **Delivery**: your delivery areas and the fee for each.
- **Closed days**: close a whole day or a single time, for holidays or when you're fully booked.
- **Notifications**:
  - The email address that receives new orders and reminders. Use **Send a test email** to check it.
  - Reminder times (e.g. 1 hour and 30 minutes before each order).
  - Which updates customers get.
- **Business & contact**: WhatsApp, phone, email, social handles and pickup address. These appear on the website and in customer emails.
- **Website text**: the homepage headline and intro, an optional announcement bar, an About section, and customer reviews. Only reviews ticked **Verified** are shown, so only add real ones you have permission to use.

## Team (owner only)

Add staff with **Team → Add a login**. They get a one-time password that only you see, and they choose their own password when they first sign in.

| | Staff can | Staff can't |
|---|---|---|
| Orders | See and update orders | Refund |
| Menu | Mark items sold out | Edit the menu |
| Settings | | Change settings |
| Team | | Manage the team |

**Switch off** blocks a login straight away.

## Emails

**Emails** lists every message sent, scheduled, skipped or failed.

- Failed emails are retried automatically. You can also press **Retry**.
- **Run automation now** runs the payment and email checks straight away. They run on their own every day anyway.

## Good habits

- Keep your hours and **Orders per slot** realistic. That's what stops you being overbooked.
- When you run out of something, mark it **Sold out** rather than cancelling orders.
- Ask Kal’s Digital for a weekly backup (or follow DEPLOYMENT.md → Backups).
