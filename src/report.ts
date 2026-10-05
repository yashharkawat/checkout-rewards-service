import { read, type Db } from './db';

export interface Report {
  totalOrders: number;
  /** One row per product, including products that have not sold. */
  itemsSold: { productId: string; productName: string; quantity: number }[];
  grossRevenueMinor: number;
  totalDiscountMinor: number;
  netRevenueMinor: number;
  coupons: { generated: number; available: number; redeemed: number };
}

/**
 * Computed from orders and coupons on every call. There are no stored counters,
 * so the report cannot drift from the data and reading it changes nothing.
 * The three queries run in one read transaction so they describe one moment.
 */
export function buildReport(db: Db): Report {
  return read(db, () => {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS totalOrders,
                COALESCE(SUM(subtotal_minor), 0) AS grossRevenueMinor,
                COALESCE(SUM(discount_minor), 0) AS totalDiscountMinor,
                COALESCE(SUM(total_minor), 0) AS netRevenueMinor
           FROM orders`,
      )
      .get() as Omit<Report, 'itemsSold' | 'coupons'>;

    const itemsSold = db
      .prepare(
        `SELECT p.id AS productId, p.name AS productName, COALESCE(SUM(oi.quantity), 0) AS quantity
           FROM products p LEFT JOIN order_items oi ON oi.product_id = p.id
          GROUP BY p.id, p.name
          ORDER BY p.id`,
      )
      .all() as Report['itemsSold'];

    // COUNT(column) counts only non-NULL values, i.e. redeemed coupons.
    const coupons = db
      .prepare('SELECT COUNT(*) AS generated, COUNT(redeemed_order_id) AS redeemed FROM coupons')
      .get() as { generated: number; redeemed: number };

    return {
      ...totals,
      itemsSold,
      coupons: {
        generated: coupons.generated,
        available: coupons.generated - coupons.redeemed,
        redeemed: coupons.redeemed,
      },
    };
  });
}
