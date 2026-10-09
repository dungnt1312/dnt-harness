/** Browser-addressable workspace and conversation locations. */
export type AppRoute =
  | { readonly kind: 'root' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'session'; readonly workspaceId: string; readonly sessionId: string }
  /** The Automations view; `automationId` opens one editor, `new` a blank one. */
  | { readonly kind: 'automations'; readonly workspaceId: string; readonly automationId?: string }

const ROOT_ROUTE: AppRoute = { kind: 'root' }

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded === '' || decoded.includes('/') || decoded.includes('\\') ? null : decoded
  } catch {
    return null
  }
}

/** Parse only the public route grammar. Query strings and hashes are ignored. */
export function parseRoute(pathname: string): AppRoute | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return ROOT_ROUTE
  if (parts[0] !== 'workspaces') return null

  const workspaceId = parts.length >= 2 ? decodeSegment(parts[1] ?? '') : null
  if (workspaceId === null) return null
  if (parts.length === 2) return { kind: 'workspace', workspaceId }
  if (parts[2] === 'automations' && parts.length <= 4) {
    if (parts.length === 3) return { kind: 'automations', workspaceId }
    const automationId = decodeSegment(parts[3] ?? '')
    return automationId === null ? null : { kind: 'automations', workspaceId, automationId }
  }
  if (parts[2] !== 'sessions' || parts.length !== 4) return null

  const sessionId = decodeSegment(parts[3] ?? '')
  return sessionId === null ? null : { kind: 'session', workspaceId, sessionId }
}

export function routePath(route: AppRoute): string {
  if (route.kind === 'root') return '/'
  const workspace = encodeURIComponent(route.workspaceId)
  if (route.kind === 'workspace') return `/workspaces/${workspace}`
  if (route.kind === 'automations') {
    return `/workspaces/${workspace}/automations${route.automationId !== undefined ? `/${encodeURIComponent(route.automationId)}` : ''}`
  }
  return `/workspaces/${workspace}/sessions/${encodeURIComponent(route.sessionId)}`
}

export function workspaceRoute(workspaceId: string): AppRoute {
  return { kind: 'workspace', workspaceId }
}

export function sessionRoute(workspaceId: string, sessionId: string): AppRoute {
  return { kind: 'session', workspaceId, sessionId }
}

export function automationsRoute(workspaceId: string, automationId?: string): AppRoute {
  return { kind: 'automations', workspaceId, ...(automationId !== undefined ? { automationId } : {}) }
}
