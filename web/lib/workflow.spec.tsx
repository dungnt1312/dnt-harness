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
  it('shows waiting only for a running turn, not stale approvals after end', () => {
    expect(taskPhase(events('turn/start'), 1)).toBe('waiting')
    expect(taskPhase(events('turn/start'), 0)).toBe('running')
    expect(taskPhase([{ type: 'turn/end', seq: 0, reason: 'completed' }], 1)).toBe('completed')
  })
  it.each(['completed', 'failed', 'interrupted', 'cancelled', 'limit', 'empty', 'rejected'] as const)('preserves durable terminal reason %s', (reason) => {
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
