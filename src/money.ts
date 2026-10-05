/**
 * Money is an integer number of minor units (paise). Nothing here uses a float.
 *
 * Discount rule: the percentage is applied once to the order subtotal and
 * rounded half up to the nearest minor unit. Because the amounts are
 * non-negative integers, floor((a * p + 50) / 100) is exactly "round half up".
 * The discount is then capped at the subtotal so a total can never go negative.
 */
export function percentDiscount(subtotalMinor: number, percent: number): number {
  const product = subtotalMinor * percent;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError('amount too large to discount exactly');
  }
  const rounded = Math.floor((product + 50) / 100);
  return Math.min(rounded, subtotalMinor);
}
