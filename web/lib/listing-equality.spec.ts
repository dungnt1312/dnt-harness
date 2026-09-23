import { describe, expect, it } from 'vitest'
import { sameListing } from './listing-equality.ts'

const a = { id: 's', title: 'One', folder: null, eventCount: 2, status: 'idle' as const }
const b = { id: 't', title: 'Two', folder: null, eventCount: 3, status: 'running' as const }

describe('sidebar polling equality', () => {
  it('preserves an unchanged array despite fresh JSON row objects', () => {
    expect(sameListing([a, b], [{ ...a }, { ...b }])).toBe(true)
  })
  it('detects live badge changes and reordering', () => {
    expect(sameListing([a, b], [{ ...a }, { ...b, status: 'idle' }])).toBe(false)
    expect(sameListing([a, b], [{ ...b }, { ...a }])).toBe(false)
  })
})
