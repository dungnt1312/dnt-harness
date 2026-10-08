// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { DISMISSED_STORAGE_KEY, MAX_DISMISSED_SESSIONS, dismissRows, dismissedKey, parseDismissed, readDismissed, resetDismissedCache, serializeDismissed, undismissRow } from './dismissed-rows.ts'

afterEach(() => {
  window.localStorage.clear()
  resetDismissedCache()
})

it('persists a Clear across a reload (cache reset) per workspace+session', () => {
  const key = dismissedKey('ws1', 's1')
  dismissRows(key, ['proc_a', 'proc_b'])
  resetDismissedCache()
  expect([...readDismissed(key)].sort()).toEqual(['proc_a', 'proc_b'])
  expect(readDismissed(dismissedKey('ws1', 's2')).size).toBe(0)
})

it('undismiss removes one id and drops an emptied conversation', () => {
  const key = dismissedKey('ws1', 's1')
  dismissRows(key, ['proc_a'])
  undismissRow(key, 'proc_a')
  resetDismissedCache()
  expect(readDismissed(key).size).toBe(0)
  expect(window.localStorage.getItem(DISMISSED_STORAGE_KEY)).toBe('{}')
})

it('ignores a null scope and corrupt storage', () => {
  dismissRows(null, ['x'])
  expect(window.localStorage.getItem(DISMISSED_STORAGE_KEY)).toBeNull()
  expect(parseDismissed('not json').size).toBe(0)
  expect(parseDismissed('{"a":[1,"ok"],"b":"nope"}').get('a')).toEqual(new Set(['ok']))
})

it('keeps only the newest conversations', () => {
  const entries = new Map<string, ReadonlySet<string>>()
  for (let index = 0; index < MAX_DISMISSED_SESSIONS + 5; index++) entries.set(`k${index}`, new Set(['p']))
  const kept = parseDismissed(serializeDismissed(entries))
  expect(kept.size).toBe(MAX_DISMISSED_SESSIONS)
  expect(kept.has('k0')).toBe(false)
  expect(kept.has(`k${MAX_DISMISSED_SESSIONS + 4}`)).toBe(true)
})
