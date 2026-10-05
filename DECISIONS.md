# Decisions

Approximate time spent: TODO-YASH

This document explains what the service guarantees, where each guarantee is enforced, what I chose where the brief was silent, and what I left out. The API reference is in [README.md](README.md).

## 1. The short version

- Checkout is one database transaction. Cart state, stock, coupon, order and the idempotency record all commit together or not at all. A failed checkout has nothing to undo because nothing was committed.
- Every "check then change" is a single conditional `UPDATE` whose row count is the answer: stock (`WHERE stock >= ?`), cart (`WHERE status = 'OPEN'`), coupon (`WHERE redeemed_order_id IS NULL`).
- Each of those rules also has a database constraint behind it, so a bug in application code fails loudly instead of writing bad data.
- Money is integer paise. One rounding rule, in one function.
- The report is computed from orders and coupons on every request. There are no counters to drift.

## 2. Invariants

| # | Invariant | Enforced in code | Database backstop | Test |
|---|---|---|---|---|
| 1 | Stock never goes below zero and is never sold twice | `takeStock` in `src/checkout.ts`: `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?` | `CHECK (stock >= 0)` | `concurrency.test.ts` "last 3 units", "different quantities" |
| 2 | A cart produces at most one order | `claimCart` in `src/checkout.ts`: `UPDATE carts SET status = 'CHECKED_OUT' WHERE id = ? AND status = 'OPEN'` | `orders.cart_id UNIQUE` | `concurrency.test.ts` "different keys" |
| 3 | A retried checkout returns the first result and has no second effect | idempotency lookup at the top of `checkout`, record insert at the bottom, same transaction | `idempotency_keys.key PRIMARY KEY` | `checkout.test.ts` "same key", `concurrency.test.ts` "9 times at once" |
| 4 | A coupon is redeemed by at most one order | `redeemCoupon` in `src/checkout.ts`: `UPDATE coupons ... WHERE code = ? AND redeemed_order_id IS NULL` | `orders.coupon_code UNIQUE`, `coupons.redeemed_order_id UNIQUE` | `concurrency.test.ts` "redeem a coupon" |
| 5 | A failed checkout consumes nothing: no stock, no coupon, cart still open | every step runs inside `write()` in `src/db.ts`; any throw rolls back | transaction | `checkout.test.ts` "fails as a whole", `coupons.test.ts` "not consumed" (two tests) |
| 6 | At most one coupon per milestone, and only for a milestone that was reached | `generateCoupon` in `src/coupons.ts` | `coupons.milestone UNIQUE` | `coupons.test.ts`, `concurrency.test.ts` "8 admins" |
| 7 | An order explains itself forever | `order_items` copies product name and unit price; `orders` stores subtotal, coupon code, percent, discount, total | `CHECK (line_total_minor = unit_price_minor * quantity)`, `CHECK (total_minor = subtotal_minor - discount_minor)` | `checkout.test.ts` "snapshots it on the order" |
| 8 | A total is never negative | `percentDiscount` in `src/money.ts` caps the discount at the subtotal | `CHECK (total_minor >= 0)` | `money.test.ts`, `coupons.test.ts` "100% off" |
| 9 | Nothing invalid enters a cart | zod schema in `src/app.ts`, product lookup in `setItemQuantity` | `CHECK (quantity > 0)`, foreign key to `products` | `carts.test.ts` rejected quantities |
| 10 | Reading the report changes nothing, and it matches the orders and coupons | `buildReport` in `src/report.ts` is three `SELECT`s in a read transaction | none needed | `report.test.ts` |

## 3. Ambiguities and what I chose

**What does "nth order" count?** Every successfully placed order in the store, across all customers. The brief has no customer identity, so a per-customer count has nothing to attach to. Milestone k is reached when the store has placed k x n orders.

**Does an order paid with a coupon count toward the next milestone?** Yes. An order is an order. Excluding discounted orders would make the milestone depend on how an order was paid, and I see no reason a store would want that.

**Who can use a coupon?** Whoever holds the code. It is a bearer code, not tied to a customer, because there are no customers to tie it to. The code has 48 random bits so it cannot be guessed. With authentication I would add an owner column and check it at checkout.

**Does a coupon expire?** No. I left expiry out and did not add an unused column for it. Adding it is one nullable column and one more condition in `couponPercent`.

**What if several milestones are waiting?** Example: n = 5, 12 orders, no coupon generated yet. Each admin call generates one coupon, oldest milestone first. Two calls give milestones 1 and 2, the third call is refused. I did not want one request to mint an unbounded number of coupons, and I did not want to silently drop a milestone the store had earned.

**What does the admin get when nothing is eligible?** `409 NO_ELIGIBLE_MILESTONE` with the order count and the order number at which the next coupon is due. It is not an error in the request, so not a 400. I did not return the existing coupon with a 200, because handing the same code out twice makes it easy to give one coupon to two people.

**Which percentage applies if x changes?** The coupon keeps the percentage it was generated with. Changing configuration should not change the value of something already issued.

**What happens if the coupon is bad?** The checkout fails. It does not continue at full price. Charging a customer more than they agreed to is worse than asking them to try again.

**How many coupons per order?** One.

**What does the discount apply to?** The order subtotal, once. Not per line.

**Price or stock changed after the item was added?** See decision 3 below.

**Is there a "failed order"?** No. An order row exists only for a successful checkout. Failures are HTTP errors and leave no rows. That keeps "total successfully placed orders" equal to `COUNT(*)`.

**Can an order be cancelled or refunded?** Not in this version. That means nothing ever returns stock or re-opens a coupon, which removes a whole class of races. It is the first thing a real store would need next.

**Empty cart?** `422 CART_EMPTY`. An order with no lines is not a purchase.

**Remove an item that is not in the cart?** `200`. The cart ends up as the client wanted, and a retried DELETE should not turn into an error.

**Payment.** I treat a successful checkout as a successful payment and did not add a fake payment provider. A fake that always succeeds adds code without adding a failure mode to reason about. A real one changes the design: see "Multiple instances and production" for how.

## 4. Material decisions

## Decision 1: Checkout is a single transaction with conditional updates

**Context:** Checkout touches five things: cart state, stock for every line, the coupon, the order, the idempotency record. If any two of them commit separately, there is an instant where a crash or a competing request sees a half-finished checkout: stock taken with no order, a coupon burned by a checkout that then failed on stock.

**Options considered:**
1. One transaction, with each rule expressed as a conditional `UPDATE`.
2. Reserve first, confirm later: a stock hold and a coupon hold with a timeout, then a second step that confirms or releases.
3. An in-process mutex around checkout.
4. Optimistic locking with a version column and a retry loop.

**Choice:** Option 1.

**Why:** With no external payment call, nothing in checkout needs to wait for the outside world, so there is no reason to hold anything across transactions. A single transaction gives the "failed checkout consumes nothing" rule for free: There is no release code, so there is no release code to get wrong. A mutex (option 3) is wrong the moment there are two processes. Version columns (option 4) need retry loops and still need a transaction around the multi-row change.

**Consequences:** The code is short and the failure story is one sentence. The cost is that this shape only works while checkout is fully inside the database. A real payment provider cannot be called inside a transaction, and at that point option 2 becomes necessary.

## Decision 2: Client-supplied idempotency key, stored with a request fingerprint and the response, in the same transaction as the order

**Context:** A client that times out cannot know whether its checkout happened. It must be able to send the request again safely.

**Options considered:**
1. Rely on the cart: a cart checks out once, so a second attempt could just return the existing order.
2. Require an `Idempotency-Key` header, store key, request hash and response, replay on a match.
3. Same as 2, but also store failed responses.
4. Same as 2, but with a separate "in progress" record written before the work starts.

**Choice:** Option 2, with the key required. Option 1 is still there underneath as a second layer.

**Why:** The cart state machine alone prevents a second order, but it cannot tell "the same request again" from "a different request for the same cart", for example a second attempt with a different coupon. Returning the old order to that second request would tell the client its coupon was applied when it was not. The key plus a hash of (cart id, coupon code, expected total) separates the two cases: same key and same hash replays, same key and a different hash is `422 IDEMPOTENCY_KEY_REUSED`, a different key on a checked-out cart is `409 CART_ALREADY_CHECKED_OUT` with the order id.

I do not store failures (option 3). A failed checkout committed nothing, so running it again is safe, and it lets a client fix the problem (stock comes back, price accepted) and retry with the same key. The price is that a retry of a failed request can get a different answer than the first attempt. I think that is what a client wants.

I did not need an in-progress record (option 4) because the record is written in the same transaction as the order. A key maps to a committed order or it does not exist. There is no window where the key exists and the order does not.

**Consequences:** A replay returns the stored body exactly, with status 201 and `Idempotent-Replayed: true`, even if prices changed since. Keys are never expired here, so the table grows without bound. In production I would expire them after a day or so. After expiry the cart state machine still stops a duplicate order. Keys are global, not per client, because there is no client identity.

## Decision 3: Price and stock are decided at checkout, and the client can pin the total

**Context:** The brief asks what happens when price or availability changes between add-to-cart and checkout.

**Options considered:**
1. Freeze the price in the cart when the item is added.
2. Reserve stock when the item is added.
3. Use current price and stock at checkout, always.
4. Use current price and stock at checkout, and let the client send the total it showed the customer. Reject if it no longer matches.

**Choice:** Option 4. The cart stores only product id and quantity.

**Why:** A frozen price (1) lets someone keep an old price by holding a cart for a month, and needs an expiry policy to stop that. Reserving on add (2) lets abandoned carts lock up the limited product, and needs a reaper job and timeouts, which is a lot of new failure modes for a cart that may never be bought. Plain repricing (3) is simple but can charge a customer a total they never saw. `expectedTotalMinor` fixes that with one comparison: if the total moved, the client gets `409 PRICE_CHANGED` with the current priced lines, shows them, and retries.

Stock works the same way. The cart reserves nothing. Checkout either gets every line or fails with `409 INSUFFICIENT_STOCK` listing each short line with requested and available quantities. There is no partial fulfilment.

**Consequences:** Having something in a cart guarantees nothing. `GET /carts/:id` shows the current price, `availableStock` and `inStock` per line so a client can warn early. Adding an item also rejects a quantity above current stock, but that is only early feedback and I do not rely on it. `expectedTotalMinor` is optional, so a client that leaves it out accepts whatever the current price is. I made it optional so a simple client still works. A stricter API would require it.

## Decision 4: Coupons are rows in a milestone table, and redemption is a conditional update

**Context:** Two separate rules. Generation: one coupon per reached milestone, never two. Redemption: one order per coupon, never two, and never lost to a failed checkout.

**Options considered:**
1. Generate the coupon automatically inside the checkout that places the nth order.
2. Admin-triggered generation, with a `milestone` column that is unique.
3. For redemption: read the coupon, check it is unused, then mark it used.
4. For redemption: one `UPDATE ... WHERE redeemed_order_id IS NULL` and check that it changed exactly one row.

**Choice:** 2 and 4.

**Why:** The brief says an administrator requests generation, so I kept generation out of checkout (1). That also keeps checkout from doing work that is not about the customer's order. Storing the milestone number with a unique constraint makes "already generated for that milestone" a fact in the database, not a calculation. Because coupons are generated in milestone order, the next one is always `MAX(milestone) + 1`, and it is eligible when that number is at most `floor(orders / n)`.

For redemption, read-then-write (3) has a gap between the read and the write. The conditional update (4) has no gap: the database decides which transaction changes the row. Checkout validates the coupon early to compute the discount, and then redeems it with the conditional update after the order row exists, since the coupon points at the order.

**Consequences:** If n is changed after coupons exist, milestone numbers keep their value but mean a different order count. For example with 10 orders and 2 coupons at n = 5, changing n to 2 makes milestones 3, 4 and 5 immediately eligible. I did not handle this. The fix is to store the order count each coupon was issued for.

## Decision 5: Adding to a cart is `PUT` with an absolute quantity

**Context:** The brief lists add, change quantity and remove. The common design is `POST /items` that adds a quantity to whatever is there.

**Options considered:**
1. `POST /carts/:id/items` that increments.
2. `PUT /carts/:id/items/:productId` with `{ quantity }` that sets.

**Choice:** Option 2, for both add and change.

**Why:** An incrementing POST doubles the quantity if the client retries after a timeout. That is the same class of bug the brief asks about for checkout, just earlier in the flow. Setting an absolute quantity can be repeated any number of times.

**Consequences:** One endpoint does two jobs, and a client that wants "one more" has to know the current quantity. Two browser tabs setting different quantities overwrite each other, last write wins.

## Decision 6: SQLite, written so that it maps to Postgres

**Context:** The brief allows any persistence. I wanted real transactions and real constraints, and a reviewer should be able to run it with `npm install`.

**Options considered:**
1. In-memory maps with a lock.
2. SQLite in a file, through better-sqlite3.
3. Postgres in Docker.

**Choice:** Option 2.

**Why:** In-memory structures (1) would make me re-implement rollback by hand, which is the exact code I am trying not to write, and the result says nothing about a second process. Postgres (3) is what I would use in production, but it means Docker for the reviewer and a slower test loop. SQLite gives transactions, `CHECK`, `UNIQUE` and foreign keys with no setup, and several processes can open the same file, which let me test with three server processes.

**Consequences:** SQLite allows one writer at a time for the whole database. That makes the service correct more easily than Postgres would, and I am explicit below about which parts of the design that hides. better-sqlite3 is synchronous, so a slow query blocks the Node event loop. Fine here, wrong for production.

## Decision 7: The report is computed from orders and coupons

**Context:** The report must reconcile with orders and coupons, and reading it must not change anything.

**Options considered:**
1. Keep running counters and update them at checkout.
2. Compute with `SUM` and `COUNT` on each request.

**Choice:** Option 2.

**Why:** A counter is a second copy of the truth. It can be updated wrongly or not at all, and then the report disagrees with the orders. A query over the orders cannot disagree with them. The three queries run in one read transaction so they describe the same moment.

**Consequences:** The report scans the whole orders table each time. At this size that is nothing. At scale it would move to a read replica or a table built from order events.

## 5. Transactions, concurrency and idempotency

### What the code does

All writes go through `write()` in `src/db.ts`, which runs the function in a `BEGIN IMMEDIATE` transaction. Any exception rolls back.

`BEGIN IMMEDIATE` matters. SQLite's default `BEGIN` is deferred: it takes a read lock on the first `SELECT` and tries to upgrade on the first write. If another process committed in between, the upgrade fails with `SQLITE_BUSY_SNAPSHOT`, and `busy_timeout` does not retry that. Taking the write lock at the start avoids it. With `write()` switched to a deferred transaction, six of the seven overlap tests fail with 500s.

Steps inside `checkout`, in order:

1. Look up the idempotency key. If found with the same request hash, return the stored response. If found with a different hash, 422.
2. Claim the cart with a conditional update. Zero rows changed means the cart does not exist or is already checked out.
3. Read the cart lines joined to products, ordered by product id, and decrement stock for each with a conditional update. Collect every short line, then fail once if there were any.
4. Compute subtotal, coupon percentage, discount and total. Compare with `expectedTotalMinor` if it was sent.
5. Insert the order and its item snapshot.
6. Redeem the coupon with a conditional update.
7. Insert the idempotency record with the response body.

If the database cannot be locked within 5 seconds, the request gets `503 DATABASE_BUSY`. Nothing was written, and checkout can be retried with the same key.

### What the tests prove and what they do not

There are two kinds of test.

The in-process tests (`checkout.test.ts`, `coupons.test.ts` and so on) call the app directly. better-sqlite3 is synchronous, so in one process a transaction always runs to the end before the next one starts. `Promise.all` over eight checkouts there interleaves at the HTTP layer but never inside the database. Those tests check the rules and the rollback. They do not show anything about real overlap, and I do not claim they do.

`concurrency.test.ts` starts three server processes on one database file and sends requests to them in parallel over HTTP. Here the overlap is real: separate processes, separate connections, competing for the same rows. It shows that the transaction boundaries are right, that no rule depends on memory shared inside one process, and that the idempotency record works across instances.

What it does not show: how the code behaves on a database with row-level locking. SQLite serialises whole write transactions, so two checkouts never run their statements interleaved. This is what the suite does when the code is broken on purpose (each row can be reproduced by making that edit and running `npm test`):

| Deliberate break | Result |
|---|---|
| `write()` uses a deferred transaction | 6 of the 7 overlap tests fail with 500s, in 3 of 3 runs |
| No transaction around checkout, and stock is read, compared in JavaScript, then decremented unconditionally | 9 or 10 tests fail in each of 5 runs. The 40-way stock race on its own failed in 8 of 10 runs |
| Transaction kept, but stock is read, compared in JavaScript, then decremented unconditionally | All 55 tests pass |

The last row is the honest limit of this test suite. On SQLite the transaction alone is enough, so that variant is actually correct there and the tests cannot tell whether the `WHERE stock >= ?` clause is present. I kept the conditional updates because they are what the design needs on Postgres, but nothing in this repository proves them under Postgres.

## 6. Money and rounding

- Every amount is an integer number of paise. Prices, line totals, subtotals, discounts and totals are stored and returned as integers. There is no floating-point arithmetic on money anywhere, and the API has no decimal amounts.
- One currency. No tax, no shipping.
- Line total = unit price x quantity. Subtotal = sum of line totals.
- Discount = subtotal x percent / 100, rounded half up to the nearest paisa. In integer arithmetic that is `floor((subtotal * percent + 50) / 100)`. Example: 10% of 34899 is 3489.9, which becomes 3490.
- The discount is capped at the subtotal, and total = subtotal minus discount. With x limited to 1..100 the cap can never actually trigger. It is there so the rule "total is never negative" does not depend on the configuration check.
- The discount is computed once on the subtotal, not per line, so there is one rounding per order and line rounding cannot add up to a different number.
- The percentage is a whole number. 12.5% is not supported. Basis points would be the way to add it.
- Limits: quantity up to 1000 per line, price up to 1,000,000,000 paise, so every product and sum stays far below 2^53. `percentDiscount` throws if a multiplication would leave the safe integer range.
- Round half up slightly favours the customer on a discount. It is a choice, not a law. A finance team might want half-even.

## 7. Error model

One envelope for every non-2xx response: `{ "error": { "code", "message", "details" } }`.

- `code` is a fixed string and is the contract. `message` is for people and may change. `details` carries what a client needs to act: the short lines and what is available, the current total, the existing order id.
- Status codes group the errors, codes distinguish them. 400: the request is malformed. 404: the thing in the URL does not exist. 409: the request is fine but conflicts with current state (stock, cart already checked out, coupon used, price moved, no milestone). 422: the request is well-formed but can never work as sent (empty cart, unknown coupon, key reused for something else). 503: try again.
- I separated `COUPON_NOT_FOUND` from `COUPON_ALREADY_REDEEMED`, and `CART_NOT_FOUND` from `CART_ALREADY_CHECKED_OUT`, because a client does different things for each. A public API might merge the two coupon codes so that codes cannot be probed.
- Unknown JSON fields are rejected. A typo like `coupon` for `couponCode` would otherwise be a full-price order with no warning.
- The 409 versus 422 split is a judgment call. Clients should switch on the code, not the status.
- Stock is checked before the coupon, so a checkout with both problems reports stock first.

## 8. Implemented and deferred

Implemented:
- Products with seed data and an admin price and stock update
- Carts: create, view with prices and totals, set quantity, remove
- Checkout with idempotent retries, stock protection, optional coupon, optional pinned total
- Orders with line snapshots
- Admin coupon generation per milestone, coupon list, order list, report
- One error envelope
- 55 tests, including overlap tests across three processes

Deferred on purpose:
- Authentication and authorisation. `/admin` is open. Cart ids and coupon codes are unguessable bearer values, nothing more.
- Customers. No per-customer coupons or order history.
- Payment, and with it order states, cancellation, refunds, returning stock, re-opening a coupon.
- Coupon expiry and coupon preview on the cart.
- Idempotency key expiry.
- Cart expiry. Carts live forever.
- Pagination on the admin lists.
- Handling a change of n after coupons exist.
- Migrations. The schema is `CREATE TABLE IF NOT EXISTS` at startup.
- Logging, metrics, rate limiting, graceful shutdown.
- A build step. The server runs TypeScript through `tsx`.
- Node 26 without a compiler. See the note on better-sqlite3 in the README.

Known weaknesses:
- One writer at a time for the whole database. Throughput is bounded, and a long write makes others wait up to 5 seconds and then get a 503.
- Database calls are synchronous and block the event loop.
- A replayed checkout returns 201 like the original. Some APIs return 200 on replay. I chose to return exactly what the first call returned and mark the replay with a header.
- Coupon codes are compared exactly, including case.

## 9. Multiple instances and production

This already runs as several processes on one SQLite file, and the tests do that. It does not run on several machines. For that the database becomes Postgres. The tables carry over with type changes. This is what else changes, and where the current code would be wrong if moved as is.

**Stock.** `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1` is correct under Postgres's default READ COMMITTED: a second transaction waits on the row lock, then re-checks the `WHERE` against the committed row. Lines are already processed in product id order so two checkouts cannot deadlock on each other. I would keep `CHECK (stock >= 0)`.

**Cart.** The conditional update on `carts` takes the row lock, so a competing checkout of the same cart waits and then changes zero rows. But `setItemQuantity` and `removeItem` currently read the cart status and then write an item. On Postgres that needs `SELECT ... FOR UPDATE` on the cart row, or an item could be added to a cart while it is being checked out.

**Idempotency. This one must change.** Today the key is looked up first and inserted last. That is only safe because SQLite runs the whole transaction alone. On Postgres two requests with the same key could both find nothing, and the second would then lose the cart claim and get `CART_ALREADY_CHECKED_OUT` in place of the replay. The fix is to insert the key first: `INSERT ... ON CONFLICT DO NOTHING` as the first statement. The second request blocks on the primary key until the first commits or rolls back, then either replays the stored response or proceeds. The response body is filled in at the end of the same transaction.

**Coupon.** The conditional update is still the arbiter. But the order insert comes before it, and `orders.coupon_code` is unique, so the loser of a race would hit a unique violation on the insert instead of my clean error. I would lock the coupon row with `SELECT ... FOR UPDATE` when validating it, which makes the rest of the transaction race-free for that coupon.

**Coupon generation.** Two admins could read the same `MAX(milestone)`. `UNIQUE (milestone)` lets one insert win. The other gets a unique violation, which I would catch and return as `NO_ELIGIBLE_MILESTONE`. A `COUNT(*)` that misses an order still in flight only means the coupon is available a moment later.

**Isolation level.** I would stay on READ COMMITTED with the explicit row locks above. SERIALIZABLE would also be correct with less thought, at the cost of handling serialisation failures with a retry loop on every write path.

**Report.** One REPEATABLE READ read-only transaction, on a replica once the table is large.

**Payment.** A provider call cannot sit inside a database transaction. Checkout becomes two steps: (1) in one transaction, claim the cart, reserve stock, hold the coupon and create the order as `PENDING` with an expiry; (2) call the provider with the order id as its idempotency key; (3) on success mark the order `PAID`, on failure or expiry release the stock and the coupon. That needs a background job for expired holds and a webhook handler that is itself idempotent. Reports would count only `PAID` orders.

**Scale.** Connection pooling, an async driver, an index on `orders (created_at)` for the admin list, pagination and idempotency key expiry. In a flash sale the single product row becomes the bottleneck, because every checkout for that product waits on the same row lock. At that point stock would move to a reservation queue or a dedicated counter service.

## 10. How I used AI tools

The service was built with Claude Code doing most of the implementation: the code, the tests and the first draft of this document. It worked from a written brief that set the stack and the main design constraints (integer money, one transaction for checkout, conditional updates, an idempotency key with a request fingerprint, a unique milestone for coupons, honest notes on what synchronous SQLite tests prove).

I am responsible for every line and have to be able to explain and change it.

These are things that were found wrong and changed during the build. They came out of the test, smoke-run and review passes that Claude Code ran, not from a claim that the first version was right:

1. **The first stock race test could not catch a broken checkout.** It used 12 parallel checkouts for 3 units. To check that the test had teeth, the checkout was deliberately broken (transaction removed, stock read then decremented without a condition). The test still passed in 9 of 10 runs, because the window between the read and the write is microseconds. With 40 parallel checkouts the broken version fails in 8 of 10 runs, and the correct version passed 10 of 10. The test now uses 40.
2. **The same exercise showed a limit of the test suite.** With the transaction kept and only the `WHERE stock >= ?` condition removed, all tests pass. So on SQLite the tests prove the transaction, not the conditional update. That is written up in section 5 instead of being left out.
3. **Latest dependency versions did not run on Node 20.** The first install pulled better-sqlite3 13 and vitest 5, which both need Node 22. They were replaced with better-sqlite3 12 and vitest 4. A clean-clone install on Node 20 then still failed, because better-sqlite3 12.11 no longer publishes a Node 20 binary and tried to compile. It is now pinned to 12.9.0, which has binaries for Node 20 to 25 but not 26. No single release covers both 20 and 26.
4. **A manual run with curl found two problems the tests had missed.** A checkout with `Content-Type: application/json` and no body was rejected by Fastify with a 400. And a database lock timeout came back as `500 INTERNAL_ERROR`. The first now works, the second is `503 DATABASE_BUSY`, and both have tests.
5. **A review pass against the brief added a constraint.** "Redeemed once" was enforced only by the conditional update. `orders.coupon_code` is now `UNIQUE` as a backstop. The same pass corrected a code comment that said the unique milestone constraint is what stops two admins generating the same coupon. On SQLite the transaction does that, and the constraint only matters on a database with more concurrency.

TODO-YASH: add your own example after reviewing (something you corrected, rejected or redirected yourself).

## 11. With two more hours

1. Run the overlap tests against Postgres in a container. Section 9 lists three places where I believe the current statement order is wrong for Postgres (idempotency insert order, cart item edits, coupon lock). I would rather see them fail and fix them than argue from reading.
2. Make the stock race deterministic. Right now a broken implementation is caught 8 times in 10. A test hook that pauses between the read and the write would make it 10 in 10.
3. Add a property test for the report: random sequences of carts, checkouts, failures and coupons, then assert the reconciliation and that stock sold plus stock left equals stock seeded.
4. Store the order count on each coupon so n can change safely.
5. Expire idempotency keys.
