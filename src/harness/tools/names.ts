/**
 * Canonical Claude-style public tool names. The built-in capabilities were
 * historically lowercase; the public contract is the capitalized set, and
 * legacy names arriving from a model (or an old permission map) normalize
 * to canonical identity at the boundary — never as exposed duplicates.
 */
export const CANONICAL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const

export type CanonicalTool = (typeof CANONICAL_TOOLS)[number]

const LEGACY_MAP: Readonly<Record<string, CanonicalTool>> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
}

/**
 * Normalize one tool name to its canonical identity. Canonical names pass
 * through; legacy lowercase names map up; unknown names return unchanged
 * so the registry's unknown-tool error stays truthful.
 */
export function canonicalToolName(name: string): string {
  return LEGACY_MAP[name.toLowerCase()] ?? name
}

/**
 * Argument aliases models commonly emit for the file tools (the Claude Code
 * / ZCode spelling). They map to the canonical argument names before
 * authorization, so path guards, approvals, and the durable log all see one
 * shape. A canonical name already present wins; the alias is then dropped.
 */
const ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Read: { file_path: 'path' },
  Write: { file_path: 'path' },
  Edit: { file_path: 'path', old_string: 'old', new_string: 'new', replace_all: 'replaceAll' },
}

function canonicalArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const aliases = ARG_ALIASES[name]
  if (aliases === undefined || !Object.keys(aliases).some((alias) => alias in args)) return args
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    const target = aliases[key]
    if (target === undefined) result[key] = value
    else if (!(target in args)) result[target] = value
  }
  return result
}

/** Normalize a whole tool call (the durable log carries canonical names and argument names). */
export function canonicalCall<T extends { id: string; name: string; args: Record<string, unknown> }>(call: T): T {
  const name = canonicalToolName(call.name)
  const args = canonicalArgs(name, call.args)
  return name === call.name && args === call.args ? call : { ...call, name, args }
}

/** Normalize a permission map keyed by (possibly legacy) tool names. */
export function canonicalPolicy(policy: Readonly<Record<string, string>>): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, mode] of Object.entries(policy)) {
    normalized[canonicalToolName(name)] = mode
  }
  return normalized
}
