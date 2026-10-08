/**
 * Claude Code subagent files need no importer: `definition-service.ts` reads
 * them natively from `~/.claude/agents`, the workspace layer and
 * `<project>/.claude/agents`. `importClaudeDefinition` remains as a thin
 * parse-and-report helper for callers that only hold the text.
 *
 * The Codex adapter targets a pinned source version; unsupported semantics
 * are reported, not faked.
 */
import { AgentDefinitionError, parseAgentDefinition, type AgentDefinition } from '../definition-service.ts'

export interface ClaudeImportResult {
  readonly definition: AgentDefinition
  /** Frontmatter keys honored. */
  readonly imported: readonly string[]
  /** Claude keys recognized but not enforced by dnt-harness. */
  readonly unsupported: readonly string[]
  readonly warnings: readonly string[]
}

/** Parse one Claude Code subagent document (same rules as the layered loader). */
export function importClaudeDefinition(raw: string, fallbackName = 'agent'): ClaudeImportResult {
  const definition = parseAgentDefinition(fallbackName, raw)
  return {
    definition,
    imported: (['name', 'description', 'tools', 'disallowedTools', 'skills', 'model'] as const).filter((key) => definition[key] !== undefined),
    unsupported: definition.unsupported ?? [],
    warnings: definition.warnings ?? [],
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
