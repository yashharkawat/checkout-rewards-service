import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDb } from '../src/db';

/** A fresh in-memory service per test. n = 2 and x = 10 keep milestone tests short. */
export function testApp(config = { ordersPerCoupon: 2, discountPercent: 10 }) {
  const db = openDb(':memory:');
  const app = buildApp(db, config);
  return { app, db, api: apiFor(app) };
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Record<string, unknown>;
}

function apiFor(app: FastifyInstance) {
  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse> {
    const res = await app.inject({ method, url, payload: payload as object, headers });
    return { status: res.statusCode, body: res.json(), headers: res.headers };
  }

  return {
    call,
    /** Create a cart holding the given quantities, e.g. { mug: 2 }. Returns the cart id. */
    async cartWith(items: Record<string, number>): Promise<string> {
      const created = await call('POST', '/carts');
      const cartId: string = created.body.cart.id;
      for (const [productId, quantity] of Object.entries(items)) {
        const res = await call('PUT', `/carts/${cartId}/items/${productId}`, { quantity });
        if (res.status !== 200) throw new Error(`could not add ${productId}: ${res.status}`);
      }
      return cartId;
    },
    checkout(cartId: string, key: string, body: Record<string, unknown> = {}) {
      return call('POST', `/carts/${cartId}/checkout`, body, { 'idempotency-key': key });
    },
  };
}
