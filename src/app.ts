import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCart, getCart, removeItem, setItemQuantity } from './carts';
import { validateConfig, type Config } from './config';
import type { Db } from './db';
import { AppError } from './errors';
import { listProducts, updateProduct } from './products';

// Upper bounds keep every sum far inside Number.MAX_SAFE_INTEGER.
const MAX_QUANTITY = 1_000;
const MAX_PRICE_MINOR = 1_000_000_000;
const MAX_STOCK = 1_000_000;

const quantityBody = z.strictObject({
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});

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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(errorBody(err.code, err.message, err.details));
    }
    // Fastify's own client errors: bad JSON, wrong content type, body too large.
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

  // ---- Admin (no auth in this exercise; everything under /admin is administrative) ----

  app.patch<{ Params: { productId: string } }>('/admin/products/:productId', (req) => ({
    product: updateProduct(db, req.params.productId, parse(productPatchBody, req.body)),
  }));

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
