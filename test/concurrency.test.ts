import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * These tests start three real server processes that share one SQLite file and
 * fire HTTP requests at them at the same time. Unlike the in-process tests, the
 * requests here really do overlap: three operating-system processes compete
 * for the same rows. See DECISIONS.md for what this does and does not prove.
 */
const INSTANCES = 3;
const servers: ChildProcess[] = [];
const urls: string[] = [];
let dir: string;

function startServer(dbPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: {
        ...process.env,
        PORT: '0', // any free port
        DB_PATH: dbPath,
        COUPON_EVERY_N_ORDERS: '2',
        COUPON_DISCOUNT_PERCENT: '10',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servers.push(child);
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/\S+)/);
      if (match?.[1]) resolve(match[1]);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited with ${code}: ${output}`)));
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'checkout-concurrency-'));
  const dbPath = join(dir, 'shared.db');
  urls.push(await startServer(dbPath)); // the first one creates the schema and seed
  urls.push(...(await Promise.all(Array.from({ length: INSTANCES - 1 }, () => startServer(dbPath)))));
}, 30_000);

afterAll(() => {
  for (const server of servers) server.kill();
  rmSync(dir, { recursive: true, force: true });
});

let requestCount = 0;

/** Send a request to the next instance, round robin. */
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const base = urls[requestCount++ % urls.length];
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function cartWith(items: Record<string, number>): Promise<string> {
  const cartId: string = (await call('POST', '/carts')).body.cart.id;
  for (const [productId, quantity] of Object.entries(items)) {
    const res = await call('PUT', `/carts/${cartId}/items/${productId}`, { quantity });
    expect(res.status).toBe(200);
  }
  return cartId;
}

function checkout(cartId: string, key: string, body: Record<string, unknown> = {}) {
  return call('POST', `/carts/${cartId}/checkout`, body, { 'idempotency-key': key });
}

async function product(id: string) {
  const { body } = await call('GET', '/products');
  return body.products.find((p: any) => p.id === id);
}

async function report() {
  return (await call('GET', '/admin/report')).body.report;
}

const codes = (results: { status: number; body: any }[]) =>
  results.map((r) => (r.status === 201 ? 'OK' : r.body.error.code)).sort();

describe('overlapping requests across three server processes', () => {
  it('sells the last 3 units to exactly 3 of 40 simultaneous checkouts', async () => {
    await call('PATCH', '/admin/products/limited-poster', { stock: 3 });
    const before = await report();
    const cartIds = await Promise.all(Array.from({ length: 40 }, () => cartWith({ 'limited-poster': 1 })));

    const results = await Promise.all(cartIds.map((id, i) => checkout(id, `last-units-${i}`)));

    expect(codes(results)).toEqual([
      ...Array(37).fill('INSUFFICIENT_STOCK'),
      ...Array(3).fill('OK'),
    ]);
    expect((await product('limited-poster')).stock).toBe(0);
    const after = await report();
    expect(after.totalOrders - before.totalOrders).toBe(3);
    const sold = (r: any) => r.itemsSold.find((row: any) => row.productId === 'limited-poster').quantity;
    expect(sold(after) - sold(before)).toBe(3);
  });

  it('never oversells when carts want different quantities of the same product', async () => {
    await call('PATCH', '/admin/products/hoodie', { stock: 10 });
    const quantities = [4, 3, 3, 2, 2, 5, 1, 4];
    const cartIds = await Promise.all(quantities.map((q) => cartWith({ hoodie: q })));

    const results = await Promise.all(cartIds.map((id, i) => checkout(id, `mixed-${i}`)));

    const sold = results
      .filter((r) => r.status === 201)
      .reduce((sum, r) => sum + r.body.order.items[0].quantity, 0);
    const left = (await product('hoodie')).stock;
    expect(sold).toBeLessThanOrEqual(10);
    expect(left).toBe(10 - sold);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(results.every((r) => r.status === 201 || r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
  });

  it('creates one order when the same checkout is sent 9 times at once with one key', async () => {
    const cartId = await cartWith({ mug: 2 });
    const stockBefore = (await product('mug')).stock;
    const ordersBefore = (await report()).totalOrders;

    const results = await Promise.all(Array.from({ length: 9 }, () => checkout(cartId, 'same-key-9x')));

    expect(results.map((r) => r.status)).toEqual(Array(9).fill(201));
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect((await product('mug')).stock).toBe(stockBefore - 2);
    expect((await report()).totalOrders - ordersBefore).toBe(1);
  });

  it('creates one order when one cart is checked out at once under different keys', async () => {
    const cartId = await cartWith({ mug: 1 });
    const stockBefore = (await product('mug')).stock;

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => checkout(cartId, `different-key-${i}`)),
    );

    expect(codes(results)).toEqual([...Array(5).fill('CART_ALREADY_CHECKED_OUT'), 'OK']);
    const winner = results.find((r) => r.status === 201)!;
    for (const loser of results.filter((r) => r.status !== 201)) {
      expect(loser.body.error.details.orderId).toBe(winner.body.order.id);
    }
    expect((await product('mug')).stock).toBe(stockBefore - 1);
  });

  it('lets one of several simultaneous checkouts redeem a coupon and takes no stock for the rest', async () => {
    // Make sure a milestone is waiting, whatever the earlier tests left behind.
    let coupon: any;
    for (let i = 0; coupon === undefined; i++) {
      const res = await call('POST', '/admin/coupons');
      if (res.status === 201) coupon = res.body.coupon;
      else await checkout(await cartWith({ 'sticker-pack': 1 }), `filler-${i}`);
    }
    const stockBefore = (await product('tshirt')).stock;
    const redeemedBefore = (await report()).coupons.redeemed;
    const cartIds = await Promise.all(Array.from({ length: 6 }, () => cartWith({ tshirt: 1 })));

    const results = await Promise.all(
      cartIds.map((id, i) => checkout(id, `coupon-race-${i}`, { couponCode: coupon.code })),
    );

    expect(codes(results)).toEqual([...Array(5).fill('COUPON_ALREADY_REDEEMED'), 'OK']);
    const winner = results.find((r) => r.status === 201)!;
    expect(winner.body.order.discountMinor).toBe(7990); // 10% of 79900
    // Five losers each had a t-shirt in the cart. None of them kept it.
    expect((await product('tshirt')).stock).toBe(stockBefore - 1);
    expect((await report()).coupons.redeemed - redeemedBefore).toBe(1);
    const stored = (await call('GET', '/admin/coupons')).body.coupons.find((c: any) => c.code === coupon.code);
    expect(stored.redeemedOrderId).toBe(winner.body.order.id);
    // A loser's cart is still open, so the customer can retry without the coupon.
    const loserCart = cartIds[results.findIndex((r) => r.status !== 201)]!;
    expect((await checkout(loserCart, 'coupon-race-retry')).status).toBe(201);
  });

  it('generates one coupon when a milestone is requested by 8 admins at once', async () => {
    // Drain any milestone that is already waiting, then place exactly enough orders for one more.
    while ((await call('POST', '/admin/coupons')).status === 201);
    const { ordersPlaced, nextMilestoneAtOrder } = (await call('POST', '/admin/coupons')).body.error.details;
    for (let i = ordersPlaced; i < nextMilestoneAtOrder; i++) {
      await checkout(await cartWith({ 'sticker-pack': 1 }), `milestone-filler-${i}`);
    }
    const generatedBefore = (await report()).coupons.generated;

    const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/admin/coupons')));

    expect(codes(results)).toEqual([...Array(7).fill('NO_ELIGIBLE_MILESTONE'), 'OK']);
    expect((await report()).coupons.generated - generatedBefore).toBe(1);
  });

  it('leaves a report that reconciles with every order and coupon after all of the above', async () => {
    const [r, { orders }, { coupons }, { products }] = await Promise.all([
      report(),
      call('GET', '/admin/orders').then((x) => x.body),
      call('GET', '/admin/coupons').then((x) => x.body),
      call('GET', '/products').then((x) => x.body),
    ]);

    expect(r.totalOrders).toBe(orders.length);
    expect(r.grossRevenueMinor).toBe(orders.reduce((t: number, o: any) => t + o.subtotalMinor, 0));
    expect(r.totalDiscountMinor).toBe(orders.reduce((t: number, o: any) => t + o.discountMinor, 0));
    expect(r.netRevenueMinor).toBe(r.grossRevenueMinor - r.totalDiscountMinor);
    expect(r.coupons.generated).toBe(coupons.length);
    expect(r.coupons.redeemed).toBe(orders.filter((o: any) => o.couponCode !== null).length);
    expect(new Set(orders.map((o: any) => o.cartId)).size).toBe(orders.length); // one order per cart
    expect(products.every((p: any) => p.stock >= 0)).toBe(true);
  });
});
