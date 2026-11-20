-- Poffi Stack ordering platform: initial schema.
-- Money is integer kobo. Times are timestamptz; scheduled fulfilment keeps the Lagos wall-clock date/time too.

CREATE TABLE admin_users (
  id               bigserial PRIMARY KEY,
  email            text NOT NULL UNIQUE,
  name             text NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner', 'staff')),
  password_hash    text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  session_version  integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media (
  id          bigserial PRIMARY KEY,
  sha256      text NOT NULL UNIQUE,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes       bytea NOT NULL,
  size        integer NOT NULL,
  width       integer,
  height      integer,
  created_by  bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  sort        integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id            bigserial PRIMARY KEY,
  category_id   bigint REFERENCES categories(id) ON DELETE SET NULL,
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  description   text NOT NULL DEFAULT '',
  price_kobo    integer NOT NULL CHECK (price_kobo >= 0),
  image_id      bigint REFERENCES media(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold_out', 'hidden')),
  featured      boolean NOT NULL DEFAULT false,
  archived      boolean NOT NULL DEFAULT false,
  sort          integer NOT NULL DEFAULT 0,
  max_per_order integer CHECK (max_per_order IS NULL OR max_per_order > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category ON products (category_id, sort);

-- A product either has no variations (its own price applies) or the customer must choose one (sizes etc.).
CREATE TABLE product_variations (
  id          bigserial PRIMARY KEY,
  product_id  bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL,
  price_kobo  integer NOT NULL CHECK (price_kobo >= 0),
  available   boolean NOT NULL DEFAULT true,
  archived    boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 0
);
CREATE INDEX product_variations_product ON product_variations (product_id, sort);

-- Optional extras, grouped with a min/max number of choices (e.g. toppings: choose up to 3).
CREATE TABLE addon_groups (
  id          bigserial PRIMARY KEY,
  product_id  bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL,
  min_select  integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select  integer NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  archived    boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 0,
  CHECK (min_select <= max_select)
);
CREATE INDEX addon_groups_product ON addon_groups (product_id, sort);

CREATE TABLE addons (
  id          bigserial PRIMARY KEY,
  group_id    bigint NOT NULL REFERENCES addon_groups(id) ON DELETE CASCADE,
  name        text NOT NULL,
  price_kobo  integer NOT NULL DEFAULT 0 CHECK (price_kobo >= 0),
  available   boolean NOT NULL DEFAULT true,
  archived    boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 0
);
CREATE INDEX addons_group ON addons (group_id, sort);

CREATE TABLE customers (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  phone       text NOT NULL,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, phone)
);

-- Days or single slots the owner has closed (holidays, sold-out mornings...).
CREATE TABLE schedule_closures (
  id          bigserial PRIMARY KEY,
  date        date NOT NULL,
  slot_time   text CHECK (slot_time IS NULL OR slot_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  reason      text NOT NULL DEFAULT '',
  created_by  bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX schedule_closures_unique ON schedule_closures (date, COALESCE(slot_time, '*'));

CREATE SEQUENCE order_number_seq START 1;

CREATE TABLE orders (
  id                 bigserial PRIMARY KEY,
  order_number       integer NOT NULL UNIQUE,
  reference          text NOT NULL UNIQUE,
  access_token       text NOT NULL,
  client_key         text UNIQUE,
  customer_id        bigint NOT NULL REFERENCES customers(id),
  customer_name      text NOT NULL,
  customer_phone     text NOT NULL,
  customer_email     text NOT NULL,
  fulfilment_method  text NOT NULL CHECK (fulfilment_method IN ('pickup', 'delivery')),
  delivery_zone_id   text,
  delivery_zone_name text,
  delivery_address   text,
  delivery_fee_kobo  integer NOT NULL DEFAULT 0 CHECK (delivery_fee_kobo >= 0),
  scheduled_date     date NOT NULL,
  scheduled_time     text NOT NULL,
  slot_minutes       integer NOT NULL,
  scheduled_at       timestamptz NOT NULL,
  notes              text NOT NULL DEFAULT '',
  subtotal_kobo      integer NOT NULL CHECK (subtotal_kobo >= 0),
  total_kobo         integer NOT NULL CHECK (total_kobo >= 0),
  payment_status     text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refund_pending', 'refunded')),
  status             text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'new', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
  hold_expires_at    timestamptz,
  paid_at            timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,
  needs_attention    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_scheduled ON orders (scheduled_at);
CREATE INDEX orders_slot ON orders (scheduled_date, scheduled_time);
CREATE INDEX orders_status ON orders (status, payment_status);
CREATE INDEX orders_created ON orders (created_at DESC);

-- Each line keeps the names and prices charged at the time, so menu edits never change old orders.
CREATE TABLE order_items (
  id               bigserial PRIMARY KEY,
  order_id         bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       bigint REFERENCES products(id) ON DELETE SET NULL,
  variation_id     bigint REFERENCES product_variations(id) ON DELETE SET NULL,
  product_name     text NOT NULL,
  variation_name   text,
  base_price_kobo  integer NOT NULL,
  unit_price_kobo  integer NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  line_total_kobo  integer NOT NULL
);
CREATE INDEX order_items_order ON order_items (order_id);

-- The customisations chosen for a line (add-ons), with the price at the time.
CREATE TABLE order_item_customisations (
  id             bigserial PRIMARY KEY,
  order_item_id  bigint NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  addon_id       bigint REFERENCES addons(id) ON DELETE SET NULL,
  group_name     text NOT NULL,
  option_name    text NOT NULL,
  price_kobo     integer NOT NULL
);
CREATE INDEX order_item_customisations_item ON order_item_customisations (order_item_id);

CREATE TABLE payments (
  id                      bigserial PRIMARY KEY,
  order_id                bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider                text NOT NULL DEFAULT 'paystack',
  reference               text NOT NULL UNIQUE,
  amount_kobo             integer NOT NULL,
  currency                text NOT NULL DEFAULT 'NGN',
  status                  text NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized', 'pending', 'success', 'failed', 'abandoned', 'mismatch', 'reversed', 'error')),
  authorization_url       text,
  access_code             text,
  provider_transaction_id text,
  gateway_response        text,
  channel                 text,
  paid_amount_kobo        integer,
  paid_at                 timestamptz,
  verified_at             timestamptz,
  last_error              text,
  raw                     jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order ON payments (order_id);
CREATE INDEX payments_status ON payments (status, created_at);

-- Every webhook event once. A repeat of the same event is recognised by event_key and ignored.
CREATE TABLE payment_events (
  id            bigserial PRIMARY KEY,
  event_key     text NOT NULL UNIQUE,
  event_type    text NOT NULL,
  reference     text,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  result        text
);

CREATE TABLE refunds (
  id            bigserial PRIMARY KEY,
  order_id      bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id    bigint NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  reference     text NOT NULL UNIQUE,
  amount_kobo   integer NOT NULL,
  status        text NOT NULL DEFAULT 'requested',
  provider_id   text,
  last_error    text,
  raw           jsonb,
  created_by    bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_status_history (
  id           bigserial PRIMARY KEY,
  order_id     bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('status', 'payment', 'note', 'system')),
  from_value   text,
  to_value     text,
  note         text NOT NULL DEFAULT '',
  actor        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order ON order_status_history (order_id, created_at);

-- Outgoing email, including scheduled owner reminders. dedupe_key makes every message exist once.
CREATE TABLE notifications (
  id               bigserial PRIMARY KEY,
  order_id         bigint REFERENCES orders(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  recipient        text NOT NULL,
  subject          text,
  dedupe_key       text NOT NULL UNIQUE,
  send_at          timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'scheduled', 'sent', 'failed', 'cancelled', 'skipped')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 6,
  next_attempt_at  timestamptz,
  provider_id      text,
  last_error       text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_due ON notifications (status, send_at);
CREATE INDEX notifications_order ON notifications (order_id);

CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE job_runs (
  id           bigserial PRIMARY KEY,
  job          text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  result       jsonb
);
CREATE INDEX job_runs_job ON job_runs (job, started_at DESC);
