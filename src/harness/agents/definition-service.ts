/**
 * Agent role definitions (G4): workspace-owned Markdown/frontmatter files
 * at `workspaces/<ws>/agents/*.md`, bundled roles are read-only and copied
 * explicitly for customization. A role is NOT a Mode — it restricts tools
 * and carries instructions within the effective mode/policy; it can never
 * grant anything the workspace policy or mode ceiling denies.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'

export const BUNDLED_AGENT_ROLES = ['explorer', 'worker', 'reviewer', 'verifier'] as const

export interface AgentDefinition {
  /** Stable lookup name (file name without .md). */
  readonly name: string
  readonly description: string
  /** System instructions prepended for the child's context. */
  readonly instructions: string
  /** Hard tool ceiling: the child can never call anything outside this list. */
  readonly tools: readonly string[]
  /** Tools the definition explicitly refuses even if the grant allows. */
  readonly disallowedTools: readonly string[]
  /** Skills preloaded into the child Turn (loaded once and hash-pinned). */
  readonly skills?: readonly string[]
  /** Optional model override; undefined inherits the session's selection. */
  readonly model?: string
  /** Deprecated compatibility metadata. Retained when importing old definitions, but never enforced. */
  readonly maxTurns?: number
  /**
   * dnt-harness native: `false` refuses `inherit: 'brief'` spawns (the role never
   * sees the delegating conversation). Absent means allowed.
   */
  readonly inheritable?: boolean
}

export interface ResolvedAgentDefinition {
  readonly definition: AgentDefinition
  readonly source: 'bundled' | 'workspace'
  /** sha256 of the raw file (workspace definitions only). */
  readonly hash?: string
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

/** Frontmatter keys a definition may carry (Claude-compatible subset plus dnt-harness `inheritable`). */
const KNOWN_KEYS = new Set([
  'name', 'description', 'tools', 'disallowedTools', 'skills', 'model', 'maxTurns', 'inheritable',
])

/**
 * Parse one definition file. Strict: unknown keys, unknown tools, missing
 * descriptions and invalid compatibility metadata reject with the invalid
 * fields listed — definitions that parse into something else are never executed.
 */
export function parseAgentDefinition(name: string, raw: string): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const body = (match !== null ? raw.slice(match[0].length) : raw).trim()
  const frontmatter = match !== null ? parseFrontmatter(match[1] ?? '') : {}
  const invalid: string[] = []

  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_KEYS.has(key)) invalid.push(`unknown frontmatter key '${key}'`)
  }
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  if (description === '') invalid.push("'description' is required and must be a non-empty string")

  let tools: string[] = []
  if (frontmatter.tools !== undefined) {
    if (Array.isArray(frontmatter.tools)) {
      tools = (frontmatter.tools as unknown[]).map((tool) => String(tool))
    } else {
      invalid.push("'tools' must be an array of tool names")
    }
  }
  let disallowedTools: string[] = []
  if (frontmatter.disallowedTools !== undefined) {
    if (Array.isArray(frontmatter.disallowedTools)) {
      disallowedTools = (frontmatter.disallowedTools as unknown[]).map((tool) => String(tool))
    } else {
      invalid.push("'disallowedTools' must be an array of tool names")
    }
  }

  let skills: string[] | undefined
  if (frontmatter.skills !== undefined) {
    if (Array.isArray(frontmatter.skills) && (frontmatter.skills as unknown[]).every((skill) => typeof skill === 'string')) {
      skills = frontmatter.skills as string[]
    } else {
      invalid.push("'skills' must be an array of skill names")
    }
  }

  let model: string | undefined
  if (frontmatter.model !== undefined) {
    if (typeof frontmatter.model === 'string' && frontmatter.model.trim() !== '') {
      model = frontmatter.model.trim()
    } else {
      invalid.push("'model' must be a non-empty string")
    }
  }

  let maxTurns: number | undefined
  if (frontmatter.maxTurns !== undefined) {
    const value = Number(frontmatter.maxTurns)
    if (Number.isInteger(value) && value > 0) maxTurns = value
    else invalid.push(`'maxTurns' must be a positive integer, got ${JSON.stringify(frontmatter.maxTurns)}`)
  }

  let inheritable: boolean | undefined
  if (frontmatter.inheritable !== undefined) {
    if (typeof frontmatter.inheritable === 'boolean') inheritable = frontmatter.inheritable
    else invalid.push("'inheritable' must be true or false")
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
    disallowedTools,
    ...(skills !== undefined ? { skills } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(inheritable !== undefined ? { inheritable } : {}),
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

function parseFrontmatter(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const line of block.split('\n')) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const rawValue = match[2]?.trim() ?? ''
    try {
      result[match[1] as string] = JSON.parse(rawValue) as unknown
    } catch {
      result[match[1] as string] = rawValue
    }
  }
  return result
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Workspace-scoped definition registry (bundled read-only + workspace files). */
export class AgentDefinitionService {
  constructor(private readonly home: string) {}

  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'agents')
  }

  private filePath(workspaceId: string, name: string): string {
    return path.join(this.dir(workspaceId), `${name}.md`)
  }

  async list(workspaceId: string): Promise<ResolvedAgentDefinition[]> {
    const rows: ResolvedAgentDefinition[] = BUNDLED_AGENT_ROLES.map((name) => ({
      definition: bundledDefinition(name),
      source: 'bundled' as const,
    }))
    let entries
    try {
      entries = await fs.readdir(this.dir(workspaceId), { withFileTypes: true })
    } catch {
      return rows
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.slice(0, -3)
      if ((BUNDLED_AGENT_ROLES as readonly string[]).includes(name)) {
        // A workspace file named like a bundled role (e.g. one written before
        // that role was bundled) never runs — the bundled role wins. Say so
        // instead of hiding it; `delete` removes such a file.
        console.warn(`agents: workspace definition '${name}' in ${workspaceId} is shadowed by the bundled role; rename it to keep it`)
        continue
      }
      try {
        rows.push(await this.resolve(workspaceId, name))
      } catch {
        // Invalid files surface on resolve; the catalog skips them.
      }
    }
    return rows.sort((a, b) => a.definition.name.localeCompare(b.definition.name))
  }

  async resolve(workspaceId: string, name: string): Promise<ResolvedAgentDefinition> {
    if ((BUNDLED_AGENT_ROLES as readonly string[]).includes(name)) {
      return { definition: bundledDefinition(name), source: 'bundled' }
    }
    let raw: string
    try {
      raw = await fs.readFile(this.filePath(workspaceId, name), 'utf8')
    } catch {
      throw new AgentDefinitionError('not-found', `no agent definition '${name}'`)
    }
    return { definition: parseAgentDefinition(name, raw), source: 'workspace', hash: sha256(raw) }
  }

  /** Save with strict validation and optional external-edit conflict check. */
  async save(workspaceId: string, name: string, raw: string, expectedHash?: string): Promise<ResolvedAgentDefinition> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new AgentDefinitionError('invalid', `agent name '${name}' must be kebab-case`)
    }
    if ((BUNDLED_AGENT_ROLES as readonly string[]).includes(name)) {
      throw new AgentDefinitionError('duplicate', `'${name}' is a bundled role; copy it to customize`)
    }
    parseAgentDefinition(name, raw) // validate before writing
    const file = this.filePath(workspaceId, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const current = await fs.readFile(file, 'utf8').catch(() => undefined)
    if (current !== undefined && expectedHash !== undefined && sha256(current) !== expectedHash) {
      throw new AgentDefinitionError('conflict', `definition '${name}' changed externally; re-read before saving`)
    }
    await replaceFileAtomic(file, raw)
    return { definition: parseAgentDefinition(name, raw), source: 'workspace', hash: sha256(raw) }
  }

  async delete(workspaceId: string, name: string): Promise<void> {
    if ((BUNDLED_AGENT_ROLES as readonly string[]).includes(name)) {
      // The bundled role itself cannot go; a shadowed workspace file can.
      const shadowed = await fs.stat(this.filePath(workspaceId, name)).then(() => true, () => false)
      if (!shadowed) throw new AgentDefinitionError('duplicate', 'bundled roles cannot be deleted')
    }
    await fs.rm(this.filePath(workspaceId, name), { force: true })
  }
}
