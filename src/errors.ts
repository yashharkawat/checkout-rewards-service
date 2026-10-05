/**
 * Every non-2xx response has the same body:
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 * `code` is the stable contract for clients. `message` is for humans and may change.
 */
export type ErrorCode =
  | 'INVALID_REQUEST' // 400 malformed body, params or headers
  | 'IDEMPOTENCY_KEY_REQUIRED' // 400 checkout without an Idempotency-Key header
  | 'NOT_FOUND' // 404 unknown route
  | 'CART_NOT_FOUND' // 404
  | 'PRODUCT_NOT_FOUND' // 404
  | 'ORDER_NOT_FOUND' // 404
  | 'CART_ALREADY_CHECKED_OUT' // 409
  | 'INSUFFICIENT_STOCK' // 409
  | 'PRICE_CHANGED' // 409 expectedTotalMinor no longer matches
  | 'COUPON_ALREADY_REDEEMED' // 409
  | 'NO_ELIGIBLE_MILESTONE' // 409 admin coupon generation with nothing to reward
  | 'CART_EMPTY' // 422
  | 'COUPON_NOT_FOUND' // 422
  | 'IDEMPOTENCY_KEY_REUSED' // 422 same key, different request
  | 'INTERNAL_ERROR' // 500
  | 'DATABASE_BUSY'; // 503 write lock not acquired in time, safe to retry

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
