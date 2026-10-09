import { describe, expect, it } from 'vitest'
import {
  describePlan,
  describeRule,
  localInstant,
  newRule,
  ruleToSchedules,
  scheduleToRule,
  schedulesToRules,
  type ScheduleRule,
} from './automation-schedule.ts'

const nine = { hour: 9, minute: 0 }

describe('schedule rules', () => {
  it('turns friendly rules into host schedules', () => {
    const cases: readonly [ScheduleRule, readonly unknown[]][] = [
      [{ kind: 'minutes', every: 10, window: null, days: [0, 1, 2, 3, 4, 5, 6] }, [{ cron: '*/10 * * * *' }]],
      [{ kind: 'minutes', every: 15, window: { from: 8, to: 22 }, days: [1, 2, 3, 4, 5] }, [{ cron: '*/15 8-21 * * 1-5' }]],
      [{ kind: 'hours', every: 2, minute: 30, window: null, days: [0, 1, 2, 3, 4, 5, 6] }, [{ cron: '30 */2 * * *' }]],
      [{ kind: 'hours', every: 3, minute: 0, window: { from: 9, to: 18 }, days: [0, 1, 2, 3, 4, 5, 6] }, [{ cron: '0 9-17/3 * * *' }]],
      [{ kind: 'daily', times: [{ hour: 7, minute: 0 }, { hour: 19, minute: 0 }], days: [0, 1, 2, 3, 4, 5, 6] }, [{ cron: '0 7 * * *' }, { cron: '0 19 * * *' }]],
      [{ kind: 'daily', times: [nine], days: [1, 3, 5] }, [{ cron: '0 9 * * 1,3,5' }]],
      [{ kind: 'monthly', day: 'last', time: nine }, [{ cron: '0 9 L * *' }]],
      [{ kind: 'monthly', day: 15, time: nine }, [{ cron: '0 9 15 * *' }]],
      [{ kind: 'once', date: '2026-10-10', time: { hour: 7, minute: 30 } }, [{ at: localInstant('2026-10-10', { hour: 7, minute: 30 }) }]],
    ]
    for (const [rule, schedules] of cases) {
      expect(ruleToSchedules(rule)).toEqual(schedules)
      // And back again: the editor reopens with the same rule.
      expect(schedulesToRules(ruleToSchedules(rule))).toEqual([rule])
    }
  })

  it('keeps anything else as a custom cron rule', () => {
    for (const cron of ['0 7 * 1 *', '0 7 1 * 1', '5,35 * * * *']) {
      expect(scheduleToRule({ cron })).toEqual({ kind: 'custom', cron })
    }
  })

  it('seeds new rules sensibly', () => {
    const now = new Date(2026, 9, 9, 14, 37).getTime()
    expect(newRule('once', now)).toEqual({ kind: 'once', date: '2026-10-09', time: { hour: 15, minute: 0 } })
    expect(newRule('weekdays', now)).toMatchObject({ kind: 'daily', days: [1, 2, 3, 4, 5] })
    expect(newRule('weekly', now)).toMatchObject({ kind: 'daily', days: [5] })
  })

  it('describes rules and plans in plain words', () => {
    expect(describeRule({ kind: 'minutes', every: 10, window: { from: 8, to: 22 }, days: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every 10 minutes between 08:00 and 22:00')
    expect(describeRule({ kind: 'daily', times: [{ hour: 7, minute: 0 }, { hour: 19, minute: 0 }], days: [1, 2, 3, 4, 5] })).toBe('On weekdays at 07:00, 19:00')
    expect(describeRule({ kind: 'daily', times: [nine], days: [1] })).toBe('Every Monday at 09:00')
    expect(describeRule({ kind: 'monthly', day: 2, time: nine })).toBe('Every month on the 2nd at 09:00')
    expect(describeRule({ kind: 'monthly', day: 'last', time: nine })).toBe('Every month on the last day at 09:00')
    expect(describePlan([{ cron: '0 7 * * *' }], null, 5)).toBe('Every day at 07:00 · 5 times total')
  })
})
