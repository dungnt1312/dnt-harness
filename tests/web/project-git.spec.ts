import { describe, expect, it } from 'vitest'
import { parseDiff } from '../../src/web/project-git.ts'

describe('parseDiff', () => {
  it('drops the git header and classifies hunk, add, delete and context lines', () => {
    const text = [
      'diff --git a/docs/README.md b/docs/README.md',
      'index 111..222 100644',
      '--- a/docs/README.md',
      '+++ b/docs/README.md',
      '@@ -27,7 +27,6 @@',
      ' unchanged',
      '-removed line',
      '+added line',
      '',
    ].join('\n')
    expect(parseDiff(text)).toEqual([
      { kind: 'meta', text: '--- a/docs/README.md' },
      { kind: 'meta', text: '+++ b/docs/README.md' },
      { kind: 'hunk', text: '@@ -27,7 +27,6 @@' },
      { kind: 'context', text: 'unchanged' },
      { kind: 'del', text: 'removed line' },
      { kind: 'add', text: 'added line' },
    ])
  })

  it('keeps a trailing marker line and strips the leading space of context', () => {
    expect(parseDiff(' context\n\\ No newline at end of file')).toEqual([
      { kind: 'context', text: 'context' },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ])
  })
})
