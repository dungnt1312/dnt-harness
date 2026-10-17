import { priceOf } from './catalog.js'
import { applyDiscounts } from './discounts.js'

export class Cart {
  constructor() {
    this.lines = []
  }

  add(id, quantity = 1) {
    this.lines.push({ id, quantity })
    return this
  }

  subtotalCents() {
    let sum = 0
    for (const line of this.lines) sum += priceOf(line.id) * line.quantity
    return sum
  }

  totalCents(discounts = []) {
    return applyDiscounts(this.subtotalCents(), discounts)
  }
}
