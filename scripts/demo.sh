#!/usr/bin/env bash
# Walks through the main behaviours with curl against a running server.
#   terminal 1:  npm run reset && npm start
#   terminal 2:  ./scripts/demo.sh
# Needs a fresh database (it assumes 3 posters in stock and no orders yet).
set -euo pipefail
BASE="${BASE_URL:-http://127.0.0.1:3000}"

json() { node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8'))$1"; }
say() { printf '\n== %s\n' "$1"; }
new_cart() { curl -s -X POST "$BASE/carts" | json .cart.id; }
put_item() { curl -s -o /dev/null -X PUT "$BASE/carts/$1/items/$2" -H 'Content-Type: application/json' -d "{\"quantity\": $3}"; }
checkout() { curl -s -X POST "$BASE/carts/$1/checkout" -H "Idempotency-Key: $2" -H 'Content-Type: application/json' -d "${3:-{\}}"; }
outcome() { node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log('  ', r.order ? 'OK    total ' + r.order.totalMinor + ' discount ' + r.order.discountMinor : 'ERROR ' + r.error.code)"; }

say "1. Retry with the same Idempotency-Key returns the same order"
CART=$(new_cart); put_item "$CART" mug 2
checkout "$CART" demo-retry | json .order.id
checkout "$CART" demo-retry | json .order.id
echo "   a different key on the same cart:"
checkout "$CART" demo-other-key | outcome

say "2. Five carts race for the 3 limited posters (requests sent in parallel)"
CARTS=()
for i in 1 2 3 4 5; do C=$(new_cart); put_item "$C" limited-poster 1; CARTS+=("$C"); done
for i in 0 1 2 3 4; do checkout "${CARTS[$i]}" "demo-race-$i" | outcome & done
wait
echo "   posters left: $(curl -s "$BASE/products" | json ".products.find(p => p.id === 'limited-poster').stock")"

say "3. Four orders so far; the default config rewards every 5th"
curl -s -X POST "$BASE/admin/coupons" | json .error.details
C=$(new_cart); put_item "$C" notebook 1; checkout "$C" demo-fifth | outcome
COUPON=$(curl -s -X POST "$BASE/admin/coupons" | json .coupon.code)
echo "   generated $COUPON"
echo "   asking again for the same milestone:"
curl -s -X POST "$BASE/admin/coupons" | json .error.code

say "4. Two checkouts use the coupon at the same moment; one wins"
A=$(new_cart); put_item "$A" tshirt 1
B=$(new_cart); put_item "$B" tshirt 1
checkout "$A" demo-coupon-a "{\"couponCode\": \"$COUPON\"}" | outcome &
checkout "$B" demo-coupon-b "{\"couponCode\": \"$COUPON\"}" | outcome &
wait
echo "   t-shirts left (100 minus the one winner): $(curl -s "$BASE/products" | json ".products.find(p => p.id === 'tshirt').stock")"

say "5. Price changes after the item was added; the client pinned the old total"
C=$(new_cart); put_item "$C" mug 1
curl -s -o /dev/null -X PATCH "$BASE/admin/products/mug" -H 'Content-Type: application/json' -d '{"unitPriceMinor": 39900}'
checkout "$C" demo-drift '{"expectedTotalMinor": 34900}' | json .error.code
checkout "$C" demo-drift-accepted '{"expectedTotalMinor": 39900}' | outcome

say "6. Report"
curl -s "$BASE/admin/report" | json .report
