import test from 'node:test'
import assert from 'node:assert/strict'

import { Cart } from '../src/cart.js'
import { applyDiscounts } from '../src/discounts.js'

test('subtotal sums line items', () => {
  const cart = new Cart().add('apple', 2).add('banana', 3)
  assert.equal(cart.subtotalCents(), 4385)
})

test('percent discount rounds to the nearest cent', () => {
  assert.equal(applyDiscounts(1999, [{ type: 'percent', value: 10 }]), 1799)
  assert.equal(applyDiscounts(4385, [{ type: 'percent', value: 15 }]), 3727)
})

test('fixed discount subtracts exact dollars', () => {
  assert.equal(applyDiscounts(5000, [{ type: 'fixed', value: 12.5 }]), 3750)
})

test('total combines subtotal and discounts', () => {
  const cart = new Cart().add('donut').add('cherry', 2)
  assert.equal(cart.totalCents([{ type: 'percent', value: 10 }]), 1799)
})

test('a discount never drives the total below zero', () => {
  assert.equal(applyDiscounts(500, [{ type: 'fixed', value: 99 }]), 0)
})
