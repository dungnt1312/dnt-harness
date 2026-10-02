import { describe, expect, it } from 'vitest'
import { todoWriteTool } from '../../src/harness/tools/todo.ts'

const tool = todoWriteTool()
const run = (args: Record<string, unknown>): Promise<string> => tool.execute(args, { root: '' })

const item = (overrides: Partial<Record<string, string>> = {}): Record<string, string> => ({
  content: 'Run tests',
  status: 'pending',
  activeForm: 'Running tests',
  ...overrides,
})

describe('TodoWrite tool', () => {
  it('is a root-free Claude-compatible tool', () => {
    expect(tool.name).toBe('TodoWrite')
    expect(tool.requiresRoot).toBe(false)
    expect(tool.description).toContain('in_progress')
  })

  it('confirms a full list replacement with a receipt', async () => {
    const receipt = await run({
      todos: [item(), item({ content: 'Ship', status: 'completed', activeForm: 'Shipping' })],
    })
    expect(receipt).toBe('Todo list updated: 2 tasks (1 completed, 1 pending)')
  })

  it('counts statuses in fixed order, omits zero parts, pluralizes tasks', async () => {
    const receipt = await run({
      todos: [
        item({ status: 'completed', content: 'A', activeForm: 'Doing a' }),
        item({ status: 'in_progress', content: 'B', activeForm: 'Doing b' }),
        item({ content: 'C' }),
        item({ content: 'D' }),
      ],
    })
    expect(receipt).toBe('Todo list updated: 4 tasks (1 completed, 1 in progress, 2 pending)')
    const single = await run({ todos: [item({ status: 'in_progress', content: 'B', activeForm: 'Doing b' })] })
    expect(single).toBe('Todo list updated: 1 task (1 in progress)')
  })

  it('clears the list on an empty array', async () => {
    expect(await run({ todos: [] })).toBe('Todo list cleared')
  })

  it('rejects a non-array todos argument', async () => {
    await expect(run({ todos: 'nope' })).rejects.toThrow(/'todos' must be an array/)
    await expect(run({})).rejects.toThrow(/'todos' must be an array/)
  })

  it('rejects malformed items with one actionable message', async () => {
    await expect(run({ todos: [{ content: 'x' }] })).rejects.toThrow(/'content' and 'activeForm'/)
    await expect(run({ todos: [item({ status: 'done' })] })).rejects.toThrow(/pending, in_progress, or completed/)
    await expect(run({ todos: [item({ content: ' ' })] })).rejects.toThrow(/'content' and 'activeForm'/)
    await expect(run({ todos: [item({ activeForm: '' })] })).rejects.toThrow(/'content' and 'activeForm'/)
  })

  it('accepts exactly 100 items', async () => {
    const todos = Array.from({ length: 100 }, () => item())
    const receipt = await run({ todos })
    expect(receipt).toBe('Todo list updated: 100 tasks (100 pending)')
  })

  it('rejects more than 100 items', async () => {
    const todos = Array.from({ length: 101 }, () => item())
    await expect(run({ todos })).rejects.toThrow(/100 items/)
  })
})
