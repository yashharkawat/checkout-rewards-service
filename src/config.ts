export interface Config {
  /** n: one coupon becomes available for every nth placed order. */
  ordersPerCoupon: number;
  /** x: percentage off, a whole number from 1 to 100. */
  discountPercent: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return validateConfig({
    ordersPerCoupon: Number(env.COUPON_EVERY_N_ORDERS ?? 5),
    discountPercent: Number(env.COUPON_DISCOUNT_PERCENT ?? 10),
  });
}

/** Fail at startup rather than produce a nonsense discount at checkout. */
export function validateConfig(config: Config): Config {
  const { ordersPerCoupon: n, discountPercent: x } = config;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`COUPON_EVERY_N_ORDERS must be an integer >= 1, got ${n}`);
  }
  if (!Number.isInteger(x) || x < 1 || x > 100) {
    throw new Error(`COUPON_DISCOUNT_PERCENT must be an integer from 1 to 100, got ${x}`);
  }
  return config;
}
