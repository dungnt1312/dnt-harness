import { describe, expect, it } from 'vitest'
import { toolDisplayName, toolFacts } from '../../web/lib/tool-facts.ts'

const call = (name: string, args: Record<string, unknown>) => ({ id: 'c1', name, args })
const ok = (output: string) => ({ ok: true, output })
const bad = (output: string) => ({ ok: false, output })

describe('toolDisplayName', () => {
  it('drops the mcp prefix, which the server chip already carries', () => {
    expect(toolDisplayName('mcp__linear__create_issue')).toBe('create_issue')
    expect(toolDisplayName('Read')).toBe('Read')
    expect(toolDisplayName('mcp__weird')).toBe('mcp__weird')
  })
})

describe('Read facts', () => {
  it('shows the window the call named and counts what came back', () => {
    const facts = toolFacts(call('Read', { path: 'src/harness/tools/service.ts', offset: 100, limit: 61 }), ok('a\nb\nc'))
    expect(facts.fullTarget).toBe('src/harness/tools/service.ts:100-160')
    expect(facts.target).toBe('…/tools/service.ts:100-160')
    expect(facts.focus).toEqual({ line: 100, lines: 61 })
    expect(facts.digest).toBe('3 lines')
    expect(facts.digestFailed).toBe(false)
  })
  it('reads an open-ended window and a whole file', () => {
    expect(toolFacts(call('Read', { path: 'a.ts', offset: 40 })).fullTarget).toBe('a.ts:40+')
    expect(toolFacts(call('Read', { path: 'a.ts', limit: 20 })).fullTarget).toBe('a.ts:1-20')
    const whole = toolFacts(call('Read', { file_path: 'a.ts' }), ok('one line'))
    expect(whole.fullTarget).toBe('a.ts')
    expect(whole.focus).toBeUndefined()
    expect(whole.digest).toBe('1 line')
  })
  it('marks a truncated read and an empty file', () => {
    expect(toolFacts(call('Read', { path: 'a.ts' }), ok('x\ny\n… [truncated 40 chars]')).digest).toBe('2 lines · truncated')
    expect(toolFacts(call('Read', { path: 'a.ts' }), ok('')).digest).toBe('empty')
  })
  it('puts the error on the row when the read failed', () => {
    const facts = toolFacts(call('Read', { path: 'docs/missing.md' }), bad('no such file: docs/missing.md'))
    expect(facts.digest).toBe('no such file: docs/missing.md')
    expect(facts.digestFailed).toBe(true)
  })
  it('carries no digest while the call is still running', () => {
    expect(toolFacts(call('Read', { path: 'a.ts' })).digest).toBeUndefined()
  })
})

describe('Write and Edit facts', () => {
  it('distinguishes a creation from an overwrite and reports the size written', () => {
    expect(toolFacts(call('Write', { path: 'a.md', content: 'x' }), ok('created a.md')).digest).toBe('created')
    expect(toolFacts(call('Write', { path: 'a.md', content: 'x' }), ok('overwrote a.md (2048 bytes written)')).digest).toBe('overwrote · 2 KB')
  })
  it('sizes an edit from the exact replacement it recorded', () => {
    const facts = toolFacts(call('Edit', { path: 'web/lib/format.ts', old: 'a\nb\nc', new: 'a\nb\nc\nd\ne\nf\ng' }), ok('edited web/lib/format.ts'))
    expect(facts.digest).toBeUndefined()
    expect(facts.lines).toEqual({ removed: 3, added: 7 })
    expect(facts.path).toBe('web/lib/format.ts')
  })
  it('keeps the path as the target even when the model sent the text first', () => {
    expect(toolFacts(call('Edit', { old: 'long old text', new: 'new', path: 'a.ts' })).fullTarget).toBe('a.ts')
  })
})

describe('file row directory', () => {
  it('keeps a short directory whole', () => {
    const facts = toolFacts(call('Read', { path: 'src/harness/tools/service.ts' }), ok('one line'))
    expect(facts.file?.directory).toBe('src/harness/tools')
  })
  it('elides a long directory from the head, keeping the segments nearest the file', () => {
    const path = 'C:\\Users\\DungNguyen\\workspace\\ZCode\\packages\\services\\src\\runtime-tools\\agentProxyEnv.ts'
    const facts = toolFacts(call('Read', { path }), ok('one line'))
    const directory = facts.file?.directory ?? ''
    expect(directory.startsWith('…\\')).toBe(true)
    expect(directory.endsWith('src\\runtime-tools')).toBe(true)
    expect(directory.length).toBeLessThan(path.length)
    // The row tooltip and the workbench opener still carry the whole path.
    expect(facts.fullTarget).toBe(path)
  })
  it('elides a long POSIX directory with its own separator', () => {
    const facts = toolFacts(call('Edit', { path: '/srv/jenkins/workspaces/feature-branch-a/source/generated/overrides/bundle.ts' }), ok('x'))
    const directory = facts.file?.directory ?? ''
    expect(directory.startsWith('…/')).toBe(true)
    expect(directory.endsWith('generated/overrides')).toBe(true)
  })
})

describe('Glob and Grep facts', () => {
  it('counts matched files', () => {
    expect(toolFacts(call('Glob', { pattern: 'web/**/*.tsx' }), ok('a.tsx\nb.tsx')).digest).toBe('2 files')
    expect(toolFacts(call('Glob', { pattern: 'nope/**' }), ok('no matches')).digest).toBe('no matches')
  })
  it('counts matches and the files they came from, and keeps the search scope visible', () => {
    const output = 'web/lib/a.ts:3: hit\nweb/lib/a.ts:9: hit\nweb/lib/b.ts:2: hit'
    const facts = toolFacts(call('Grep', { pattern: 'toolTarget', path: 'web/lib' }), ok(output))
    expect(facts.fullTarget).toBe('toolTarget in web/lib')
    expect(facts.digest).toBe('3 matches · 2 files')
    // The scope is a folder to search, not a file to open in the workbench.
    expect(facts.path).toBeUndefined()
    expect(toolFacts(call('Grep', { pattern: 'x' }), ok('a.ts:1: x')).digest).toBe('1 match')
    expect(toolFacts(call('Grep', { pattern: 'x' }), ok('no matches')).digest).toBe('no matches')
  })
})

describe('Bash facts', () => {
  it('keeps the whole command line and reports the exit code', () => {
    const facts = toolFacts(call('Bash', { command: 'git diff src/web/server.ts' }), ok('…\n[exit code: 0]'))
    // Never shortened as a path: `…/web/server.ts` would drop the verb.
    expect(facts.target).toBe('git diff src/web/server.ts')
    expect(facts.digest).toBe('exit 0')
    expect(facts.digestFailed).toBe(false)
  })
  it('reads a non-zero exit as a failure even though the call itself succeeded', () => {
    const facts = toolFacts(call('Bash', { command: 'npm test' }), ok('1 failing\n[exit code: 1]'))
    expect(facts.digest).toBe('exit 1')
    expect(facts.digestFailed).toBe(true)
  })
  it('reports a stop, a timeout and a spawn error', () => {
    expect(toolFacts(call('Bash', { command: 'sleep 90' }), ok('\n[terminated by stop]')).digest).toBe('terminated')
    expect(toolFacts(call('Bash', { command: 'sleep 90' }), ok('\n[terminated: timeout or stop]')).digest).toBe('terminated')
    expect(toolFacts(call('Bash', { command: 'x' }), ok('cancelled: stop requested before this command started')).digest).toBe('cancelled')
    expect(toolFacts(call('Bash', { command: 'x' }), ok('error: bash is not available on this system; install Git Bash')).digestFailed).toBe(true)
  })
})

describe('MCP and unknown tools', () => {
  it('names the tool without its server prefix and measures its output', () => {
    const facts = toolFacts(call('mcp__linear__create_issue', { title: 'Fix the row' }), ok('created ENG-42'))
    expect(facts.name).toBe('create_issue')
    expect(facts.fullTarget).toBe('Fix the row')
    expect(facts.digest).toBe('created ENG-42')
  })
  it('measures long output instead of quoting it', () => {
    const long = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n')
    expect(toolFacts(call('custom_tool', {}), ok(long)).digest).toBe('12 lines')
    expect(toolFacts(call('custom_tool', {}), ok('   ')).digest).toBe('empty')
  })
})
