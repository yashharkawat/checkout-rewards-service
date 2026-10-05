import { describe, expect, it } from 'vitest';
import { testApp } from './helpers';

describe('admin report', () => {
  it('is all zeros before anything is sold', async () => {
    const { api } = testApp();

    const { status, body } = await api.call('GET', '/admin/report');

    expect(status).toBe(200);
    expect(body.report).toMatchObject({
      totalOrders: 0,
      grossRevenueMinor: 0,
      totalDiscountMinor: 0,
      netRevenueMinor: 0,
      coupons: { generated: 0, available: 0, redeemed: 0 },
    });
    expect(body.report.itemsSold.every((row: any) => row.quantity === 0)).toBe(true);
  });

  it('reconciles with the orders and coupons the API returns, and ignores failed checkouts', async () => {
    const { api } = testApp(); // n = 2, x = 10

    // Three successful orders, one of them discounted, plus two failures.
    await api.checkout(await api.cartWith({ mug: 2, notebook: 1 }), 'o1');
    await api.checkout(await api.cartWith({ 'limited-poster': 2 }), 'o2');
    const coupon = (await api.call('POST', '/admin/coupons')).body.coupon;
    await api.checkout(await api.cartWith({ notebook: 3, 'sticker-pack': 1 }), 'o3', {
      couponCode: coupon.code,
    });
    await api.call('PATCH', '/admin/products/notebook', { unitPriceMinor: 1 }); // must not rewrite history
    const shortCart = await api.cartWith({ 'limited-poster': 1 });
    await api.call('PATCH', '/admin/products/limited-poster', { stock: 0 });
    const short = await api.checkout(shortCart, 'f1');
    const reused = await api.checkout(await api.cartWith({ mug: 1 }), 'f2', {
      couponCode: coupon.code,
    });
    expect(short.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(reused.body.error.code).toBe('COUPON_ALREADY_REDEEMED');
    await api.checkout(await api.cartWith({ mug: 1 }), 'o4');
    await api.call('POST', '/admin/coupons'); // milestone 2, left unused

    const { report } = (await api.call('GET', '/admin/report')).body;
    const { orders } = (await api.call('GET', '/admin/orders')).body;
    const { coupons } = (await api.call('GET', '/admin/coupons')).body;

    // Recompute every figure from the order and coupon lists.
    const sum = (pick: (order: any) => number) => orders.reduce((t: number, o: any) => t + pick(o), 0);
    const quantities: Record<string, number> = {};
    for (const item of orders.flatMap((o: any) => o.items)) {
      quantities[item.productId] = (quantities[item.productId] ?? 0) + item.quantity;
    }

    expect(report.totalOrders).toBe(orders.length);
    expect(report.grossRevenueMinor).toBe(sum((o) => o.subtotalMinor));
    expect(report.totalDiscountMinor).toBe(sum((o) => o.discountMinor));
    expect(report.netRevenueMinor).toBe(sum((o) => o.totalMinor));
    expect(report.netRevenueMinor).toBe(report.grossRevenueMinor - report.totalDiscountMinor);
    for (const row of report.itemsSold) {
      expect(row.quantity).toBe(quantities[row.productId] ?? 0);
    }
    expect(report.coupons).toEqual({
      generated: coupons.length,
      available: coupons.filter((c: any) => c.status === 'AVAILABLE').length,
      redeemed: coupons.filter((c: any) => c.status === 'REDEEMED').length,
    });

    // And pin the absolute numbers so the comparison above cannot pass on two wrong answers.
    expect(report).toMatchObject({
      totalOrders: 4,
      grossRevenueMinor: 514396, // 94799 + 299800 + 84897 + 34900
      totalDiscountMinor: 8490, // 10% of 84897 = 8489.7, rounded half up
      netRevenueMinor: 505906,
      coupons: { generated: 2, available: 1, redeemed: 1 },
    });
    expect(Object.fromEntries(report.itemsSold.map((r: any) => [r.productId, r.quantity]))).toEqual({
      hoodie: 0,
      'limited-poster': 2,
      mug: 3,
      notebook: 4,
      'sticker-pack': 1,
      tshirt: 0,
    });
  });

  it('does not change anything when requested repeatedly', async () => {
    const { api, db } = testApp();
    await api.checkout(await api.cartWith({ mug: 1 }), 'o1');
    await api.checkout(await api.cartWith({ mug: 1 }), 'o2');
    await api.call('POST', '/admin/coupons');
    const changesBefore = db.prepare('SELECT total_changes() AS n').get() as { n: number };

    const first = await api.call('GET', '/admin/report');
    const second = await api.call('GET', '/admin/report');
    const third = await api.call('GET', '/admin/report');

    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
    // total_changes() counts every row inserted, updated or deleted on this connection.
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changesBefore);
    // In particular, reading the report did not generate the coupon for a milestone.
    expect((await api.call('GET', '/admin/coupons')).body.coupons).toHaveLength(1);
  });
});
