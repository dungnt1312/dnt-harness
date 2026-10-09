import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AutomationError,
  AutomationScheduler,
  AutomationStore,
  excerpt,
  latestDueBetween,
  nextRuns,
  parseAutomationInput,
  planOf,
  runTitle,
  validateCron,
  type Automation,
} from '../../src/web/automations.ts'

const at = (iso: string): number => new Date(iso).getTime()
const WS = 'ws-test'

function base(overrides: Record<string, unknown> = {}): ReturnType<typeof parseAutomationInput> {
  return parseAutomationInput({ title: 'Pills', prompt: 'remind me', schedules: [{ cron: '0 7 * * *' }], ...overrides }, false)
}

/** Fake clock + timer: `advance` moves time and runs the timer when it falls due. */
function harness(start: number) {
  let now = start
  let timer: { fn: () => void; due: number } | undefined
  const fired: { id: string; dueAt: number }[] = []
  const store = new AutomationStore(undefined, () => now)
  let busy = false
  const scheduler = new AutomationScheduler({
    store,
    workspaces: () => [WS],
    now: () => now,
    setTimer: (fn, ms) => { timer = { fn, due: now + ms }; return timer },
    clearTimer: () => { timer = undefined },
    fire: async (_ws, automation, dueAt) => {
      if (busy) {
        await store.record(WS, { runId: `r-${dueAt}`, automationId: automation.id, dueAt, status: 'skipped-busy' })
        return false
      }
      fired.push({ id: automation.id, dueAt })
      return true
    },
  })
  return {
    store,
    scheduler,
    fired,
    setBusy: (value: boolean) => { busy = value },
    setNow: (value: number) => { now = value },
    timerDue: () => timer?.due,
    async advance(to: number): Promise<void> {
      while (timer !== undefined && timer.due <= to) {
        now = timer.due
        const { fn } = timer
        timer = undefined
        fn()
        await scheduler.poke()
      }
      now = to
    },
  }
}

describe('cron helpers', () => {
  it('validates five-field cron and normalizes whitespace', () => {
    expect(validateCron('  0   7 * * * ')).toBe('0 7 * * *')
    expect(() => validateCron('0 0 7 * * *')).toThrow(AutomationError)
    expect(() => validateCron('nope')).toThrow(/five fields/)
    expect(() => validateCron('61 7 * * *')).toThrow(/invalid cron/)
  })

  it('merges several schedules and finds the latest due time in a window', () => {
    const schedules = planOf([{ cron: '0 7 * * *' }, { cron: '0 19 * * *' }])
    const runs = nextRuns(schedules, at('2026-10-09T08:00:00'), 3)
    expect(runs).toEqual([at('2026-10-09T19:00:00'), at('2026-10-10T07:00:00'), at('2026-10-10T19:00:00')])
    expect(latestDueBetween(schedules, at('2026-10-09T06:00:00'), at('2026-10-09T20:00:00'))).toBe(at('2026-10-09T19:00:00'))
    expect(latestDueBetween(schedules, at('2026-10-09T07:00:00'), at('2026-10-09T08:00:00'))).toBeUndefined()
    // Inclusive upper bound: exactly on the due second counts.
    expect(latestDueBetween(schedules, at('2026-10-09T06:00:00'), at('2026-10-09T07:00:00'))).toBe(at('2026-10-09T07:00:00'))
  })
})

describe('parseAutomationInput', () => {
  it('fills defaults on create and rejects bad shapes', () => {
    const input = base()
    expect(input).toMatchObject({ title: 'Pills', enabled: true, catchUpMinutes: 120, projectId: null, modeId: null, controls: null })
    expect(() => parseAutomationInput({ prompt: '', schedules: [{ cron: '0 7 * * *' }] }, false)).toThrow(/prompt/)
    expect(() => parseAutomationInput({ prompt: 'x', schedules: [] }, false)).toThrow(/schedules/)
    expect(() => parseAutomationInput({ prompt: 'x', schedules: [{ cron: '0 7 * * *' }], controls: { provider: 'a', model: null } }, false)).toThrow(/controls/)
    expect(parseAutomationInput({ enabled: false }, true)).toEqual({ enabled: false })
  })
})

describe('AutomationScheduler', () => {
  it('fires at the due time and re-arms for the next one', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    const created = await h.store.create(WS, base())
    await h.scheduler.start()
    await h.scheduler.poke()
    expect(h.fired).toEqual([])
    await h.advance(at('2026-10-09T07:00:05'))
    expect(h.fired).toEqual([{ id: created.id, dueAt: at('2026-10-09T07:00:00') }])
    await h.advance(at('2026-10-10T07:00:05'))
    expect(h.fired.map((f) => f.dueAt)).toEqual([at('2026-10-09T07:00:00'), at('2026-10-10T07:00:00')])
  })

  it('never back-fires a due time from before the automation existed', async () => {
    const h = harness(at('2026-10-09T07:30:00'))
    await h.store.create(WS, base())
    await h.scheduler.start()
    await h.scheduler.poke()
    expect(h.fired).toEqual([])
  })

  it('catches up once inside the window and records missed outside it', async () => {
    const h = harness(at('2026-10-08T06:00:00'))
    const created = await h.store.create(WS, base())
    // Host was down; boots at 08:30 on the 9th: two due times passed, latest is 07:00 (90 min late).
    h.setNow(at('2026-10-09T08:30:00'))
    await h.scheduler.start()
    await h.scheduler.poke()
    expect(h.fired).toEqual([{ id: created.id, dueAt: at('2026-10-09T07:00:00') }])

    const late = harness(at('2026-10-08T06:00:00'))
    const other = await late.store.create(WS, base())
    late.setNow(at('2026-10-09T10:00:00'))
    await late.scheduler.start()
    await late.scheduler.poke()
    expect(late.fired).toEqual([])
    const history = await late.store.history(WS, other.id)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ status: 'missed', dueAt: at('2026-10-09T07:00:00') })
  })

  it('skips disabled automations and reports busy skips', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    const off = await h.store.create(WS, base({ enabled: false }))
    const on = await h.store.create(WS, base({ title: 'Mail' }))
    h.setBusy(true)
    await h.scheduler.start()
    await h.advance(at('2026-10-09T07:01:00'))
    expect(h.fired).toEqual([])
    expect(await h.store.history(WS, off.id)).toEqual([])
    expect((await h.store.history(WS, on.id))[0]).toMatchObject({ status: 'skipped-busy' })
  })

  it('caps the timer at one hour', async () => {
    const h = harness(at('2026-10-09T08:00:00'))
    await h.store.create(WS, base())
    await h.scheduler.start()
    await h.scheduler.poke()
    expect(h.timerDue()! - at('2026-10-09T08:00:00')).toBeLessThanOrEqual(60 * 60_000 + 250)
  })

  it('runs a one-time schedule once, then turns itself off', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    const created = await h.store.create(WS, base({ schedules: [{ at: at('2026-10-09T09:30:00') }] }))
    await h.scheduler.start()
    await h.advance(at('2026-10-10T12:00:00'))
    expect(h.fired).toEqual([{ id: created.id, dueAt: at('2026-10-09T09:30:00') }])
    expect((await h.store.get(WS, created.id)).enabled).toBe(false)
  })

  it('stops after N runs; busy skips do not count', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    const created = await h.store.create(WS, base({ maxRuns: 2 }))
    h.setBusy(true)
    await h.scheduler.start()
    await h.advance(at('2026-10-09T07:01:00'))
    h.setBusy(false)
    await h.advance(at('2026-10-13T08:00:00'))
    expect(h.fired.map((f) => f.dueAt)).toEqual([at('2026-10-10T07:00:00'), at('2026-10-11T07:00:00')])
    expect(await h.store.get(WS, created.id)).toMatchObject({ runCount: 2, enabled: false })
  })

  it('stops at the end date', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    const created = await h.store.create(WS, base({ endsAt: at('2026-10-10T23:59:59') }))
    await h.scheduler.start()
    await h.advance(at('2026-10-13T08:00:00'))
    expect(h.fired.map((f) => f.dueAt)).toEqual([at('2026-10-09T07:00:00'), at('2026-10-10T07:00:00')])
    expect((await h.store.get(WS, created.id)).enabled).toBe(false)
  })

  it('refuses a plan that never runs, and re-enabling one with nothing left', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    await expect(h.store.create(WS, base({ schedules: [{ at: at('2026-10-08T09:00:00') }] }))).rejects.toThrow(/never runs/)
    await expect(h.store.create(WS, base({ endsAt: at('2026-10-09T06:30:00') }))).rejects.toThrow(/never runs/)
    const once = await h.store.create(WS, base({ schedules: [{ at: at('2026-10-09T06:30:00') }] }))
    await h.scheduler.start()
    await h.advance(at('2026-10-09T07:00:00'))
    await expect(h.store.update(WS, once.id, { enabled: true })).rejects.toThrow(/no future runs/)
    // A new time revives it.
    const revived = await h.store.update(WS, once.id, { schedules: [{ at: at('2026-10-09T08:00:00') }], enabled: true })
    expect(revived).toMatchObject({ enabled: true, runCount: 0 })
  })

  it('saving an unchanged plan keeps the run count', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    const created = await h.store.create(WS, base({ maxRuns: 3 }))
    await h.scheduler.start()
    await h.advance(at('2026-10-09T07:01:00'))
    const saved = await h.store.update(WS, created.id, { title: 'Renamed', schedules: [{ cron: '0 7 * * *' }], maxRuns: 3, endsAt: null })
    expect(saved.runCount).toBe(1)
  })

  it('re-enabling rebases lastDueAt so time spent disabled is not caught up', async () => {
    const h = harness(at('2026-10-09T06:00:00'))
    const created = await h.store.create(WS, base({ enabled: false }))
    h.setNow(at('2026-10-09T07:30:00'))
    await h.store.update(WS, created.id, { enabled: true })
    await h.scheduler.start()
    await h.scheduler.poke()
    expect(h.fired).toEqual([])
  })
})

describe('AutomationStore persistence', () => {
  let home = ''
  beforeEach(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-auto-')) })
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

  it('round-trips definitions and folds run history by run id', async () => {
    const dir = (ws: string): string => path.join(home, ws)
    const first = new AutomationStore(dir)
    const created = await first.create(WS, base())
    await first.record(WS, { runId: 'r1', automationId: created.id, dueAt: 1, status: 'started', sessionId: 's1' })
    await first.record(WS, { runId: 'r1', automationId: created.id, dueAt: 1, status: 'done', summary: 'ok' })
    await first.flush()
    await fs.appendFile(path.join(home, WS, 'automation-runs.jsonl'), '{"torn":')

    const second = new AutomationStore(dir)
    const rows: readonly Automation[] = await second.list(WS)
    expect(rows.map((row) => row.id)).toEqual([created.id])
    const history = await second.history(WS, created.id)
    expect(history).toEqual([expect.objectContaining({ runId: 'r1', status: 'done', sessionId: 's1', summary: 'ok' })])
  })
})

describe('text helpers', () => {
  it('strips markdown for the push body and truncates', () => {
    expect(excerpt('## Today\n- **Take** pills\n- [mail](http://x)')).toBe('Today Take pills mail')
    expect(excerpt('a'.repeat(200)).length).toBe(140)
  })
  it('titles a run in host-local time', () => {
    expect(runTitle('Pills', at('2026-10-09T07:00:00'))).toBe('⏰ Pills · 09/10 07:00')
  })
})
