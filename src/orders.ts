import type { Db } from './db';
import { AppError } from './errors';

export interface Order {
  id: string;
  cartId: string;
  items: OrderItem[];
  /** Sum of line totals, before any discount. */
  subtotalMinor: number;
  couponCode: string | null;
  discountPercent: number;
  discountMinor: number;
  /** subtotalMinor - discountMinor. Never negative. */
  totalMinor: number;
  createdAt: string;
}

export interface OrderItem {
  productId: string;
  /** Name and unit price as they were at checkout. */
  productName: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

const SELECT_ORDER = `
  SELECT id, cart_id AS cartId, subtotal_minor AS subtotalMinor, coupon_code AS couponCode,
         discount_percent AS discountPercent, discount_minor AS discountMinor,
         total_minor AS totalMinor, created_at AS createdAt
    FROM orders`;

const SELECT_ITEMS = `
  SELECT product_id AS productId, product_name AS productName,
         unit_price_minor AS unitPriceMinor, quantity, line_total_minor AS lineTotalMinor
    FROM order_items WHERE order_id = ? ORDER BY product_id`;

export function insertOrder(db: Db, order: Order): void {
  db.prepare(
    `INSERT INTO orders (id, cart_id, subtotal_minor, coupon_code, discount_percent,
                         discount_minor, total_minor, created_at)
     VALUES (@id, @cartId, @subtotalMinor, @couponCode, @discountPercent,
             @discountMinor, @totalMinor, @createdAt)`,
  ).run(order);
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price_minor,
                              quantity, line_total_minor)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const item of order.items) {
    insertItem.run(
      order.id,
      item.productId,
      item.productName,
      item.unitPriceMinor,
      item.quantity,
      item.lineTotalMinor,
    );
  }
}

export function getOrder(db: Db, orderId: string): Order {
  const order = db.prepare(`${SELECT_ORDER} WHERE id = ?`).get(orderId) as
    | Omit<Order, 'items'>
    | undefined;
  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', `Order ${orderId} does not exist`, { orderId });
  }
  return { ...order, items: db.prepare(SELECT_ITEMS).all(orderId) as OrderItem[] };
}

export function listOrders(db: Db): Order[] {
  const orders = db.prepare(`${SELECT_ORDER} ORDER BY created_at, id`).all() as Omit<
    Order,
    'items'
  >[];
  const items = db.prepare(SELECT_ITEMS);
  return orders.map((order) => ({ ...order, items: items.all(order.id) as OrderItem[] }));
}
