import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb } from '../src/db';
import { testApp } from './helpers';

describe('error envelope', () => {
  it('accepts a checkout with a JSON content type and no body', async () => {
    const { app, api } = testApp();
    const cartId = await api.cartWith({ mug: 1 });

    const res = await app.inject({
      method: 'POST',
      url: `/carts/${cartId}/checkout`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'no-body' },
    });

    expect(res.statusCode).toBe(201);
  });

  it('rejects unknown checkout fields instead of ignoring them', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 1 });

    const res = await api.checkout(cartId, 'key-1', { coupon: 'TYPO-FOR-couponCode' });

    expect([res.status, res.body.error.code]).toEqual([400, 'INVALID_REQUEST']);
    expect((await api.call('GET', `/carts/${cartId}`)).body.cart.status).toBe('OPEN');
  });

  it('answers 503 DATABASE_BUSY, not 500, when the write lock cannot be taken in time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'checkout-busy-'));
    try {
      const path = join(dir, 'busy.db');
      const app = buildApp(openDb(path, 50), { ordersPerCoupon: 5, discountPercent: 10 });
      const cartId = (await app.inject({ method: 'POST', url: '/carts' })).json().cart.id;
      const put = () =>
        app.inject({ method: 'PUT', url: `/carts/${cartId}/items/mug`, payload: { quantity: 1 } });

      // A second connection, standing in for another server process, holds the write lock.
      const other = new Database(path);
      other.exec('BEGIN IMMEDIATE');
      const blocked = await put();
      other.exec('ROLLBACK');
      const retried = await put();

      expect(blocked.statusCode).toBe(503);
      expect(blocked.json().error.code).toBe('DATABASE_BUSY');
      expect(blocked.headers['retry-after']).toBe('1');
      expect(retried.statusCode).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
