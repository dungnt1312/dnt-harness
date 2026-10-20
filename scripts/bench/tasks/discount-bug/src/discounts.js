/**
 * Apply an ordered list of discounts to a subtotal (integer cents).
 *
 * Supported discounts:
 *   { type: 'percent', value: n }  -> removes n% of the running total
 *   { type: 'fixed', value: n }    -> removes n dollars from the running total
 *
 * Percentages round to the nearest cent (half up). A discount never drives the
 * total below zero.
 */
export function applyDiscounts(subtotalCents, discounts) {
  let total = subtotalCents
  for (const discount of discounts) {
    if (discount.type === 'percent') {
      total -= Math.floor(total * (discount.value / 100))
    } else if (discount.type === 'fixed') {
      total -= Math.round(discount.value * 100)
    } else {
      throw new Error(`unknown discount type: ${discount.type}`)
    }
    if (total < 0) total = 0
  }
  return total
}
