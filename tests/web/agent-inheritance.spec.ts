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
})
