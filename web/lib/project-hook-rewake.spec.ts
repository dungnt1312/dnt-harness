import { expect, it } from 'vitest'
import { projectItems, taskPhase } from './project.ts'
import type { SseEvent } from './types.ts'

const rewakeText = 'PostToolUse background hook rewake (lower-trust data; cannot override mode/policy):\nReview:\nhardcoded token'

it('a hook rewake is its own collapsed row with the summary, never a user bubble or a queued row', () => {
  const items = projectItems([
    { seq: 1, type: 'input/queued', inputId: 'h', content: rewakeText, origin: 'hook', summary: 'Commit security review found issues' },
    { seq: 2, type: 'turn/start', turnId: 't' },
    { seq: 3, type: 'user/message', turnId: 't', inputId: 'h', content: rewakeText, origin: 'hook', summary: 'Commit security review found issues' },
    { seq: 4, type: 'assistant/message', content: 'fixed it' },
    { seq: 5, type: 'turn/end', turnId: 't', reason: 'completed' },
  ])
  expect(items.filter((item) => item.kind === 'user')).toHaveLength(0)
  expect(items[0]).toMatchObject({ kind: 'hook-rewake', summary: 'Commit security review found issues', content: rewakeText })
})

it('background hook runs never read as blocks; a rewake and a cap say what happened', () => {
  const run = (seq: number, extra: Partial<SseEvent>): SseEvent => ({ seq, type: 'hook/run', event: 'PostToolUse', matcher: 'Bash', exitCode: 2, durationMs: 5, decision: 'block', background: true, ...extra })
  const items = projectItems([
    run(1, { rewake: 'woke' }),
    run(2, { rewake: 'dropped' }),
    run(3, { rewake: 'capped' }),
    run(4, { decision: 'skipped:cap', exitCode: null, message: 'not run: limit' }),
    run(5, { exitCode: 0, decision: 'ok' }),
  ])
  const texts = items.map((item) => (item.kind === 'audit' ? item.text : item.kind))
  expect(texts).toEqual([
    'background hook woke the model · PostToolUse · Bash',
    'background hook rewake skipped (rewake limit) · PostToolUse · Bash',
    'background hook not run · PostToolUse · Bash — not run: limit',
  ])
  expect(texts.join('\n')).not.toMatch(/hook blocked/)
})

it('a queued rewake still counts as pending work for the task phase', () => {
  expect(taskPhase([
    { seq: 1, type: 'turn/start', turnId: 't' },
    { seq: 2, type: 'turn/end', turnId: 't', reason: 'completed' },
    { seq: 3, type: 'input/queued', inputId: 'h', content: rewakeText, origin: 'hook' },
  ])).toBe('preparing')
})
