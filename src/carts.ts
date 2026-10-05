import { randomUUID } from 'node:crypto';
import { read, write, type Db } from './db';
import { AppError } from './errors';
import { getProduct } from './products';

export interface CartView {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  /** Set once the cart has been checked out. The order is the record of the sale. */
  orderId: string | null;
  items: CartLine[];
  /** Sum of line totals at the current product prices. An estimate until checkout. */
  subtotalMinor: number;
  createdAt: string;
}

export interface CartLine {
  productId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  availableStock: number;
  /** False when the quantity in the cart is more than the current stock. */
  inStock: boolean;
}

export function createCart(db: Db): CartView {
  const id = randomUUID();
  db.prepare("INSERT INTO carts (id, status, created_at) VALUES (?, 'OPEN', ?)").run(
    id,
    new Date().toISOString(),
  );
  return getCart(db, id);
}

export function getCart(db: Db, cartId: string): CartView {
  return read(db, () => loadCart(db, cartId));
}

/**
 * Put a product in the cart with an absolute quantity (add and change are the
 * same call). Absolute, not "add one more", so a retried request cannot double
 * the quantity.
 */
export function setItemQuantity(
  db: Db,
  cartId: string,
  productId: string,
  quantity: number,
): CartView {
  return write(db, () => {
    requireOpenCart(db, cartId);
    const product = getProduct(db, productId);
    // Early feedback only. The cart reserves nothing, so checkout checks again.
    if (quantity > product.stock) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', `Only ${product.stock} of ${productId} left`, {
        items: [{ productId, requested: quantity, available: product.stock }],
      });
    }
    db.prepare(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = excluded.quantity`,
    ).run(cartId, productId, quantity);
    return loadCart(db, cartId);
  });
}

/** Removing an item that is not in the cart succeeds, so a retry is harmless. */
export function removeItem(db: Db, cartId: string, productId: string): CartView {
  return write(db, () => {
    requireOpenCart(db, cartId);
    db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?').run(
      cartId,
      productId,
    );
    return loadCart(db, cartId);
  });
}

interface CartRow {
  id: string;
  status: CartView['status'];
  createdAt: string;
  orderId: string | null;
}

function loadCart(db: Db, cartId: string): CartView {
  const cart = db
    .prepare(
      `SELECT c.id, c.status, c.created_at AS createdAt, o.id AS orderId
         FROM carts c LEFT JOIN orders o ON o.cart_id = c.id
        WHERE c.id = ?`,
    )
    .get(cartId) as CartRow | undefined;
  if (!cart) {
    throw new AppError(404, 'CART_NOT_FOUND', `Cart ${cartId} does not exist`, { cartId });
  }

  const rows = db
    .prepare(
      `SELECT p.id AS productId, p.name, p.unit_price_minor AS unitPriceMinor,
              ci.quantity, p.stock AS availableStock
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = ?
        ORDER BY p.id`,
    )
    .all(cartId) as Omit<CartLine, 'lineTotalMinor' | 'inStock'>[];

  const items = rows.map((row) => ({
    ...row,
    lineTotalMinor: row.unitPriceMinor * row.quantity,
    inStock: row.quantity <= row.availableStock,
  }));
  return {
    id: cart.id,
    status: cart.status,
    orderId: cart.orderId,
    items,
    subtotalMinor: items.reduce((sum, item) => sum + item.lineTotalMinor, 0),
    createdAt: cart.createdAt,
  };
}

function requireOpenCart(db: Db, cartId: string): void {
  const cart = loadCart(db, cartId);
  if (cart.status !== 'OPEN') {
    throw new AppError(409, 'CART_ALREADY_CHECKED_OUT', `Cart ${cartId} is already checked out`, {
      cartId,
      orderId: cart.orderId,
    });
  }
}
