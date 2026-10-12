/**
 * Claude Code plugins for one host: install/enable/disable/uninstall across
 * the four settings scopes, and the per-workspace/project view every loader
 * consumes (commands, skills, agents, hooks, MCP).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CommandLayer } from '../commands/catalog.ts'
import type { PluginAgentLayer } from '../agents/definition-service.ts'
import type { SkillLayer } from '../skills/layers.ts'
import { describePlugin, type PluginDetails } from './details.ts'
import { PluginError, readManifest, resolveComponents } from './manifest.ts'
import { addMarketplace, assertGitUrl, fetchPlugin, findEntry, inspectPlugin, parseMarketplaceInput, readMarketplace, sourceKind, removeMarketplace, updateMarketplace, type MarketplaceDeps, type MarketplaceDocument } from './marketplace.ts'
import { pluginServers, type PluginServerDraft } from './mcp.ts'
import {
  PluginStore, parsePluginId, readEnabledPlugins, readSuggestedMarketplaces, scopeSettingsFile, strictlyInside, writeEnabledPlugin,
  type InstallRecord, type LoadedPlugin, type MarketplaceSource, type PluginScope, type SettingsFiles,
} from './store.ts'

export interface PluginContext {
  readonly workspaceId: string
  readonly projectId?: string
}

export interface PluginServiceDeps {
  readonly dataDir: string
  /** `~/.claude`; its settings.json is read (never written). */
  readonly userClaudeDir?: string
  readonly homeDir: string
  readonly projectRootOf: (workspaceId: string, projectId: string) => string | undefined
  /** Test seam for git. */
  readonly clone?: MarketplaceDeps['clone']
}

/** One row of Settings → Plugins. */
export interface PluginRow {
  readonly id: string
  readonly name: string
  readonly marketplace: string
  readonly description?: string
  readonly version?: string
  readonly installed: boolean
  /** Scopes holding an install record that applies here. */
  readonly installedScopes: readonly PluginScope[]
  /** The merged `enabledPlugins` value and the layer that decided it. */
  readonly enabled?: { readonly value: boolean; readonly scope: PluginScope }
  readonly active: boolean
  readonly components?: { readonly commands: number; readonly skills: number; readonly agents: number; readonly hooks: boolean; readonly mcpServers: readonly string[] }
  readonly notes?: readonly string[]
  readonly error?: string
}

export class PluginService {
  readonly store: PluginStore
  private readonly marketplaceDeps: MarketplaceDeps
  /** Serializes installs and settings writes (one store per host). */
  private tail: Promise<unknown> = Promise.resolve()
  /** Described-not-installed plugins, keyed by id and marketplace revision. */
  private readonly inspected = new Map<string, Promise<PluginDetails>>()

  constructor(private readonly deps: PluginServiceDeps) {
    this.store = new PluginStore(deps.dataDir)
    this.marketplaceDeps = { store: this.store, homeDir: deps.homeDir, ...(deps.clone !== undefined ? { clone: deps.clone } : {}) }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => undefined)
    return next
  }

  private projectRoot(context: PluginContext): string | undefined {
    return context.projectId !== undefined ? this.deps.projectRootOf(context.workspaceId, context.projectId) : undefined
  }

  workspaceDir(workspaceId: string): string {
    return path.join(this.deps.dataDir, 'workspaces', workspaceId)
  }

  settingsFiles(context: PluginContext): SettingsFiles {
    const projectRoot = this.projectRoot(context)
    return {
      ...(this.deps.userClaudeDir !== undefined ? { user: path.join(this.deps.userClaudeDir, 'settings.json') } : {}),
      workspace: path.join(this.workspaceDir(context.workspaceId), 'settings.json'),
      ...(projectRoot !== undefined
        ? { project: path.join(projectRoot, '.claude', 'settings.json'), local: path.join(projectRoot, '.claude', 'settings.local.json') }
        : {}),
    }
  }

  /** The plugins that run here (enabled + installed), every component resolved. */
  async active(context: PluginContext): Promise<{ readonly plugins: readonly LoadedPlugin[]; readonly errors: readonly { id: string; message: string }[] }> {
    const projectPath = this.projectRoot(context)
    return this.store.enabledPlugins({
      workspaceId: context.workspaceId,
      ...(projectPath !== undefined ? { projectPath } : {}),
      settings: this.settingsFiles(context),
      entries: async (id) => {
        const parsed = parsePluginId(id)
        if (parsed === undefined) return undefined
        return (await findEntry(this.marketplaceDeps, parsed.marketplace, parsed.name).catch(() => undefined))?.entry
      },
    })
  }

  async commandLayers(context: PluginContext): Promise<CommandLayer[]> {
    const { plugins } = await this.active(context)
    const layers: CommandLayer[] = []
    for (const plugin of plugins) {
      const info = { id: plugin.id, name: plugin.name, root: plugin.root, data: plugin.data }
      for (const dir of plugin.components.commandDirs) layers.push({ source: 'plugin', dir, prefix: plugin.name, plugin: info })
      for (const file of plugin.components.commandFiles) layers.push({ source: 'plugin', dir: file, file: true, prefix: plugin.name, plugin: info })
    }
    return layers
  }

  async skillLayers(context: PluginContext): Promise<SkillLayer[]> {
    const { plugins } = await this.active(context)
    const layers: SkillLayer[] = []
    for (const plugin of plugins) {
      const info = { id: plugin.id, name: plugin.name, root: plugin.root, data: plugin.data }
      for (const dir of plugin.components.skillDirs) layers.push({ base: dir, source: 'plugin', prefix: plugin.name, plugin: info })
      for (const folder of plugin.components.skillFolders) layers.push({ base: folder, source: 'plugin', prefix: plugin.name, single: true, plugin: info })
    }
    return layers
  }

  async agentLayers(context: PluginContext): Promise<PluginAgentLayer[]> {
    const { plugins } = await this.active(context)
    return plugins.map((plugin) => ({ prefix: plugin.name, dirs: plugin.components.agentDirs, files: plugin.components.agentFiles }))
  }

  async hookSources(context: PluginContext): Promise<{ id: string; root: string; data: string; hooks: unknown; label: string }[]> {
    const { plugins } = await this.active(context)
    return plugins
      .filter((plugin) => plugin.components.hooks !== undefined)
      .map((plugin) => ({ id: plugin.id, root: plugin.root, data: plugin.data, hooks: plugin.components.hooks, label: `plugin ${plugin.id}` }))
  }

  /**
   * MCP servers every plugin enabled ANYWHERE in this workspace contributes
   * (MCP is workspace-scoped here: the workspace scope, the user scope, and
   * each of the workspace's projects count).
   */
  async workspaceServers(workspaceId: string, projectIds: readonly string[]): Promise<{ readonly drafts: readonly PluginServerDraft[]; readonly notes: readonly string[] }> {
    const contexts: PluginContext[] = [{ workspaceId }, ...projectIds.map((projectId) => ({ workspaceId, projectId }))]
    const seen = new Set<string>()
    const drafts: PluginServerDraft[] = []
    const notes: string[] = []
    for (const context of contexts) {
      const { plugins } = await this.active(context)
      for (const plugin of plugins) {
        if (seen.has(plugin.id) || plugin.components.mcpServers === undefined) continue
        seen.add(plugin.id)
        const converted = pluginServers({ id: plugin.id, name: plugin.name, root: plugin.root, data: plugin.data }, plugin.components.mcpServers)
        drafts.push(...converted.drafts)
        notes.push(...converted.notes.map((note) => `${plugin.id}: ${note}`))
      }
    }
    return { drafts, notes }
  }

  // ── marketplaces ─────────────────────────────────────────────────────────

  async listMarketplaces(): Promise<{ name: string; source: MarketplaceSource; lastUpdated: string; document?: MarketplaceDocument; error?: string }[]> {
    const known = await this.store.marketplaces()
    return Promise.all(Object.entries(known).map(async ([name, entry]) => {
      try {
        return { name, source: entry.source, lastUpdated: entry.lastUpdated, document: await readMarketplace(entry.installLocation) }
      } catch (error) {
        return { name, source: entry.source, lastUpdated: entry.lastUpdated, error: String(error instanceof Error ? error.message : error) }
      }
    }))
  }

  addMarketplace(source: MarketplaceSource): Promise<{ name: string; document: MarketplaceDocument }> {
    return this.serialize(() => addMarketplace(this.marketplaceDeps, source))
  }

  updateMarketplace(name: string): Promise<MarketplaceDocument> {
    return this.serialize(async () => {
      const document = await updateMarketplace(this.marketplaceDeps, name)
      this.store.invalidate()
      return document
    })
  }

  removeMarketplace(name: string): Promise<void> {
    return this.serialize(() => removeMarketplace(this.marketplaceDeps, name))
  }

  // ── install / enable ─────────────────────────────────────────────────────

  private scopeFile(scope: PluginScope, context: PluginContext): string {
    if (scope === 'user') throw new PluginError('invalid', 'dnt-harness does not write ~/.claude; install at workspace, project or local scope')
    const projectRoot = this.projectRoot(context)
    return scopeSettingsFile(scope, { workspaceDir: this.workspaceDir(context.workspaceId), ...(projectRoot !== undefined ? { projectRoot } : {}) })
  }

  private ownerOf(scope: PluginScope, context: PluginContext): Pick<InstallRecord, 'workspaceId' | 'projectPath'> {
    if (scope === 'workspace') return { workspaceId: context.workspaceId }
    if (scope === 'project' || scope === 'local') {
      const projectPath = this.projectRoot(context)
      if (projectPath === undefined) throw new PluginError('invalid', `${scope} scope needs a project`)
      return { projectPath }
    }
    return {}
  }

  /**
   * Where an unknown marketplace can be fetched from, as Claude Code resolves
   * it: settings `extraKnownMarketplaces`, then the user's own Claude Code
   * `~/.claude/plugins/known_marketplaces.json` (read only), then the
   * built-in official marketplace.
   */
  private async knownSource(name: string, context: PluginContext): Promise<MarketplaceSource | undefined> {
    const suggested = (await readSuggestedMarketplaces(this.settingsFiles(context)))[name]
    const fromSettings = toMarketplaceSource(isRecord(suggested) ? suggested['source'] : undefined)
    if (fromSettings !== undefined) return fromSettings
    if (this.deps.userClaudeDir !== undefined) {
      const text = await fs.readFile(path.join(this.deps.userClaudeDir, 'plugins', 'known_marketplaces.json'), 'utf8').catch(() => undefined)
      let known: unknown
      try { known = text !== undefined ? JSON.parse(text) : undefined } catch { known = undefined }
      const entry = isRecord(known) ? known[name] : undefined
      const fromClaude = toMarketplaceSource(isRecord(entry) ? entry['source'] : undefined)
      if (fromClaude !== undefined) return fromClaude
    }
    return name === OFFICIAL_MARKETPLACE.name ? OFFICIAL_MARKETPLACE.source : undefined
  }

  /**
   * What a plugin contains. An installed plugin is read from its cache
   * folder; otherwise the marketplace entry's files are staged (git sources
   * cloned into a temporary folder) and described without installing. Results
   * of staged reads are memoized per marketplace revision.
   */
  async details(id: string, context: PluginContext): Promise<PluginDetails> {
    const parsed = parsePluginId(id)
    if (parsed === undefined) throw new PluginError('invalid', `'${id}' is not plugin@marketplace`)
    const known = (await this.store.marketplaces())[parsed.marketplace]
    const found = await findEntry(this.marketplaceDeps, parsed.marketplace, parsed.name).catch(() => undefined)
    const entry = found?.entry
    const source = { kind: entry !== undefined ? sourceKind(entry.source) : 'installed', location: entry !== undefined ? sourceLocation(entry.source) : '' }
    const extra = {
      ...(entry?.category !== undefined ? { category: entry.category } : {}),
      ...(entry?.description !== undefined ? { fallbackDescription: entry.description } : {}),
      ...(entry?.version !== undefined ? { fallbackVersion: entry.version } : {}),
    }
    const projectPath = this.projectRoot(context)
    const records = (await this.store.installed()).plugins[id] ?? []
    const record = PluginStore.applicableRecord(records, { workspaceId: context.workspaceId, ...(projectPath !== undefined ? { projectPath } : {}) }) ?? records[0]
    if (record !== undefined && (await fs.stat(record.installPath).catch(() => undefined))?.isDirectory() === true) {
      const loaded = await this.store.load(id, parsed, record, async () => entry)
      return describePlugin({ id, marketplace: parsed.marketplace, manifest: loaded.manifest, components: loaded.components, source, ...extra })
    }
    if (found === undefined || entry === undefined) throw new PluginError('not-found', `no plugin '${parsed.name}' in marketplace '${parsed.marketplace}'`)
    const key = `${id}\u0000${known?.lastUpdated ?? ''}`
    let pending = this.inspected.get(key)
    if (pending === undefined) {
      pending = inspectPlugin(this.marketplaceDeps, parsed.marketplace, entry, found.location, async (dir) => {
        const manifest = await readManifest(dir, { ...entry.raw, name: entry.name })
        const components = await resolveComponents(dir, manifest, entry)
        return describePlugin({ id, marketplace: parsed.marketplace, manifest, components, source, ...extra })
      })
      this.inspected.set(key, pending)
      // A failure (network, unsupported source) is not cached.
      pending.catch(() => { this.inspected.delete(key) })
      if (this.inspected.size > 200) this.inspected.delete(this.inspected.keys().next().value as string)
    }
    return pending
  }

  /** Fetch into the cache, record it for the scope, and enable it there (Claude's `/plugin install`). */
  install(id: string, scope: PluginScope, context: PluginContext): Promise<InstallRecord> {
    return this.serialize(async () => {
      const parsed = parsePluginId(id)
      if (parsed === undefined) throw new PluginError('invalid', `'${id}' is not plugin@marketplace`)
      const settingsFile = this.scopeFile(scope, context)
      if ((await this.store.marketplaces())[parsed.marketplace] === undefined) {
        const source = await this.knownSource(parsed.marketplace, context)
        if (source === undefined) throw new PluginError('not-found', `marketplace '${parsed.marketplace}' is not added; add it in Settings → Plugins first`)
        const added = await addMarketplace(this.marketplaceDeps, source)
        if (added.name !== parsed.marketplace) throw new PluginError('invalid', `marketplace source for '${parsed.marketplace}' declares the name '${added.name}'`)
      }
      const found = await findEntry(this.marketplaceDeps, parsed.marketplace, parsed.name)
      if (found === undefined) throw new PluginError('not-found', `no plugin '${parsed.name}' in marketplace '${parsed.marketplace}'`)
      const fetched = await fetchPlugin(this.marketplaceDeps, parsed.marketplace, found.entry, found.location)
      const now = new Date().toISOString()
      const owner = this.ownerOf(scope, context)
      const record: InstallRecord = { scope, installPath: fetched.installPath, version: fetched.version, installedAt: now, lastUpdated: now, ...(fetched.gitCommitSha !== undefined ? { gitCommitSha: fetched.gitCommitSha } : {}), ...owner }
      const installed = await this.store.installed()
      const others = (installed.plugins[id] ?? []).filter((existing) => !sameOwner(existing, record))
      await this.store.saveInstalled({ version: 2, plugins: { ...installed.plugins, [id]: [...others, record] } })
      await writeEnabledPlugin(settingsFile, id, true)
      this.store.invalidate()
      return record
    })
  }

  /** Re-fetch every install record of a plugin at its marketplace's current version. */
  update(id: string): Promise<readonly InstallRecord[]> {
    return this.serialize(async () => {
      const parsed = parsePluginId(id)
      if (parsed === undefined) throw new PluginError('invalid', `'${id}' is not plugin@marketplace`)
      const installed = await this.store.installed()
      const records = installed.plugins[id] ?? []
      if (records.length === 0) throw new PluginError('not-found', `'${id}' is not installed`)
      const found = await findEntry(this.marketplaceDeps, parsed.marketplace, parsed.name)
      if (found === undefined) throw new PluginError('not-found', `no plugin '${parsed.name}' in marketplace '${parsed.marketplace}'`)
      const fetched = await fetchPlugin(this.marketplaceDeps, parsed.marketplace, found.entry, found.location)
      const now = new Date().toISOString()
      const next = records.map((record) => ({ ...record, installPath: fetched.installPath, version: fetched.version, lastUpdated: now, ...(fetched.gitCommitSha !== undefined ? { gitCommitSha: fetched.gitCommitSha } : {}) }))
      await this.store.saveInstalled({ version: 2, plugins: { ...installed.plugins, [id]: next } })
      await this.pruneCache(id, next)
      this.store.invalidate()
      return next
    })
  }

  /** Write `enabledPlugins[id] = value` at one scope (Claude's enable/disable). */
  setEnabled(id: string, scope: PluginScope, context: PluginContext, value: boolean): Promise<void> {
    return this.serialize(async () => {
      if (parsePluginId(id) === undefined) throw new PluginError('invalid', `'${id}' is not plugin@marketplace`)
      await writeEnabledPlugin(this.scopeFile(scope, context), id, value)
      this.store.invalidate()
    })
  }

  /** Remove the scope's install record and its `enabledPlugins` key; the cache goes with the last record. */
  uninstall(id: string, scope: PluginScope, context: PluginContext): Promise<void> {
    return this.serialize(async () => {
      if (parsePluginId(id) === undefined) throw new PluginError('invalid', `'${id}' is not plugin@marketplace`)
      const owner = { scope, ...this.ownerOf(scope, context) } as InstallRecord
      const installed = await this.store.installed()
      const remaining = (installed.plugins[id] ?? []).filter((record) => !sameOwner(record, owner))
      const { [id]: _gone, ...rest } = installed.plugins
      void _gone
      await this.store.saveInstalled({ version: 2, plugins: remaining.length > 0 ? { ...rest, [id]: remaining } : rest })
      if (scope !== 'user') await writeEnabledPlugin(this.scopeFile(scope, context), id, undefined)
      await this.pruneCache(id, remaining)
      this.store.invalidate()
    })
  }

  /** Delete cached versions no record points at. */
  private async pruneCache(id: string, records: readonly InstallRecord[]): Promise<void> {
    const parsed = parsePluginId(id)
    if (parsed === undefined) return
    const dir = path.join(this.store.cacheDir, parsed.marketplace, parsed.name)
    // Defense in depth: only ever delete inside this plugin's own cache folder.
    if (!strictlyInside(this.store.cacheDir, dir)) return
    const keep = new Set(records.map((record) => path.resolve(record.installPath)))
    const versions = await fs.readdir(dir).catch(() => [] as string[])
    for (const version of versions) {
      const full = path.resolve(dir, version)
      if (!strictlyInside(dir, full)) continue
      if (!keep.has(full)) await fs.rm(full, { recursive: true, force: true })
    }
  }

  /** Every plugin known here: installed, enabled by settings, or offered by a marketplace. */
  async list(context: PluginContext): Promise<{ readonly plugins: readonly PluginRow[]; readonly suggestedMarketplaces: Readonly<Record<string, unknown>> }> {
    const settings = this.settingsFiles(context)
    const projectPath = this.projectRoot(context)
    const [enabled, installed, active, suggested] = await Promise.all([
      readEnabledPlugins(settings),
      this.store.installed(),
      this.active(context),
      readSuggestedMarketplaces(settings),
    ])
    const ids = new Set<string>([...enabled.keys(), ...Object.keys(installed.plugins)])
    const rows: PluginRow[] = []
    for (const id of ids) {
      const parsed = parsePluginId(id)
      if (parsed === undefined) continue
      const records = installed.plugins[id] ?? []
      const applicable = records.filter((record) => PluginStore.applicableRecord([record], { workspaceId: context.workspaceId, ...(projectPath !== undefined ? { projectPath } : {}) }) !== undefined)
      const loaded = active.plugins.find((plugin) => plugin.id === id)
      const error = active.errors.find((item) => item.id === id)?.message
      const state = enabled.get(id)
      const entry = loaded === undefined ? (await findEntry(this.marketplaceDeps, parsed.marketplace, parsed.name).catch(() => undefined))?.entry : undefined
      const description = loaded?.manifest.description ?? entry?.description
      const version = loaded?.manifest.version ?? applicable[0]?.version ?? entry?.version
      rows.push({
        id,
        name: parsed.name,
        marketplace: parsed.marketplace,
        ...(description !== undefined ? { description } : {}),
        ...(version !== undefined ? { version } : {}),
        installed: applicable.length > 0,
        installedScopes: applicable.map((record) => record.scope),
        ...(state !== undefined ? { enabled: { value: state.enabled, scope: state.scope } } : {}),
        active: loaded !== undefined,
        ...(loaded !== undefined ? { components: await countComponents(loaded) } : {}),
        ...(loaded !== undefined && loaded.components.notes.length > 0 ? { notes: loaded.components.notes } : {}),
        ...(error !== undefined ? { error } : {}),
      })
    }
    return { plugins: rows.sort((a, b) => a.id.localeCompare(b.id)), suggestedMarketplaces: suggested }
  }
}

/** Anthropic's official marketplace, which Claude Code knows without being told. */
export const OFFICIAL_MARKETPLACE = {
  name: 'claude-plugins-official',
  source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
} as const satisfies { readonly name: string; readonly source: MarketplaceSource }

/** A marketplace entry source as one readable line. */
function sourceLocation(source: unknown): string {
  if (typeof source === 'string') return source
  if (!isRecord(source)) return ''
  const where = typeof source['repo'] === 'string' ? source['repo'] : typeof source['url'] === 'string' ? source['url'] : typeof source['package'] === 'string' ? source['package'] : ''
  const sub = typeof source['path'] === 'string' ? ` (${source['path']})` : ''
  const ref = typeof source['ref'] === 'string' ? `#${source['ref']}` : ''
  return `${where}${ref}${sub}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A Claude settings/known-marketplaces `source` object, validated like typed input. */
function toMarketplaceSource(value: unknown): MarketplaceSource | undefined {
  if (!isRecord(value)) return undefined
  const ref = typeof value['ref'] === 'string' ? { ref: value['ref'] } : {}
  try {
    if (value['source'] === 'github' && typeof value['repo'] === 'string') {
      const parsed = parseMarketplaceInput(value['repo'])
      return parsed.source === 'github' ? { ...parsed, ...ref } : undefined
    }
    if ((value['source'] === 'git' || value['source'] === 'url') && typeof value['url'] === 'string') {
      assertGitUrl(value['url'])
      return { source: 'git', url: value['url'], ...ref }
    }
    if (value['source'] === 'directory' && typeof value['path'] === 'string' && path.isAbsolute(value['path'])) {
      return { source: 'directory', path: value['path'] }
    }
  } catch {
    return undefined
  }
  return undefined
}

function sameOwner(a: Pick<InstallRecord, 'scope' | 'workspaceId' | 'projectPath'>, b: Pick<InstallRecord, 'scope' | 'workspaceId' | 'projectPath'>): boolean {
  if (a.scope !== b.scope) return false
  if (a.scope === 'workspace') return a.workspaceId === b.workspaceId
  if (a.scope === 'project' || a.scope === 'local') return a.projectPath !== undefined && b.projectPath !== undefined && path.resolve(a.projectPath) === path.resolve(b.projectPath)
  return true
}

async function countComponents(plugin: LoadedPlugin): Promise<NonNullable<PluginRow['components']>> {
  const countMd = async (dirs: readonly string[]): Promise<number> => {
    let total = 0
    for (const dir of dirs) total += (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.md')).length
    return total
  }
  const countSkills = async (): Promise<number> => {
    let total = plugin.components.skillFolders.length
    for (const dir of plugin.components.skillDirs) {
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        if ((await fs.stat(path.join(dir, name, 'SKILL.md')).catch(() => undefined))?.isFile() === true) total += 1
      }
    }
    return total
  }
  return {
    commands: await countMd(plugin.components.commandDirs) + plugin.components.commandFiles.length,
    skills: await countSkills(),
    agents: await countMd(plugin.components.agentDirs) + plugin.components.agentFiles.length,
    hooks: plugin.components.hooks !== undefined,
    mcpServers: Object.keys(plugin.components.mcpServers ?? {}),
  }
}
