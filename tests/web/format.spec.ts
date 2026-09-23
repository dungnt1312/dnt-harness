import { describe, expect, it } from 'vitest'
import { pathBasename, shortCommand, shortPath, toolTarget } from '../../web/lib/format.ts'

describe('pathBasename', () => {
  it('returns the last segment for win/unix paths', () => {
    expect(pathBasename('C:\\workspace\\mini-dsh')).toBe('mini-dsh')
    expect(pathBasename('/home/dev/project')).toBe('project')
    expect(pathBasename('plain')).toBe('plain')
    expect(pathBasename('')).toBe('')
  })
})

describe('toolTarget', () => {
  it('picks the first non-empty string argument', () => {
    expect(toolTarget({ path: 'src/x.ts' })).toBe('src/x.ts')
    expect(toolTarget({ command: 'npm test' })).toBe('npm test')
    expect(toolTarget({ pattern: '', limit: 5 })).toBe('')
    expect(toolTarget({ limit: 5 })).toBe('')
  })
})

describe('shortPath', () => {
  it('keeps the last segments of a deep path and leaves a shallow one alone', () => {
    expect(shortPath('src/harness/tools/service.ts')).toBe('…/tools/service.ts')
    expect(shortPath('C:\\acme\\src\\index.ts')).toBe('…/src/index.ts')
    expect(shortPath('README.md')).toBe('README.md')
  })
})

describe('shortCommand', () => {
  it('keeps the verb at the front and the argument at the end', () => {
    expect(shortCommand('npm test')).toBe('npm test')
    expect(shortCommand('git  diff\n  src/web/server.ts')).toBe('git diff src/web/server.ts')
    const long = shortCommand('npm run build:web -- --mode production --out dist/assets/bundle.js', 40)
    expect(long).toHaveLength(40)
    expect(long.startsWith('npm run build:web')).toBe(true)
    expect(long.endsWith('bundle.js')).toBe(true)
  })
})
