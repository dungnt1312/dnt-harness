/**
 * Claude Code plugin format: `<root>/.claude-plugin/plugin.json` plus the
 * default component folders (`commands/`, `agents/`, `skills/`,
 * `hooks/hooks.json`, `.mcp.json`). Manifest path fields supplement the
 * defaults (`commands`, `agents`, `skills`: string or list) or replace them
 * (`hooks`, `mcpServers`: a path or an inline object), as Claude Code reads
 * them. Fields dnt-harness does not run (`lspServers`, `outputStyles`,
 * `userConfig`, …) are kept and reported.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Claude's plugin name rule (kebab-case, starts with a letter or digit). */
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/i

export class PluginError extends Error {
  constructor(readonly code: 'not-found' | 'invalid' | 'conflict' | 'unsupported' | 'failed', message: string) {
    super(message)
    this.name = 'PluginError'
  }
}

export interface PluginManifest {
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly author?: string
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
  /** The raw manifest (every key, for display and for fields read later). */
  readonly raw: Readonly<Record<string, unknown>>
}

/** Component fields a manifest or a marketplace entry may carry. */
export interface ComponentFields {
  readonly commands?: unknown
  readonly agents?: unknown
  readonly skills?: unknown
  readonly hooks?: unknown
  readonly mcpServers?: unknown
}

/** Everything one plugin contributes, with absolute paths. */
export interface PluginComponents {
  readonly commandDirs: readonly string[]
  readonly commandFiles: readonly string[]
  readonly agentDirs: readonly string[]
  readonly agentFiles: readonly string[]
  /** Folders whose sub-folders are skills (`skills/`), and single skill folders. */
  readonly skillDirs: readonly string[]
  readonly skillFolders: readonly string[]
  /** The raw `hooks` section (from hooks.json or inline). */
  readonly hooks?: unknown
  /** Raw MCP server map (from `.mcp.json` or inline), `mcpServers` wrapper removed. */
  readonly mcpServers?: Readonly<Record<string, unknown>>
  /** Keys dnt-harness reads but does not run, plus load problems. */
  readonly notes: readonly string[]
}

const NOT_RUN = ['lspServers', 'outputStyles', 'themes', 'userConfig', 'workflows', 'channels', 'monitors', 'settings', 'experimental']

function authorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') return (value as { name: string }).name
  return undefined
}

function stringOrUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') return (value as { url: string }).url
  return undefined
}

/** Validate a manifest document. `fallbackName` stands in when a `strict: false` entry has no plugin.json. */
export function parseManifest(raw: unknown, fallbackName?: string): PluginManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new PluginError('invalid', 'plugin.json must be a JSON object')
  const doc = raw as Record<string, unknown>
  const name = typeof doc['name'] === 'string' && doc['name'].trim() !== '' ? doc['name'].trim() : fallbackName
  if (name === undefined) throw new PluginError('invalid', "plugin.json needs a 'name'")
  if (!PLUGIN_NAME.test(name)) throw new PluginError('invalid', `plugin name '${name}' must be kebab-case`)
  const author = authorText(doc['author'])
  const repository = stringOrUrl(doc['repository'])
  return {
    name,
    ...(typeof doc['version'] === 'string' ? { version: doc['version'] } : {}),
    ...(typeof doc['description'] === 'string' ? { description: doc['description'] } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(typeof doc['homepage'] === 'string' ? { homepage: doc['homepage'] } : {}),
    ...(repository !== undefined ? { repository } : {}),
    ...(typeof doc['license'] === 'string' ? { license: doc['license'] } : {}),
    ...(Array.isArray(doc['keywords']) ? { keywords: doc['keywords'].filter((item): item is string => typeof item === 'string') } : {}),
    raw: doc,
  }
}

/**
 * Refuse a plugin tree containing a symlink whose resolved target leaves the
 * plugin root. Internal symlinks are allowed; broken links are refused. This
 * one validation protects nested command/skill/agent resources as well as
 * plugin.json itself — individual loaders may follow symlinks by design.
 */
export async function assertPluginTreeContained(root: string): Promise<void> {
  const realRoot = await fs.realpath(root).catch(() => undefined)
  if (realRoot === undefined) throw new PluginError('invalid', `plugin root '${root}' is missing`)
  const visited = new Set<string>()
  const walk = async (current: string): Promise<void> => {
    const realCurrent = await fs.realpath(current).catch(() => undefined)
    if (realCurrent === undefined || !(realCurrent === realRoot || realCurrent.startsWith(realRoot + path.sep))) {
      throw new PluginError('invalid', `plugin symlink '${path.relative(root, current)}' escapes the plugin root`)
    }
    if (visited.has(realCurrent)) return
    visited.add(realCurrent)
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error: unknown) => {
      throw new PluginError('invalid', `cannot scan plugin '${root}': ${String(error instanceof Error ? error.message : error)}`)
    })
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(child).catch(() => undefined)
        if (target === undefined || !(target === realRoot || target.startsWith(realRoot + path.sep))) {
          throw new PluginError('invalid', `plugin symlink '${path.relative(root, child)}' escapes the plugin root`)
        }
        const stat = await fs.stat(child).catch(() => undefined)
        if (stat?.isDirectory() === true) await walk(child)
      } else if (entry.isDirectory()) {
        await walk(child)
      }
    }
  }
  await walk(root)
}

/** The plugin's manifest; with no plugin.json, a marketplace-entry stand-in. */
export async function readManifest(root: string, fallback?: Readonly<Record<string, unknown>>): Promise<PluginManifest> {
  const file = path.join(root, '.claude-plugin', 'plugin.json')
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) {
    if (fallback !== undefined) return parseManifest(fallback, typeof fallback['name'] === 'string' ? fallback['name'] : undefined)
    throw new PluginError('invalid', `${file} is missing`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PluginError('invalid', `${file} is not valid JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  return parseManifest(parsed)
}

/**
 * A manifest path, resolved inside the plugin root. Claude requires `./`
 * paths; an absolute path or one escaping the root is refused (a plugin must
 * not point the host at files outside itself).
 */
export function resolveInside(root: string, rel: string): string | undefined {
  if (typeof rel !== 'string' || rel.trim() === '' || path.isAbsolute(rel)) return undefined
  const resolved = path.resolve(root, rel)
  const base = path.resolve(root)
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : undefined
}

/**
 * Existing component/source path contained after symlink resolution. Lexical
 * containment alone lets `commands -> /outside` or a marketplace's
 * `source -> /outside` smuggle host files into a trusted plugin install.
 */
export async function resolveExistingInside(root: string, rel: string): Promise<string | undefined> {
  const lexical = resolveInside(root, rel)
  if (lexical === undefined) return undefined
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(root).catch(() => undefined),
    fs.realpath(lexical).catch(() => undefined),
  ])
  if (realRoot === undefined || realTarget === undefined) return undefined
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep) ? realTarget : undefined
}

const isDir = async (target: string): Promise<boolean> => (await fs.stat(target).catch(() => undefined))?.isDirectory() === true
const isFile = async (target: string): Promise<boolean> => (await fs.stat(target).catch(() => undefined))?.isFile() === true

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
}

function list(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

/** `{ mcpServers: {…} }` or the bare server map, as Claude accepts both. */
export function serverMap(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const doc = value as Record<string, unknown>
  const inner = doc['mcpServers']
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>
  return doc
}

/**
 * One convention-or-declared JSON component (`hooks/hooks.json`,
 * `.mcp.json`) located inside the plugin. `absent` is the normal case — most
 * plugins have neither; `escape` is the security-relevant symlink case; the
 * declared variants distinguish an author typo from plain absence.
 */
type JsonComponent =
  | { readonly kind: 'absent' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'not-file' }
  | { readonly kind: 'file'; readonly file: string }

async function resolveJsonComponent(root: string, rel: string): Promise<JsonComponent> {
  const lexical = resolveInside(root, rel)
  if (lexical === undefined) return { kind: 'escape' }
  if (!(await isFile(lexical))) {
    const stat = await fs.stat(lexical).catch(() => undefined)
    return stat === undefined ? { kind: 'absent' } : { kind: 'not-file' }
  }
  const file = await resolveExistingInside(root, rel)
  return file === undefined ? { kind: 'escape' } : { kind: 'file', file }
}

/**
 * Resolve every component of the plugin at `root`. `extra` carries a
 * marketplace entry's component fields, which supplement the manifest's.
 */
export async function resolveComponents(root: string, manifest: PluginManifest, extra: ComponentFields = {}): Promise<PluginComponents> {
  const notes: string[] = []
  const notRun = NOT_RUN.filter((key) => manifest.raw[key] !== undefined)
  if (notRun.length > 0) notes.push(`not supported by dnt-harness: ${notRun.join(', ')}`)

  const paths = async (key: 'commands' | 'agents' | 'skills', defaultDir: string): Promise<{ dirs: string[]; files: string[] }> => {
    const dirs: string[] = []
    const files: string[] = []
    const defaultPath = await resolveExistingInside(root, defaultDir)
    if (defaultPath !== undefined && await isDir(defaultPath)) dirs.push(defaultPath)
    for (const rel of [...list(manifest.raw[key]), ...list((extra as Record<string, unknown>)[key])]) {
      const resolved = await resolveExistingInside(root, rel)
      if (resolved === undefined) { notes.push(`${key}: '${rel}' is missing or outside the plugin after symlink resolution; ignored`); continue }
      if (dirs.includes(resolved) || files.includes(resolved)) continue
      if (await isDir(resolved)) dirs.push(resolved)
      else if (await isFile(resolved)) files.push(resolved)
      else notes.push(`${key}: '${rel}' does not exist`)
    }
    return { dirs, files }
  }

  const commands = await paths('commands', 'commands')
  const agents = await paths('agents', 'agents')
  const skillPaths = await paths('skills', 'skills')
  // A listed path that is itself a skill (holds SKILL.md) is one skill;
  // anything else is a folder of skills.
  const skillDirs: string[] = []
  const skillFolders: string[] = []
  for (const dir of skillPaths.dirs) {
    if (await isFile(path.join(dir, 'SKILL.md'))) skillFolders.push(dir)
    else skillDirs.push(dir)
  }
  // A plugin with no skills folder at all whose root holds SKILL.md is a
  // single-skill plugin (Claude does the same).
  if (skillDirs.length === 0 && skillFolders.length === 0 && manifest.raw['skills'] === undefined && await isFile(path.join(root, 'SKILL.md'))) {
    skillFolders.push(root)
  }

  let hooks: unknown
  const hooksField = (extra.hooks ?? manifest.raw['hooks'])
  if (hooksField !== undefined && typeof hooksField === 'object' && hooksField !== null) {
    hooks = (hooksField as Record<string, unknown>)['hooks'] ?? hooksField
  } else {
    const rel = typeof hooksField === 'string' ? hooksField : './hooks/hooks.json'
    const component = await resolveJsonComponent(root, rel)
    if (component.kind === 'file') {
      try {
        const doc = await readJson(component.file) as Record<string, unknown>
        hooks = doc !== null && typeof doc === 'object' ? doc['hooks'] ?? doc : undefined
      } catch (error) {
        notes.push(`hooks: ${path.relative(root, component.file)} is not valid JSON (${String(error instanceof Error ? error.message : error)})`)
      }
    } else if (component.kind === 'escape' || typeof hooksField === 'string') {
      notes.push(`hooks: '${rel}' ${component.kind === 'escape' ? 'is missing or outside the plugin after symlink resolution; ignored' : 'does not exist'}`)
    }
  }

  let mcpServers: Record<string, unknown> | undefined
  const mcpField = extra.mcpServers ?? manifest.raw['mcpServers']
  if (mcpField !== undefined && typeof mcpField === 'object' && mcpField !== null) {
    mcpServers = serverMap(mcpField)
  } else {
    const rel = typeof mcpField === 'string' ? mcpField : './.mcp.json'
    const component = await resolveJsonComponent(root, rel)
    if (component.kind === 'file') {
      try {
        mcpServers = serverMap(await readJson(component.file))
      } catch (error) {
        notes.push(`mcpServers: ${path.relative(root, component.file)} is not valid JSON (${String(error instanceof Error ? error.message : error)})`)
      }
    } else if (component.kind === 'escape' || typeof mcpField === 'string') {
      notes.push(`mcpServers: '${rel}' ${component.kind === 'escape' ? 'is missing or outside the plugin after symlink resolution; ignored' : 'does not exist'}`)
    }
  }

  return {
    commandDirs: commands.dirs,
    commandFiles: commands.files,
    agentDirs: agents.dirs,
    agentFiles: agents.files,
    skillDirs,
    skillFolders,
    ...(hooks !== undefined ? { hooks } : {}),
    ...(mcpServers !== undefined && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    notes,
  }
}

/** `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` in a string (hook commands, MCP fields). */
export function substitutePluginVars(value: string, vars: { readonly root: string; readonly data: string }): string {
  return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => vars.root).replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => vars.data)
}

/** Deep substitution over a JSON value (objects, arrays, strings). */
export function substituteDeep(value: unknown, vars: { readonly root: string; readonly data: string }): unknown {
  if (typeof value === 'string') return substitutePluginVars(value, vars)
  if (Array.isArray(value)) return value.map((item) => substituteDeep(item, vars))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, substituteDeep(item, vars)]))
  }
  return value
}
