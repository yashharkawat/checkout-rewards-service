-- All money columns are integers in minor units (paise). No floats anywhere.
-- The schema is written so it ports to Postgres with type changes only
-- (TEXT ids -> uuid/text, TEXT timestamps -> timestamptz).

CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  -- Backstop for "never oversell": even a buggy code path cannot commit negative stock.
  stock            INTEGER NOT NULL CHECK (stock >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS carts (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id    TEXT NOT NULL REFERENCES carts (id),
  product_id TEXT NOT NULL REFERENCES products (id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, product_id)
) STRICT;

CREATE TABLE IF NOT EXISTS coupons (
  code              TEXT PRIMARY KEY,
  -- Milestone k is "the (k * n)th order was placed". UNIQUE makes generation idempotent.
  milestone         INTEGER NOT NULL UNIQUE CHECK (milestone >= 1),
  discount_percent  INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  created_at        TEXT NOT NULL,
  -- NULL means available. Set once, by the checkout that redeems it.
  -- (orders is created below. On Postgres this foreign key would be added
  -- with ALTER TABLE after both tables exist.)
  redeemed_order_id TEXT UNIQUE REFERENCES orders (id),
  redeemed_at       TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  -- Backstop for "a cart is checked out at most once".
  cart_id          TEXT NOT NULL UNIQUE REFERENCES carts (id),
  subtotal_minor   INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  discount_minor   INTEGER NOT NULL CHECK (discount_minor >= 0),
  total_minor      INTEGER NOT NULL CHECK (total_minor >= 0),
  -- Backstop for "a coupon is redeemed at most once": a code can sit on one order only.
  coupon_code      TEXT UNIQUE REFERENCES coupons (code),
  created_at       TEXT NOT NULL,
  CHECK (total_minor = subtotal_minor - discount_minor)
) STRICT;

-- Snapshot of what was bought: name and unit price are copied, not joined,
-- so later product edits cannot change the meaning of an old order.
CREATE TABLE IF NOT EXISTS order_items (
  order_id         TEXT NOT NULL REFERENCES orders (id),
  product_id       TEXT NOT NULL REFERENCES products (id),
  product_name     TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = unit_price_minor * quantity),
  PRIMARY KEY (order_id, product_id)
) STRICT;

-- One row per successful checkout. Written in the same transaction as the order,
-- so a key either maps to a committed order or does not exist.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;
