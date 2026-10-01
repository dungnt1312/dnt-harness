import { describe, expect, it } from 'vitest'
import { parseAheadBehind } from '../../src/web/project-git.ts'

describe('porcelain branch header ahead/behind', () => {
  it('parses ahead, behind, both, and none', () => {
    expect(parseAheadBehind('## main...origin/main')).toEqual({})
    expect(parseAheadBehind('## main...origin/main [ahead 1]')).toEqual({ ahead: 1 })
    expect(parseAheadBehind('## main...origin/main [behind 2]')).toEqual({ behind: 2 })
    expect(parseAheadBehind('## main...origin/main [ahead 3, behind 4]')).toEqual({ ahead: 3, behind: 4 })
    expect(parseAheadBehind('## main (no upstream)')).toEqual({})
  })
})
