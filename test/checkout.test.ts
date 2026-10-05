import { describe, expect, it } from 'vitest';
import { testApp } from './helpers';

async function stockOf(api: ReturnType<typeof testApp>['api'], productId: string): Promise<number> {
  const { body } = await api.call('GET', '/products');
  return body.products.find((p: any) => p.id === productId).stock;
}

describe('checkout', () => {
  it('creates an order, takes stock and closes the cart', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 2, 'limited-poster': 1 });

    const res = await api.checkout(cartId, 'key-1');

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({
      cartId,
      subtotalMinor: 219700, // 2 * 34900 + 149900
      discountMinor: 0,
      totalMinor: 219700,
      couponCode: null,
    });
    expect(await stockOf(api, 'mug')).toBe(198);
    expect(await stockOf(api, 'limited-poster')).toBe(2);
    const cart = await api.call('GET', `/carts/${cartId}`);
    expect(cart.body.cart).toMatchObject({ status: 'CHECKED_OUT', orderId: res.body.order.id });
  });

  it('requires an Idempotency-Key header', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 1 });

    const res = await api.call('POST', `/carts/${cartId}/checkout`, {});

    expect([res.status, res.body.error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    expect(await stockOf(api, 'mug')).toBe(200);
  });

  it('refuses an empty cart, an unknown cart and an unknown coupon without side effects', async () => {
    const { api } = testApp();
    const emptyCart = await api.cartWith({});
    const cartId = await api.cartWith({ mug: 1 });

    const empty = await api.checkout(emptyCart, 'k1');
    const missing = await api.checkout('no-such-cart', 'k2');
    const badCoupon = await api.checkout(cartId, 'k3', { couponCode: 'NOPE' });

    expect([empty.status, empty.body.error.code]).toEqual([422, 'CART_EMPTY']);
    expect([missing.status, missing.body.error.code]).toEqual([404, 'CART_NOT_FOUND']);
    expect([badCoupon.status, badCoupon.body.error.code]).toEqual([422, 'COUPON_NOT_FOUND']);
    // The failed attempts rolled back: both carts are still open, stock is untouched.
    expect((await api.call('GET', `/carts/${emptyCart}`)).body.cart.status).toBe('OPEN');
    expect((await api.call('GET', `/carts/${cartId}`)).body.cart.status).toBe('OPEN');
    expect(await stockOf(api, 'mug')).toBe(200);
  });
});

describe('checkout retries', () => {
  it('returns the original order when the same key is sent again', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ 'limited-poster': 1 });

    const first = await api.checkout(cartId, 'retry-key');
    const second = await api.checkout(cartId, 'retry-key');
    const third = await api.checkout(cartId, 'retry-key');

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBe('false');
    for (const retry of [second, third]) {
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
    }
    expect(await stockOf(api, 'limited-poster')).toBe(2); // charged once, not three times
    expect((await api.call('GET', '/admin/orders')).body.orders).toHaveLength(1);
  });

  it('replays the stored response even if prices changed in between', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 1 });

    const first = await api.checkout(cartId, 'retry-key');
    await api.call('PATCH', '/admin/products/mug', { unitPriceMinor: 1 });
    const retry = await api.checkout(cartId, 'retry-key');

    expect(retry.body).toEqual(first.body);
  });

  it('rejects a key that is reused for a different request', async () => {
    const { api } = testApp();
    const cartA = await api.cartWith({ mug: 1 });
    const cartB = await api.cartWith({ mug: 1 });
    await api.checkout(cartA, 'shared-key');

    const otherCart = await api.checkout(cartB, 'shared-key');
    const otherBody = await api.checkout(cartA, 'shared-key', { expectedTotalMinor: 1 });

    for (const res of [otherCart, otherBody]) {
      expect([res.status, res.body.error.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    }
    expect((await api.call('GET', `/carts/${cartB}`)).body.cart.status).toBe('OPEN');
    expect(await stockOf(api, 'mug')).toBe(199);
  });

  it('refuses a second checkout of the same cart under a new key and points at the order', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 1 });
    const first = await api.checkout(cartId, 'key-a');

    const second = await api.checkout(cartId, 'key-b');

    expect([second.status, second.body.error.code]).toEqual([409, 'CART_ALREADY_CHECKED_OUT']);
    expect(second.body.error.details.orderId).toBe(first.body.order.id);
    expect(await stockOf(api, 'mug')).toBe(199);
  });

  it('does not remember a failure: the same key can succeed once the problem is fixed', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ 'limited-poster': 3 });
    await api.call('PATCH', '/admin/products/limited-poster', { stock: 2 });

    const failed = await api.checkout(cartId, 'same-key');
    await api.call('PATCH', '/admin/products/limited-poster', { stock: 3 });
    const retried = await api.checkout(cartId, 'same-key');

    expect(failed.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(retried.status).toBe(201);
    expect(await stockOf(api, 'limited-poster')).toBe(0);
  });

  it('locks a checked-out cart against further edits', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 1 });
    await api.checkout(cartId, 'key-1');

    const put = await api.call('PUT', `/carts/${cartId}/items/tshirt`, { quantity: 1 });
    const del = await api.call('DELETE', `/carts/${cartId}/items/mug`);

    expect(put.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
    expect(del.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
  });
});

describe('stock at checkout', () => {
  it('fails as a whole and takes nothing when any line is short', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 5, 'limited-poster': 3, tshirt: 2 });
    await api.call('PATCH', '/admin/products/limited-poster', { stock: 1 });
    await api.call('PATCH', '/admin/products/tshirt', { stock: 0 });

    const res = await api.checkout(cartId, 'key-1');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.items).toEqual([
      { productId: 'limited-poster', requested: 3, available: 1 },
      { productId: 'tshirt', requested: 2, available: 0 },
    ]);
    // The mug line had enough stock and was decremented inside the transaction,
    // but the rollback put it back.
    expect(await stockOf(api, 'mug')).toBe(200);
    expect(await stockOf(api, 'limited-poster')).toBe(1);
    expect((await api.call('GET', `/carts/${cartId}`)).body.cart.status).toBe('OPEN');
    expect((await api.call('GET', '/admin/orders')).body.orders).toEqual([]);
  });

  // In one process better-sqlite3 runs each transaction to completion, so these
  // eight requests are interleaved by the event loop but never overlap inside
  // the database. concurrency.test.ts repeats this across separate processes.
  it('sells the last units exactly once when checkouts are sent together', async () => {
    const { api } = testApp();
    const cartIds = await Promise.all(
      Array.from({ length: 8 }, () => api.cartWith({ 'limited-poster': 1 })),
    );

    const results = await Promise.all(cartIds.map((id, i) => api.checkout(id, `key-${i}`)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const failures = results.filter((r) => r.status !== 201);
    expect(failures).toHaveLength(5);
    expect(failures.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await stockOf(api, 'limited-poster')).toBe(0);
  });
});

describe('price changes between add-to-cart and checkout', () => {
  it('charges the price at checkout time and snapshots it on the order', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 2 });
    await api.call('PATCH', '/admin/products/mug', { unitPriceMinor: 40000 });

    const placed = await api.checkout(cartId, 'key-1');
    await api.call('PATCH', '/admin/products/mug', { unitPriceMinor: 99999 });
    const fetched = await api.call('GET', `/orders/${placed.body.order.id}`);

    expect(placed.body.order.totalMinor).toBe(80000);
    expect(fetched.body.order).toEqual(placed.body.order);
    expect(fetched.body.order.items).toEqual([
      {
        productId: 'mug',
        productName: 'Ceramic Mug',
        unitPriceMinor: 40000,
        quantity: 2,
        lineTotalMinor: 80000,
      },
    ]);
  });

  it('rejects the checkout when the client pinned a total that no longer holds', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 2 });
    const seenTotal = (await api.call('GET', `/carts/${cartId}`)).body.cart.subtotalMinor;
    await api.call('PATCH', '/admin/products/mug', { unitPriceMinor: 40000 });

    const rejected = await api.checkout(cartId, 'key-1', { expectedTotalMinor: seenTotal });

    expect([rejected.status, rejected.body.error.code]).toEqual([409, 'PRICE_CHANGED']);
    expect(rejected.body.error.details).toMatchObject({
      expectedTotalMinor: 69800,
      currentTotalMinor: 80000,
    });
    expect(await stockOf(api, 'mug')).toBe(200);

    // The client shows the new total, the customer accepts, and the retry goes through.
    const accepted = await api.checkout(cartId, 'key-2', { expectedTotalMinor: 80000 });
    expect(accepted.status).toBe(201);
  });

  it('returns ORDER_NOT_FOUND for an unknown order', async () => {
    const { api } = testApp();
    const res = await api.call('GET', '/orders/nope');
    expect([res.status, res.body.error.code]).toEqual([404, 'ORDER_NOT_FOUND']);
  });
});
