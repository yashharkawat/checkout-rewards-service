import { createHash, randomUUID } from 'node:crypto';
import { write, type Db } from './db';
import { AppError } from './errors';
import { percentDiscount } from './money';
import { insertOrder, type Order, type OrderItem } from './orders';

export interface CheckoutRequest {
  cartId: string;
  couponCode?: string;
  /** If sent, checkout fails with PRICE_CHANGED unless the final total equals this. */
  expectedTotalMinor?: number;
}

export interface CheckoutResult {
  status: number;
  body: { order: Order };
  /** True when this is the stored response of an earlier request with the same key. */
  replayed: boolean;
}

/**
 * Checkout is one write transaction. Every step either happens with all the
 * others or not at all:
 *
 *   1. idempotency lookup        (a retry returns the stored response)
 *   2. cart OPEN -> CHECKED_OUT  (conditional update)
 *   3. stock decrement           (conditional update per line)
 *   4. pricing at current prices, coupon validation, expected-total check
 *   5. order + item snapshot insert
 *   6. coupon redemption         (conditional update)
 *   7. idempotency record insert
 *
 * Any throw rolls the whole transaction back. That is why a failed checkout
 * never needs to "release" stock or "restore" a coupon: nothing was committed.
 */
export function checkout(db: Db, idempotencyKey: string, request: CheckoutRequest): CheckoutResult {
  const requestHash = fingerprint(request);

  return write(db, () => {
    const stored = db
      .prepare('SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = ?')
      .get(idempotencyKey) as
      | { request_hash: string; status_code: number; response_body: string }
      | undefined;
    if (stored) {
      if (stored.request_hash !== requestHash) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different checkout request',
        );
      }
      return { status: stored.status_code, body: JSON.parse(stored.response_body), replayed: true };
    }

    claimCart(db, request.cartId);
    const items = takeStock(db, request.cartId);

    const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
    const discountPercent = request.couponCode ? couponPercent(db, request.couponCode) : 0;
    const discountMinor = percentDiscount(subtotalMinor, discountPercent);
    const totalMinor = subtotalMinor - discountMinor;

    if (request.expectedTotalMinor !== undefined && request.expectedTotalMinor !== totalMinor) {
      throw new AppError(409, 'PRICE_CHANGED', 'The cart total is no longer what the client expected', {
        expectedTotalMinor: request.expectedTotalMinor,
        currentTotalMinor: totalMinor,
        subtotalMinor,
        discountMinor,
        items,
      });
    }

    const order: Order = {
      id: randomUUID(),
      cartId: request.cartId,
      items,
      subtotalMinor,
      couponCode: request.couponCode ?? null,
      discountPercent,
      discountMinor,
      totalMinor,
      createdAt: new Date().toISOString(),
    };
    insertOrder(db, order);
    if (request.couponCode) redeemCoupon(db, request.couponCode, order);

    const result = { status: 201, body: { order } };
    db.prepare(
      `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(idempotencyKey, requestHash, result.status, JSON.stringify(result.body), order.createdAt);
    return { ...result, replayed: false };
  });
}

/** Two requests are "the same" when cart, coupon and expected total all match. */
function fingerprint(request: CheckoutRequest): string {
  const canonical = JSON.stringify([
    request.cartId,
    request.couponCode ?? null,
    request.expectedTotalMinor ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** The state change is the check: only one transaction can move a cart out of OPEN. */
function claimCart(db: Db, cartId: string): void {
  const claimed = db
    .prepare("UPDATE carts SET status = 'CHECKED_OUT' WHERE id = ? AND status = 'OPEN'")
    .run(cartId);
  if (claimed.changes === 1) return;

  const existing = db
    .prepare(
      `SELECT o.id AS orderId FROM carts c LEFT JOIN orders o ON o.cart_id = c.id WHERE c.id = ?`,
    )
    .get(cartId) as { orderId: string | null } | undefined;
  if (!existing) {
    throw new AppError(404, 'CART_NOT_FOUND', `Cart ${cartId} does not exist`, { cartId });
  }
  throw new AppError(409, 'CART_ALREADY_CHECKED_OUT', `Cart ${cartId} is already checked out`, {
    cartId,
    orderId: existing.orderId,
  });
}

/**
 * Decrement stock for every line and return the lines priced at current prices.
 * "UPDATE ... WHERE stock >= quantity" checks and takes in one statement, so
 * there is no gap between reading stock and writing it.
 */
function takeStock(db: Db, cartId: string): OrderItem[] {
  // Ordered by product id: on a row-locking database, every checkout then
  // locks products in the same order and two checkouts cannot deadlock.
  const lines = db
    .prepare(
      `SELECT p.id AS productId, p.name AS productName, p.unit_price_minor AS unitPriceMinor,
              ci.quantity, p.stock AS available
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = ?
        ORDER BY p.id`,
    )
    .all(cartId) as (Omit<OrderItem, 'lineTotalMinor'> & { available: number })[];
  if (lines.length === 0) {
    throw new AppError(422, 'CART_EMPTY', 'Cannot check out an empty cart', { cartId });
  }

  const take = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
  const short = lines.filter(
    (line) => take.run(line.quantity, line.productId, line.quantity).changes === 0,
  );
  if (short.length > 0) {
    // Report every short line at once so the client can fix the cart in one go.
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for one or more items', {
      items: short.map((line) => ({
        productId: line.productId,
        requested: line.quantity,
        available: line.available,
      })),
    });
  }

  return lines.map(({ available: _available, ...line }) => ({
    ...line,
    lineTotalMinor: line.unitPriceMinor * line.quantity,
  }));
}

/** Validate a coupon and return its percentage. Does not consume it. */
function couponPercent(db: Db, code: string): number {
  const coupon = db
    .prepare(
      'SELECT discount_percent AS discountPercent, redeemed_order_id AS redeemedOrderId FROM coupons WHERE code = ?',
    )
    .get(code) as { discountPercent: number; redeemedOrderId: string | null } | undefined;
  if (!coupon) {
    throw new AppError(422, 'COUPON_NOT_FOUND', `Coupon ${code} does not exist`, { couponCode: code });
  }
  if (coupon.redeemedOrderId !== null) throw alreadyRedeemed(code);
  return coupon.discountPercent;
}

/** The state change is the check, same as claimCart: only one order can take a coupon. */
function redeemCoupon(db: Db, code: string, order: Order): void {
  const redeemed = db
    .prepare(
      `UPDATE coupons SET redeemed_order_id = ?, redeemed_at = ?
        WHERE code = ? AND redeemed_order_id IS NULL`,
    )
    .run(order.id, order.createdAt, code);
  if (redeemed.changes !== 1) throw alreadyRedeemed(code);
}

function alreadyRedeemed(code: string): AppError {
  return new AppError(409, 'COUPON_ALREADY_REDEEMED', `Coupon ${code} has already been used`, {
    couponCode: code,
  });
}
