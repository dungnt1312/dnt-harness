import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localDate, longestMergedSpan, openUsageLog, parseUsageLine, SESSION_GAP_MS } from '../../src/web/usage-log.ts'

const base = { sessionId: 's1', rootSessionId: 's1', kind: 'turn' as const, model: 'm1', input: 100, cached: 40, output: 10 }

describe('usage log', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-log-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('rebuilds the same daily rows after reopening', async () => {
    const file = path.join(dir, 'nested', 'usage.jsonl')
    const now = new Date(2026, 9, 8, 12).getTime()
    const log = await openUsageLog(file, { now: () => now })
    log.record({ ...base, at: now - 1000, startedAt: now - 2000 })
    log.record({ ...base, at: now, startedAt: now - 500, model: 'm2', output: 5 })
    log.record({ ...base, at: now - 86_400_000, startedAt: now - 86_400_000 })
    await log.flush()
    const reopened = await openUsageLog(file, { now: () => now })
    expect(reopened.daily()).toEqual(log.daily())
    const rows = reopened.daily().days
    expect(rows).toContainEqual({ date: '2026-10-08', model: 'm1', input: 100, cached: 40, output: 10, requests: 1 })
    expect(rows).toContainEqual({ date: '2026-10-08', model: 'm2', input: 100, cached: 40, output: 5, requests: 1 })
    expect(rows).toContainEqual({ date: '2026-10-07', model: 'm1', input: 100, cached: 40, output: 10, requests: 1 })
    expect(reopened.daily().today).toBe('2026-10-08')
  })

  it('skips truncated, malformed and foreign-version lines', async () => {
    const file = path.join(dir, 'usage.jsonl')
    const at = new Date(2026, 9, 8, 9).getTime()
    const good = JSON.stringify({ v: 1, ...base, at, startedAt: at })
    await fs.writeFile(file, `${good}\n{"v":1,"at":12\nnot json\n${JSON.stringify({ v: 2, ...base, at, startedAt: at })}\n\n${good}\n`)
    const log = await openUsageLog(file, { now: () => at })
    expect(log.daily().days).toEqual([{ date: '2026-10-08', model: 'm1', input: 200, cached: 80, output: 20, requests: 2 }])
  })

  it('drops days outside the 371-day window', async () => {
    const file = path.join(dir, 'usage.jsonl')
    const now = new Date(2026, 9, 8, 12).getTime()
    const log = await openUsageLog(file, { now: () => now })
    log.record({ ...base, at: now - 400 * 86_400_000, startedAt: now - 400 * 86_400_000 })
    await log.flush()
    expect(log.daily().days).toEqual([])
    expect(log.daily().firstRecordAt).toBeDefined()
  })

  it('serializes concurrent appends into whole lines', async () => {
    const file = path.join(dir, 'usage.jsonl')
    const log = await openUsageLog(file)
    for (let i = 0; i < 200; i += 1) log.record({ ...base, at: Date.now(), startedAt: Date.now(), sessionId: `s${i}` })
    await log.flush()
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(200)
    expect(lines.every((line) => parseUsageLine(line) !== undefined)).toBe(true)
  })

  it('degrades to a warning when the file cannot be written', async () => {
    const blocker = path.join(dir, 'blocker')
    await fs.writeFile(blocker, 'x')
    const warnings: string[] = []
    const log = await openUsageLog(path.join(blocker, 'usage.jsonl'), { warn: (m) => warnings.push(m) })
    log.record({ ...base, at: Date.now(), startedAt: Date.now() })
    log.record({ ...base, at: Date.now(), startedAt: Date.now() })
    await log.flush()
    expect(warnings).toHaveLength(1)
    expect(log.daily().days[0]?.requests).toBe(2)
  })

  it('folds child usage into the root session span', async () => {
    const now = new Date(2026, 9, 8, 12).getTime()
    const log = await openUsageLog(path.join(dir, 'u.jsonl'), { now: () => now })
    log.record({ ...base, startedAt: now - 3_600_000, at: now - 3_500_000 })
    log.record({ ...base, sessionId: 'child', kind: 'child', startedAt: now - 3_500_000, at: now - 1_800_000 })
    await log.flush()
    expect(log.daily().longestSessionMs).toBe(1_800_000)
  })
})

describe('longestMergedSpan', () => {
  it('merges gaps up to 30 minutes and splits longer idles', () => {
    const m = 60_000
    expect(longestMergedSpan([])).toBe(0)
    expect(longestMergedSpan([[0, 10 * m], [40 * m, 50 * m]])).toBe(50 * m)
    expect(longestMergedSpan([[0, 10 * m], [41 * m, 50 * m]])).toBe(10 * m)
    expect(longestMergedSpan([[100 * m, 130 * m], [0, 5 * m], [131 * m, 300 * m]])).toBe(200 * m)
    expect(SESSION_GAP_MS).toBe(30 * m)
  })
})

describe('localDate', () => {
  it('buckets by the host-local calendar day', () => {
    expect(localDate(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02')
    expect(localDate(new Date(2026, 0, 3, 0, 0).getTime())).toBe('2026-01-03')
  })
})
