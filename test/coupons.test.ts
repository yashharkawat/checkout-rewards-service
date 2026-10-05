import { describe, expect, it } from 'vitest';
import { testApp } from './helpers';

type Api = ReturnType<typeof testApp>['api'];

/** Place `count` one-mug orders. */
async function placeOrders(api: Api, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await api.checkout(await api.cartWith({ mug: 1 }), `setup-${i}-${Math.random()}`);
    if (res.status !== 201) throw new Error('setup order failed');
  }
}

async function generate(api: Api) {
  return api.call('POST', '/admin/coupons');
}

async function stockOf(api: Api, productId: string): Promise<number> {
  const { body } = await api.call('GET', '/products');
  return body.products.find((p: any) => p.id === productId).stock;
}

// The test config is n = 2, x = 10: every 2nd order earns a 10% coupon.
describe('coupon generation', () => {
  it('refuses until the nth order has been placed', async () => {
    const { api } = testApp();
    await placeOrders(api, 1);

    const res = await generate(api);

    expect([res.status, res.body.error.code]).toEqual([409, 'NO_ELIGIBLE_MILESTONE']);
    expect(res.body.error.details).toEqual({
      ordersPlaced: 1,
      ordersPerCoupon: 2,
      couponsGenerated: 0,
      nextMilestoneAtOrder: 2,
    });
  });

  it('generates exactly one coupon per milestone, however often it is asked', async () => {
    const { api } = testApp();
    await placeOrders(api, 2);

    const results = await Promise.all([generate(api), generate(api), generate(api)]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const { body } = await api.call('GET', '/admin/coupons');
    expect(body.coupons).toHaveLength(1);
    expect(body.coupons[0]).toMatchObject({ milestone: 1, discountPercent: 10, status: 'AVAILABLE' });
  });

  it('hands out skipped milestones one call at a time, oldest first', async () => {
    const { api } = testApp();
    await placeOrders(api, 5); // milestones 1 and 2 reached, the 5th order is halfway to 3

    const first = await generate(api);
    const second = await generate(api);
    const third = await generate(api);

    expect(first.body.coupon.milestone).toBe(1);
    expect(second.body.coupon.milestone).toBe(2);
    expect(first.body.coupon.code).not.toBe(second.body.coupon.code);
    expect(third.body.error.code).toBe('NO_ELIGIBLE_MILESTONE');
    expect(third.body.error.details.nextMilestoneAtOrder).toBe(6);
  });

  it('counts an order paid with a coupon toward the next milestone', async () => {
    const { api } = testApp();
    await placeOrders(api, 2);
    const { code } = (await generate(api)).body.coupon;
    await placeOrders(api, 1); // order 3
    await api.checkout(await api.cartWith({ mug: 1 }), 'with-coupon', { couponCode: code }); // order 4

    const res = await generate(api);

    expect(res.status).toBe(201);
    expect(res.body.coupon.milestone).toBe(2);
  });
});

describe('coupon redemption', () => {
  async function withCoupon() {
    const ctx = testApp();
    await placeOrders(ctx.api, 2);
    const code: string = (await generate(ctx.api)).body.coupon.code;
    return { ...ctx, code };
  }

  it('takes x% off the subtotal, rounded half up, and records how the total was reached', async () => {
    const { api, code } = await withCoupon();
    const cartId = await api.cartWith({ notebook: 1, 'sticker-pack': 1 }); // 24999 + 9900

    const res = await api.checkout(cartId, 'key-1', { couponCode: code });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({
      subtotalMinor: 34899,
      couponCode: code,
      discountPercent: 10,
      discountMinor: 3490, // 3489.9 rounds up
      totalMinor: 31409,
    });
    const coupons = (await api.call('GET', '/admin/coupons')).body.coupons;
    expect(coupons[0]).toMatchObject({ status: 'REDEEMED', redeemedOrderId: res.body.order.id });
  });

  it('can be redeemed only once', async () => {
    const { api, code } = await withCoupon();
    await api.checkout(await api.cartWith({ mug: 1 }), 'key-1', { couponCode: code });
    const secondCart = await api.cartWith({ tshirt: 1 });

    const res = await api.checkout(secondCart, 'key-2', { couponCode: code });

    expect([res.status, res.body.error.code]).toEqual([409, 'COUPON_ALREADY_REDEEMED']);
    // The refused checkout did not go through at full price behind the customer's back.
    expect((await api.call('GET', `/carts/${secondCart}`)).body.cart.status).toBe('OPEN');
    expect(await stockOf(api, 'tshirt')).toBe(100);
  });

  it('is not consumed by a checkout that fails on stock', async () => {
    const { api, code } = await withCoupon();
    const cartId = await api.cartWith({ 'limited-poster': 3 });
    await api.call('PATCH', '/admin/products/limited-poster', { stock: 2 });

    const failed = await api.checkout(cartId, 'key-1', { couponCode: code });

    expect(failed.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await api.call('GET', '/admin/coupons')).body.coupons[0].status).toBe('AVAILABLE');
    // And it still works afterwards.
    const ok = await api.checkout(await api.cartWith({ mug: 1 }), 'key-2', { couponCode: code });
    expect(ok.status).toBe(201);
    expect(ok.body.order.discountMinor).toBe(3490);
  });

  it('is not consumed by a checkout that fails on the expected total', async () => {
    const { api, code } = await withCoupon();
    const cartId = await api.cartWith({ mug: 1 });

    const failed = await api.checkout(cartId, 'key-1', { couponCode: code, expectedTotalMinor: 1 });

    expect(failed.body.error.code).toBe('PRICE_CHANGED');
    expect(failed.body.error.details.currentTotalMinor).toBe(31410); // 34900 - 3490
    expect((await api.call('GET', '/admin/coupons')).body.coupons[0].status).toBe('AVAILABLE');
    expect(await stockOf(api, 'mug')).toBe(198); // only the two setup orders
  });

  it('is redeemed once when the redeeming checkout is retried with the same key', async () => {
    const { api, code } = await withCoupon();
    const cartId = await api.cartWith({ mug: 1 });

    const first = await api.checkout(cartId, 'retry', { couponCode: code });
    const retry = await api.checkout(cartId, 'retry', { couponCode: code });

    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect((await api.call('GET', '/admin/report')).body.report.coupons).toEqual({
      generated: 1,
      available: 0,
      redeemed: 1,
    });
  });

  it('never produces a negative total, even at 100% off', async () => {
    const { api } = testApp({ ordersPerCoupon: 1, discountPercent: 100 });
    await placeOrders(api, 1);
    const { code } = (await generate(api)).body.coupon;

    const res = await api.checkout(await api.cartWith({ hoodie: 1 }), 'key-1', { couponCode: code });

    expect(res.body.order).toMatchObject({ subtotalMinor: 199900, discountMinor: 199900, totalMinor: 0 });
  });

  it('keeps the percentage it was generated with if the configuration changes later', async () => {
    const { db, api } = testApp({ ordersPerCoupon: 1, discountPercent: 10 });
    await placeOrders(api, 1);
    const { code } = (await generate(api)).body.coupon;

    // Same database, service restarted with x = 50.
    const { buildApp } = await import('../src/app');
    const restarted = buildApp(db, { ordersPerCoupon: 1, discountPercent: 50 });
    const cart = (await restarted.inject({ method: 'POST', url: '/carts' })).json().cart.id;
    await restarted.inject({ method: 'PUT', url: `/carts/${cart}/items/mug`, payload: { quantity: 1 } });
    const res = await restarted.inject({
      method: 'POST',
      url: `/carts/${cart}/checkout`,
      payload: { couponCode: code },
      headers: { 'idempotency-key': 'after-restart' },
    });

    expect(res.json().order.discountPercent).toBe(10);
  });
});
