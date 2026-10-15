import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS, chipLabel, chipTitle, chipWireText, isBuiltinCommand, messageText, parseMessageText } from './inline-chips.ts'

describe('chip wire text', () => {
  it('writes every chip as a Markdown link whose destination is its identity', () => {
    expect(chipWireText({ kind: 'mention', path: 'web/api.ts' })).toBe('[@api.ts](./web/api.ts)')
    expect(chipWireText({ kind: 'mention', path: 'docs/my notes.md' })).toBe('[@my notes.md](<./docs/my notes.md>)')
    expect(chipWireText({ kind: 'mention', path: 'a/[x]).md' })).toBe('[@\\[x\\]).md](<./a/[x]).md>)')
    expect(chipWireText({ kind: 'command', name: 'ak-plan' })).toBe('[$ak-plan](skill://ak-plan)')
    expect(chipWireText({ kind: 'command', name: 'ak-plan' }, true)).toBe('/ak-plan')
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
  it('parses a leading /command and chip links anywhere', () => {
    expect(parseMessageText('/git:commit xem [@api.ts](./web/api.ts) và [@my notes.md](<./docs/my notes.md>)')).toEqual([
      { kind: 'command', name: 'git:commit' },
      { kind: 'text', text: ' xem ' },
      { kind: 'mention', path: 'web/api.ts' },
      { kind: 'text', text: ' và ' },
      { kind: 'mention', path: 'docs/my notes.md' },
    ])
  })

  it('parses a mid-message skill chip (the $ menu)', () => {
    expect(parseMessageText('Ghi docs rồi commit\n[$softel-git](skill://softel-git) nhé')).toEqual([
      { kind: 'text', text: 'Ghi docs rồi commit\n' },
      { kind: 'command', name: 'softel-git' },
      { kind: 'text', text: ' nhé' },
    ])
  })

  it('keeps everything that is not a canonical chip link as text', () => {
    for (const text of [
      'mail me at a@b.com',
      'open @src/a.ts',
      'Use the ak-plan skill: go',
      '$ak-plan',
      '[docs](https://example.com)',
      '[@wrong label](./web/api.ts)',
      '[$x](skill://y)',
      '[$bad name](skill://bad name)',
      '[@a](./)',
    ]) {
      expect(parseMessageText(text)).toEqual([{ kind: 'text', text }])
    }
  })

  it('round-trips every message exactly', () => {
    const samples = [
      '',
      '/review',
      '/review args here',
      '/usr/bin/env node',
      'run [@api.ts](./web/api.ts)\nand [@d.ts](<./a b/c d.ts>) then [@x](./x).',
      '[@\\[x\\]).md](<./a/[x]).md>) [unclosed](',
      'tab\t[$t](skill://t)\there',
    ]
    for (const text of samples) expect(messageText(parseMessageText(text))).toBe(text)
  })

  it('round-trips chips through serialization', () => {
    const segments = [
      { kind: 'text', text: 'see ' },
      { kind: 'mention', path: 'a/[x]) <y>.md' },
      { kind: 'text', text: ' with ' },
      { kind: 'command', name: 'plugin:cmd' },
    ] as const
    expect(parseMessageText(messageText(segments))).toEqual(segments)
  })
})

describe('leading token', () => {
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
