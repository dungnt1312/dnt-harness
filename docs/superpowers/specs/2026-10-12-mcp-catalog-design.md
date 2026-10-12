# MCP catalog in Settings → MCP

Status: draft for review, 2026-10-12. The decisions in the table below were
chosen by the user during brainstorming. The review findings section records
what changed after checking the design against the code and the live servers.

## Goal

Give Settings → MCP a curated catalog of common MCP servers, modelled on the
Claude Connectors Directory (research:
`plans/reports/research-261012-1545-claude-connectors.md`). The user picks an
entry, the existing server form opens prefilled, the user reviews it and adds
any secrets, then saves. Saving still does not start the server; Enable does.

Success means a user can add any catalog entry without typing a command, URL,
or env name by hand, and no catalog path can start a server or write a
credential without an explicit user action.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Data source | Static, curated catalog checked into the repo. No runtime registry query. |
| Add behaviour | Prefill the existing form for review. The catalog never writes `mcp.json` itself. |
| UI placement | Inside the existing `McpPanel`, as a third view beside the editor and Import. |
| Initial groups | Dev & Git, Docs & Search, Browser & Testing, Database, Productivity (remote-first). |

## Review findings that changed the design

1. **Most hosted remote servers need OAuth with dynamic client registration,
   which this host does not implement.** `src/harness/mcp/oauth.ts` states
   "Dynamic client registration is not implemented", and `managed_oauth` needs
   a pinned `clientId` and endpoints. Probing on 2026-10-12 showed GitHub,
   Notion, Linear, Atlassian, Supabase, Sentry, Slack, and GitLab all answer
   `401` with an OAuth `resource_metadata` challenge. So the catalog only lists
   an entry when it works with what the host supports today: no auth, a bearer
   token from the secrets store, or a stdio server whose credentials come from
   env. OAuth-only servers are listed under "Not in v1" below.
2. **Six `@modelcontextprotocol/server-*` npm packages are deprecated**
   (`server-github`, `server-gitlab`, `server-brave-search`,
   `server-puppeteer`, `server-postgres`, `server-slack`). The catalog uses the
   vendor-maintained replacement where one exists and drops the entry
   otherwise. Puppeteer is dropped because Playwright covers it.
3. **The form cannot edit `env`.** `McpPanel.configOf` keeps fields the form
   does not own from a `stored` seed. Stdio entries carry their secrets in
   `env`, so the prefill must pass the catalog config as that seed rather than
   only setting form fields.
4. **No API route is needed.** The web app already imports shared data from
   `src/` directly (`web/lib/model-info.ts` reads
   `src/harness/llm/model-catalog.ts`). The catalog follows that precedent.
   This drops the `GET /api/mcp/catalog` route proposed in chat, and with it a
   `ROUTE_INVENTORY` change.

## Data model

New module `src/harness/mcp/catalog.ts`, pure data plus types, no I/O:

```ts
export type CatalogCategory = 'dev-git' | 'docs-search' | 'browser-testing' | 'database' | 'productivity'

export interface CatalogSecret {
  readonly name: string          // secrets-store key, e.g. GITHUB_PERSONAL_ACCESS_TOKEN
  readonly description: string   // what it is and the scope to grant
  readonly obtainUrl: string     // where the user creates it
}

export interface CatalogEntry {
  readonly id: string                    // stable, also the default server name
  readonly title: string                 // display name
  readonly category: CatalogCategory
  readonly description: string           // one sentence
  readonly maintainer: 'official' | 'community'   // vendor-maintained vs third party
  readonly config: Record<string, unknown>         // an mcp.json server body, without name/enabled
  readonly secrets: readonly CatalogSecret[]
  readonly placeholders: readonly string[]         // tokens like <PROJECT_REF> the user must replace
  readonly requires: readonly ('npx' | 'uvx')[]    // launcher the host must have, display only
  readonly docsUrl: string
  readonly notes?: string                          // e.g. "starts read-only"
}

export const MCP_CATALOG: readonly CatalogEntry[]
```

`config` uses the same shape `mcp.json` already accepts: `transport`,
`command`/`args`/`env` for stdio, `url`/`auth`/`headers` for http. Every
credential is a `${NAME}` reference, never a value. `maintainer` mirrors the
Verified/Community split in Claude's directory, but says who maintains the
server rather than claiming a review.

## Initial entries

"Probe" means the check run on 2026-10-12: an MCP `initialize` POST for
remote URLs, and the npm or PyPI registry for packages.

| id | Category | Maintainer | Config | Secrets | Probe |
|---|---|---|---|---|---|
| `github` | dev-git | official | http `https://api.githubcopilot.com/mcp/`, bearer `${GITHUB_PERSONAL_ACCESS_TOKEN}` | PAT | 401 without token, as expected. PAT acceptance must be confirmed in the implementation gate. |
| `git` | dev-git | official | stdio `uvx mcp-server-git` | none | PyPI 2026.10.10 |
| `context7` | docs-search | official | http `https://mcp.context7.com/mcp` | none | initialize 200 |
| `exa` | docs-search | official | http `https://mcp.exa.ai/mcp` | none | initialize 200 |
| `fetch` | docs-search | official | stdio `uvx mcp-server-fetch` | none | PyPI 2026.10.10 |
| `brave-search` | docs-search | official | stdio `npx -y @brave/brave-search-mcp-server`, env `BRAVE_API_KEY` | API key | npm 2.1.4 |
| `playwright` | browser-testing | official | stdio `npx -y @playwright/mcp` | none | npm 0.0.83 |
| `postgres` | database | community | stdio `uvx postgres-mcp --access-mode=restricted`, env `DATABASE_URI=${DATABASE_URI}` | connection URI | PyPI 0.3.0 |
| `sqlite` | database | official | stdio `uvx mcp-server-sqlite --db-path <DB_PATH>` | none | PyPI 2025.4.25, archived reference server |
| `supabase` | database | official | stdio `npx -y @supabase/mcp-server-supabase --read-only --project-ref=<PROJECT_REF>`, env `SUPABASE_ACCESS_TOKEN` | PAT | npm 0.13.0 |
| `notion` | productivity | official | stdio `npx -y @notionhq/notion-mcp-server`, env `NOTION_TOKEN` | integration token | npm 2.5.2 |
| `linear` | productivity | official | http `https://mcp.linear.app/mcp`, bearer `${LINEAR_API_KEY}` | API key | Rejects an invalid key with `invalid_token`. A real key must be confirmed in the implementation gate. |

Implementation gate: before an entry ships, the implementer checks its exact
command, env names, and flags against the package's current README, and for
`github` and `linear` connects once with a real token. An entry that fails is
removed rather than shipped with a guess. The spec does not need re-approval
for a removal, but the final report must list it.

### Not in v1

| Server | Why |
|---|---|
| Atlassian, Slack, GitLab, Sentry (hosted) | OAuth with dynamic client registration only. Add when the host implements it. |
| GitLab, Slack (npm reference) | Deprecated packages. The community replacements were not reviewed. |
| Puppeteer | Deprecated; Playwright covers the use case. |
| Google Workspace | Not selected in brainstorming. |

## UI

`McpPanel` gains a **Browse catalog** button beside **Import…** and **Add
server**, guarded by the existing `guardDiscard`. It opens a third view,
`'catalog'`, alongside `'edit'` and `'import'`.

The catalog view groups entries by category in the order listed above. Each
row shows title, description, a `maintainer` badge, a transport badge, and
"needs: npx/uvx" when `requires` is not empty. A text filter matches title and
description. An entry whose `id` already exists as a server shows an
"Added" badge but stays selectable.

Choosing an entry calls `beginFromCatalog(entry)`:

- Name: `entry.id`, or the first free `id-2`, `id-3`, … when taken. This
  avoids the existing "Replace the existing server?" path; the user can still
  rename.
- `editing` stays `null` (this is an add), and a new `catalogSeed` state holds
  `entry.config`. `configOf(form, catalogSeed)` therefore keeps `env` and
  `headers` the form does not own. The unsaved-changes baseline is the
  prefilled form, so leaving without edits does not prompt.
- The form fields come from `formOf(name, entry.config)`.
- A banner above the form says the values came from the catalog, lists each
  required secret with whether it exists in the workspace secrets store
  (`listSecrets`) and a link to `obtainUrl`, and lists unreplaced
  placeholders.

Save is blocked, with the existing notice mechanism, while any
`placeholders` string still appears in the URL, args, or env values. A
missing secret does not block save, because save does not start the server.
The success notice already says "use Enable to start it".

The secrets value itself is set in Settings → Secrets as today. The catalog
does not add a secret input.

## Error handling

- The catalog is static. A bad entry is a build-time test failure, not a
  runtime state.
- Missing launcher (`npx`/`uvx`) or a missing secret surfaces at Enable
  through the existing `failed` status, `lastError`, and stderr tail. The
  catalog row's "needs" badge tells the user beforehand.
- Revision conflicts and name races go through the existing save path (409
  handling, replace confirmation).

## Testing

1. `tests/harness/mcp-catalog.spec.ts` (unit, no network):
   - every `config` is accepted by `upsertServer` (which validates through
     `parseMcpConfig`) on an empty v2 config, and the result stays disabled;
   - ids are unique and match the server-name pattern;
   - every `${NAME}` in `config` has a `secrets` entry and every secret is
     referenced;
   - every `placeholders` token appears in `config`, and no `<…>` token
     appears without being declared;
   - no credential-looking literal (no value in `env`/`headers`/`auth` that is
     not a `${NAME}` reference).
2. `web/components/settings/mcp-catalog.spec.tsx` (component):
   - Browse opens the catalog grouped by category, and filter narrows it;
   - choosing `brave-search` prefills the form, and the save body carries
     `env.BRAVE_API_KEY = "${BRAVE_API_KEY}"` with no `enabled: true`;
   - choosing an id that exists prefills `id-2`;
   - save is blocked while `<PROJECT_REF>` remains;
   - the secret banner reflects `listSecrets` results.
3. Existing MCP and settings specs must stay green. Run the affected specs,
   then `pnpm test`, `pnpm run typecheck`, and `pnpm run build:web`.

## Documentation

Add a short "Catalog" subsection to the MCP section of
`docs/capabilities.md`: what the catalog is, that it only prefills, and how to
add an entry (edit `src/harness/mcp/catalog.ts`, pass the unit test).

## Out of scope

Runtime registry search, auto-updating the catalog, OAuth dynamic client
registration, a `provenance.catalog` marker in `mcp.json`, install counts,
favourites, and a separate directory page.
