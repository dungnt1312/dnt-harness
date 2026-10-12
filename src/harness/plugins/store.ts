/**
 * The host's own Claude Code plugin store, laid out like `~/.claude/plugins/`:
 *
 *   <data>/plugins/known_marketplaces.json
 *   <data>/plugins/installed_plugins.json      { version: 2, plugins: { "p@m": [record…] } }
 *   <data>/plugins/marketplaces/<name>/
 *   <data>/plugins/cache/<m>/<p>/<version>/
 *   <data>/plugins/data/<p>@<m>/               CLAUDE_PLUGIN_DATA
 *
 * Enabling follows Claude's `enabledPlugins` across settings layers, with
 * dnt-harness's workspace layer: `~/.claude/settings.json` (read only) <
 * `<ws>/settings.json` < `<project>/.claude/settings.json` <
 * `<project>/.claude/settings.local.json`; the most specific value wins.
 * dnt-harness never writes `~/.claude`.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { PluginError, assertPluginTreeContained, readManifest, resolveComponents, type ComponentFields, type PluginComponents, type PluginManifest } from './manifest.ts'

export type PluginScope = 'user' | 'workspace' | 'project' | 'local'

/** One install record, Claude's shape plus the scope's owner. */
export interface InstallRecord {
  readonly scope: PluginScope
  readonly installPath: string
  readonly version: string
  readonly installedAt: string
  readonly lastUpdated: string
  readonly gitCommitSha?: string
  /** For workspace scope: which workspace installed it. */
  readonly workspaceId?: string
  /** For project/local scope: the project folder. */
  readonly projectPath?: string
}

export interface InstalledPlugins {
  readonly version: 2
  readonly plugins: Readonly<Record<string, readonly InstallRecord[]>>
}

export interface KnownMarketplace {
  readonly source: MarketplaceSource
  readonly installLocation: string
  readonly lastUpdated: string
}

export type MarketplaceSource =
  | { readonly source: 'github'; readonly repo: string; readonly ref?: string }
  | { readonly source: 'git'; readonly url: string; readonly ref?: string }
  | { readonly source: 'directory'; readonly path: string }

/** One enabled, installed plugin as the loaders consume it. */
export interface LoadedPlugin {
  /** `plugin@marketplace`. */
  readonly id: string
  readonly name: string
  readonly marketplace: string
  readonly root: string
  readonly data: string
  readonly manifest: PluginManifest
  readonly components: PluginComponents
}

/**
 * One store path segment (plugin, marketplace, version): Claude's name
 * characters, never `.`/`..` or anything that could leave its parent folder.
 */
export const STORE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

export function isStoreSegment(value: string): boolean {
  return STORE_SEGMENT.test(value)
}

/** A plugin id `name@marketplace`; both halves must be safe path segments. */
export function parsePluginId(id: string): { readonly name: string; readonly marketplace: string } | undefined {
  const at = id.lastIndexOf('@')
  if (at <= 0 || at === id.length - 1) return undefined
  const name = id.slice(0, at)
  const marketplace = id.slice(at + 1)
  if (!isStoreSegment(name) || !isStoreSegment(marketplace)) return undefined
  return { name, marketplace }
}

/** `child` is strictly inside `parent` (lexically; callers pass store-owned paths). */
export function strictlyInside(parent: string, child: string): boolean {
  const base = path.resolve(parent)
  const target = path.resolve(child)
  return target.startsWith(base + path.sep)
}

export interface SettingsFiles {
  /** `~/.claude/settings.json` (read only). */
  readonly user?: string
  readonly workspace?: string
  readonly project?: string
  readonly local?: string
}

/** Settings file of one writable scope. */
export function scopeSettingsFile(scope: Exclude<PluginScope, 'user'>, dirs: { readonly workspaceDir?: string; readonly projectRoot?: string }): string {
  if (scope === 'workspace') {
    if (dirs.workspaceDir === undefined) throw new PluginError('invalid', 'workspace scope needs a workspace')
    return path.join(dirs.workspaceDir, 'settings.json')
  }
  if (dirs.projectRoot === undefined) throw new PluginError('invalid', `${scope} scope needs a project folder`)
  return path.join(dirs.projectRoot, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json')
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined || text.trim() === '') return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Merged `enabledPlugins` (later layers win) and which layer set each id. */
export async function readEnabledPlugins(files: SettingsFiles): Promise<Map<string, { readonly enabled: boolean; readonly scope: PluginScope }>> {
  const merged = new Map<string, { enabled: boolean; scope: PluginScope }>()
  for (const scope of ['user', 'workspace', 'project', 'local'] as const) {
    const file = files[scope]
    if (file === undefined) continue
    const doc = await readJsonObject(file)
    const section = doc?.['enabledPlugins']
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    for (const [id, value] of Object.entries(section as Record<string, unknown>)) {
      if (typeof value === 'boolean') merged.set(id, { enabled: value, scope })
    }
  }
  return merged
}

/** `extraKnownMarketplaces` suggested by settings files (project settings mostly). */
export async function readSuggestedMarketplaces(files: SettingsFiles): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const scope of ['user', 'workspace', 'project', 'local'] as const) {
    const file = files[scope]
    if (file === undefined) continue
    const section = (await readJsonObject(file))?.['extraKnownMarketplaces']
    if (section !== null && typeof section === 'object' && !Array.isArray(section)) Object.assign(out, section)
  }
  return out
}

/** Set (or remove, with `undefined`) one `enabledPlugins` key, keeping every other key of the file. */
export async function writeEnabledPlugin(file: string, id: string, value: boolean | undefined): Promise<void> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  let doc: Record<string, unknown> = {}
  if (text !== undefined && text.trim() !== '') {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      doc = parsed as Record<string, unknown>
    } catch (error) {
      throw new PluginError('invalid', `${file} is not a valid settings object: ${String(error instanceof Error ? error.message : error)}`)
    }
  }
  const current = doc['enabledPlugins']
  const section: Record<string, unknown> = current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  if (value === undefined) delete section[id]
  else section[id] = value
  if (Object.keys(section).length === 0) delete doc['enabledPlugins']
  else doc['enabledPlugins'] = section
  await fs.mkdir(path.dirname(file), { recursive: true })
  await replaceFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`)
}

export class PluginStore {
  readonly root: string
  private readonly componentCache = new Map<string, { readonly stamp: string; readonly loaded: LoadedPlugin }>()

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'plugins')
  }

  get marketplacesDir(): string { return path.join(this.root, 'marketplaces') }
  get cacheDir(): string { return path.join(this.root, 'cache') }

  dataDirOf(id: string): string {
    return path.join(this.root, 'data', id.replace(/[^A-Za-z0-9._@-]/g, '_'))
  }

  private get installedFile(): string { return path.join(this.root, 'installed_plugins.json') }
  private get marketplacesFile(): string { return path.join(this.root, 'known_marketplaces.json') }

  async installed(): Promise<InstalledPlugins> {
    const doc = await readJsonObject(this.installedFile)
    const plugins = doc?.['plugins']
    if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) return { version: 2, plugins: {} }
    const out: Record<string, InstallRecord[]> = {}
    for (const [id, records] of Object.entries(plugins as Record<string, unknown>)) {
      if (!Array.isArray(records)) continue
      out[id] = records.filter((record): record is InstallRecord =>
        record !== null && typeof record === 'object' && typeof (record as InstallRecord).installPath === 'string' && typeof (record as InstallRecord).scope === 'string')
    }
    return { version: 2, plugins: out }
  }

  async saveInstalled(next: InstalledPlugins): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    await replaceFileAtomic(this.installedFile, `${JSON.stringify(next, null, 2)}\n`)
  }

  async marketplaces(): Promise<Record<string, KnownMarketplace>> {
    const doc = await readJsonObject(this.marketplacesFile)
    if (doc === undefined) return {}
    const out: Record<string, KnownMarketplace> = {}
    for (const [name, value] of Object.entries(doc)) {
      if (value !== null && typeof value === 'object' && typeof (value as KnownMarketplace).installLocation === 'string') out[name] = value as KnownMarketplace
    }
    return out
  }

  async saveMarketplaces(next: Record<string, KnownMarketplace>): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    await replaceFileAtomic(this.marketplacesFile, `${JSON.stringify(next, null, 2)}\n`)
  }

  /**
   * The install record that applies to a workspace/project: one installed at
   * the matching project, then the workspace, then the user scope. Records of
   * other workspaces or projects never apply.
   */
  static applicableRecord(records: readonly InstallRecord[], context: { readonly workspaceId: string; readonly projectPath?: string }): InstallRecord | undefined {
    const match = (scope: PluginScope): InstallRecord | undefined => records.find((record) => {
      if (record.scope !== scope) return false
      if (scope === 'workspace') return record.workspaceId === context.workspaceId
      if (scope === 'project' || scope === 'local') return context.projectPath !== undefined && record.projectPath !== undefined && path.resolve(record.projectPath) === path.resolve(context.projectPath)
      return true
    })
    return match('local') ?? match('project') ?? match('workspace') ?? match('user')
  }

  /**
   * Every plugin that runs for this workspace/project: enabled by the merged
   * settings AND installed with an applicable record. Broken plugins are
   * skipped and reported in `errors`, never failing the caller.
   */
  async enabledPlugins(context: { readonly workspaceId: string; readonly projectPath?: string; readonly settings: SettingsFiles; readonly entries?: (id: string) => Promise<ComponentFields | undefined> }): Promise<{ readonly plugins: readonly LoadedPlugin[]; readonly errors: readonly { readonly id: string; readonly message: string }[] }> {
    const [enabled, installed] = await Promise.all([readEnabledPlugins(context.settings), this.installed()])
    const plugins: LoadedPlugin[] = []
    const errors: { id: string; message: string }[] = []
    for (const [id, state] of enabled) {
      if (!state.enabled) continue
      const parsed = parsePluginId(id)
      const record = PluginStore.applicableRecord(installed.plugins[id] ?? [], context)
      if (parsed === undefined || record === undefined) continue
      try {
        plugins.push(await this.load(id, parsed, record, context.entries))
      } catch (error) {
        errors.push({ id, message: String(error instanceof Error ? error.message : error) })
      }
    }
    return { plugins: plugins.sort((a, b) => a.id.localeCompare(b.id)), errors }
  }

  /** One installed plugin's manifest and components, cached by its manifest stamp. */
  async load(id: string, parsed: { readonly name: string; readonly marketplace: string }, record: InstallRecord, entries?: (id: string) => Promise<ComponentFields | undefined>): Promise<LoadedPlugin> {
    const root = record.installPath
    // Every file that shapes the components is part of the cache identity, so
    // an edit to hooks.json, .mcp.json or a component folder is picked up.
    const extraFields = await entries?.(id)
    const stamp = `${root}:${record.lastUpdated}:${JSON.stringify(extraFields ?? null)}:${await componentStamp(root)}`
    const cached = this.componentCache.get(id)
    if (cached !== undefined && cached.stamp === stamp) return cached.loaded
    if ((await fs.stat(root).catch(() => undefined))?.isDirectory() !== true) throw new PluginError('not-found', `plugin files are missing at ${root}; reinstall it`)
    await assertPluginTreeContained(root)
    const extra = extraFields
    // plugin.json is optional in Claude: without one the plugin is named by
    // its id and its components come from the default folders.
    const manifest = await readManifest(root, { ...(extra as Record<string, unknown> | undefined), name: parsed.name })
    const components = await resolveComponents(root, manifest, extra ?? {})
    // CLAUDE_PLUGIN_DATA must exist before hooks/MCP of the plugin run.
    const data = this.dataDirOf(id)
    await fs.mkdir(data, { recursive: true })
    const loaded: LoadedPlugin = {
      id,
      name: manifest.name,
      marketplace: parsed.marketplace,
      root,
      data,
      manifest,
      components,
    }
    this.componentCache.set(id, { stamp, loaded })
    return loaded
  }

  invalidate(): void {
    this.componentCache.clear()
  }
}

/**
 * Cheap change stamp of a plugin's component sources: (mtime, size) of the
 * manifest, hooks.json, .mcp.json and each top-level component folder's
 * entries. Changes inside nested skill folders also bump the folder mtime of
 * their direct parent, which is scanned here.
 */
async function componentStamp(root: string): Promise<string> {
  const parts: string[] = []
  const stamp = async (rel: string): Promise<void> => {
    const stat = await fs.stat(path.join(root, rel)).catch(() => undefined)
    parts.push(`${rel}:${stat === undefined ? '-' : `${stat.mtimeMs}:${stat.size}`}`)
  }
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json', '.mcp.json', 'SKILL.md']) await stamp(rel)
  for (const dir of ['commands', 'agents', 'skills', 'hooks']) {
    await stamp(dir)
    const names = await fs.readdir(path.join(root, dir)).catch(() => [] as string[])
    for (const name of names.sort()) await stamp(`${dir}/${name}`)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** Short stable digest (hook ids, MCP names). */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}
