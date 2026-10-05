import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS, chipLabel, chipTitle, chipWireText, isBuiltinCommand, messageText, parseMessageText } from './inline-chips.ts'

describe('chip wire text', () => {
  it('writes mentions as @path, quoting only when the path needs it', () => {
    expect(chipWireText({ kind: 'mention', path: 'web/api.ts' })).toBe('@web/api.ts')
    expect(chipWireText({ kind: 'mention', path: 'docs/my notes.md' })).toBe('@"docs/my notes.md"')
    expect(chipWireText({ kind: 'mention', path: 'odd.' })).toBe('@"odd."')
    expect(chipWireText({ kind: 'command', name: 'ak-plan' })).toBe('Use the ak-plan skill:')
  })

  it('labels a file by base name and a skill by its bare name', () => {
    expect(chipLabel({ kind: 'mention', path: 'web/lib/api.ts' })).toBe('api.ts')
    expect(chipLabel({ kind: 'command', name: 'ak-plan' })).toBe('ak-plan')
  })

  it('titles built-in commands apart from workspace skills', () => {
    expect(chipTitle({ kind: 'command', name: 'ak-plan' })).toBe('Skill: ak-plan')
    expect(chipTitle({ kind: 'command', name: 'compact' })).toBe('Command: compact')
    expect(isBuiltinCommand('compact')).toBe(true)
    expect(isBuiltinCommand('ak-plan')).toBe(false)
    expect(BUILTIN_COMMANDS.map((command) => command.name)).toContain('compact')
  })
})

describe('parseMessageText', () => {
  it('parses a leading skill command and mentions anywhere a word starts', () => {
    expect(parseMessageText('Use the ak-plan skill: xem @web/api.ts và @"docs/my notes.md"')).toEqual([
      { kind: 'command', name: 'ak-plan' },
      { kind: 'text', text: ' xem ' },
      { kind: 'mention', path: 'web/api.ts' },
      { kind: 'text', text: ' và ' },
      { kind: 'mention', path: 'docs/my notes.md' },
    ])
  })

  it('leaves sentence punctuation out of a bare path', () => {
    expect(parseMessageText('open @src/a.ts, then (@b.md).')).toEqual([
      { kind: 'text', text: 'open ' },
      { kind: 'mention', path: 'src/a.ts' },
      { kind: 'text', text: ', then (@b.md).' },
    ])
  })

  it('keeps text that is not a chip as text', () => {
    for (const text of ['mail me at a@b.com', 'say Use the ak-plan skill: later', 'lone @ sign', '@"plain"', '@...']) {
      expect(parseMessageText(text)).toEqual([{ kind: 'text', text }])
    }
  })

  it('round-trips every message exactly', () => {
    const samples = [
      '',
      'Use the review skill:',
      'Use the review skill: run @web/api.ts\nand @"a b/c d.ts" then @x.',
      '@@double @"unterminated',
      'tab\t@path\there',
    ]
    for (const text of samples) expect(messageText(parseMessageText(text))).toBe(text)
  })
})
