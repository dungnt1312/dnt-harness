import { describe, expect, it } from 'vitest'
import { projectInheritedMessages } from '../../src/web/agent-delegation.ts'

describe('projectInheritedMessages', () => {
  it('keeps a speaker-labelled truncation marker when the oldest included message straddles the cap', () => {
    const olderInstruction = `Review the inherited boundary carefully. ${'retain this instruction '.repeat(12)}END-OF-OLDER-INSTRUCTION`
    const projected = projectInheritedMessages([
      { type: 'user/message', content: olderInstruction, seq: 1, timestamp: 1 },
      { type: 'assistant/message', content: 'Newest message remains complete.', seq: 2, timestamp: 2 },
    ] as never, 96)

    expect(projected.length).toBeLessThanOrEqual(96)
    expect(projected.startsWith('User: [truncated] ')).toBe(true)
    expect(projected).toContain('\n\nAssistant: Newest message remains complete.')
    expect(projected).toContain('END-OF-OLDER-INSTRUCTION')
  })

  it('projects user and tool-free assistant messages only, in chronological order', () => {
    const projected = projectInheritedMessages([
      { type: 'user/message', content: 'Where is the config loaded?', seq: 1, timestamp: 1 },
      { type: 'assistant/message', content: 'Let me look.', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'secret.env' } }], seq: 2, timestamp: 2 },
      { type: 'tool/call', call: { id: 'c1', name: 'Read', args: { path: 'secret.env' } }, seq: 3, timestamp: 3 },
      { type: 'tool/result', callId: 'c1', content: 'TOKEN=tool-output-must-not-leak', seq: 4, timestamp: 4 },
      { type: 'assistant/message', content: '   ', seq: 5, timestamp: 5 },
      { type: 'assistant/message', content: 'It is loaded in src/config.ts.', seq: 6, timestamp: 6 },
    ] as never)

    expect(projected).toBe('User: Where is the config loaded?\n\nAssistant: It is loaded in src/config.ts.')
  })

  it('omits an older message entirely when not even its label and marker fit', () => {
    const projected = projectInheritedMessages([
      { type: 'user/message', content: 'An older message that has no room left.', seq: 1, timestamp: 1 },
      { type: 'assistant/message', content: 'Newest.', seq: 2, timestamp: 2 },
    ] as never, 'Assistant: Newest.'.length + 5)

    expect(projected).toBe('Assistant: Newest.')
  })
})
