/**
 * Subagent definitions in Claude Code format: Markdown files with YAML
 * frontmatter, read from layered folders exactly where Claude Code reads
 * them, plus one dnt-harness layer (the workspace folder, laid out like
 * `~/.claude`). Later layers override earlier ones by name:
 *
 *   bundled    explorer / worker / reviewer / verifier (built-ins)
 *   user       ~/.claude/agents/*.md
 *   workspace  <data>/workspaces/<ws>/agents/*.md   (the in-app editable layer)
 *   project    <project>/.claude/agents/*.md
 *
 * A role is NOT a mode: it restricts tools and carries instructions within
 * the effective mode/policy; it can never grant anything the workspace
 * policy or mode ceiling denies.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { KNOWN_MODE_TOOLS } from '../modes/known-tools.ts'

export const BUNDLED_AGENT_ROLES = ['explorer', 'worker', 'reviewer', 'verifier'] as const

export type AgentSource = 'bundled' | 'user' | 'workspace' | 'project'

export interface AgentDefinition {
  /** Identity from `name:` (Claude), falling back to the file name. */
  readonly name: string
  readonly description: string
  /** System instructions prepended for the child's context (the Markdown body). */
  readonly instructions: string
  /** Hard tool ceiling: the child can never call anything outside this list. */
  readonly tools: readonly string[]
  /**
   * `tools` was omitted (Claude: inherit every tool). `tools` then lists the
   * built-ins, and MCP tools named in a spawn grant are also admitted.
   */
  readonly inheritsTools?: boolean
  /** Tools the definition explicitly refuses even if the grant allows. */
  readonly disallowedTools: readonly string[]
  /** Skills preloaded into the child Turn (loaded once and hash-pinned). */
  readonly skills?: readonly string[]
  /** `inherit`/omitted inherits the session's model; aliases resolve at spawn. */
  readonly model?: string
  /** Claude fields recognized but not enforced by dnt-harness (shown as warnings). */
  readonly unsupported?: readonly string[]
  /** Tool names the file listed that dnt-harness does not have (dropped). */
  readonly droppedTools?: readonly string[]
  /** Parse notes: unknown tools dropped, unsupported fields, … */
  readonly warnings?: readonly string[]
}

export interface ResolvedAgentDefinition {
  readonly definition: AgentDefinition
  readonly source: AgentSource
  /** Absolute file path (file-backed layers only). */
  readonly path?: string
  /** sha256 of the raw file (file-backed layers only). */
  readonly hash?: string
  /** Lower layers this definition overrides, by source. */
  readonly overrides?: readonly AgentSource[]
}

export class AgentDefinitionError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'duplicate' | 'conflict' | 'blocked',
    message: string,
  ) {
    super(message)
    this.name = 'AgentDefinitionError'
  }
}

/** Claude subagent frontmatter keys dnt-harness enforces. */
const ENFORCED_KEYS = new Set(['name', 'description', 'tools', 'disallowedTools', 'skills', 'model'])
/** Claude keys recognized but not enforced: accepted, reported as warnings. */
const UNSUPPORTED_KEYS = new Set([
  'permissionMode', 'hooks', 'mcpServers', 'memory', 'color', 'effort', 'isolation', 'background', 'maxTurns',
])

/** Claude Code tool names → dnt-harness tools. `null` = no equivalent. */
const CLAUDE_TOOL_ALIASES: Readonly<Record<string, string | null>> = {
  Task: 'Agent',
  MultiEdit: 'Edit',
  LS: 'Glob',
  NotebookRead: 'Read',
  NotebookEdit: null,
  WebFetch: null,
  WebSearch: null,
  TodoRead: 'TodoWrite',
  KillBash: 'KillShell',
}

/** One Claude tool name → a dnt-harness tool, or the name it had to drop. */
function normalizeTool(raw: string): { tool?: string; dropped?: string } {
  const name = raw.trim()
  if (name === '' || name === '*') return {}
  if (name.startsWith('mcp__')) return { tool: name }
  // Claude permission-rule syntax `Bash(git:*)` names the tool before the paren.
  const base = name.replace(/\(.*\)$/, '')
  if (Object.hasOwn(CLAUDE_TOOL_ALIASES, base)) {
    const mapped = CLAUDE_TOOL_ALIASES[base]
    return mapped === null || mapped === undefined ? { dropped: base } : { tool: mapped }
  }
  return KNOWN_MODE_TOOLS.includes(base) ? { tool: base } : { dropped: base }
}

/** Claude accepts `tools: Read, Grep` (comma string) or a YAML list. */
function toolList(value: unknown, key: string, invalid: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  invalid.push(`'${key}' must be a comma-separated string or a list of names`)
  return undefined
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string; error?: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (match === null) return { frontmatter: {}, body: raw.trim() }
  const body = raw.slice(match[0].length).trim()
  try {
    const parsed = loadYaml(match[1] ?? '') as unknown
    if (parsed === null || parsed === undefined) return { frontmatter: {}, body }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return { frontmatter: {}, body, error: 'frontmatter must be a YAML mapping' }
    return { frontmatter: parsed as Record<string, unknown>, body }
  } catch (error) {
    return { frontmatter: {}, body, error: `frontmatter is not valid YAML: ${String(error instanceof Error ? error.message.split('\n')[0] : error)}` }
  }
}

/**
 * Claude subagent descriptions often end in `Examples:` followed by
 * `<example>` blocks; tools that strip the tags leave `Examples: - - -`.
 * Drop that empty tail (the delegating model reads the description) and
 * collapse whitespace; real example text is kept.
 */
export function cleanDescription(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*Examples?:\s*(?:[-–•]\s*)*$/i, '')
    .trim()
}

/**
 * Parse one subagent file (Claude Code format). Required: `description` and
 * a non-empty body. Omitted `tools` inherits every tool the conversation
 * exposes (the mode ceiling still applies). Unknown tool names are dropped
 * with a warning — only narrowing, never widening. `fallbackName` is the file
 * name, used when `name:` is absent.
 */
export function parseAgentDefinition(fallbackName: string, raw: string): AgentDefinition {
  const { frontmatter, body, error } = splitFrontmatter(raw)
  const invalid: string[] = error !== undefined ? [error] : []
  const warnings: string[] = []
  const unsupported: string[] = []

  for (const key of Object.keys(frontmatter)) {
    if (ENFORCED_KEYS.has(key)) continue
    if (UNSUPPORTED_KEYS.has(key)) unsupported.push(key)
    else warnings.push(`unknown frontmatter key '${key}' ignored`)
  }
  if (unsupported.length > 0) warnings.push(`not enforced by dnt-harness: ${unsupported.join(', ')}`)

  const rawName = frontmatter['name']
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : fallbackName
  const rawDescription = frontmatter['description']
  const description = typeof rawDescription === 'string' ? cleanDescription(rawDescription) : ''
  if (description === '') invalid.push("'description' is required and must be a non-empty string")

  const dropped: string[] = []
  const normalize = (list: string[] | undefined): string[] | undefined => {
    if (list === undefined) return undefined
    const out: string[] = []
    for (const entry of list) {
      const { tool, dropped: gone } = normalizeTool(entry)
      if (tool !== undefined && !out.includes(tool)) out.push(tool)
      if (gone !== undefined && !dropped.includes(gone)) dropped.push(gone)
    }
    return out
  }
  const declaredTools = normalize(toolList(frontmatter['tools'], 'tools', invalid))
  const disallowedTools = normalize(toolList(frontmatter['disallowedTools'], 'disallowedTools', invalid)) ?? []
  if (dropped.length > 0) warnings.push(`tools not available in dnt-harness, dropped: ${dropped.join(', ')}`)
  // Omitted (or `*`) = inherit all tools, as in Claude Code. A child never
  // delegates further, so `Agent` is never part of an inherited set.
  const inherits = declaredTools === undefined || toolList(frontmatter['tools'], 'tools', [])?.includes('*') === true
  const tools = inherits ? KNOWN_MODE_TOOLS.filter((tool) => tool !== 'Agent') : declaredTools

  const skills = toolList(frontmatter['skills'], 'skills', invalid)

  let model: string | undefined
  const rawModel = frontmatter['model']
  if (rawModel !== undefined && rawModel !== null) {
    if (typeof rawModel === 'string' && rawModel.trim() !== '') {
      model = rawModel.trim() === 'inherit' ? undefined : rawModel.trim()
    } else {
      invalid.push("'model' must be a non-empty string")
    }
  }

  if (body === '') invalid.push('instructions body must not be empty')
  if (invalid.length > 0) {
    throw new AgentDefinitionError('invalid', `agent definition '${name}' is invalid: ${invalid.join('; ')}`)
  }
  return {
    name,
    description,
    instructions: body,
    tools,
    ...(inherits ? { inheritsTools: true } : {}),
    disallowedTools,
    ...(skills !== undefined ? { skills } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(unsupported.length > 0 ? { unsupported } : {}),
    ...(dropped.length > 0 ? { droppedTools: dropped } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

const READ_ONLY_DISALLOWED = ['Write', 'Edit', 'Bash', 'Skill', 'MemoryCreate', 'MemoryUpdate', 'MemoryForget']

/**
 * Bundled role definitions (read-only; copied for customization). Each
 * description is a SELECTION rule — the sentence the delegating model reads —
 * and each body states the exact shape of the final report, because a
 * child's final message is its whole deliverable.
 */
export function bundledDefinition(name: string): AgentDefinition {
  if (name === 'explorer') {
    return {
      name: 'explorer',
      description: 'Finds and explains things in the project. Use it when you need to locate code or understand how something works and will act on the answer yourself.',
      instructions: [
        'You investigate the project and report what you found. You cannot change anything.',
        'Search broadly first (Glob, Grep), then read only what answers the brief. Prefer evidence over guesses; say so when something could not be found.',
        'Your final message answers the brief directly, then lists the evidence: one line per finding as `path:line` — what is there and why it matters.',
      ].join(' '),
      tools: ['Read', 'Glob', 'Grep'],
      disallowedTools: READ_ONLY_DISALLOWED,
    }
  }
  if (name === 'worker') {
    return {
      name: 'worker',
      description: 'Implements one bounded, already-agreed task and runs relevant checks. Use it when the goal and constraints are decided and you want the implementation done without spending your own context on it.',
      instructions: [
        'You implement exactly the task the brief describes — nothing beyond it. Read the files before editing them, preserve unrelated changes, and re-read what you wrote to check it. Do not expand the scope or refactor unrelated code.',
        'If the brief is ambiguous, a design decision is unresolved, or the change turns out to be wrong, stop and report what is blocked instead of improvising.',
        'Use shell commands only to support the task: tests, typecheck, build, and inspecting diffs. Do not commit, push, run destructive commands, or change dependencies unless the brief explicitly requires it. Bash may return a running process ID after its foreground wait; watch the same execution with BashOutput (block:true for bounded waiting), never rerun it just because it is still running. Stop unneeded processes with KillShell.',
        'Your final message lists every file you changed as `path` — what changed, then each check you ran with its command and outcome. Clearly identify checks not run, incomplete verification, and anything blocked or unfinished and why. Never claim a check passed without its completed result.',
      ].join(' '),
      tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell'],
      disallowedTools: [],
    }
  }
  if (name === 'reviewer') {
    return {
      name: 'reviewer',
      description: 'Finds defects in existing code. Use it after you or a worker changed something, when you want a second read rather than more edits.',
      instructions: [
        'You review code and report defects. You cannot change anything.',
        'Read the files named in your brief plus whatever they depend on. Look for incorrect behaviour first, then missing error handling, then contract breaks — not style.',
        'Your final message is a list. Each entry: `path:line` — the defect in one sentence — the concrete input or state that triggers it. Say "no defects found" if that is the truth; do not pad the list.',
      ].join(' '),
      tools: ['Read', 'Glob', 'Grep'],
      disallowedTools: READ_ONLY_DISALLOWED,
    }
  }
  if (name === 'verifier') {
    return {
      name: 'verifier',
      description: 'Runs a command and judges its outcome. Use it when you need tests, a typecheck, or a build run and want a verdict back instead of the raw output.',
      instructions: [
        'You run the commands the brief names (tests, typecheck, build) and judge the outcome. Do not modify source or update snapshots; commands may create build artifacts or caches.',
        'Run each command once; rerun only to confirm a flaky result. If Bash returns a running process ID, watch it with BashOutput (block:true for bounded waiting); use KillShell to stop unneeded commands. Read the code a failure points at when that explains it.',
        'Your final message starts with PASS, FAIL, BLOCKED, or INCONCLUSIVE; never claim a still-running check passed, then one line per command: the command — its exit code — the failing cases, each with `path:line` and the assertion or error text.',
      ].join(' '),
      tools: ['Read', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell'],
      disallowedTools: ['Write', 'Edit', 'Skill', 'MemoryCreate', 'MemoryUpdate', 'MemoryForget'],
    }
  }
  throw new AgentDefinitionError('not-found', `no bundled agent role '${name}'`)
}


function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Names that may be written by the app (file name = lookup key). */
const AGENT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Agent identity is case-insensitive (`Explore` == `explore`). */
export function agentKey(name: string): string {
  return name.trim().toLowerCase()
}

export interface AgentLayerDirs {
  /** `~/.claude`; omitted skips the user layer. */
  readonly userDir?: string
  /** Bound project root; omitted skips the project layer. */
  readonly projectRoot?: string
}

/** Layered definition registry (bundled + user + workspace + project). */
export class AgentDefinitionService {
  constructor(
    private readonly home: string,
    private readonly options: { readonly userClaudeDir?: string; readonly projectRootOf?: (workspaceId: string, projectId: string) => string | undefined } = {},
  ) {}

  /** The workspace layer folder (the only one the app writes). */
  workspaceAgentsDir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'agents')
  }

  private layers(workspaceId: string, projectId?: string): { source: Exclude<AgentSource, 'bundled'>; dir: string }[] {
    const projectRoot = projectId !== undefined ? this.options.projectRootOf?.(workspaceId, projectId) : undefined
    return [
      ...(this.options.userClaudeDir !== undefined ? [{ source: 'user' as const, dir: path.join(this.options.userClaudeDir, 'agents') }] : []),
      { source: 'workspace' as const, dir: this.workspaceAgentsDir(workspaceId) },
      ...(projectRoot !== undefined ? [{ source: 'project' as const, dir: path.join(projectRoot, '.claude', 'agents') }] : []),
    ]
  }

  private async readLayer(source: Exclude<AgentSource, 'bundled'>, dir: string): Promise<{ rows: ResolvedAgentDefinition[]; errors: { path: string; message: string }[] }> {
    const rows: ResolvedAgentDefinition[] = []
    const errors: { path: string; message: string }[] = []
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return { rows, errors }
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.md') || !(entry.isFile() || entry.isSymbolicLink())) continue
      const file = path.join(dir, entry.name)
      let raw: string
      try { raw = await fs.readFile(file, 'utf8') } catch { continue }
      try {
        rows.push({ definition: parseAgentDefinition(entry.name.slice(0, -3), raw), source, path: file, hash: sha256(raw) })
      } catch (error) {
        errors.push({ path: file, message: String(error instanceof Error ? error.message : error) })
      }
    }
    return { rows, errors }
  }

  /** Every effective definition (highest layer wins per name) plus invalid files. */
  async catalog(workspaceId: string, projectId?: string): Promise<{ rows: ResolvedAgentDefinition[]; errors: { path: string; message: string }[] }> {
    const byKey = new Map<string, ResolvedAgentDefinition>()
    for (const name of BUNDLED_AGENT_ROLES) byKey.set(name, { definition: bundledDefinition(name), source: 'bundled' })
    const errors: { path: string; message: string }[] = []
    for (const layer of this.layers(workspaceId, projectId)) {
      const read = await this.readLayer(layer.source, layer.dir)
      errors.push(...read.errors)
      for (const row of read.rows) {
        const key = agentKey(row.definition.name)
        const lower = byKey.get(key)
        byKey.set(key, lower === undefined ? row : { ...row, overrides: [...(lower.overrides ?? []), lower.source] })
      }
    }
    const rows = [...byKey.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name))
    return { rows, errors }
  }

  async list(workspaceId: string, projectId?: string): Promise<ResolvedAgentDefinition[]> {
    return (await this.catalog(workspaceId, projectId)).rows
  }

  async resolve(workspaceId: string, name: string, projectId?: string): Promise<ResolvedAgentDefinition> {
    const key = agentKey(name)
    const { rows, errors } = await this.catalog(workspaceId, projectId)
    // Identity is `name:` (Claude); the file name is a fallback handle, so a
    // workspace file saved as `x.md` stays addressable as `x`.
    const found = rows.find((row) => agentKey(row.definition.name) === key)
      ?? rows.find((row) => row.path !== undefined && agentKey(path.basename(row.path, '.md')) === key)
    if (found !== undefined) return found
    const broken = errors.find((error) => agentKey(path.basename(error.path, '.md')) === key)
    if (broken !== undefined) throw new AgentDefinitionError('invalid', broken.message)
    throw new AgentDefinitionError('not-found', `no agent definition '${name}'`)
  }

  private filePath(workspaceId: string, name: string): string {
    if (!AGENT_FILE_PATTERN.test(name)) {
      throw new AgentDefinitionError('invalid', `agent name '${name}' must be letters, digits, '-' or '_'`)
    }
    const dir = path.resolve(this.workspaceAgentsDir(workspaceId))
    const file = path.resolve(dir, `${name}.md`)
    if (path.dirname(file) !== dir) throw new AgentDefinitionError('invalid', `agent name '${name}' escapes the agents directory`)
    return file
  }

  /** Save into the workspace layer with validation and an optional external-edit conflict check. */
  async save(workspaceId: string, name: string, raw: string, expectedHash?: string): Promise<ResolvedAgentDefinition> {
    const file = this.filePath(workspaceId, name)
    const definition = parseAgentDefinition(name, raw)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const current = await fs.readFile(file, 'utf8').catch(() => undefined)
    if (current !== undefined && expectedHash !== undefined && sha256(current) !== expectedHash) {
      throw new AgentDefinitionError('conflict', `definition '${name}' changed externally; re-read before saving`)
    }
    await replaceFileAtomic(file, raw)
    return { definition, source: 'workspace', path: file, hash: sha256(raw) }
  }

  /** The exact text of one workspace-layer file plus its hash (for the raw editor). */
  async readWorkspaceFile(workspaceId: string, name: string): Promise<{ content: string; hash: string }> {
    const file = this.filePath(workspaceId, name)
    const content = await fs.readFile(file, 'utf8').catch(() => undefined)
    if (content === undefined) throw new AgentDefinitionError('not-found', `no workspace agent file '${name}'`)
    return { content, hash: sha256(content) }
  }

  /**
   * Copy a `~/.claude` or bundled role into this workspace under the SAME
   * name, byte for byte (every Claude field kept), so the workspace copy
   * overrides it here and becomes editable. Never overwrites an existing file.
   */
  async cloneToWorkspace(workspaceId: string, name: string): Promise<ResolvedAgentDefinition> {
    const key = agentKey(name)
    const { rows } = await this.catalog(workspaceId)
    const row = rows.find((candidate) => agentKey(candidate.definition.name) === key)
    if (row === undefined) throw new AgentDefinitionError('not-found', `no agent definition '${name}'`)
    if (row.source === 'workspace') throw new AgentDefinitionError('duplicate', `'${row.definition.name}' is already in this workspace`)
    const stem = row.path !== undefined ? path.basename(row.path, '.md') : row.definition.name
    const raw = row.path !== undefined ? await fs.readFile(row.path, 'utf8') : serializeAgentDefinition(row.definition)
    const file = this.filePath(workspaceId, stem)
    if (await fs.stat(file).then(() => true, () => false)) {
      throw new AgentDefinitionError('duplicate', `this workspace already has agents/${stem}.md`)
    }
    return this.save(workspaceId, stem, raw)
  }

  /** Delete a workspace-layer file. Bundled roles and other layers are read-only here. */
  async delete(workspaceId: string, name: string): Promise<void> {
    const file = this.filePath(workspaceId, name)
    const exists = await fs.stat(file).then(() => true, () => false)
    if (!exists) {
      if ((BUNDLED_AGENT_ROLES as readonly string[]).includes(agentKey(name))) {
        throw new AgentDefinitionError('duplicate', 'bundled roles cannot be deleted')
      }
      throw new AgentDefinitionError('not-found', `no workspace agent file '${name}'`)
    }
    await fs.rm(file, { force: true })
  }
}

/** Claude Code subagent document for a definition (used by the app's create/copy form). */
export function serializeAgentDefinition(definition: Pick<AgentDefinition, 'name' | 'description' | 'instructions' | 'tools' | 'disallowedTools' | 'skills' | 'model' | 'inheritsTools'>): string {
  const quote = (value: string): string => JSON.stringify(value)
  const lines = [
    '---',
    `name: ${quote(definition.name)}`,
    `description: ${quote(definition.description)}`,
    // Omitted = inherit all; an explicit empty ceiling must stay explicit.
    ...(definition.inheritsTools === true ? [] : [`tools: ${definition.tools.length > 0 ? definition.tools.join(', ') : '[]'}`]),
    ...(definition.disallowedTools.length > 0 ? [`disallowedTools: ${definition.disallowedTools.join(', ')}`] : []),
    ...(definition.skills !== undefined && definition.skills.length > 0 ? [`skills: ${definition.skills.join(', ')}`] : []),
    ...(definition.model !== undefined ? [`model: ${definition.model}`] : []),
    '---',
    '',
    definition.instructions.trim(),
    '',
  ]
  return lines.join('\n')
}
