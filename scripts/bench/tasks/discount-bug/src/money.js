/** Money is always handled in integer cents. */

export function toCents(amount) {
  return Math.round(amount * 100)
}

export function fromCents(cents) {
  return cents / 100
}

export function formatMoney(cents) {
  return `$${fromCents(cents).toFixed(2)}`
}
