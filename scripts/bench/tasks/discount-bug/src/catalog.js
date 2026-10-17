/** Product catalog. Prices are integer cents. */

export const CATALOG = {
  apple: { name: 'Apple', priceCents: 1999 },
  banana: { name: 'Banana', priceCents: 129 },
  cherry: { name: 'Cherry Pack', priceCents: 450 },
  donut: { name: 'Donut Box', priceCents: 1099 },
}

export function priceOf(id) {
  const item = CATALOG[id]
  if (item === undefined) throw new Error(`unknown product: ${id}`)
  return item.priceCents
}
