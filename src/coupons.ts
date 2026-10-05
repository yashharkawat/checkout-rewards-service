import { randomBytes } from 'node:crypto';
import type { Config } from './config';
import { write, type Db } from './db';
import { AppError } from './errors';

export interface Coupon {
  code: string;
  /** Milestone k rewards the (k * n)th placed order. */
  milestone: number;
  discountPercent: number;
  status: 'AVAILABLE' | 'REDEEMED';
  redeemedOrderId: string | null;
  redeemedAt: string | null;
  createdAt: string;
}

const SELECT_COUPON = `
  SELECT code, milestone, discount_percent AS discountPercent,
         CASE WHEN redeemed_order_id IS NULL THEN 'AVAILABLE' ELSE 'REDEEMED' END AS status,
         redeemed_order_id AS redeemedOrderId, redeemed_at AS redeemedAt, created_at AS createdAt
    FROM coupons`;

/**
 * Admin: generate the coupon for the earliest milestone that has been reached
 * and has no coupon yet. One coupon per call.
 *
 * Coupons are always generated in milestone order, so "earliest unrewarded" is
 * simply MAX(milestone) + 1. UNIQUE (milestone) is what makes this safe if two
 * admins call at the same moment: only one insert for a milestone can commit.
 */
export function generateCoupon(db: Db, config: Config): Coupon {
  return write(db, () => {
    const { ordersPlaced } = db.prepare('SELECT COUNT(*) AS ordersPlaced FROM orders').get() as {
      ordersPlaced: number;
    };
    const { couponsGenerated } = db
      .prepare('SELECT COALESCE(MAX(milestone), 0) AS couponsGenerated FROM coupons')
      .get() as { couponsGenerated: number };

    const milestonesReached = Math.floor(ordersPlaced / config.ordersPerCoupon);
    const nextMilestone = couponsGenerated + 1;
    if (nextMilestone > milestonesReached) {
      throw new AppError(409, 'NO_ELIGIBLE_MILESTONE', 'No order milestone is waiting for a coupon', {
        ordersPlaced,
        ordersPerCoupon: config.ordersPerCoupon,
        couponsGenerated,
        nextMilestoneAtOrder: nextMilestone * config.ordersPerCoupon,
      });
    }

    // The code is the only secret a holder needs, so it has to be unguessable.
    const code = `SAVE${config.discountPercent}-${randomBytes(6).toString('hex').toUpperCase()}`;
    db.prepare(
      'INSERT INTO coupons (code, milestone, discount_percent, created_at) VALUES (?, ?, ?, ?)',
    ).run(code, nextMilestone, config.discountPercent, new Date().toISOString());
    return db.prepare(`${SELECT_COUPON} WHERE code = ?`).get(code) as Coupon;
  });
}

export function listCoupons(db: Db): Coupon[] {
  return db.prepare(`${SELECT_COUPON} ORDER BY milestone`).all() as Coupon[];
}
