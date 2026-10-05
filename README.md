# Checkout and Rewards Service

Backend for a small store: carts, checkout, orders, and a discount coupon that becomes available after every nth order.

The interesting part is what happens when requests are retried or overlap. That reasoning is in [DECISIONS.md](DECISIONS.md). This file is the setup and API reference.

- TypeScript, Fastify, SQLite (better-sqlite3), zod, vitest
- No external services, no credentials, no build step

## Run it

Needs Node 20, 22 or 24. I ran the install, the tests and the server from a clean clone on Node 20.19 and Node 22.22.

better-sqlite3 is a native module and is pinned to 12.9.0, the last release that ships prebuilt binaries for Node 20. That release has binaries for Node 20 to 25. On Node 26 the install compiles it from source, which needs a C++ toolchain, or run `npm install better-sqlite3@latest` first.

```bash
npm install
npm test        # 55 tests, about 2 seconds
npm start       # http://127.0.0.1:3000
```

The first start creates `data/checkout.db` and seeds six products. `npm run reset` deletes the database.

To see the main behaviours end to end (retry, a stock race, a coupon race, a price change, the report), start the server on a fresh database and run the walkthrough in a second terminal:

```bash
npm run reset && npm start
./scripts/demo.sh
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `COUPON_EVERY_N_ORDERS` | `5` | n. A coupon becomes available for every nth placed order. Integer, 1 or more. |
| `COUPON_DISCOUNT_PERCENT` | `10` | x. Percentage off. Integer from 1 to 100. |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | |
| `DB_PATH` | `data/checkout.db` | SQLite file. Several server processes can share one file. |

The server refuses to start if n or x is out of range.

### Seed products

Prices are in paise.

| id | name | unitPriceMinor | stock |
|---|---|---|---|
| `tshirt` | Cotton T-Shirt | 79900 | 100 |
| `hoodie` | Zip Hoodie | 199900 | 50 |
| `mug` | Ceramic Mug | 34900 | 200 |
| `notebook` | Dotted Notebook | 24999 | 150 |
| `sticker-pack` | Sticker Pack | 9900 | 500 |
| `limited-poster` | Limited Edition Poster | 149900 | 3 |

## Conventions

- **Money** is always an integer in minor units (paise), in fields ending in `Minor`. `79900` means 799.00. There is one currency.
- **Bodies** are JSON. Unknown fields are rejected, not ignored.
- **Admin operations** are everything under `/admin`. There is no authentication in this exercise.
- **Errors** always have this shape, and `code` is the part to program against:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Not enough stock for one or more items",
    "details": { "items": [{ "productId": "limited-poster", "requested": 3, "available": 1 }] }
  }
}
```

### Error codes

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Body is not valid JSON, has a wrong type, a missing field or an unknown field. `details.issues` lists the fields. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Checkout without an `Idempotency-Key` header. |
| 404 | `CART_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND` | The id in the path does not exist. |
| 404 | `NOT_FOUND` | No such route. |
| 409 | `CART_ALREADY_CHECKED_OUT` | Editing or checking out a cart that already has an order. `details.orderId` is that order. |
| 409 | `INSUFFICIENT_STOCK` | Not enough stock. `details.items` lists every short line with `requested` and `available`. |
| 409 | `PRICE_CHANGED` | `expectedTotalMinor` was sent and is not the current total. `details` has the current priced lines and total. |
| 409 | `COUPON_ALREADY_REDEEMED` | The coupon has been used by another order. |
| 409 | `NO_ELIGIBLE_MILESTONE` | Admin coupon generation when no milestone is waiting. `details` says how many orders exist and when the next one is due. |
| 422 | `CART_EMPTY` | Checkout of a cart with no items. |
| 422 | `COUPON_NOT_FOUND` | The coupon code does not exist. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The key was already used for a different cart or body. |
| 503 | `DATABASE_BUSY` | The write lock could not be taken in time. Nothing was written. Retry (checkout: with the same key). |
| 500 | `INTERNAL_ERROR` | A bug. |

A failed checkout changes nothing: no stock is taken, the cart stays open, the coupon stays available.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/products` | List products with current price and stock |
| POST | `/carts` | Create a cart |
| GET | `/carts/:cartId` | View a cart with prices and totals |
| PUT | `/carts/:cartId/items/:productId` | Add an item or change its quantity |
| DELETE | `/carts/:cartId/items/:productId` | Remove an item |
| POST | `/carts/:cartId/checkout` | Check out, optionally with a coupon |
| GET | `/orders/:orderId` | Retrieve an order |
| POST | `/admin/coupons` | Admin: generate the coupon for an eligible milestone |
| GET | `/admin/coupons` | Admin: list coupons |
| GET | `/admin/orders` | Admin: list orders |
| GET | `/admin/report` | Admin: sales and coupon summary |
| PATCH | `/admin/products/:productId` | Admin: change price and/or stock |

### GET /products

`200`

```json
{ "products": [{ "id": "mug", "name": "Ceramic Mug", "unitPriceMinor": 34900, "stock": 200 }] }
```

### POST /carts

No body. `201`

```json
{
  "cart": {
    "id": "965c648f-eb22-498f-bb4a-2d7c04bec0de",
    "status": "OPEN",
    "orderId": null,
    "items": [],
    "subtotalMinor": 0,
    "createdAt": "2026-10-05T06:58:12.317Z"
  }
}
```

### GET /carts/:cartId

`200`. Prices and stock are the current ones, so the totals are an estimate until checkout.

```json
{
  "cart": {
    "id": "965c648f-eb22-498f-bb4a-2d7c04bec0de",
    "status": "OPEN",
    "orderId": null,
    "items": [
      {
        "productId": "mug",
        "name": "Ceramic Mug",
        "unitPriceMinor": 34900,
        "quantity": 2,
        "availableStock": 200,
        "lineTotalMinor": 69800,
        "inStock": true
      }
    ],
    "subtotalMinor": 69800,
    "createdAt": "2026-10-05T06:58:12.317Z"
  }
}
```

`inStock` is `false` when the cart holds more than the current stock. After checkout, `status` is `CHECKED_OUT` and `orderId` points at the order, which is the record of what was actually charged.

Errors: `404 CART_NOT_FOUND`.

### PUT /carts/:cartId/items/:productId

Sets the quantity of a product in the cart. This is both "add" and "change quantity". The quantity is absolute, so sending the same request twice leaves the same cart.

Request:

```json
{ "quantity": 2 }
```

`quantity` is an integer from 1 to 1000.

`200` with the updated cart (same shape as GET).

Errors: `400 INVALID_REQUEST` (zero, negative, fractional, string, missing, extra fields), `404 CART_NOT_FOUND`, `404 PRODUCT_NOT_FOUND`, `409 CART_ALREADY_CHECKED_OUT`, `409 INSUFFICIENT_STOCK` (quantity is more than the current stock).

A rejected request leaves the cart exactly as it was.

### DELETE /carts/:cartId/items/:productId

`200` with the updated cart. Removing an item that is not in the cart also returns `200`.

Errors: `404 CART_NOT_FOUND`, `409 CART_ALREADY_CHECKED_OUT`.

### POST /carts/:cartId/checkout

Header `Idempotency-Key` is required: any string of 1 to 255 characters that the client generates once per checkout attempt and reuses on every retry of that attempt. A UUID works.

Request body, both fields optional (the body can be omitted):

```json
{ "couponCode": "SAVE10-1F79AF35F178", "expectedTotalMinor": 71910 }
```

- `couponCode`: a coupon to redeem. If it cannot be redeemed the whole checkout fails. It never falls back to full price.
- `expectedTotalMinor`: the total the customer was shown, after discount. If the total at checkout is different, the checkout fails with `PRICE_CHANGED` and nothing is charged. Without it, checkout goes through at current prices.

`201`

```json
{
  "order": {
    "id": "c2b2854f-e1dc-4a09-92a2-ed6e9ecaedfe",
    "cartId": "965c648f-eb22-498f-bb4a-2d7c04bec0de",
    "items": [
      {
        "productId": "tshirt",
        "productName": "Cotton T-Shirt",
        "unitPriceMinor": 79900,
        "quantity": 1,
        "lineTotalMinor": 79900
      }
    ],
    "subtotalMinor": 79900,
    "couponCode": "SAVE10-1F79AF35F178",
    "discountPercent": 10,
    "discountMinor": 7990,
    "totalMinor": 71910,
    "createdAt": "2026-10-05T06:58:12.385Z"
  }
}
```

Retries:

- Same key, same cart and body: `201` with the original order, byte for byte, and the response header `Idempotent-Replayed: true`. No second order, no second stock decrement, no second coupon redemption.
- Same key, different cart or body: `422 IDEMPOTENCY_KEY_REUSED`.
- Different key, cart already checked out: `409 CART_ALREADY_CHECKED_OUT` with `details.orderId`.
- A checkout that failed is not remembered. The same key can be sent again after the cause is fixed.

Errors: `400 IDEMPOTENCY_KEY_REQUIRED`, `400 INVALID_REQUEST`, `404 CART_NOT_FOUND`, `409 CART_ALREADY_CHECKED_OUT`, `409 INSUFFICIENT_STOCK`, `409 PRICE_CHANGED`, `409 COUPON_ALREADY_REDEEMED`, `422 CART_EMPTY`, `422 COUPON_NOT_FOUND`, `422 IDEMPOTENCY_KEY_REUSED`, `503 DATABASE_BUSY`.

### GET /orders/:orderId

`200` with `{ "order": ... }` in the shape above. Item names and unit prices are the ones charged at checkout and do not change when the product changes later.

Errors: `404 ORDER_NOT_FOUND`.

### POST /admin/coupons

Admin. No body. Generates the coupon for the earliest milestone that has been reached and has no coupon yet. One coupon per call.

`201`

```json
{
  "coupon": {
    "code": "SAVE10-1F79AF35F178",
    "milestone": 1,
    "discountPercent": 10,
    "status": "AVAILABLE",
    "redeemedOrderId": null,
    "redeemedAt": null,
    "createdAt": "2026-10-05T07:01:44.120Z"
  }
}
```

`milestone` 1 is the nth order, 2 is the 2nth, and so on.

Errors: `409 NO_ELIGIBLE_MILESTONE` when there is nothing to reward, including when the coupon for the latest milestone already exists:

```json
{
  "error": {
    "code": "NO_ELIGIBLE_MILESTONE",
    "message": "No order milestone is waiting for a coupon",
    "details": { "ordersPlaced": 4, "ordersPerCoupon": 5, "couponsGenerated": 0, "nextMilestoneAtOrder": 5 }
  }
}
```

### GET /admin/coupons

Admin. `200` with `{ "coupons": [...] }` ordered by milestone. `status` is `AVAILABLE` or `REDEEMED`.

### GET /admin/orders

Admin. `200` with `{ "orders": [...] }`, oldest first. Not paginated.

### GET /admin/report

Admin. Read-only. `200`

```json
{
  "report": {
    "totalOrders": 7,
    "grossRevenueMinor": 664299,
    "totalDiscountMinor": 7990,
    "netRevenueMinor": 656309,
    "itemsSold": [
      { "productId": "hoodie", "productName": "Zip Hoodie", "quantity": 0 },
      { "productId": "limited-poster", "productName": "Limited Edition Poster", "quantity": 3 }
    ],
    "coupons": { "generated": 1, "available": 0, "redeemed": 1 }
  }
}
```

- `grossRevenueMinor` is the sum of order subtotals, before discounts.
- `netRevenueMinor` is the sum of order totals. It always equals gross minus discounts.
- `itemsSold` has a row for every product, including ones with no sales.
- Only successful orders count. There is no other kind of order in this system.

### PATCH /admin/products/:productId

Admin. Changes the current price, the stock, or both. It exists so price and stock changes can be tried out. Existing orders are not affected.

```json
{ "unitPriceMinor": 39900, "stock": 25 }
```

`200` with `{ "product": ... }`.

Errors: `400 INVALID_REQUEST` (neither field sent, negative or fractional values), `404 PRODUCT_NOT_FOUND`.

## curl examples

```bash
BASE=http://127.0.0.1:3000

# Create a cart and put two mugs in it
CART=$(curl -s -X POST $BASE/carts | node -pe 'JSON.parse(require("fs").readFileSync(0)).cart.id')
curl -s -X PUT $BASE/carts/$CART/items/mug -H 'Content-Type: application/json' -d '{"quantity": 2}'
curl -s $BASE/carts/$CART

# Check out. Run this line twice: the second response is the same order.
curl -si -X POST $BASE/carts/$CART/checkout -H 'Idempotency-Key: 7f0c1a52-attempt-1'

# Check out with a coupon and a pinned total (on a new cart with two mugs; use a real coupon code)
curl -s -X POST $BASE/carts/$CART/checkout \
  -H 'Idempotency-Key: 7f0c1a52-attempt-2' \
  -H 'Content-Type: application/json' \
  -d '{"couponCode": "SAVE10-1F79AF35F178", "expectedTotalMinor": 62820}'

# Admin
curl -s -X POST $BASE/admin/coupons
curl -s $BASE/admin/report
curl -s -X PATCH $BASE/admin/products/limited-poster -H 'Content-Type: application/json' -d '{"stock": 1}'
```

## Tests

```bash
npm test
```

| File | What it covers |
|---|---|
| `test/money.test.ts` | Rounding, exactness, discount never above the subtotal |
| `test/carts.test.ts` | Cart operations, rejected quantities and products, price and stock shown after a change |
| `test/checkout.test.ts` | Order creation, repeated checkout with one key, key reuse, second checkout of a cart, partial stock failure rolls back, price drift |
| `test/coupons.test.ts` | Milestone eligibility, one coupon per milestone, single redemption, coupon survives a failed checkout |
| `test/report.test.ts` | Report reconciles with orders and coupons, and reading it changes nothing |
| `test/errors.test.ts` | Body-less requests, unknown fields, 503 when the database is locked |
| `test/concurrency.test.ts` | Starts three server processes on one database file and sends overlapping HTTP requests: 40 checkouts for 3 units, one coupon used by 6 checkouts, one checkout sent 9 times, 8 admins generating one milestone |

`npm run typecheck` runs the TypeScript compiler without emitting.

## Layout

```
src/
  schema.sql    tables and constraints
  db.ts         open the database, seed, read/write transaction helpers
  money.ts      percentage discount in integer minor units
  products.ts   product queries and the admin update
  carts.ts      cart create, view, set quantity, remove
  checkout.ts   the checkout transaction
  orders.ts     order insert and queries
  coupons.ts    milestone coupon generation
  report.ts     admin report
  errors.ts     error codes and AppError
  config.ts     n and x
  app.ts        routes, validation, error envelope
  server.ts     entry point
```
