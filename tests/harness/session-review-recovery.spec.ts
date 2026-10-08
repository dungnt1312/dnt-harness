import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Kernel, fileSessions } from 'dnt-harness'

function boot(dir: string): Kernel {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(dir))
  return kernel
}

describe('declared tool batch recovery', () => {
  it.each([
    { recorded: 0, executionIds: true },
    { recorded: 1, executionIds: true },
    { recorded: 2, executionIds: true },
    { recorded: 0, executionIds: false },
    { recorded: 1, executionIds: false },
    { recorded: 2, executionIds: false },
  ])('completes replies after a crash with $recorded calls recorded (executionIds=$executionIds)', async ({ recorded, executionIds }) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-session-review-'))
    let kernel = boot(dir)
    try {
      const original = kernel.ctx.sessions.create('ws-review' as never)
      const calls = [0, 1, 2].map(index => ({ id: `c${index}`, name: 'Read', args: { path: `${index}.txt` } }))
      const previous = calls[2]!
      original.append({ type: 'turn/start', turnId: 't1' as never })
      original.append({ type: 'assistant/message', stepId: 's1' as never, content: '', toolCalls: [previous] })
      original.append({ type: 'tool/call', stepId: 's1' as never, call: previous })
      original.append({ type: 'tool/result', stepId: 's1' as never, callId: previous.id, ok: true, output: 'earlier step' })
      original.append({ type: 'turn/end', turnId: 't1' as never, reason: 'completed' })
      original.append({ type: 'turn/start', turnId: 't2' as never })
      original.append({ type: 'step/start', turnId: 't2' as never, stepId: 'abandoned' as never })
      original.append({ type: 'assistant/chunk', stepId: 'abandoned' as never, delta: 'discarded' })
      original.append({ type: 'step/abandoned', turnId: 't2' as never, stepId: 'abandoned' as never, reason: 'stream failed' })
      original.append({ type: 'step/start', turnId: 't2' as never, stepId: 's2' as never })
      original.append({ type: 'assistant/message', stepId: 's2' as never, content: '', toolCalls: calls })
      for (let index = 0; index < recorded; index++) {
        const call = calls[index]!
        const execution = executionIds ? { executionId: `execution-${index}` as never } : {}
        original.append({ type: 'tool/call', stepId: 's2' as never, call, ...execution })
        if (index < recorded - 1) {
          original.append({ type: 'tool/result', stepId: 's2' as never, callId: call.id, ok: true, output: 'finished', ...execution })
        }
      }
      await original.durable()
      const prefix = original.events.map(event => ({ ...event, v: 1 }))
      await kernel.stop()

      kernel = boot(dir)
      await kernel.ctx.sessions.boot()
      const recovered = await kernel.ctx.sessions.load(original.id)
      expect(recovered.events.slice(0, prefix.length)).toEqual(prefix)
      const results = recovered.events.filter(event => event.type === 'tool/result').filter(event => event.stepId === 's2')
      expect(results).toHaveLength(calls.length)
      for (let index = 0; index < calls.length; index++) {
        const result = results.find(event => event.callId === calls[index]!.id)
        if (index < recorded - 1) {
          expect(result).toMatchObject({ ok: true, output: 'finished' })
          expect(result?.recovery).toBeUndefined()
        } else {
          expect(result).toMatchObject({ ok: false, recovery: true })
          expect(result?.output).toMatch(index < recorded ? /outcome unknown/ : /call never started.*host was interrupted before it ran/)
          expect(result?.executionId).toBe(index < recorded && executionIds ? `execution-${index}` : undefined)
        }
      }
      expect(recovered.events.filter(event => event.type === 'tool/call')).toHaveLength(recorded + 1)
      expect(recovered.events.filter(event => event.type === 'tool/result' && event.recovery)).toHaveLength(3 - Math.max(0, recorded - 1))
      expect(recovered.events.at(-1)).toMatchObject({ type: 'turn/end', turnId: 't2', reason: 'interrupted' })
      const messages = recovered.deriveMessages()
      expect(messages.slice(2, 3)).toEqual([{ role: 'assistant', content: '', toolCalls: calls }])
      expect(messages.slice(3).map(message => message.role === 'tool' && message.toolCallId)).toEqual(calls.map(call => call.id))
      expect(recovered.committedEvents).toEqual(recovered.events)

      const repaired = recovered.events.map(event => ({ ...event, v: 1 }))
      await kernel.stop()
      kernel = boot(dir)
      await kernel.ctx.sessions.boot()
      const reloaded = await kernel.ctx.sessions.load(original.id)
      expect(reloaded.events).toEqual(repaired)
      expect(reloaded.deriveMessages()).toEqual(messages)
    } finally {
      await kernel.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
