import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCart, getCart, removeItem, setItemQuantity } from './carts';
import { checkout } from './checkout';
import { validateConfig, type Config } from './config';
import { generateCoupon, listCoupons } from './coupons';
import type { Db } from './db';
import { AppError } from './errors';
import { getOrder, listOrders } from './orders';
import { listProducts, updateProduct } from './products';
import { buildReport } from './report';

// Upper bounds keep every sum far inside Number.MAX_SAFE_INTEGER.
const MAX_QUANTITY = 1_000;
const MAX_PRICE_MINOR = 1_000_000_000;
const MAX_STOCK = 1_000_000;

const quantityBody = z.strictObject({
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});

const checkoutBody = z.strictObject({
  couponCode: z.string().min(1).max(64).optional(),
  expectedTotalMinor: z.number().int().min(0).optional(),
});

const idempotencyKeyHeader = z.string().min(1).max(255);

const productPatchBody = z
  .strictObject({
    unitPriceMinor: z.number().int().min(0).max(MAX_PRICE_MINOR).optional(),
    stock: z.number().int().min(0).max(MAX_STOCK).optional(),
  })
  .refine((body) => body.unitPriceMinor !== undefined || body.stock !== undefined, {
    message: 'Send unitPriceMinor, stock, or both',
  });

type CartParams = { cartId: string };
type ItemParams = { cartId: string; productId: string };

export function buildApp(db: Db, config: Config): FastifyInstance {
  validateConfig(config);
  const app = Fastify();

  // Fastify rejects an empty body when Content-Type is application/json. Many
  // HTTP clients always send that header, even on a body-less POST or DELETE,
  // so an empty body is accepted and treated as "no body".
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'INVALID_REQUEST', 'Request body is not valid JSON'));
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(errorBody(err.code, err.message, err.details));
    }
    // Another process held the write lock for longer than busy_timeout. Nothing
    // was written, so the client can retry (checkout: with the same key).
    if ((err as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
      return reply
        .status(503)
        .header('Retry-After', '1')
        .send(errorBody('DATABASE_BUSY', 'The database is busy, retry shortly'));
    }
    // Fastify's own client errors: wrong content type, body too large.
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send(errorBody('INVALID_REQUEST', (err as Error).message));
    }
    console.error(err);
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Unexpected error'));
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', `No route for ${req.method} ${req.url}`)),
  );

  // ---- Catalogue ----

  app.get('/products', () => ({ products: listProducts(db) }));

  // ---- Carts ----

  app.post('/carts', (_req, reply) => reply.status(201).send({ cart: createCart(db) }));

  app.get<{ Params: CartParams }>('/carts/:cartId', (req) => ({
    cart: getCart(db, req.params.cartId),
  }));

  app.put<{ Params: ItemParams }>('/carts/:cartId/items/:productId', (req) => {
    const { quantity } = parse(quantityBody, req.body);
    return { cart: setItemQuantity(db, req.params.cartId, req.params.productId, quantity) };
  });

  app.delete<{ Params: ItemParams }>('/carts/:cartId/items/:productId', (req) => ({
    cart: removeItem(db, req.params.cartId, req.params.productId),
  }));

  // ---- Checkout and orders ----

  app.post<{ Params: CartParams }>('/carts/:cartId/checkout', (req, reply) => {
    const key = idempotencyKeyHeader.safeParse(req.headers['idempotency-key']);
    if (!key.success) {
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header (1 to 255 characters) and reuse it when retrying',
      );
    }
    const body = parse(checkoutBody, req.body);
    const result = checkout(db, key.data, { cartId: req.params.cartId, ...body });
    return reply
      .status(result.status)
      .header('Idempotent-Replayed', String(result.replayed))
      .send(result.body);
  });

  app.get<{ Params: { orderId: string } }>('/orders/:orderId', (req) => ({
    order: getOrder(db, req.params.orderId),
  }));

  // ---- Admin (no auth in this exercise; everything under /admin is administrative) ----

  app.patch<{ Params: { productId: string } }>('/admin/products/:productId', (req) => ({
    product: updateProduct(db, req.params.productId, parse(productPatchBody, req.body)),
  }));

  app.get('/admin/orders', () => ({ orders: listOrders(db) }));

  app.post('/admin/coupons', (_req, reply) =>
    reply.status(201).send({ coupon: generateCoupon(db, config) }),
  );

  app.get('/admin/coupons', () => ({ coupons: listCoupons(db) }));

  app.get('/admin/report', () => ({ report: buildReport(db) }));

  return app;
}

function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, details: details ?? {} } };
}

/** Validate a request body. A missing body is treated as {} so optional-only bodies work. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError(400, 'INVALID_REQUEST', 'Request body is invalid', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
