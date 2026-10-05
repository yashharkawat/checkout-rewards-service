import { describe, expect, it } from 'vitest';
import { percentDiscount } from '../src/money';

describe('percentDiscount', () => {
  it('rounds half up to the nearest minor unit', () => {
    expect(percentDiscount(1004, 10)).toBe(100); // 100.4 -> 100
    expect(percentDiscount(1005, 10)).toBe(101); // 100.5 -> 101
    expect(percentDiscount(1006, 10)).toBe(101); // 100.6 -> 101
    expect(percentDiscount(1, 50)).toBe(1); //   0.5 -> 1
    expect(percentDiscount(1, 49)).toBe(0); //   0.49 -> 0
  });

  it('is exact where floating point is not', () => {
    // 0.07 * 3 is 0.21000000000000002 in floats. In minor units it is just 21.
    expect(percentDiscount(300, 7)).toBe(21);
    expect(percentDiscount(24999, 15)).toBe(3750); // 3749.85 -> 3750
  });

  it('never exceeds the subtotal, so a total cannot go negative', () => {
    expect(percentDiscount(0, 10)).toBe(0);
    expect(percentDiscount(999, 100)).toBe(999);
    for (const subtotal of [1, 2, 3, 49, 50, 51, 99, 101, 79900]) {
      for (let percent = 1; percent <= 100; percent++) {
        const discount = percentDiscount(subtotal, percent);
        expect(discount).toBeGreaterThanOrEqual(0);
        expect(discount).toBeLessThanOrEqual(subtotal);
      }
    }
  });

  it('refuses amounts it cannot compute exactly', () => {
    expect(() => percentDiscount(Number.MAX_SAFE_INTEGER, 10)).toThrow(RangeError);
  });
});
