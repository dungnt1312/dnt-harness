/**
 * What a plugin contains, for Settings → Plugins: its manifest facts and the
 * names and descriptions of its commands, skills, agents, hook events and
 * MCP servers. Read from an installed plugin, or from a marketplace entry's
 * files staged without installing.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { splitFrontmatter } from '../commands/catalog.ts'
import type { PluginComponents, PluginManifest } from './manifest.ts'

export interface PluginItem {
  readonly name: string
  readonly description?: string
}

export interface PluginDetails {
  readonly id: string
  readonly name: string
  readonly marketplace: string
  readonly description?: string
  readonly version?: string
  readonly author?: string
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly category?: string
  readonly keywords?: readonly string[]
  /** `relative`, `github`, `url`, `git-subdir`, … and a readable location. */
  readonly source: { readonly kind: string; readonly location: string }
  readonly commands: readonly PluginItem[]
  readonly skills: readonly PluginItem[]
  readonly agents: readonly PluginItem[]
  /** Hook event names, e.g. `SessionStart`. */
  readonly hooks: readonly string[]
  readonly mcpServers: readonly { readonly name: string; readonly type: string }[]
  readonly notes: readonly string[]
}

const MAX_ITEMS = 200

async function readFront(file: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  return text !== undefined ? splitFrontmatter(text).frontmatter : {}
}

function describe(name: string, front: Record<string, unknown>): PluginItem {
  const description = front['description']
  return { name, ...(typeof description === 'string' && description.trim() !== '' ? { description: description.trim() } : {}) }
}

/** Markdown files under `dir`, with Claude's `:` namespace for sub-folders. */
async function markdownItems(dir: string, prefix: string, out: PluginItem[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_ITEMS) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if ((await fs.stat(path.join(full, 'SKILL.md')).catch(() => undefined))?.isFile() === true) {
        out.push(describe(`${prefix}${entry.name}`, await readFront(path.join(full, 'SKILL.md'))))
      } else {
        await markdownItems(full, `${prefix}${entry.name}:`, out)
      }
    } else if (entry.name.endsWith('.md')) {
      out.push(describe(`${prefix}${entry.name.slice(0, -3)}`, await readFront(full)))
    }
  }
}

async function skillItems(components: PluginComponents): Promise<PluginItem[]> {
  const out: PluginItem[] = []
  const add = async (folder: string): Promise<void> => {
    const front = await readFront(path.join(folder, 'SKILL.md'))
    out.push(describe(typeof front['name'] === 'string' ? front['name'] : path.basename(folder), front))
  }
  for (const folder of components.skillFolders) await add(folder)
  for (const dir of components.skillDirs) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_ITEMS) break
      if ((await fs.stat(path.join(dir, entry.name, 'SKILL.md')).catch(() => undefined))?.isFile() === true) await add(path.join(dir, entry.name))
    }
  }
  return out
}

async function agentItems(components: PluginComponents): Promise<PluginItem[]> {
  const out: PluginItem[] = []
  for (const dir of components.agentDirs) {
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of entries.filter((item) => item.endsWith('.md')).sort()) {
      const front = await readFront(path.join(dir, name))
      out.push(describe(typeof front['name'] === 'string' ? front['name'] : name.slice(0, -3), front))
    }
  }
  for (const file of components.agentFiles) {
    const front = await readFront(file)
    out.push(describe(typeof front['name'] === 'string' ? front['name'] : path.basename(file, '.md'), front))
  }
  return out.slice(0, MAX_ITEMS)
}

function mcpType(spec: unknown): string {
  if (spec === null || typeof spec !== 'object') return 'unknown'
  const record = spec as Record<string, unknown>
  if (typeof record['type'] === 'string') return record['type']
  return typeof record['command'] === 'string' ? 'stdio' : typeof record['url'] === 'string' ? 'http' : 'unknown'
}

/** Everything a plugin brings, from its resolved components. */
export async function describePlugin(input: {
  readonly id: string
  readonly marketplace: string
  readonly manifest: PluginManifest
  readonly components: PluginComponents
  readonly source: PluginDetails['source']
  readonly category?: string
  readonly fallbackDescription?: string
  readonly fallbackVersion?: string
}): Promise<PluginDetails> {
  const { manifest, components } = input
  const commands: PluginItem[] = []
  for (const dir of components.commandDirs) await markdownItems(dir, '', commands)
  for (const file of components.commandFiles) commands.push(describe(path.basename(file, '.md'), await readFront(file)))
  const hooks = components.hooks !== null && typeof components.hooks === 'object' && !Array.isArray(components.hooks)
    ? Object.keys(components.hooks as Record<string, unknown>).sort()
    : []
  const description = manifest.description ?? input.fallbackDescription
  const version = manifest.version ?? input.fallbackVersion
  return {
    id: input.id,
    name: manifest.name,
    marketplace: input.marketplace,
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(manifest.author !== undefined ? { author: manifest.author } : {}),
    ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
    ...(manifest.repository !== undefined ? { repository: manifest.repository } : {}),
    ...(manifest.license !== undefined ? { license: manifest.license } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(manifest.keywords !== undefined && manifest.keywords.length > 0 ? { keywords: manifest.keywords } : {}),
    source: input.source,
    commands: commands.slice(0, MAX_ITEMS).map((item) => ({ ...item, name: `${manifest.name}:${item.name}` })),
    skills: (await skillItems(components)).map((item) => ({ ...item, name: `${manifest.name}:${item.name}` })),
    agents: (await agentItems(components)).map((item) => ({ ...item, name: `${manifest.name}:${item.name}` })),
    hooks,
    mcpServers: Object.entries(components.mcpServers ?? {}).map(([name, spec]) => ({ name, type: mcpType(spec) })),
    notes: components.notes,
  }
}
