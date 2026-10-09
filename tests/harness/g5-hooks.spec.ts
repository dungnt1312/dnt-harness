/** Claude Code hooks: settings.json parse/merge, runner I/O contract, verdicts (spec 2026-10-08 §B). */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fromClaudeToolInput,
  hookMatches,
  interpretHooks,
  loadHooks,
  migrateLegacyHooksJson,
  parseHooksSection,
  readWorkspaceHooks,
  runHook,
  selectHooks,
  setHookActive,
  toClaudeToolInput,
  writeWorkspaceHooks,
  type ClaudeHookEvent,
} from 'dnt-harness'

const fixture = fileURLToPath(new URL('../fixtures/hook-command.mjs', import.meta.url))
const cmd = (mode: string): string => `"${process.execPath}" "${fixture}" ${mode}`
const run = (mode: string, input: Record<string, unknown> = {}, timeout?: number) =>
  runHook({ command: cmd(mode), ...(timeout !== undefined ? { timeout } : {}) }, input)
const verdict = async (event: ClaudeHookEvent, mode: string, input: Record<string, unknown> = {}) =>
  interpretHooks(event, [await run(mode, { hook_event_name: event, ...input })])

let dir: string
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'hooks-'))) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('settings.json hooks section', () => {
  it('parses the Claude schema and is lenient on load, strict on save', () => {
    const section = { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'x', timeout: 5 }] }], Nope: [] }
    const lenient = parseHooksSection(section)
    expect(lenient.hooks.PreToolUse?.[0]?.hooks[0]).toEqual({ type: 'command', command: 'x', timeout: 5 })
    expect(lenient.diagnostics.join()).toMatch(/unknown hook event 'Nope'/)
    expect(() => parseHooksSection(section, { strict: true })).toThrow(/unknown hook event/)
    expect(() => parseHooksSection({ Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] }, { strict: true })).toThrow(/only type "command"/)
  })

  it('merges user < workspace < project < local and honors disableAllHooks', async () => {
    const write = async (file: string, doc: unknown): Promise<void> => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify(doc))
    }
    const hook = (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } })
    await write(path.join(dir, 'user', 'settings.json'), { ...hook('u'), theme: 'dark' })
    await write(path.join(dir, 'ws', 'settings.json'), hook('w'))
    await write(path.join(dir, 'proj', '.claude', 'settings.json'), hook('p'))
    await write(path.join(dir, 'proj', '.claude', 'settings.local.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'l' }] }], WorktreeCreate: [] } })
    const dirs = { userDir: path.join(dir, 'user'), workspaceDir: path.join(dir, 'ws'), projectRoot: path.join(dir, 'proj') }
    const resolved = await loadHooks(dirs)
    expect(resolved.hooks.map((h) => `${h.layer}:${h.command}`)).toEqual(['user:u', 'workspace:w', 'project:p', 'local:l'])
    expect(resolved.diagnostics.join()).toMatch(/unknown hook event 'WorktreeCreate'/)
    await write(path.join(dir, 'ws', 'settings.json'), { ...hook('w'), disableAllHooks: true })
    expect((await loadHooks(dirs)).hooks).toEqual([])
  })

  it('matchers are anchored regexes; empty/* match all; identical commands run once', () => {
    expect(hookMatches('Write|Edit', 'Edit')).toBe(true)
    expect(hookMatches('Write|Edit', 'MultiEdit')).toBe(false)
    expect(hookMatches('mcp__github__.*', 'mcp__github__issue')).toBe(true)
    expect(hookMatches('', 'Bash')).toBe(true)
    expect(hookMatches('*', 'Bash')).toBe(true)
    const hook = (matcher: string, command: string, layer: 'user' | 'workspace') => ({ id: `${layer}${command}`, event: 'PreToolUse' as const, matcher, command, layer, source: layer, active: true, supported: true })
    const hooks = [hook('Bash', 'a', 'user'), hook('.*', 'a', 'workspace'), hook('Read', 'b', 'workspace')]
    const resolved = { all: hooks, hooks, disabled: false, sources: [], diagnostics: [] }
    expect(selectHooks(resolved, 'PreToolUse', 'Bash').map((h) => h.command)).toEqual(['a'])
  })

  it('switches one hook off per workspace without touching settings.json', async () => {
    const ws = path.join(dir, 'ws')
    await fs.mkdir(ws, { recursive: true })
    const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] } })
    await fs.writeFile(path.join(ws, 'settings.json'), settings)
    const before = await loadHooks({ workspaceDir: ws })
    expect(before.hooks.map((h) => h.command)).toEqual(['a', 'b'])
    await setHookActive(ws, before.all[0]!.id, false)
    const after = await loadHooks({ workspaceDir: ws })
    expect(after.hooks.map((h) => h.command)).toEqual(['b'])
    expect(after.all.map((h) => `${h.command}:${h.active}`)).toEqual(['a:false', 'b:true'])
    expect(await fs.readFile(path.join(ws, 'settings.json'), 'utf8')).toBe(settings)
    await setHookActive(ws, before.all[0]!.id, true)
    expect((await loadHooks({ workspaceDir: ws })).hooks).toHaveLength(2)
    await expect(setHookActive(ws, '../x', false)).rejects.toThrow(/invalid hook id/)
  })

  it('workspace writes preserve other settings keys; legacy hooks.json migrates once', async () => {
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    await writeWorkspaceHooks(dir, { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] })
    expect(JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } })

    const legacy = path.join(dir, 'legacy')
    await fs.mkdir(legacy)
    await fs.writeFile(path.join(legacy, 'hooks.json'), JSON.stringify({ version: 1, hooks: {
      PreToolUse: [{ matcher: 'Bash', type: 'command', command: '/usr/bin/node', args: ['a b.js', 'x'], timeoutMs: 2500, onFailure: 'deny' }],
      PostToolUse: [{ matcher: 'mcp__*', type: 'command', command: 'scan', onFailure: 'allow' }],
    } }))
    expect(await migrateLegacyHooksJson(legacy)).toBe(true)
    const migrated = await readWorkspaceHooks(legacy)
    expect(migrated.hooks.PreToolUse?.[0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: "/usr/bin/node 'a b.js' x", timeout: 3 }] })
    expect(migrated.hooks.PostToolUse?.[0]?.matcher).toBe('mcp__.*')
    await expect(fs.stat(path.join(legacy, 'hooks.json.migrated'))).resolves.toBeTruthy()
  })
})

describe('command hooks (runner)', () => {
  it('runs through the shell with stdin JSON, cwd and CLAUDE_PROJECT_DIR', async () => {
    const outcome = await runHook({ command: cmd('echo') }, { hook_event_name: 'SessionStart', session_id: 's1' }, { cwd: dir })
    expect(outcome.exitCode).toBe(0)
    const seen = JSON.parse(String((outcome.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext']))
    expect(seen.input).toEqual({ hook_event_name: 'SessionStart', session_id: 's1' })
    expect(seen.env.CLAUDE_PROJECT_DIR).toBe(dir)
    expect(seen.cwd).toBe(dir)
  })

  it('timeout is in seconds and kills the hook', async () => {
    const start = Date.now()
    const outcome = await run('hang', {}, 0.2)
    expect(outcome.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(3_000)
  }, 10_000)
})

describe('verdicts (Claude output contract)', () => {
  it('PreToolUse: exit 2 and permissionDecision deny block; ask/allow/updatedInput carry through', async () => {
    expect((await verdict('PreToolUse', 'block')).block?.reason).toContain('blocked by fixture')
    const denied = await verdict('PreToolUse', 'deny')
    expect(denied.permission).toBe('deny')
    expect(denied.block?.reason).toBe('fixture denies')
    expect((await verdict('PreToolUse', 'ask')).permission).toBe('ask')
    const rewritten = await verdict('PreToolUse', 'rewrite', { tool_input: { command: 'ls' } })
    expect(rewritten.permission).toBe('allow')
    expect(rewritten.block).toBeUndefined()
    expect(rewritten.updatedInput).toEqual({ command: 'ls', rewritten: true })
  })

  it('UserPromptSubmit/SessionStart: plain stdout and additionalContext become context', async () => {
    expect((await verdict('UserPromptSubmit', 'stdout')).additionalContext).toBe('fixture plain stdout context')
    expect((await verdict('SessionStart', 'context')).additionalContext).toBe('fixture additional context')
    // PostToolUse plain stdout is transcript-only in Claude.
    expect((await verdict('PostToolUse', 'stdout')).additionalContext).toBeUndefined()
  })

  it('Stop: decision block continues; stop_hook_active lets go; continue:false stops', async () => {
    expect((await verdict('Stop', 'stop-once', { stop_hook_active: false })).block?.reason).toBe('fixture says keep going')
    expect((await verdict('Stop', 'stop-once', { stop_hook_active: true })).block).toBeUndefined()
    expect((await verdict('Stop', 'stop')).stop?.reason).toBe('fixture stopped')
  })

  it('treats shell syntax errors as failures, not intentional exit-2 blocks', async () => {
    if (process.platform === 'win32') return
    const outcome = await runHook({ command: 'echo "unterminated' }, {})
    expect(outcome.exitCode).toBe(2)
    const result = interpretHooks('UserPromptSubmit', [outcome])
    expect(result.block).toBeUndefined()
    expect(result.userMessages.join('\n')).toMatch(/syntax|unterminated|quote/i)
    expect((await verdict('UserPromptSubmit', 'block')).block?.reason).toContain('blocked by fixture')
  })

  it('non-blocking errors and non-blockable exit 2 only reach the user', async () => {
    const failed = await verdict('PreToolUse', 'fail')
    expect(failed.block).toBeUndefined()
    expect(failed.userMessages.join()).toMatch(/fixture failed/)
    const preCompact = await verdict('PreCompact', 'block')
    expect(preCompact.block).toBeUndefined()
    expect(preCompact.userMessages.join()).toMatch(/blocked by fixture/)
  })
})

describe('tool_input mapping', () => {
  it('maps native argument names to Claude names and back', () => {
    expect(toClaudeToolInput('Edit', { path: 'a', old: 'x', new: 'y', replaceAll: true })).toEqual({ file_path: 'a', old_string: 'x', new_string: 'y', replace_all: true })
    expect(fromClaudeToolInput('Edit', { file_path: 'a', old_string: 'x', new_string: 'z' })).toEqual({ path: 'a', old: 'x', new: 'z' })
    expect(toClaudeToolInput('Bash', { command: 'ls' })).toEqual({ command: 'ls' })
  })
})
