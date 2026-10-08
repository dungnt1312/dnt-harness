/**
 * Claude Code hooks, read from Claude Code `settings.json` files — the same
 * schema Claude Code reads, plus one dnt-harness layer (the workspace folder,
 * laid out like `~/.claude`):
 *
 *   user       ~/.claude/settings.json
 *   workspace  <data>/workspaces/<ws>/settings.json
 *   project    <project>/.claude/settings.json
 *   local      <project>/.claude/settings.local.json
 *
 * Hooks from every source are merged and all run (Claude semantics);
 * `disableAllHooks: true` in any source turns every hook off. Keys other than
 * `hooks`/`disableAllHooks` belong to Claude Code and are preserved untouched.
 *
 * Loading is lenient the way Claude Code is: a malformed entry is skipped and
 * reported as a diagnostic, never failing the turn. Saving the workspace
 * layer from the app is strict.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'

/** Every hook event name Claude Code documents. */
export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'UserPromptSubmit', 'Notification',
  'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionStart', 'SessionEnd',
] as const
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]

/** The events dnt-harness actually fires. The rest parse and are reported as not run. */
export const SUPPORTED_HOOK_EVENTS: ReadonlySet<ClaudeHookEvent> = new Set<ClaudeHookEvent>([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'SessionStart', 'SessionEnd',
])

export type HookLayer = 'user' | 'workspace' | 'project' | 'local'

export interface HookCommand {
  readonly type: 'command'
  readonly command: string
  /** Seconds (Claude); default {@link DEFAULT_HOOK_TIMEOUT_SECONDS}. */
  readonly timeout?: number
}

export interface HookMatcherGroup {
  readonly matcher?: string
  readonly hooks: readonly HookCommand[]
}

export type HooksSection = Partial<Record<string, readonly HookMatcherGroup[]>>

/** One runnable hook, flattened from a source file. */
export interface ResolvedHook {
  /** Stable identity: sha256 of layer, event, matcher and command (see {@link hookId}). */
  readonly id: string
  readonly event: ClaudeHookEvent
  readonly matcher: string
  readonly command: string
  readonly timeout?: number
  readonly layer: HookLayer
  readonly source: string
  /** False when the workspace switched this hook off (`hooks-state.json`). */
  readonly active: boolean
  /** True when dnt-harness fires this event. */
  readonly supported: boolean
}

export interface ResolvedHooks {
  /** Every configured hook, active or not (Settings lists them all). */
  readonly all: readonly ResolvedHook[]
  /** The hooks that run: active, supported, and not under `disableAllHooks`. */
  readonly hooks: readonly ResolvedHook[]
  /** True when any source sets `disableAllHooks: true`. */
  readonly disabled: boolean
  readonly sources: readonly { readonly layer: HookLayer; readonly path: string; readonly exists: boolean }[]
  readonly diagnostics: readonly string[]
}

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 60

export class HookSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HookSettingsError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse the `hooks` section of one settings document. `strict` throws on the
 * first problem (app saves); otherwise problems become diagnostics and the
 * entry is skipped (loading files written for Claude Code).
 */
export function parseHooksSection(value: unknown, options: { strict?: boolean; label?: string } = {}): { hooks: HooksSection; diagnostics: string[] } {
  const label = options.label ?? 'hooks'
  const diagnostics: string[] = []
  const problem = (message: string): void => {
    if (options.strict === true) throw new HookSettingsError(`${label}: ${message}`)
    diagnostics.push(`${label}: ${message}`)
  }
  const out: Record<string, HookMatcherGroup[]> = {}
  if (value === undefined) return { hooks: out, diagnostics }
  if (!isRecord(value)) {
    problem("'hooks' must be an object keyed by event name")
    return { hooks: out, diagnostics }
  }
  for (const [event, groupsRaw] of Object.entries(value)) {
    if (!(CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) {
      problem(`unknown hook event '${event}'`)
      continue
    }
    if (!Array.isArray(groupsRaw)) {
      problem(`${event} must be an array of matcher groups`)
      continue
    }
    const groups: HookMatcherGroup[] = []
    for (const [index, groupRaw] of groupsRaw.entries()) {
      if (!isRecord(groupRaw)) {
        problem(`${event}[${index}] must be an object`)
        continue
      }
      if (groupRaw['matcher'] !== undefined && typeof groupRaw['matcher'] !== 'string') {
        problem(`${event}[${index}].matcher must be a string`)
        continue
      }
      if (!Array.isArray(groupRaw['hooks'])) {
        problem(`${event}[${index}].hooks must be an array`)
        continue
      }
      const commands: HookCommand[] = []
      for (const [hookIndex, hookRaw] of (groupRaw['hooks'] as unknown[]).entries()) {
        const where = `${event}[${index}].hooks[${hookIndex}]`
        if (!isRecord(hookRaw)) { problem(`${where} must be an object`); continue }
        if (hookRaw['type'] !== 'command') { problem(`${where}: only type "command" hooks run in dnt-harness (got ${JSON.stringify(hookRaw['type'])})`); continue }
        if (typeof hookRaw['command'] !== 'string' || hookRaw['command'].trim() === '') { problem(`${where}.command must be a non-empty string`); continue }
        const timeout = hookRaw['timeout']
        if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) { problem(`${where}.timeout must be a positive number of seconds`); continue }
        commands.push({ type: 'command', command: hookRaw['command'], ...(typeof timeout === 'number' ? { timeout } : {}) })
      }
      groups.push({ ...(typeof groupRaw['matcher'] === 'string' ? { matcher: groupRaw['matcher'] } : {}), hooks: commands })
    }
    out[event] = groups
  }
  return { hooks: out, diagnostics }
}

async function readSettings(file: string): Promise<{ exists: boolean; doc?: Record<string, unknown>; error?: string }> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return { exists: false }
  }
  if (raw.trim() === '') return { exists: true, doc: {} }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return { exists: true, error: `${file}: settings must be a JSON object` }
    return { exists: true, doc: parsed }
  } catch (error) {
    return { exists: true, error: `${file}: invalid JSON (${String(error instanceof Error ? error.message : error)})` }
  }
}

export interface HookSourceDirs {
  /** `~/.claude`; omitted skips the user layer. */
  readonly userDir?: string
  /** `<data>/workspaces/<ws>`. */
  readonly workspaceDir?: string
  /** Bound project root. */
  readonly projectRoot?: string
}

export function hookSourceFiles(dirs: HookSourceDirs): { layer: HookLayer; path: string }[] {
  return [
    ...(dirs.userDir !== undefined ? [{ layer: 'user' as const, path: path.join(dirs.userDir, 'settings.json') }] : []),
    ...(dirs.workspaceDir !== undefined ? [{ layer: 'workspace' as const, path: path.join(dirs.workspaceDir, 'settings.json') }] : []),
    ...(dirs.projectRoot !== undefined
      ? [
          { layer: 'project' as const, path: path.join(dirs.projectRoot, '.claude', 'settings.json') },
          { layer: 'local' as const, path: path.join(dirs.projectRoot, '.claude', 'settings.local.json') },
        ]
      : []),
  ]
}

/**
 * Stable hook identity for the on/off switch: the same command under the
 * same event, matcher and layer is the same hook across reloads and edits
 * elsewhere in the file.
 */
export function hookId(layer: HookLayer, event: string, matcher: string, command: string): string {
  return createHash('sha256').update(JSON.stringify([layer, event, matcher, command])).digest('hex').slice(0, 16)
}

/**
 * Per-workspace on/off switches, kept OUT of the Claude settings files so
 * those stay exactly what Claude Code reads: `<ws>/hooks-state.json` =
 * `{ "inactive": ["<hookId>", …] }`. Applies to hooks from every layer.
 */
export function hookStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, 'hooks-state.json')
}

export async function readInactiveHooks(workspaceDir: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(hookStatePath(workspaceDir), 'utf8')) as unknown
    const list = isRecord(parsed) && Array.isArray(parsed['inactive']) ? parsed['inactive'] : []
    return new Set(list.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/** Switch one hook on or off for this workspace. */
export async function setHookActive(workspaceDir: string, id: string, active: boolean): Promise<void> {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new HookSettingsError(`invalid hook id '${id}'`)
  const inactive = await readInactiveHooks(workspaceDir)
  if (active) inactive.delete(id)
  else inactive.add(id)
  await fs.mkdir(workspaceDir, { recursive: true })
  await replaceFileAtomic(hookStatePath(workspaceDir), `${JSON.stringify({ inactive: [...inactive].sort() }, null, 2)}\n`)
}

/** Load and merge every source. Never throws. */
export async function loadHooks(dirs: HookSourceDirs): Promise<ResolvedHooks> {
  if (dirs.workspaceDir !== undefined) await migrateLegacyHooksJson(dirs.workspaceDir).catch(() => undefined)
  // Every file is read at once: this sits on the prompt-admission path.
  const files = hookSourceFiles(dirs)
  const [inactive, reads] = await Promise.all([
    dirs.workspaceDir !== undefined ? readInactiveHooks(dirs.workspaceDir) : Promise.resolve(new Set<string>()),
    Promise.all(files.map((source) => readSettings(source.path))),
  ])
  const all: ResolvedHook[] = []
  const diagnostics: string[] = []
  const sources: { layer: HookLayer; path: string; exists: boolean }[] = []
  let disabled = false
  for (const [index, source] of files.entries()) {
    const read = reads[index]!
    sources.push({ ...source, exists: read.exists })
    if (read.error !== undefined) { diagnostics.push(read.error); continue }
    if (read.doc === undefined) continue
    if (read.doc['disableAllHooks'] === true) disabled = true
    const parsed = parseHooksSection(read.doc['hooks'], { label: source.path })
    diagnostics.push(...parsed.diagnostics)
    for (const [event, groups] of Object.entries(parsed.hooks)) {
      const supported = SUPPORTED_HOOK_EVENTS.has(event as ClaudeHookEvent)
      for (const group of groups ?? []) {
        for (const command of group.hooks) {
          const matcher = group.matcher ?? ''
          const id = hookId(source.layer, event, matcher, command.command)
          all.push({
            id,
            event: event as ClaudeHookEvent,
            matcher,
            command: command.command,
            ...(command.timeout !== undefined ? { timeout: command.timeout } : {}),
            layer: source.layer,
            source: source.path,
            active: !inactive.has(id),
            supported,
          })
        }
      }
    }
  }
  const hooks = disabled ? [] : all.filter((hook) => hook.active && hook.supported)
  return { all, hooks, disabled, sources, diagnostics }
}

/**
 * Claude matcher semantics: empty, omitted or `*` matches everything;
 * otherwise a regular expression over the whole value (`Write|Edit`,
 * `mcp__github__.*`). A matcher that is not a valid regex matches exactly.
 */
export function hookMatches(matcher: string, value: string | undefined): boolean {
  if (matcher === '' || matcher === '*') return true
  if (value === undefined) return false
  try {
    return new RegExp(`^(?:${matcher})$`).test(value)
  } catch {
    return matcher === value
  }
}

/** Hooks of one event that match `value` (tool name, source, trigger…), identical commands once. */
export function selectHooks(resolved: ResolvedHooks, event: ClaudeHookEvent, value?: string): ResolvedHook[] {
  const seen = new Set<string>()
  const out: ResolvedHook[] = []
  for (const hook of resolved.hooks) {
    if (hook.event !== event) continue
    // Events without a matcher dimension ignore the matcher (Claude).
    if (value !== undefined && !hookMatches(hook.matcher, value)) continue
    if (seen.has(hook.command)) continue
    seen.add(hook.command)
    out.push(hook)
  }
  return out
}

/**
 * True when a file path names hook configuration or a hook script: any
 * `.claude/settings.json` / `.claude/settings.local.json`, anything under a
 * `.claude/hooks/` folder, or `settings.json` inside an extra root (the user
 * `~/.claude` folder). Writing one changes which shell commands run on later
 * events, so the host always asks first (Claude Code does the same for its
 * own settings files).
 */
export function isHookConfigPath(filePath: string, extraRoots: readonly string[] = []): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/i.test(normalized)) return true
  if (/(^|\/)\.claude\/hooks(\/|$)/i.test(normalized)) return true
  if (/(^|\/)hooks-state\.json$/i.test(normalized)) return true
  for (const root of extraRoots) {
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized === `${base}/settings.json` || normalized === `${base}/settings.local.json` || normalized.startsWith(`${base}/hooks/`)) return true
  }
  return false
}

// ── workspace layer: read/write from the app ─────────────────────────────

export function workspaceSettingsPath(workspaceDir: string): string {
  return path.join(workspaceDir, 'settings.json')
}

/** The workspace settings document's `hooks` section (strict view for the editor). */
export async function readWorkspaceHooks(workspaceDir: string): Promise<{ hooks: HooksSection; disableAllHooks: boolean }> {
  await migrateLegacyHooksJson(workspaceDir).catch(() => undefined)
  const read = await readSettings(workspaceSettingsPath(workspaceDir))
  if (read.error !== undefined) throw new HookSettingsError(read.error)
  const doc = read.doc ?? {}
  return { hooks: parseHooksSection(doc['hooks']).hooks, disableAllHooks: doc['disableAllHooks'] === true }
}

/** Replace the workspace `hooks` section (strictly validated), preserving every other key. */
export async function writeWorkspaceHooks(workspaceDir: string, hooks: unknown, disableAllHooks?: boolean): Promise<void> {
  const parsed = parseHooksSection(hooks, { strict: true }).hooks
  const file = workspaceSettingsPath(workspaceDir)
  const read = await readSettings(file)
  if (read.error !== undefined) throw new HookSettingsError(read.error)
  const doc: Record<string, unknown> = { ...(read.doc ?? {}) }
  if (Object.keys(parsed).length === 0) delete doc['hooks']
  else doc['hooks'] = parsed
  if (disableAllHooks === true) doc['disableAllHooks'] = true
  else if (disableAllHooks === false) delete doc['disableAllHooks']
  await fs.mkdir(workspaceDir, { recursive: true })
  await replaceFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`)
}

// ── one-time migration of the retired dnt-harness hooks.json ─────────────

/** POSIX shell quoting for a legacy `command + args` pair. */
function shellQuote(part: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`
}

/**
 * A legacy `<ws>/hooks.json` (`{version:1, hooks:{Event:[{matcher,type,
 * command,args,timeoutMs,onFailure}]}}`) becomes the `hooks` section of
 * `<ws>/settings.json` when that file has none; the old file is renamed
 * `hooks.json.migrated`. `onFailure` has no Claude equivalent and is dropped.
 */
export async function migrateLegacyHooksJson(workspaceDir: string): Promise<boolean> {
  const legacy = path.join(workspaceDir, 'hooks.json')
  let raw: string
  try { raw = await fs.readFile(legacy, 'utf8') } catch { return false }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return false }
  if (!isRecord(parsed) || !isRecord(parsed['hooks'])) return false
  const settings = await readSettings(workspaceSettingsPath(workspaceDir))
  if (settings.error !== undefined) return false
  const doc: Record<string, unknown> = { ...(settings.doc ?? {}) }
  if (doc['hooks'] === undefined) {
    const converted: Record<string, HookMatcherGroup[]> = {}
    for (const [event, bindings] of Object.entries(parsed['hooks'])) {
      if (!Array.isArray(bindings) || !(CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) continue
      for (const binding of bindings) {
        if (!isRecord(binding) || typeof binding['command'] !== 'string') continue
        const args = Array.isArray(binding['args']) ? (binding['args'] as unknown[]).map(String) : undefined
        const command = args !== undefined ? [binding['command'], ...args].map(shellQuote).join(' ') : binding['command']
        const timeoutMs = typeof binding['timeoutMs'] === 'number' ? binding['timeoutMs'] : undefined
        ;(converted[event] ??= []).push({
          // Legacy matchers were exact names or `prefix*`; the regex form of a prefix is `prefix.*`.
          ...(typeof binding['matcher'] === 'string' && binding['matcher'] !== '*' && binding['matcher'] !== ''
            ? { matcher: binding['matcher'].endsWith('*') ? `${binding['matcher'].slice(0, -1).replace(/[.+?^${}()|[\]\\]/g, '\\$&')}.*` : binding['matcher'] }
            : {}),
          hooks: [{ type: 'command', command, ...(timeoutMs !== undefined ? { timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) } : {}) }],
        })
      }
    }
    if (Object.keys(converted).length > 0) {
      doc['hooks'] = converted
      await replaceFileAtomic(workspaceSettingsPath(workspaceDir), `${JSON.stringify(doc, null, 2)}\n`)
    }
  }
  await fs.rename(legacy, `${legacy}.migrated`).catch(() => undefined)
  return true
}
