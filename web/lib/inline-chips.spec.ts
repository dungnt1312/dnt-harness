import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS, chipLabel, chipTitle, chipWireText, isBuiltinCommand, messageText, parseMessageText } from './inline-chips.ts'

describe('chip wire text', () => {
  it('writes mentions as @path, quoting only when the path needs it', () => {
    expect(chipWireText({ kind: 'mention', path: 'web/api.ts' })).toBe('@web/api.ts')
    expect(chipWireText({ kind: 'mention', path: 'docs/my notes.md' })).toBe('@"docs/my notes.md"')
    expect(chipWireText({ kind: 'mention', path: 'odd.' })).toBe('@"odd."')
    expect(chipWireText({ kind: 'command', name: 'ak-plan' }, true)).toBe('/ak-plan')
    expect(chipWireText({ kind: 'command', name: 'ak-plan' })).toBe('Use the ak-plan skill:')
    expect(chipWireText({ kind: 'command', name: 'ak-plan', legacy: true }, true)).toBe('Use the ak-plan skill:')
  })

  it('labels a file by base name and a skill by its bare name', () => {
    expect(chipLabel({ kind: 'mention', path: 'web/lib/api.ts' })).toBe('api.ts')
    expect(chipLabel({ kind: 'command', name: 'ak-plan' })).toBe('ak-plan')
  })

  it('titles built-in commands apart from workspace skills', () => {
    expect(chipTitle({ kind: 'command', name: 'ak-plan' })).toBe('Command: /ak-plan')
    expect(chipTitle({ kind: 'command', name: 'compact' })).toBe('Command: compact')
    expect(isBuiltinCommand('compact')).toBe(true)
    expect(isBuiltinCommand('ak-plan')).toBe(false)
    expect(BUILTIN_COMMANDS.map((command) => command.name)).toContain('compact')
  })
})

describe('parseMessageText', () => {
  it('parses a leading /command and mentions anywhere a word starts', () => {
    expect(parseMessageText('/git:commit xem @web/api.ts và @"docs/my notes.md"')).toEqual([
      { kind: 'command', name: 'git:commit' },
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
      '/review',
      '/review args here',
      '/usr/bin/env node',
      'Use the review skill:',
      'Use the review skill: run @web/api.ts\nand @"a b/c d.ts" then @x.',
      '@@double @"unterminated',
      'tab\t@path\there',
    ]
    for (const text of samples) expect(messageText(parseMessageText(text))).toBe(text)
  })
})

describe('legacy skill phrase', () => {
  it('parses the retired leading phrase into a legacy chip that keeps its exact text', () => {
    const segments = parseMessageText('Use the ak-plan skill: go')
    expect(segments[0]).toEqual({ kind: 'command', name: 'ak-plan', legacy: true })
    expect(messageText(segments)).toBe('Use the ak-plan skill: go')
  })

  it('keeps a path-like first token as text', () => {
    expect(parseMessageText('/usr/bin/env node')).toEqual([{ kind: 'text', text: '/usr/bin/env node' }])
  })
})

describe('leading command chip spacing', () => {
  it('keeps a leading /name chip separated from glued text so it round-trips', () => {
    const text = messageText([{ kind: 'command', name: 'review' }, { kind: 'text', text: 'fix' }])
    expect(text).toBe('/review fix')
    expect(parseMessageText(text)[0]).toEqual({ kind: 'command', name: 'review' })
    expect(messageText([{ kind: 'command', name: 'review' }])).toBe('/review')
  })
})
