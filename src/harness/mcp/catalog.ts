/**
 * Curated MCP servers shown in Settings → MCP → Browse catalog. Pure data
 * plus small helpers; no I/O. An entry is a server body the host would
 * accept in `mcp.json`, never a credential: secrets are `${NAME}` references
 * and the person installing supplies their values.
 *
 * Checked on 2026-10-12: remote URLs answered `initialize` (or a Bearer
 * challenge that OAuth Connect completed discovery for), npm and PyPI
 * packages exist and are not deprecated, flags were read from the package.
 * Deprecated `@modelcontextprotocol/server-*` packages are deliberately absent.
 */

export type CatalogCategory = 'dev' | 'docs-search' | 'browser-testing' | 'database' | 'productivity'

export const CATALOG_CATEGORIES: readonly { readonly id: CatalogCategory; readonly label: string }[] = [
  { id: 'dev', label: 'Dev & Git' },
  { id: 'docs-search', label: 'Docs & Search' },
  { id: 'browser-testing', label: 'Browser & Testing' },
  { id: 'database', label: 'Database' },
  { id: 'productivity', label: 'Productivity' },
]

/** A value the installer must type, written into the config in place of `token`. */
export interface CatalogPlaceholder {
  readonly token: string
  readonly label: string
  readonly hint: string
}

/** A workspace secret the server reads through a `${NAME}` reference. */
export interface CatalogSecret {
  readonly name: string
  readonly label: string
  readonly obtainUrl: string
}

export type CatalogAuth = 'none' | 'token' | 'oauth'

export interface CatalogEntry {
  /** Stable; also the default server name. */
  readonly id: string
  readonly title: string
  readonly category: CatalogCategory
  readonly description: string
  /** Who maintains the server. This is not a security review. */
  readonly maintainer: 'official' | 'community'
  /** An `mcp.json` server body without `name` and `enabled`. */
  readonly config: Readonly<Record<string, unknown>>
  readonly secrets: readonly CatalogSecret[]
  readonly placeholders: readonly CatalogPlaceholder[]
  /** Launcher the host machine needs; shown before install. */
  readonly requires: readonly ('npx' | 'uvx')[]
  readonly docsUrl: string
  readonly notes?: string
}

const oauthConfig = (url: string): Record<string, unknown> => ({
  transport: 'http',
  url,
  auth: { type: 'managed_oauth', provider: new URL(url).host, resource: url },
})

export const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'github',
    title: 'GitHub',
    category: 'dev',
    description: 'Repositories, issues, pull requests, and Actions through GitHub’s hosted MCP server.',
    maintainer: 'official',
    config: { transport: 'http', url: 'https://api.githubcopilot.com/mcp/', auth: { type: 'bearer', token: '${GITHUB_PERSONAL_ACCESS_TOKEN}' } },
    secrets: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', obtainUrl: 'https://github.com/settings/personal-access-tokens/new' }],
    placeholders: [],
    requires: [],
    docsUrl: 'https://github.com/github/github-mcp-server',
    notes: 'Grant the token only the repositories and permissions you want the agent to use.',
  },
  {
    id: 'git',
    title: 'Git',
    category: 'dev',
    description: 'Read and operate on local Git repositories: status, diff, log, commit.',
    maintainer: 'official',
    config: { transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] },
    secrets: [],
    placeholders: [],
    requires: ['uvx'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    id: 'sentry',
    title: 'Sentry',
    category: 'dev',
    description: 'Look up issues, events, and releases in Sentry.',
    maintainer: 'official',
    config: oauthConfig('https://mcp.sentry.dev/mcp'),
    secrets: [],
    placeholders: [],
    requires: [],
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  {
    id: 'context7',
    title: 'Context7',
    category: 'docs-search',
    description: 'Up-to-date library documentation and code examples.',
    maintainer: 'official',
    config: { transport: 'http', url: 'https://mcp.context7.com/mcp' },
    secrets: [],
    placeholders: [],
    requires: [],
    docsUrl: 'https://github.com/upstash/context7',
  },
  {
    id: 'exa',
    title: 'Exa Search',
    category: 'docs-search',
    description: 'Web search and page content retrieval.',
    maintainer: 'official',
    config: { transport: 'http', url: 'https://mcp.exa.ai/mcp' },
    secrets: [],
    placeholders: [],
    requires: [],
    docsUrl: 'https://docs.exa.ai/reference/exa-mcp',
  },
  {
    id: 'fetch',
    title: 'Fetch',
    category: 'docs-search',
    description: 'Fetch a web page and convert it to Markdown.',
    maintainer: 'official',
    config: { transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    secrets: [],
    placeholders: [],
    requires: ['uvx'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'brave-search',
    title: 'Brave Search',
    category: 'docs-search',
    description: 'Web, news, image, and local search through the Brave Search API.',
    maintainer: 'official',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } },
    secrets: [{ name: 'BRAVE_API_KEY', label: 'Brave Search API key', obtainUrl: 'https://brave.com/search/api/' }],
    placeholders: [],
    requires: ['npx'],
    docsUrl: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'playwright',
    title: 'Playwright',
    category: 'browser-testing',
    description: 'Drive a real browser: navigate, click, fill forms, take snapshots.',
    maintainer: 'official',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    secrets: [],
    placeholders: [],
    requires: ['npx'],
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    notes: 'The first run downloads a browser.',
  },
  {
    id: 'postgres',
    title: 'PostgreSQL',
    category: 'database',
    description: 'Inspect schemas, run queries, and analyse query plans. Starts in restricted (read-only) mode.',
    maintainer: 'community',
    config: { transport: 'stdio', command: 'uvx', args: ['postgres-mcp', '--access-mode=restricted'], env: { DATABASE_URI: '${DATABASE_URI}' } },
    secrets: [{ name: 'DATABASE_URI', label: 'Connection URI (postgresql://user:password@host:5432/db)', obtainUrl: 'https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-URIS' }],
    placeholders: [],
    requires: ['uvx'],
    docsUrl: 'https://github.com/crystaldba/postgres-mcp',
    notes: 'Restricted mode allows read-only transactions with a time limit. Edit the server to switch to unrestricted.',
  },
  {
    id: 'sqlite',
    title: 'SQLite',
    category: 'database',
    description: 'Query and modify a local SQLite database file.',
    maintainer: 'official',
    config: { transport: 'stdio', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '<DB_PATH>'] },
    secrets: [],
    placeholders: [{ token: '<DB_PATH>', label: 'Database file', hint: 'Absolute path, e.g. /Users/you/data/app.db' }],
    requires: ['uvx'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite',
    notes: 'Archived reference server; it can modify the file.',
  },
  {
    id: 'supabase',
    title: 'Supabase',
    category: 'database',
    description: 'Manage a Supabase project: tables, SQL, logs. Starts read-only and scoped to one project.',
    maintainer: 'official',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only', '--project-ref=<PROJECT_REF>'], env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' } },
    secrets: [{ name: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase personal access token', obtainUrl: 'https://supabase.com/dashboard/account/tokens' }],
    placeholders: [{ token: '<PROJECT_REF>', label: 'Project reference', hint: 'Project Settings → General → Reference ID' }],
    requires: ['npx'],
    docsUrl: 'https://github.com/supabase-community/supabase-mcp',
  },
  {
    id: 'notion',
    title: 'Notion',
    category: 'productivity',
    description: 'Search and edit pages and databases in your Notion workspace.',
    maintainer: 'official',
    config: oauthConfig('https://mcp.notion.com/mcp'),
    secrets: [],
    placeholders: [],
    requires: [],
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'linear',
    title: 'Linear',
    category: 'productivity',
    description: 'Find, create, and update issues, projects, and comments in Linear.',
    maintainer: 'official',
    config: oauthConfig('https://mcp.linear.app/mcp'),
    secrets: [],
    placeholders: [],
    requires: [],
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    id: 'atlassian',
    title: 'Atlassian (Jira & Confluence)',
    category: 'productivity',
    description: 'Search and update Jira issues and Confluence pages.',
    maintainer: 'official',
    config: oauthConfig('https://mcp.atlassian.com/v1/mcp'),
    secrets: [],
    placeholders: [],
    requires: [],
    docsUrl: 'https://www.atlassian.com/platform/remote-mcp-server',
  },
]

export function catalogAuth(entry: CatalogEntry): CatalogAuth {
  const auth = entry.config['auth']
  if (auth !== null && typeof auth === 'object') {
    const type = (auth as { type?: unknown }).type
    if (type === 'managed_oauth') return 'oauth'
    if (type === 'bearer') return 'token'
  }
  return entry.secrets.length > 0 ? 'token' : 'none'
}

/** One line saying what installing runs or connects to. */
export function catalogPreview(entry: CatalogEntry): string {
  const { command, args, url } = entry.config as { command?: unknown; args?: unknown; url?: unknown }
  if (typeof command === 'string') return [command, ...(Array.isArray(args) ? args.map(String) : [])].join(' ')
  return typeof url === 'string' ? url : ''
}

/** The first free server name: `id`, then `id-2`, `id-3`, … */
export function catalogServerName(id: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(id)) return id
  for (let n = 2; ; n += 1) if (!used.has(`${id}-${n}`)) return `${id}-${n}`
}

/** Replace every placeholder token in every string of the config (deep copy). */
export function applyPlaceholders(config: Readonly<Record<string, unknown>>, values: Readonly<Record<string, string>>): Record<string, unknown> {
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') return Object.entries(values).reduce((text, [token, replacement]) => text.split(token).join(replacement), value)
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  return replace(config) as Record<string, unknown>
}
