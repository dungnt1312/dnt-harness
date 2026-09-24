/**
 * Authentication migration inventory for the local control plane.
 * Phase 2 owns enforcement. This table is the contract it must not shrink:
 * every privileged route has an owner, an expected denial, and a client.
 *
 * `public` routes stay reachable without a session. Everything else is
 * default-deny once phase 2 lands.
 */

export type RouteAuth = 'public' | 'authenticated'
export type RouteCredential = 'none' | 'cookie+csrf' | 'scoped-bearer' | 'operator-key'
export type RouteOwner = 'phase-2-control-plane' | 'existing-host-guard' | 'static'

export interface RouteInventoryEntry {
  readonly id: string
  readonly methods: readonly string[]
  readonly pattern: string
  readonly auth: RouteAuth
  readonly credential: RouteCredential
  readonly denial: 400 | 401 | 403 | 409 | null
  readonly owner: RouteOwner
  readonly clients: readonly ('browser' | 'cli' | 'headless' | 'pm2' | 'test')[]
  readonly notes: string
}

export const ROUTE_INVENTORY: readonly RouteInventoryEntry[] = [
  { id: 'static', methods: ['GET'], pattern: '/* (non-/api)', auth: 'public', credential: 'none', denial: null, owner: 'static', clients: ['browser'], notes: 'The app shell. Host allow-list still applies.' },
  { id: 'workspaces', methods: ['GET', 'POST', 'PATCH', 'DELETE'], pattern: '/api/workspaces', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Workspace lifecycle.' },
  { id: 'workspace', methods: ['GET', 'POST', 'PATCH', 'DELETE'], pattern: '/api/workspaces/:id', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Single workspace.' },
  { id: 'sessions', methods: ['GET', 'POST'], pattern: '/api/workspaces/:id/sessions', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'cli', 'test'], notes: 'Session list and create.' },
  { id: 'session', methods: ['DELETE', 'PATCH'], pattern: '/api/workspaces/:id/sessions/:sid', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Session mutation.' },
  { id: 'session-grants', methods: ['GET', 'PUT'], pattern: '/api/workspaces/:id/sessions/:sid/grants', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Session folder grants for file tools. PUT is browser-principal only and revision-checked (409 when stale).' },
  { id: 'session-events', methods: ['GET'], pattern: '/api/workspaces/:id/sessions/:sid/events', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'SSE. Logout fences the stream.' },
  { id: 'session-messages', methods: ['POST'], pattern: '/api/workspaces/:id/sessions/:sid/messages', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'cli', 'test'], notes: 'Starts a turn.' },
  { id: 'session-stop', methods: ['POST'], pattern: '/api/workspaces/:id/sessions/:sid/stop', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Cancels a turn.' },
  { id: 'agents', methods: ['GET', 'POST', 'DELETE'], pattern: '/api/workspaces/:id/agents/:name', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Agent definitions. Spawn can run tools.' },
  { id: 'agent-import', methods: ['POST'], pattern: '/api/workspaces/:id/agents/:name/import', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Imports executable definitions.' },
  { id: 'children', methods: ['GET', 'POST'], pattern: '/api/workspaces/:id/children/:cid', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Child wait/cancel.' },
  { id: 'mcp', methods: ['GET', 'POST', 'DELETE'], pattern: '/api/workspaces/:id/mcp/:server', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Executable MCP configuration.' },
  { id: 'mcp-import', methods: ['POST'], pattern: '/api/workspaces/:id/mcp/import', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Imports server commands.' },
  { id: 'hooks', methods: ['GET', 'PUT'], pattern: '/api/workspaces/:id/hooks', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Hook commands run on the host.' },
  { id: 'secrets', methods: ['GET', 'PUT', 'DELETE'], pattern: '/api/workspaces/:id/secrets/:key', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Credential mutations. GET returns names only.' },
  { id: 'approvals', methods: ['POST'], pattern: '/api/approvals/:id', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'Settles a tool approval. Revocation fences in-flight asks.' },
  { id: 'terminals', methods: ['GET', 'POST', 'DELETE'], pattern: '/api/workspaces/:id/terminals', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'PTY control. Non-loopback stays 403 from the existing host guard, before auth.' },
  { id: 'terminal-events', methods: ['GET'], pattern: '/api/workspaces/:id/terminals/events', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'Terminal SSE. Separate from MCP process ownership.' },
  { id: 'providers', methods: ['GET', 'POST', 'PATCH', 'DELETE'], pattern: '/api/providers', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Provider keys.' },
  { id: 'model-defaults', methods: ['GET', 'PUT'], pattern: '/api/model-defaults', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Global model default.' },
  { id: 'modes', methods: ['GET', 'PUT', 'DELETE', 'POST'], pattern: '/api/workspaces/:id/modes', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Permission mode files.' },
  { id: 'skills', methods: ['GET', 'PUT', 'DELETE'], pattern: '/api/workspaces/:id/skills', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Skill files.' },
  { id: 'memory', methods: ['GET', 'POST', 'PATCH', 'DELETE'], pattern: '/api/workspaces/:id/memory', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Memory entries.' },
  { id: 'projects', methods: ['GET', 'POST', 'PATCH', 'DELETE'], pattern: '/api/workspaces/:id/projects', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Project bindings. Busy retarget is 409.' },
  { id: 'project-files', methods: ['GET'], pattern: '/api/workspaces/:id/projects/:pid/files', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'Reads workspace files.' },
  { id: 'fs-dirs', methods: ['GET'], pattern: '/api/fs/dirs', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'Server-side directory listing.' },
  { id: 'attachments', methods: ['GET', 'POST'], pattern: '/api/workspaces/:id/attachments', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'Upload bytes.' },
  { id: 'legacy-sessions', methods: ['GET', 'POST', 'DELETE', 'PATCH'], pattern: '/api/sessions', auth: 'authenticated', credential: 'scoped-bearer', denial: 401, owner: 'phase-2-control-plane', clients: ['cli', 'headless', 'test'], notes: 'Memory-mode routes. Bearer is the non-browser credential.' },
  { id: 'meta', methods: ['GET'], pattern: '/api/meta', auth: 'public', credential: 'none', denial: null, owner: 'existing-host-guard', clients: ['browser', 'cli'], notes: 'Non-sensitive host metadata. Host allow-list still applies.' },
  { id: 'health', methods: ['GET'], pattern: '/api/health', auth: 'public', credential: 'none', denial: null, owner: 'phase-2-control-plane', clients: ['browser', 'pm2', 'test'], notes: 'Liveness only: `{ ok: true }`.' },
  { id: 'auth-state', methods: ['GET'], pattern: '/api/auth/state', auth: 'public', credential: 'none', denial: null, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'This browser\'s pairing state; a live session also gets its CSRF token back, a dead cookie is cleared.' },
  { id: 'auth-pair', methods: ['POST'], pattern: '/api/auth/pair', auth: 'public', credential: 'none', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'test'], notes: 'Redeems a single-use code for a browser session. Refuses any cookie or query string.' },
  { id: 'auth-pairing-code', methods: ['POST'], pattern: '/api/auth/pairing-code', auth: 'public', credential: 'operator-key', denial: 403, owner: 'phase-2-control-plane', clients: ['cli', 'test'], notes: 'Operator recovery (`npm run pair`): mints a code for whoever can read the data home\'s operator file.' },
  { id: 'auth-logout', methods: ['POST'], pattern: '/api/auth/logout', auth: 'authenticated', credential: 'cookie+csrf', denial: 401, owner: 'phase-2-control-plane', clients: ['browser', 'cli'], notes: 'Revokes the caller\'s session or bearer and closes its streams.' },
  { id: 'mcp-oauth-callback', methods: ['GET', 'POST'], pattern: '/api/mcp/oauth/callback', auth: 'public', credential: 'none', denial: 400, owner: 'phase-2-control-plane', clients: ['browser'], notes: 'Deposits an authorization code only; completion needs the initiating session.' },
]

/** Privileged entries phase 2 must authenticate. A missing id is a contract break. */
export function privilegedRoutes(): readonly RouteInventoryEntry[] {
  return ROUTE_INVENTORY.filter((entry) => entry.auth === 'authenticated')
}
