/** The digest each recorded tool call earns on its activity row. */
import { describe, expect, it } from 'vitest'
import { toolFacts } from './tool-facts.ts'

describe('todowrite rows', () => {
  const todos = [
    { content: 'A', status: 'completed', activeForm: 'Doing a' },
    { content: 'B', status: 'completed', activeForm: 'Doing b' },
    { content: 'C', status: 'in_progress', activeForm: 'Doing c' },
    { content: 'D', status: 'pending', activeForm: 'Doing d' },
  ]

  it('targets the task count and digests progress', () => {
    const running = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, undefined)
    expect(running.target).toBe('4 tasks')
    expect(running.digest).toBeUndefined()

    const done = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, { ok: true, output: 'Todo list updated: 4 tasks (2 completed, 1 in progress, 1 pending)' })
    expect(done.target).toBe('4 tasks')
    expect(done.digest).toBe('2 done · 1 in progress')
  })

  it('keeps the failure excerpt on a failed call', () => {
    const failed = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, { ok: false, output: 'error: every todo needs non-empty …' })
    expect(failed.digestFailed).toBe(true)
  })
})
