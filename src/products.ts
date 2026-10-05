import type { Db } from './db';
import { AppError } from './errors';

export interface Product {
  id: string;
  name: string;
  unitPriceMinor: number;
  stock: number;
}

const SELECT_PRODUCT =
  'SELECT id, name, unit_price_minor AS unitPriceMinor, stock FROM products';

export function listProducts(db: Db): Product[] {
  return db.prepare(`${SELECT_PRODUCT} ORDER BY id`).all() as Product[];
}

export function getProduct(db: Db, productId: string): Product {
  const product = db.prepare(`${SELECT_PRODUCT} WHERE id = ?`).get(productId) as
    | Product
    | undefined;
  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} does not exist`, {
      productId,
    });
  }
  return product;
}

/**
 * Admin: change the current price and/or stock. Exists so price and
 * availability drift can be produced and tested. Orders already placed are
 * unaffected because they hold their own copy of name and price.
 */
export function updateProduct(
  db: Db,
  productId: string,
  changes: { unitPriceMinor?: number; stock?: number },
): Product {
  // COALESCE keeps the current value for a field that was not sent. One
  // statement, so it cannot interleave with a checkout's stock decrement.
  db.prepare(
    `UPDATE products
        SET unit_price_minor = COALESCE(?, unit_price_minor),
            stock = COALESCE(?, stock)
      WHERE id = ?`,
  ).run(changes.unitPriceMinor ?? null, changes.stock ?? null, productId);
  return getProduct(db, productId); // throws PRODUCT_NOT_FOUND if the id matched nothing
}
