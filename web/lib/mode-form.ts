import type { PolicyMode } from './types.ts'

/**
 * The canonical built-in tools a mode may name, mirroring the harness's
 * `KNOWN_MODE_TOOLS`. One duplication, traded against a REST round-trip for a
 * static list; the server still validates every save.
 */
export const KNOWN_MODE_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill', 'Agent',
  'MemorySearch', 'MemoryRead', 'MemoryCreate', 'MemoryUpdate', 'MemoryForget',
]

/** The structured shape the Modes panel edits; serialized to canonical frontmatter. */
export interface ModeForm {
  readonly name: string
  readonly instructions: string
  readonly history: 'none' | 'recent' | 'compact'
  readonly workspaceInstructions: boolean
  readonly skills: 'off' | 'on-demand'
  readonly memoryPinned: boolean
  readonly memoryRetrieval: boolean
  /** Hard ceiling of exposed tools (canonical names). */
  readonly exposure: readonly string[]
  readonly permissions: Readonly<Record<string, PolicyMode>>
}

export const emptyModeForm = (): ModeForm => ({
  name: '',
  instructions: '',
  history: 'recent',
  workspaceInstructions: true,
  skills: 'on-demand',
  memoryPinned: true,
  memoryRetrieval: true,
  exposure: [],
  permissions: {},
})

/** Frontmatter of a mode file, loosely typed; junk falls back to defaults. */
type LooseFrontmatter = {
  name?: unknown
  history?: unknown
  workspaceInstructions?: unknown
  skills?: unknown
  memoryPinned?: unknown
  memoryRetrieval?: unknown
  toolExposure?: unknown
  permissionDefaults?: unknown
}

/**
 * Read a mode file into the form. Deliberately lenient — unknown shapes fall
 * back to the defaults the server also starts from — because the server
 * re-validates the serialized result on save and reports anything invalid.
 */
export function parseModeForm(raw: string): ModeForm {
  const form: { -readonly [K in keyof ModeForm]: ModeForm[K] } = { ...emptyModeForm(), permissions: {} }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const frontmatter = match !== null ? parseFrontmatter(match[1] ?? '') : {}
  form.instructions = (match !== null ? raw.slice(match[0].length) : raw).trim()
  if (typeof frontmatter.name === 'string') form.name = frontmatter.name
  if (frontmatter.history === 'none' || frontmatter.history === 'compact' || frontmatter.history === 'recent') form.history = frontmatter.history
  for (const flag of ['workspaceInstructions', 'memoryPinned', 'memoryRetrieval'] as const) {
    if (frontmatter[flag] === true || frontmatter[flag] === false) form[flag] = frontmatter[flag]
  }
  if (frontmatter.skills === 'off' || frontmatter.skills === 'on-demand') form.skills = frontmatter.skills
  if (Array.isArray(frontmatter.toolExposure)) {
    form.exposure = frontmatter.toolExposure.map((tool) => String(tool)).filter((tool) => KNOWN_MODE_TOOLS.includes(tool))
  }
  if (frontmatter.permissionDefaults !== null && typeof frontmatter.permissionDefaults === 'object' && !Array.isArray(frontmatter.permissionDefaults)) {
    const permissions: Record<string, PolicyMode> = {}
    for (const [key, value] of Object.entries(frontmatter.permissionDefaults as Record<string, unknown>)) {
      if (value === 'allow' || value === 'ask' || value === 'deny') permissions[key] = value
    }
    form.permissions = permissions
  }
  return form
}

function parseFrontmatter(block: string): LooseFrontmatter {
  // The same minimal `key: value` parser the server uses: values may be
  // inline JSON, anything unparsable stays a raw string.
  const result: Record<string, unknown> = {}
  for (const line of block.split('\n')) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const rawValue = match[2]?.trim() ?? ''
    try {
      result[match[1] ?? ''] = JSON.parse(rawValue) as unknown
    } catch {
      result[match[1] ?? ''] = rawValue
    }
  }
  return result as LooseFrontmatter
}

/** Canonical Markdown/frontmatter, byte-compatible with the server's serializer. */
export function serializeModeForm(form: ModeForm): string {
  const fm = [
    `name: ${JSON.stringify(form.name)}`,
    `history: ${form.history}`,
    `workspaceInstructions: ${form.workspaceInstructions}`,
    `skills: ${form.skills}`,
    `memoryPinned: ${form.memoryPinned}`,
    `memoryRetrieval: ${form.memoryRetrieval}`,
    `toolExposure: ${JSON.stringify(form.exposure)}`,
    `permissionDefaults: ${JSON.stringify(form.permissions)}`,
  ]
  return `---\n${fm.join('\n')}\n---\n\n${form.instructions.trim()}\n`
}

/**
 * Only an exact known tool, an `mcp__<server>__<tool>` name, an
 * `mcp__<server>__*` wildcard, or the bare `*` is ever consulted by the gate —
 * the same rule the server enforces, surfaced inline while typing.
 */
export function permissionKeyError(key: string): string | null {
  if (key === '*' || KNOWN_MODE_TOOLS.includes(key)) return null
  const parts = key.split('__')
  const server = parts[1] ?? ''
  const tool = parts[2] ?? ''
  if (parts.length === 3 && parts[0] === 'mcp' && /^[A-Za-z0-9_-]+$/.test(server) && (tool === '*' || (tool !== '' && !tool.includes('*')))) return null
  return `"${key}" would never match. Use a tool name, mcp__server__tool, mcp__server__*, or *.`
}
