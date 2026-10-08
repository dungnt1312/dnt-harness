import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { taskPhase, projectItems } from './project.ts'
import { validConversationScope } from './interaction.ts'
import { TaskStatus } from '../components/chat/TaskStatus.tsx'
import { ApprovalBar } from '../components/chat/ApprovalBar.tsx'
import type { SseEvent } from './types.ts'
const project = { id: 'p1', name: 'Project', workspaceId: 'w1', path: 'C:/code', createdAt: 1 }
const events = (...types: string[]): SseEvent[] => types.map((type, seq) => ({ type, seq }))
describe('production conversation workflows', () => {
  it('requires a registered project or chat-only scope, never a stale id', () => {
    expect(validConversationScope('deleted-project', ['p1'])).toBe(false)
    expect(validConversationScope('p1', ['p1'])).toBe(true)
    expect(validConversationScope(null, [])).toBe(true)
  })
  it('derives preparing from durable acceptance and consumes input on start', () => {
    const queued: SseEvent = { type: 'input/queued', seq: 0, inputId: 'i1' }
    expect(taskPhase([queued])).toBe('preparing')
    expect(taskPhase([queued, { type: 'turn/start', seq: 1 }, { type: 'user/message', seq: 2, inputId: 'i1' }, { type: 'turn/end', seq: 3, reason: 'completed' }])).toBe('completed')
    expect(taskPhase([], 0, true)).toBe('preparing')
  })
  it('queue left behind by a stop or restart is held — a resting state, not "preparing"', () => {
    const run = (reason: string): SseEvent[] => [
      { type: 'turn/start', seq: 0 },
      { type: 'input/queued', seq: 1, inputId: 'q' },
      { type: 'turn/end', seq: 2, reason },
    ]
    expect(taskPhase(run('cancelled'))).toBe('held')
    expect(taskPhase(run('interrupted'))).toBe('held')
    // A steered turn hands the queue to the next turn: that is preparing.
    expect(taskPhase(run('steered'))).toBe('preparing')
  })
  it('shows waiting only for a running turn, not stale approvals after end', () => {
    expect(taskPhase(events('turn/start'), 1)).toBe('waiting')
    expect(taskPhase(events('turn/start'), 0)).toBe('running')
    expect(taskPhase([{ type: 'turn/end', seq: 0, reason: 'completed' }], 1)).toBe('completed')
  })
  it('a rejected or empty input ends "preparing" and shows Not sent, not a stuck queued bubble (fix A)', () => {
    const log: SseEvent[] = [
      { type: 'input/queued', seq: 0, inputId: 'i1', content: 'Run it' },
      { type: 'turn/start', seq: 1, turnId: 't1' },
      { type: 'input/settled', seq: 2, inputId: 'i1', outcome: 'rejected' },
      { type: 'turn/error', seq: 3, turnId: 't1', kind: 'rejected', message: 'hook failed' },
      { type: 'turn/end', seq: 4, turnId: 't1', reason: 'rejected' },
    ]
    expect(taskPhase(log)).toBe('rejected')
    const items = projectItems(log)
    expect(items[0]).toMatchObject({ kind: 'user', content: 'Run it', queued: false, notSent: 'rejected' })
    // A policy rejection is deterministic: no Retry (Reuse puts the text back).
    expect(items.some((item) => item.kind === 'status' && item.retry !== undefined)).toBe(false)
  })
  it('Retry resends what the user typed, not a hook rewrite whose user/message has no id', () => {
    const items = projectItems([
      { type: 'input/queued', seq: 0, inputId: 'i1', content: 'Typed by me' },
      { type: 'turn/start', seq: 1, turnId: 't1' },
      { type: 'user/message', seq: 2, turnId: 't1', content: 'Hook-provided context…\nTyped by me (rewritten)' },
      { type: 'input/settled', seq: 3, inputId: 'i1', outcome: 'admitted' },
      { type: 'turn/error', seq: 4, turnId: 't1', kind: 'provider', message: 'boom' },
      { type: 'turn/end', seq: 5, turnId: 't1', reason: 'failed' },
    ])
    expect(items.find((item) => item.kind === 'status' && item.retry !== undefined)).toMatchObject({
      retry: { key: 'seq-4', inputs: [{ content: 'Typed by me' }], toolsRan: false },
    })
  })
  it('an admitted settle does not mark the bubble Not sent', () => {
    const items = projectItems([
      { type: 'input/queued', seq: 0, inputId: 'i1', content: 'Hi' },
      { type: 'turn/start', seq: 1, turnId: 't1' },
      { type: 'user/message', seq: 2, turnId: 't1', inputId: 'i1', content: 'Hi' },
      { type: 'input/settled', seq: 3, inputId: 'i1', outcome: 'admitted' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'user', queued: false })
    expect(items[0]).not.toHaveProperty('notSent')
  })
  it('Retry targets the failed turn, not the newest message, and knows when tools ran (fix D)', () => {
    const items = projectItems([
      { type: 'input/queued', seq: 0, inputId: 'a', content: 'First' },
      { type: 'turn/start', seq: 1, turnId: 't1' },
      { type: 'user/message', seq: 2, turnId: 't1', inputId: 'a', content: 'First' },
      { type: 'tool/call', seq: 3, call: { id: 'c1', name: 'Write', args: {} } },
      { type: 'tool/result', seq: 4, callId: 'c1', ok: true, output: 'ok' },
      { type: 'turn/error', seq: 5, turnId: 't1', kind: 'provider', message: 'boom' },
      { type: 'turn/end', seq: 6, turnId: 't1', reason: 'failed' },
      { type: 'input/queued', seq: 7, inputId: 'b', content: 'Second' },
      { type: 'turn/start', seq: 8, turnId: 't2' },
      { type: 'user/message', seq: 9, turnId: 't2', inputId: 'b', content: 'Second' },
      { type: 'turn/error', seq: 10, turnId: 't2', kind: 'provider', message: 'boom again' },
      { type: 'turn/end', seq: 11, turnId: 't2', reason: 'failed' },
    ])
    const retries = items.flatMap((item) => item.kind === 'status' && item.retry !== undefined ? [item.retry] : [])
    expect(retries).toEqual([
      { key: 'seq-5', inputs: [{ content: 'First' }], toolsRan: true },
      { key: 'seq-10', inputs: [{ content: 'Second' }], toolsRan: false },
    ])
  })
  it('a steered input is marked until its turn claims it; the steered turn reads Redirected', () => {
    const log: SseEvent[] = [
      { type: 'turn/start', seq: 0, turnId: 't1' },
      { type: 'input/queued', seq: 1, inputId: 's', content: 'Do this instead', delivery: 'steer' },
    ]
    expect(projectItems(log)[0]).toMatchObject({ kind: 'user', queued: true, steer: true, inputId: 's' })
    const done = projectItems([...log,
      { type: 'turn/end', seq: 2, turnId: 't1', reason: 'steered' },
      { type: 'turn/start', seq: 3, turnId: 't2' },
      { type: 'user/message', seq: 4, turnId: 't2', inputId: 's', content: 'Do this instead' },
    ])
    // The claimed steer opens the turn it runs: after the stopped turn's status.
    expect(done.map((item) => item.kind)).toEqual(['status', 'user'])
    expect(done.at(-1)).toMatchObject({ kind: 'user', queued: false })
    expect(done.at(-1)).not.toHaveProperty('steer')
    expect(taskPhase([{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1, reason: 'steered' }])).toBe('steered')
  })
  it.each(['completed', 'failed', 'interrupted', 'cancelled', 'steered', 'limit', 'empty', 'rejected'] as const)('preserves durable terminal reason %s', (reason) => {
    expect(taskPhase([{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1, reason }])).toBe(reason)
  })
  it('ends incomplete streamed output on interruption and retains approval decisions', () => {
    const items = projectItems([{ type: 'assistant/chunk', seq: 0, delta: 'partial' }, { type: 'approval/decision', seq: 1, approvalId: 'a1', decision: 'invalidated' }, { type: 'turn/end', seq: 2, reason: 'interrupted' }])
    expect(items[0]).toMatchObject({ kind: 'assistant', live: false, thinkingLive: false })
    expect(items).toContainEqual({ kind: 'audit', icon: 'expired', text: 'Invalidated · no decision recorded' })
  })
  it('separates connection loss from execution and never offers replay', () => {
    const html = renderToStaticMarkup(<TaskStatus events={[{ type: 'turn/end', seq: 0, reason: 'interrupted' }, { type: 'tool/result', seq: 1, recovery: true }]} pending={0} sending={false} connected={false} />)
    expect(html).toContain('does not mean work has stopped')
    expect(html).not.toContain('Before continuing')
    expect(html).toContain('unknown')
    expect(html).not.toContain('<button')
  })
  it('does not repeat an old recovery warning in a later interrupted turn', () => {
    const html = renderToStaticMarkup(<TaskStatus events={[
      { type: 'turn/start', seq: 0, turnId: 'old' },
      { type: 'tool/result', seq: 1, recovery: true },
      { type: 'turn/end', seq: 2, turnId: 'old', reason: 'interrupted' },
      { type: 'turn/start', seq: 3, turnId: 'new' },
      { type: 'turn/end', seq: 4, turnId: 'new', reason: 'interrupted' },
    ]} pending={0} sending={false} connected={true} />)
    expect(html).toContain('Interrupted')
    expect(html).not.toContain('A recovered tool outcome may be unknown')
  })
  it('resolved approval history is not rendered as a failed request', async () => {
    const { StatusLine } = await import('../components/chat/MessageParts.tsx')
    const html = renderToStaticMarkup(<StatusLine reason="Permission decision · a1: allow" />)
    expect(html).toContain('allow')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('not completed')
  })
  it('approval shows all arguments, target and bounded decision scope with escaped content', () => {
    const html = renderToStaticMarkup(<ApprovalBar scope="C:/code" approvals={[{ approvalId: 'a', call: { id: 'call', name: 'bash', args: { command: '<script>rm</script>', timeout: 123, nested: { value: 'exact' } } } }]} onAnswer={async () => {}} />)
    expect(html).toContain('123')
    expect(html).toContain('exact')
    expect(html).toContain('C:/code')
    expect(html).toContain('not the project or future requests')
    expect(html).not.toContain('<script>')
    expect(html).toContain('Allow once')
  })
})
