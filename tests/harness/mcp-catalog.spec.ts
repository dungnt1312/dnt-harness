import { describe, expect, it } from 'vitest'
import {
  applyPlaceholders, catalogAuth, catalogPreview, catalogServerName, CATALOG_CATEGORIES, MCP_CATALOG,
} from '../../src/harness/mcp/catalog.ts'
import { upsertServer } from '../../src/harness/mcp/config-v2.ts'
import type { McpConfig } from '../../src/harness/mcp/config.ts'

const empty: McpConfig = { version: 2, revision: 1, servers: {} }
const refs = (value: unknown): string[] => {
  if (typeof value === 'string') return [...value.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? '')
  if (Array.isArray(value)) return value.flatMap(refs)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(refs)
  return []
}
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

describe('MCP catalog data', () => {
  it('has unique ids that are valid server names, in known categories', () => {
    const ids = MCP_CATALOG.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of MCP_CATALOG) {
      expect(entry.id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(CATALOG_CATEGORIES.map((category) => category.id)).toContain(entry.category)
      expect(entry.description.length).toBeGreaterThan(10)
      expect(entry.docsUrl).toMatch(/^https:\/\//)
    }
  })

  it.each(MCP_CATALOG.map((entry) => [entry.id, entry] as const))('%s is accepted by the config parser and stays disabled', (_id, entry) => {
    // Placeholders are filled the way the installer does before saving.
    const filled = applyPlaceholders(entry.config, Object.fromEntries(entry.placeholders.map((placeholder) => [placeholder.token, 'value'])))
    const saved = upsertServer(empty, entry.id, filled)
    expect(saved.servers[entry.id]?.enabled).toBe(false)
  })

  it('references only declared secrets, and declares only secrets it references', () => {
    for (const entry of MCP_CATALOG) {
      const used = [...new Set(refs(entry.config))].sort()
      expect(used, entry.id).toEqual(entry.secrets.map((secret) => secret.name).sort())
      for (const secret of entry.secrets) expect(secret.name).toMatch(/^[A-Za-z0-9_]+$/)
    }
  })

  it('keeps credentials out of the config: only ${NAME} references', () => {
    for (const entry of MCP_CATALOG) {
      const config = entry.config as { env?: Record<string, string>; headers?: Record<string, string>; auth?: Record<string, unknown> }
      for (const value of [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})]) expect(value, entry.id).toMatch(/^\$\{[A-Za-z0-9_]+\}$/)
      if (config.auth?.['type'] === 'bearer') expect(config.auth['token'], entry.id).toMatch(/^\$\{[A-Za-z0-9_]+\}$/)
      expect(config.auth?.['clientSecret'], entry.id).toBeUndefined()
    }
  })

  it('declares every <PLACEHOLDER> it contains, and no declared one is unused', () => {
    for (const entry of MCP_CATALOG) {
      const found = [...new Set(strings(entry.config).flatMap((text) => text.match(/<[A-Z][A-Z0-9_]*>/g) ?? []))].sort()
      expect(found, entry.id).toEqual(entry.placeholders.map((placeholder) => placeholder.token).sort())
    }
  })

  it('uses only https remote URLs, and declares the launcher a stdio command needs', () => {
    for (const entry of MCP_CATALOG) {
      const config = entry.config as { transport: string; url?: string; command?: string }
      if (config.transport === 'http') {
        expect(config.url, entry.id).toMatch(/^https:\/\//)
        expect(entry.requires, entry.id).toEqual([])
      } else {
        expect(entry.requires, entry.id).toContain(config.command)
      }
    }
  })

  it('does not ship deprecated reference packages', () => {
    const text = MCP_CATALOG.flatMap((entry) => strings(entry.config)).join(' ')
    expect(text).not.toMatch(/@modelcontextprotocol\/server-(github|gitlab|brave-search|puppeteer|postgres|slack)/)
  })

  it('covers every category and the OAuth servers the host can connect to', () => {
    for (const category of CATALOG_CATEGORIES) expect(MCP_CATALOG.some((entry) => entry.category === category.id), category.id).toBe(true)
    expect(MCP_CATALOG.filter((entry) => catalogAuth(entry) === 'oauth').map((entry) => entry.id).sort()).toEqual(['atlassian', 'linear', 'notion', 'sentry'])
  })
})

describe('catalog helpers', () => {
  const byId = (id: string) => MCP_CATALOG.find((entry) => entry.id === id)!

  it('classifies authentication', () => {
    expect(catalogAuth(byId('context7'))).toBe('none')
    expect(catalogAuth(byId('github'))).toBe('token')
    expect(catalogAuth(byId('brave-search'))).toBe('token')
    expect(catalogAuth(byId('linear'))).toBe('oauth')
  })

  it('previews what installing runs or connects to', () => {
    expect(catalogPreview(byId('git'))).toBe('uvx mcp-server-git')
    expect(catalogPreview(byId('context7'))).toBe('https://mcp.context7.com/mcp')
  })

  it('picks the first free server name', () => {
    expect(catalogServerName('git', [])).toBe('git')
    expect(catalogServerName('git', ['git'])).toBe('git-2')
    expect(catalogServerName('git', ['git', 'git-2'])).toBe('git-3')
  })

  it('replaces placeholders deep, without touching the original', () => {
    const entry = byId('supabase')
    const filled = applyPlaceholders(entry.config, { '<PROJECT_REF>': 'abcd1234' })
    expect(JSON.stringify(filled)).toContain('--project-ref=abcd1234')
    expect(JSON.stringify(filled)).not.toContain('<PROJECT_REF>')
    expect(JSON.stringify(entry.config)).toContain('<PROJECT_REF>')
  })
})
