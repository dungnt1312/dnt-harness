/**
 * Claude Code tool-input shapes for hooks. Hook scripts written for Claude
 * Code read `tool_input.file_path`, `old_string`, … — dnt-harness tools use
 * shorter argument names. Hooks see (and may return) the Claude shape; the
 * host maps it back before the call re-enters the gates.
 */

type FieldMap = readonly (readonly [native: string, claude: string])[]

const FIELD_MAPS: Readonly<Record<string, FieldMap>> = {
  Read: [['path', 'file_path']],
  Write: [['path', 'file_path']],
  Edit: [['path', 'file_path'], ['old', 'old_string'], ['new', 'new_string'], ['replaceAll', 'replace_all']],
  Bash: [['timeoutMs', 'timeout']],
}

function rename(args: Record<string, unknown>, map: FieldMap, direction: 'toClaude' | 'toNative'): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lookup = new Map(map.map(([native, claude]) => direction === 'toClaude' ? [native, claude] : [claude, native]))
  for (const [key, value] of Object.entries(args)) out[lookup.get(key) ?? key] = value
  return out
}

/** Native tool arguments → the Claude Code `tool_input` object. */
export function toClaudeToolInput(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const map = FIELD_MAPS[tool]
  return map === undefined ? { ...args } : rename(args, map, 'toClaude')
}

/** A hook's `updatedInput` (Claude shape, or already native) → native tool arguments. */
export function fromClaudeToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const map = FIELD_MAPS[tool]
  return map === undefined ? { ...input } : rename(input, map, 'toNative')
}
