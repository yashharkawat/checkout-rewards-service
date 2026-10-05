import { describe, expect, it } from 'vitest';
import { testApp } from './helpers';

describe('carts', () => {
  it('prices a cart with several products', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 2, notebook: 3 });

    const { status, body } = await api.call('GET', `/carts/${cartId}`);

    expect(status).toBe(200);
    expect(body.cart.status).toBe('OPEN');
    expect(body.cart.items).toEqual([
      expect.objectContaining({ productId: 'mug', quantity: 2, lineTotalMinor: 69800 }),
      expect.objectContaining({ productId: 'notebook', quantity: 3, lineTotalMinor: 74997 }),
    ]);
    expect(body.cart.subtotalMinor).toBe(144797);
  });

  it('sets an absolute quantity, so repeating the request does not add more', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({});

    await api.call('PUT', `/carts/${cartId}/items/mug`, { quantity: 2 });
    await api.call('PUT', `/carts/${cartId}/items/mug`, { quantity: 2 });
    const changed = await api.call('PUT', `/carts/${cartId}/items/mug`, { quantity: 5 });

    expect(changed.body.cart.items).toHaveLength(1);
    expect(changed.body.cart.items[0].quantity).toBe(5);
  });

  it('removes an item, and removing it again is not an error', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ mug: 1, tshirt: 1 });

    const first = await api.call('DELETE', `/carts/${cartId}/items/mug`);
    const second = await api.call('DELETE', `/carts/${cartId}/items/mug`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.cart.items.map((i: any) => i.productId)).toEqual(['tshirt']);
  });

  it.each([
    ['zero', { quantity: 0 }],
    ['negative', { quantity: -1 }],
    ['fractional', { quantity: 1.5 }],
    ['a string', { quantity: '2' }],
    ['missing', {}],
    ['sent with an unknown field', { quantity: 1, unitPriceMinor: 1 }],
  ])('rejects a quantity that is %s and leaves the cart unchanged', async (_name, payload) => {
    const { api } = testApp();
    const cartId = await api.cartWith({});

    const res = await api.call('PUT', `/carts/${cartId}/items/mug`, payload);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    const cart = await api.call('GET', `/carts/${cartId}`);
    expect(cart.body.cart.items).toEqual([]);
  });

  it('rejects an unknown product and an unknown cart with different codes', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({});

    const badProduct = await api.call('PUT', `/carts/${cartId}/items/nope`, { quantity: 1 });
    const badCart = await api.call('PUT', '/carts/nope/items/mug', { quantity: 1 });

    expect([badProduct.status, badProduct.body.error.code]).toEqual([404, 'PRODUCT_NOT_FOUND']);
    expect([badCart.status, badCart.body.error.code]).toEqual([404, 'CART_NOT_FOUND']);
  });

  it('rejects a quantity above current stock and says how many are left', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({});

    const res = await api.call('PUT', `/carts/${cartId}/items/limited-poster`, { quantity: 4 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.items).toEqual([
      { productId: 'limited-poster', requested: 4, available: 3 },
    ]);
  });

  it('shows current price and availability when they change after the item was added', async () => {
    const { api } = testApp();
    const cartId = await api.cartWith({ 'limited-poster': 2 });

    await api.call('PATCH', '/admin/products/limited-poster', { unitPriceMinor: 100000, stock: 1 });
    const { body } = await api.call('GET', `/carts/${cartId}`);

    expect(body.cart.items[0]).toMatchObject({
      unitPriceMinor: 100000,
      lineTotalMinor: 200000,
      availableStock: 1,
      inStock: false,
    });
  });

  it('uses one error envelope for malformed JSON and unknown routes', async () => {
    const { app, api } = testApp();

    const badJson = await app.inject({
      method: 'PUT',
      url: '/carts/x/items/mug',
      payload: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    const noRoute = await api.call('GET', '/nothing-here');

    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.code).toBe('INVALID_REQUEST');
    expect([noRoute.status, noRoute.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });
});
