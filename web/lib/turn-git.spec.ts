import { describe, expect, it } from 'vitest'
import { overlayTurnChanges } from './turn-git.ts'
import type { GitStatusReport } from './api.ts'
import type { TurnChanges } from './turn-changes.ts'

const changes: TurnChanges = {
  files: [
    { path: 'src/a.ts', status: 'modified' },
    { path: 'C:/proj/notes.md', status: 'created' },
    { path: 'C:/elsewhere/outsider.ts', status: 'modified' },
  ],
  uncertain: [],
}

const REPORT: GitStatusReport = {
  branch: 'main',
  truncated: false,
  changes: [
    { path: 'src/a.ts', status: 'modified', added: 7, removed: 3 },
    { path: 'notes.md', status: 'added', added: 12, removed: 0 },
  ],
}

describe('overlayTurnChanges', () => {
  it('matches relative and absolute recorded paths through the same rule as the workbench opener', () => {
    const rows = overlayTurnChanges(changes, 'C:/proj', REPORT)
    expect(rows[0]).toEqual({ path: 'src/a.ts', status: 'modified', git: { status: 'modified', added: 7, removed: 3 } })
    expect(rows[1]).toEqual({ path: 'C:/proj/notes.md', status: 'created', git: { status: 'added', added: 12, removed: 0 } })
  })

  it('marks paths outside the project instead of reading them as unchanged', () => {
    const rows = overlayTurnChanges(changes, 'C:/proj', REPORT)
    expect(rows[2]).toEqual({ path: 'C:/elsewhere/outsider.ts', status: 'modified', outside: true })
  })

  it('a null report leaves every row uncounted, none claimed clean', () => {
    const rows = overlayTurnChanges(changes, 'C:/proj', null)
    expect(rows.every((row) => row.git === undefined)).toBe(true)
    // Outside-ness is a pure path computation, independent of git.
    expect(rows.filter((row) => row.outside === true).map((row) => row.path)).toEqual(['C:/elsewhere/outsider.ts'])
  })
})

