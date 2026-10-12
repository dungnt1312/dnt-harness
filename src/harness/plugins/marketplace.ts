/**
 * Claude Code marketplaces and plugin installation, into the host's own
 * store. A marketplace is a folder (a git clone, or a local directory) with
 * `.claude-plugin/marketplace.json`; its `plugins` entries name a source:
 *
 *   "./plugins/x"                                   relative to the marketplace
 *   { source: "github", repo: "o/r", ref?, sha? }
 *   { source: "url", url: "https://…git", ref?, sha? }  (a git repository)
 *   { source: "git-subdir", url, path, ref?, sha? }
 *
 * Other source kinds (npm, …) are reported as unsupported. Git work runs the
 * `git` CLI with a scrubbed environment and no prompts.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { scrubbedChildEnv } from '../child-env.ts'
import { PLUGIN_NAME, PluginError, assertPluginTreeContained, readManifest, resolveExistingInside, type ComponentFields } from './manifest.ts'
import { isStoreSegment, strictlyInside, type KnownMarketplace, type MarketplaceSource, type PluginStore } from './store.ts'
import { createHash } from 'node:crypto'

/** Deterministic sha256 over a plugin tree (relative paths, file bytes, link targets), `.git` excluded. */
export async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) hash.update(`L\0${childRel}\0${await fs.readlink(full)}\0`)
      else if (entry.isDirectory()) { hash.update(`D\0${childRel}\0`); await walk(full, childRel) }
      else if (entry.isFile()) { hash.update(`F\0${childRel}\0`); hash.update(await fs.readFile(full)); hash.update('\0') }
    }
  }
  await walk(root, '')
  return hash.digest('hex')
}

const execFileAsync = promisify(execFile)

export interface MarketplaceEntry extends ComponentFields {
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly category?: string
  readonly author?: string
  readonly homepage?: string
  readonly keywords?: readonly string[]
  readonly source: unknown
  readonly strict?: boolean
  readonly raw: Readonly<Record<string, unknown>>
}

export interface MarketplaceDocument {
  readonly name: string
  readonly description?: string
  readonly owner?: string
  readonly plugins: readonly MarketplaceEntry[]
  readonly renames: Readonly<Record<string, string>>
}

const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

async function git(args: readonly string[], cwd?: string, timeoutMs = 300_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: scrubbedChildEnv({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }),
    })
    return stdout.trim()
  } catch (error) {
    const detail = error as { stderr?: string; message?: string }
    throw new PluginError('failed', `git ${args[0]} failed: ${(detail.stderr ?? detail.message ?? String(error)).trim().split('\n').slice(-3).join(' ')}`)
  }
}

/** A git URL the host may clone: https, ssh (`git@…`), or file. Never a local option string. */
export function assertGitUrl(url: string): void {
  if (url.startsWith('-') || !/^(https?:\/\/|ssh:\/\/|git@[^:]+:|file:\/\/)/.test(url)) {
    throw new PluginError('invalid', `'${url}' is not a git URL (https://, ssh://, git@host:path or file://)`)
  }
}

function assertRef(ref: string | undefined): void {
  if (ref !== undefined && (ref.startsWith('-') || !/^[A-Za-z0-9._/@+-]{1,200}$/.test(ref))) throw new PluginError('invalid', `invalid git ref '${ref}'`)
}

/** Shallow clone at `ref` (branch/tag), then pin to `sha` when given. Returns HEAD. */
export async function cloneRepo(url: string, target: string, ref?: string, sha?: string): Promise<string> {
  assertGitUrl(url)
  assertRef(ref)
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new PluginError('invalid', `invalid commit sha '${sha}'`)
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await git(['clone', '--depth', '1', ...(ref !== undefined ? ['--branch', ref] : []), '--', url, target])
  if (sha !== undefined) {
    const head = await git(['rev-parse', 'HEAD'], target)
    if (!head.startsWith(sha.toLowerCase())) {
      await git(['fetch', '--depth', '1', 'origin', sha], target)
      await git(['checkout', '--detach', 'FETCH_HEAD'], target)
    }
  }
  return git(['rev-parse', 'HEAD'], target)
}

/** `owner/repo`, a git URL, or a local folder → a marketplace source. */
export function parseMarketplaceInput(input: string): MarketplaceSource {
  const value = input.trim()
  if (value === '') throw new PluginError('invalid', 'a marketplace source is required')
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return { source: 'github', repo: value }
  if (/^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(value)) {
    const hash = value.indexOf('#')
    const url = hash > 0 ? value.slice(0, hash) : value
    const ref = hash > 0 ? value.slice(hash + 1) : undefined
    assertGitUrl(url)
    return { source: 'git', url, ...(ref !== undefined && ref !== '' ? { ref } : {}) }
  }
  if (path.isAbsolute(value) || value.startsWith('~')) return { source: 'directory', path: value }
  throw new PluginError('invalid', `'${value}' is not owner/repo, a git URL, or an absolute folder path`)
}

function githubUrl(repo: string): string {
  return `https://github.com/${repo}.git`
}

function expandHome(value: string, home: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value
}

/** Read and validate `.claude-plugin/marketplace.json` in a marketplace folder. */
export async function readMarketplace(dir: string): Promise<MarketplaceDocument> {
  const file = path.join(dir, '.claude-plugin', 'marketplace.json')
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) throw new PluginError('invalid', `${file} is missing; not a Claude Code marketplace`)
  let doc: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be an object')
    doc = parsed as Record<string, unknown>
  } catch (error) {
    throw new PluginError('invalid', `${file} is not valid JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (typeof doc['name'] !== 'string' || !MARKETPLACE_NAME.test(doc['name']) || !isStoreSegment(doc['name'])) throw new PluginError('invalid', 'marketplace.json needs a valid name')
  const plugins: MarketplaceEntry[] = []
  for (const raw of Array.isArray(doc['plugins']) ? doc['plugins'] : []) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    if (typeof entry['name'] !== 'string' || !PLUGIN_NAME.test(entry['name']) || !isStoreSegment(entry['name'])) continue
    const author = entry['author']
    plugins.push({
      name: entry['name'],
      ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
      ...(typeof entry['version'] === 'string' ? { version: entry['version'] } : {}),
      ...(typeof entry['category'] === 'string' ? { category: entry['category'] } : {}),
      ...(typeof author === 'string' ? { author } : author !== null && typeof author === 'object' && typeof (author as { name?: unknown }).name === 'string' ? { author: (author as { name: string }).name } : {}),
      ...(typeof entry['homepage'] === 'string' ? { homepage: entry['homepage'] } : {}),
      ...(Array.isArray(entry['keywords']) ? { keywords: entry['keywords'].filter((item): item is string => typeof item === 'string') } : {}),
      source: entry['source'],
      ...(typeof entry['strict'] === 'boolean' ? { strict: entry['strict'] } : {}),
      ...(entry['commands'] !== undefined ? { commands: entry['commands'] } : {}),
      ...(entry['agents'] !== undefined ? { agents: entry['agents'] } : {}),
      ...(entry['skills'] !== undefined ? { skills: entry['skills'] } : {}),
      ...(entry['hooks'] !== undefined ? { hooks: entry['hooks'] } : {}),
      ...(entry['mcpServers'] !== undefined ? { mcpServers: entry['mcpServers'] } : {}),
      raw: entry,
    })
  }
  const renames: Record<string, string> = {}
  if (doc['renames'] !== null && typeof doc['renames'] === 'object' && !Array.isArray(doc['renames'])) {
    for (const [from, to] of Object.entries(doc['renames'] as Record<string, unknown>)) if (typeof to === 'string') renames[from] = to
  }
  const owner = doc['owner']
  return {
    name: doc['name'],
    ...(typeof doc['description'] === 'string' ? { description: doc['description'] } : {}),
    ...(owner !== null && typeof owner === 'object' && typeof (owner as { name?: unknown }).name === 'string' ? { owner: (owner as { name: string }).name } : {}),
    plugins,
    renames,
  }
}

export interface MarketplaceDeps {
  readonly store: PluginStore
  readonly homeDir: string
  /** Test seam: replaces `cloneRepo`. */
  readonly clone?: typeof cloneRepo
}

/**
 * Fetch (clone or refresh) a marketplace and register it under the name its
 * manifest declares. A local folder is read in place, never copied.
 */
export async function addMarketplace(deps: MarketplaceDeps, source: MarketplaceSource): Promise<{ readonly name: string; readonly document: MarketplaceDocument }> {
  const clone = deps.clone ?? cloneRepo
  let location: string
  let staging: string | undefined
  if (source.source === 'directory') {
    location = path.resolve(expandHome(source.path, deps.homeDir))
  } else {
    staging = path.join(deps.store.marketplacesDir, `.staging-${process.pid}-${Date.now()}`)
    await clone(source.source === 'github' ? githubUrl(source.repo) : source.url, staging, source.ref)
    location = staging
  }
  let document: MarketplaceDocument
  try {
    document = await readMarketplace(location)
  } catch (error) {
    if (staging !== undefined) await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
  if (staging !== undefined) {
    const target = path.join(deps.store.marketplacesDir, document.name)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
    location = target
  }
  const known = await deps.store.marketplaces()
  const entry: KnownMarketplace = { source, installLocation: location, lastUpdated: new Date().toISOString() }
  await deps.store.saveMarketplaces({ ...known, [document.name]: entry })
  return { name: document.name, document }
}

/** Re-fetch a known marketplace from its recorded source. */
export async function updateMarketplace(deps: MarketplaceDeps, name: string): Promise<MarketplaceDocument> {
  const known = (await deps.store.marketplaces())[name]
  if (known === undefined) throw new PluginError('not-found', `no marketplace '${name}'`)
  const { document } = await addMarketplace(deps, known.source)
  return document
}

export async function removeMarketplace(deps: MarketplaceDeps, name: string): Promise<void> {
  const known = await deps.store.marketplaces()
  const entry = known[name]
  if (entry === undefined) throw new PluginError('not-found', `no marketplace '${name}'`)
  const { [name]: _removed, ...rest } = known
  void _removed
  await deps.store.saveMarketplaces(rest)
  // Only folders the store owns are deleted; a local directory stays.
  const owned = path.join(deps.store.marketplacesDir, name)
  if (entry.source.source !== 'directory' && isStoreSegment(name) && strictlyInside(deps.store.marketplacesDir, owned)) {
    await fs.rm(owned, { recursive: true, force: true })
  }
}

/** A marketplace's entry for one plugin (following `renames`). */
export async function findEntry(deps: MarketplaceDeps, marketplace: string, plugin: string): Promise<{ readonly entry: MarketplaceEntry; readonly location: string } | undefined> {
  const known = (await deps.store.marketplaces())[marketplace]
  if (known === undefined) return undefined
  const document = await readMarketplace(known.installLocation).catch(() => undefined)
  if (document === undefined) return undefined
  const name = document.renames[plugin] ?? plugin
  const entry = document.plugins.find((candidate) => candidate.name === name)
  return entry !== undefined ? { entry, location: known.installLocation } : undefined
}

/** A plugin source kind as the UI shows it: `relative`, `github`, `url`, `git-subdir`, or the raw unsupported kind. */
export function sourceKind(source: unknown): string {
  if (typeof source === 'string') return 'relative'
  if (source !== null && typeof source === 'object') {
    const kind = (source as Record<string, unknown>)['source']
    return typeof kind === 'string' ? kind : 'unknown'
  }
  return 'unknown'
}

/**
 * Put a marketplace entry's files on disk without publishing them. A
 * relative source is copied into `scratch` when `copyRelative`, else read in
 * place; git sources clone into `scratch`. The tree must stay contained.
 */
async function stagePlugin(deps: MarketplaceDeps, entry: MarketplaceEntry, location: string, scratch: string, copyRelative: boolean): Promise<{ readonly pluginDir: string; readonly commit?: string }> {
  const clone = deps.clone ?? cloneRepo
  const source = entry.source
  let pluginDir: string
  let commit: string | undefined
  if (typeof source === 'string') {
    const resolved = await resolveExistingInside(location, source)
    if (resolved === undefined) throw new PluginError('invalid', `plugin '${entry.name}': source '${source}' is missing or outside the marketplace after symlink resolution`)
    if (copyRelative) {
      await fs.mkdir(path.dirname(scratch), { recursive: true })
      await fs.cp(resolved, scratch, { recursive: true, dereference: false, filter: (from) => !from.split(path.sep).includes('.git') })
      pluginDir = scratch
    } else {
      pluginDir = resolved
    }
  } else if (source !== null && typeof source === 'object') {
    const spec = source as Record<string, unknown>
    const kind = spec['source']
    const ref = typeof spec['ref'] === 'string' ? spec['ref'] : undefined
    const sha = typeof spec['sha'] === 'string' ? spec['sha'] : undefined
    if (kind === 'github' && typeof spec['repo'] === 'string') {
      commit = await clone(githubUrl(spec['repo']), scratch, ref, sha)
      pluginDir = scratch
    } else if ((kind === 'url' || kind === 'git') && typeof spec['url'] === 'string') {
      commit = await clone(spec['url'], scratch, ref, sha)
      pluginDir = scratch
    } else if (kind === 'git-subdir' && typeof spec['url'] === 'string' && typeof spec['path'] === 'string') {
      commit = await clone(spec['url'], scratch, ref, sha)
      const sub = await resolveExistingInside(scratch, spec['path'])
      if (sub === undefined) throw new PluginError('invalid', `plugin '${entry.name}': path '${spec['path']}' is missing or outside the repository after symlink resolution`)
      pluginDir = sub
    } else {
      throw new PluginError('unsupported', `plugin '${entry.name}': source ${JSON.stringify(kind)} is not supported by dnt-harness`)
    }
  } else {
    throw new PluginError('invalid', `plugin '${entry.name}' has no source`)
  }
  if ((await fs.stat(pluginDir).catch(() => undefined))?.isDirectory() !== true) throw new PluginError('invalid', `plugin '${entry.name}': source folder is missing`)
  await assertPluginTreeContained(pluginDir)
  return { pluginDir, ...(commit !== undefined ? { commit } : {}) }
}

/**
 * Run `inspect` on a marketplace entry's files without installing anything:
 * git sources clone into a temporary folder that is removed afterwards.
 */
export async function inspectPlugin<T>(deps: MarketplaceDeps, marketplace: string, entry: MarketplaceEntry, location: string, inspect: (pluginDir: string) => Promise<T>): Promise<T> {
  // Outside cache/<m>/<p>/ so an uninstall's cache prune never races it.
  const scratch = path.join(deps.store.root, 'tmp', `inspect-${marketplace}-${entry.name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    const { pluginDir } = await stagePlugin(deps, entry, location, scratch, false)
    return await inspect(pluginDir)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Fetch one plugin's files into `cache/<m>/<p>/<version>/`. Returns the
 * install path, the version, and the git commit when one was cloned.
 */
export async function fetchPlugin(deps: MarketplaceDeps, marketplace: string, entry: MarketplaceEntry, location: string): Promise<{ readonly installPath: string; readonly version: string; readonly gitCommitSha?: string }> {
  const scratch = path.join(deps.store.cacheDir, marketplace, entry.name, `.fetch-${process.pid}-${Date.now()}`)
  try {
    const { pluginDir, commit } = await stagePlugin(deps, entry, location, scratch, true)
    // plugin.json is optional (Claude derives the name from the entry); an
    // invalid one is still an error.
    const manifest = await readManifest(pluginDir, { ...entry.raw, name: entry.name })
    const version = manifest.version ?? entry.version ?? (commit !== undefined ? commit.slice(0, 12) : 'unknown')
    // Published cache folders are immutable and content-addressed: the same
    // version with different bytes gets its own folder, so reinstalling in
    // another workspace never rewrites code an existing record runs. The
    // version part is sanitized to one safe segment (never `.`/`..`/empty).
    const versionPart = version.replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '').slice(0, 64)
    const segment = `${versionPart === '' ? 'unknown' : versionPart}-${(await treeHash(pluginDir)).slice(0, 12)}`
    const pluginCache = path.join(deps.store.cacheDir, marketplace, entry.name)
    const target = path.join(pluginCache, segment)
    if (!strictlyInside(pluginCache, target) || !isStoreSegment(segment)) throw new PluginError('invalid', `plugin '${entry.name}': unusable version '${version}'`)
    if ((await fs.stat(target).catch(() => undefined))?.isDirectory() !== true) {
      if (pluginDir === scratch) {
        await fs.rename(scratch, target)
      } else {
        await fs.cp(pluginDir, target, { recursive: true, dereference: false, filter: (from) => !from.split(path.sep).includes('.git') })
      }
    }
    return { installPath: target, version, ...(commit !== undefined ? { gitCommitSha: commit } : {}) }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
