/**
 * Compatibility imports (G4): Claude-first definition import of the
 * SUPPORTED subset, with unsupported execution/security fields reported —
 * never silently discarded with broader permissions, never executed, never
 * carrying credentials. The Codex adapter targets a pinned source version;
 * unsupported semantics are reported, not faked.
 */
import { AgentDefinitionError, type AgentDefinition } from '../definition-service.ts'

/** Fields the Claude sub-agent frontmatter may carry (documented subset). */
// dnt-harness's native `inheritable` is deliberately absent: it is not a Claude
// key, so a Claude file carrying it reports it under `ignored` and no Claude
// import ever produces it.
const CLAUDE_SUPPORTED_KEYS = new Set(['name', 'description', 'tools', 'disallowedTools', 'skills', 'model', 'maxTurns'])

/**
 * Fields we RECOGNIZE but cannot honor safely. Their presence blocks
 * automatic activation: the import reports them and the definition stays
 * disabled until the operator resolves each explicitly.
 */
const CLAUDE_BLOCKING_KEYS = new Set([
  'permissionMode', 'isolation', 'effort', 'mcpServers', 'hooks', 'background', 'worktree', 'memory',
])

export interface ClaudeImportResult {
  readonly definition: AgentDefinition
  /** Supported subset actually imported (provenance). */
  readonly imported: readonly string[]
  /** Blocking fields that prevent automatic activation. */
  readonly blocked: readonly string[]
  /** Unknown fields ignored with provenance (no security impact). */
  readonly ignored: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * Import one Claude sub-agent Markdown/frontmatter file. Recognizes name,
 * description, tools, disallowedTools, model, and legacy maxTurns metadata.
 * maxTurns is retained for round-trip compatibility but is not enforced.
 * Blocking fields (hooks/mcpServers/permissionMode/isolation/
 * background/worktree/memory/effort) surface in `blocked`; the caller must
 * NOT auto-activate such definitions. Import never executes anything.
 */
export function importClaudeDefinition(raw: string): ClaudeImportResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const body = (match !== null ? raw.slice(match[0].length) : raw).trim()
  const frontmatter = match !== null ? parseFrontmatter(match[1] ?? '') : {}
  const imported: string[] = []
  const blocked: string[] = []
  const ignored: string[] = []
  const warnings: string[] = []

  for (const key of Object.keys(frontmatter)) {
    if (CLAUDE_SUPPORTED_KEYS.has(key)) continue
    if (CLAUDE_BLOCKING_KEYS.has(key)) blocked.push(key)
    else ignored.push(key)
  }

  const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'].trim() : ''
  if (name === '') throw new AgentDefinitionError('invalid', "Claude import needs a non-empty 'name'")
  const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'].trim() : ''
  if (description === '') warnings.push("'description' missing; imported with an empty description")

  let tools: string[] = []
  if (Array.isArray(frontmatter['tools'])) tools = (frontmatter['tools'] as unknown[]).map(String)
  let disallowedTools: string[] = []
  if (Array.isArray(frontmatter['disallowedTools'])) disallowedTools = (frontmatter['disallowedTools'] as unknown[]).map(String)

  const skills = Array.isArray(frontmatter['skills']) ? (frontmatter['skills'] as unknown[]).map(String) : undefined
  let model: string | undefined
  if (typeof frontmatter['model'] === 'string' && frontmatter['model'].trim() !== '') {
    // Claude model aliases map to workspace resources at ACTIVATION time;
    // the alias is carried verbatim and the host resolves/reports it.
    model = frontmatter['model'].trim()
    warnings.push(`model alias '${model}' is resolved against workspace providers at activation`)
  }

  let maxTurns: number | undefined
  if (frontmatter['maxTurns'] !== undefined) {
    const value = Number(frontmatter['maxTurns'])
    if (Number.isInteger(value) && value > 0) {
      maxTurns = value
      warnings.push("'maxTurns' is retained as deprecated metadata but is not enforced")
    } else {
      warnings.push(`'maxTurns' ${JSON.stringify(frontmatter['maxTurns'])} is not a positive integer and was ignored`)
    }
  }

  if (blocked.length > 0) {
    warnings.push(`blocking fields present (${blocked.join(', ')}): automatic activation prevented until resolved`)
  }

  return {
    definition: {
      name,
      description,
      instructions: body,
      tools,
      disallowedTools,
      ...(skills !== undefined ? { skills } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    },
    imported: [...CLAUDE_SUPPORTED_KEYS].filter((key) => frontmatter[key] !== undefined),
    blocked,
    ignored,
    warnings,
  }
}

/** The Codex adapter pins ONE verified source version — documented here. */
export const CODEX_PINNED_VERSION = 'openai/codex@38cbebaf3fe3e81a94bf462079e7cf9659fc9e50'

export interface CodexImportResult {
  readonly definition: AgentDefinition
  readonly pinnedVersion: string
  readonly unsupported: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * Import a Codex multi-agent TOML/spec from the PINNED version. Codex's
 * multi-agent specs vary across commits and generations; this adapter
 * targets exactly {@link CODEX_PINNED_VERSION} and REPORTS unsupported
 * semantics (messaging/resume/fork/worktree, exec_command/write_stdin
 * process continuation, apply_patch freeform grammar) instead of faking a
 * mapping. Anything else is rejected as out-of-pin.
 */
export function importCodexDefinition(toml: string, sourceVersion?: string): CodexImportResult {
  const version = sourceVersion ?? CODEX_PINNED_VERSION
  if (version !== CODEX_PINNED_VERSION) {
    throw new AgentDefinitionError(
      'blocked',
      `Codex source version '${version}' is outside the pinned adapter (${CODEX_PINNED_VERSION}); do not import unverified specs`,
    )
  }
  // Minimal TOML-ish scan for the fields this pinned version exposes in its
  // multi_agents_spec: [agent] name + instructions + model.
  const name = /(?:^|\n)name\s*=\s*"([^"]+)"/.exec(toml)?.[1]
  const model = /(?:^|\n)model\s*=\s*"([^"]+)"/.exec(toml)?.[1]
  const instructions = /(?:^|\n)instructions\s*=\s*"([\s\S]*?)"\s*(?:\n|$)/.exec(toml)?.[1]
  if (name === undefined) {
    throw new AgentDefinitionError('invalid', 'Codex import needs a [agent] name = "..." field')
  }
  const unsupported = ['messaging', 'resume', 'fork', 'worktree', 'exec_command/write_stdin continuation', 'apply_patch freeform grammar']
  return {
    definition: {
      name,
      description: `Imported from Codex (${CODEX_PINNED_VERSION})`,
      instructions: instructions ?? '',
      tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
      disallowedTools: [],
      ...(model !== undefined ? { model } : {}),
    },
    pinnedVersion: CODEX_PINNED_VERSION,
    unsupported,
    warnings: [
      'Codex exec_command/write_stdin process continuation and apply_patch freeform grammar are NOT mapped; the definition runs on dnt-harness native tools',
      'messaging/resume/fork/worktree semantics are unsupported and reported, not faked',
    ],
  }
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
