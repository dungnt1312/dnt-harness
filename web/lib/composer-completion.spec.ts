/**
 * Composer completion rules: which trigger the caret is inside, what a chosen
 * item does to the draft, and how the two menus rank their items.
 */
import { describe, expect, it } from 'vitest'
import {
  builtinCommandIn,
  builtinCompletionItem,
  completionAt,
  draftIsOnlyCommand,
  moveActive,
  rankSkills,
  skillCompletionItem,
} from './composer-completion.ts'
import { emptyDraft, textDraft, type RichDraft } from './composer-draft.ts'

describe('completionAt', () => {
  it('detects a file mention at a word boundary and after whitespace', () => {
    expect(completionAt('@rea', 4)).toEqual({ kind: 'file', query: 'rea', start: 0, end: 4 })
    expect(completionAt('look at @src/i', 14)).toEqual({ kind: 'file', query: 'src/i', start: 8, end: 14 })
  })

  it('opens a bare mention with an empty query', () => {
    expect(completionAt('note @', 6)).toEqual({ kind: 'file', query: '', start: 5, end: 6 })
  })

  it('ignores an address-like @ glued to a word, and a finished mention', () => {
    expect(completionAt('mail me@example.com', 19)).toBeNull()
    expect(completionAt('@README.md now', 14)).toBeNull()
  })

  it('triggers a skill only at the draft start', () => {
    expect(completionAt('/rev', 4)).toEqual({ kind: 'skill', query: 'rev', start: 0, end: 4 })
    expect(completionAt('/', 1)).toEqual({ kind: 'skill', query: '', start: 0, end: 1 })
    expect(completionAt('run /review', 11)).toBeNull()
    expect(completionAt('/usr/bin', 8)).toBeNull()
  })

  it('reads the caret, not the end of the draft', () => {
    expect(completionAt('@rea and more', 4)).toEqual({ kind: 'file', query: 'rea', start: 0, end: 4 })
  })

  it('never completes an out-of-range caret or a spanning selection', () => {
    expect(completionAt('@rea', 4, 5)).toBeNull()
    expect(completionAt('@rea', 9)).toBeNull()
    expect(completionAt('@rea', -1)).toBeNull()
  })
})

describe('skillCompletionItem', () => {
  it('returns a command segment with the existing wire text', () => {
    expect(skillCompletionItem({ name: 'review', description: 'Check a diff' })).toEqual({
      id: 'skill:review',
      insert: 'Use the review skill:',
      segment: { kind: 'command', name: 'review' },
      label: 'review',
      detail: 'Check a diff',
    })
  })
})

describe('built-in commands', () => {
  it('the compact item carries the command chip and its own id space', () => {
    expect(builtinCompletionItem({ name: 'compact', description: 'Summarize older turns' })).toEqual({
      id: 'command:compact',
      insert: '/compact',
      segment: { kind: 'command', name: 'compact' },
      label: '/compact',
      detail: 'Summarize older turns',
    })
  })

  it('builtinCommandIn matches only built-in command chips', () => {
    const draft = (segments: RichDraft['segments']): RichDraft => ({ segments, attachments: [] })
    expect(builtinCommandIn(draft([{ kind: 'command', name: 'compact' }]))).toBe('compact')
    expect(builtinCommandIn(draft([{ kind: 'text', text: 'hi ' }, { kind: 'command', name: 'compact' }]))).toBe('compact')
    expect(builtinCommandIn(draft([{ kind: 'command', name: 'review' }]))).toBeNull()
    expect(builtinCommandIn(textDraft('/compact typed as text'))).toBeNull()
    expect(builtinCommandIn(emptyDraft)).toBeNull()
  })

  it('draftIsOnlyCommand accepts the bare command and refuses mixed drafts', () => {
    const commandOnly: RichDraft = { segments: [{ kind: 'command', name: 'compact' }], attachments: [] }
    const withWhitespace: RichDraft = { segments: [{ kind: 'command', name: 'compact' }, { kind: 'text', text: '  ' }], attachments: [] }
    const withText: RichDraft = { segments: [{ kind: 'command', name: 'compact' }, { kind: 'text', text: ' focus on tests' }], attachments: [] }
    const withChip: RichDraft = { segments: [{ kind: 'command', name: 'compact' }, { kind: 'command', name: 'review' }], attachments: [] }
    const withFile: RichDraft = { segments: [{ kind: 'command', name: 'compact' }], attachments: [{ id: 'a'.repeat(64), name: 'a.png', mediaType: 'image/png', bytes: 1 }] }

    expect(draftIsOnlyCommand(commandOnly, 'compact')).toBe(true)
    expect(draftIsOnlyCommand(withWhitespace, 'compact')).toBe(true)
    expect(draftIsOnlyCommand(withText, 'compact')).toBe(false)
    expect(draftIsOnlyCommand(withChip, 'compact')).toBe(false)
    expect(draftIsOnlyCommand(withFile, 'compact')).toBe(false)
  })
})

describe('moveActive', () => {
  it('wraps in both directions and reports -1 for an empty list', () => {
    expect(moveActive(0, 1, 3)).toBe(1)
    expect(moveActive(2, 1, 3)).toBe(0)
    expect(moveActive(0, -1, 3)).toBe(2)
    expect(moveActive(-1, 1, 0)).toBe(-1)
  })
})

describe('rankSkills', () => {
  const skills = [
    { name: 'review', description: 'Check a diff' },
    { name: 'preview', description: 'Render a page' },
    { name: 'test', description: 'Run the review suite' },
  ]

  it('orders name prefix, then name substring, then description', () => {
    expect(rankSkills(skills, 'review').map((skill) => skill.name)).toEqual(['review', 'preview', 'test'])
  })

  it('returns the catalog head for an empty query and honours the limit', () => {
    expect(rankSkills(skills, '').map((skill) => skill.name)).toEqual(['review', 'preview', 'test'])
    expect(rankSkills(skills, '', 2)).toHaveLength(2)
    expect(rankSkills(skills, 'nothing-here')).toEqual([])
  })
})
