import { describe, expect, it } from 'vitest'
import { editLineCounts, editOccurrences, lineDiff } from './line-diff.ts'

describe('lineDiff', () => {
  it('keeps shared head and tail lines as context', () => {
    expect(lineDiff('a\nb\nc', 'a\nX\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'X' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('aligns an inserted line in the middle instead of rewriting the block', () => {
    expect(editLineCounts('a\nb\nc\nd', 'a\nb\nNEW\nc\nd')).toEqual({ added: 1, removed: 0 })
    expect(editLineCounts('x\na\ny\nb', 'z\na\nw\nb')).toEqual({ added: 2, removed: 2 })
  })

  it('treats empty sides as pure additions or deletions', () => {
    expect(editLineCounts('', 'a\nb')).toEqual({ added: 2, removed: 0 })
    expect(editLineCounts('a\nb\n', '')).toEqual({ added: 0, removed: 2 })
  })

  it('reads the replaceAll count from the receipt, defaulting to one', () => {
    expect(editOccurrences('edited a.ts: replaced 4 occurrences')).toBe(4)
    expect(editOccurrences('edited a.ts\n  3\tx')).toBe(1)
    expect(editOccurrences(undefined)).toBe(1)
  })
})
