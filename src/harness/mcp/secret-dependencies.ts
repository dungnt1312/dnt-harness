/**
 * Which workspace secrets a server's configuration reads. A `${NAME}`
 * reference may be the whole value or sit inside one (`Bearer ${TOKEN}`), in
 * env, headers, a static auth token, or a managed OAuth client secret.
 */
import type { McpConfig, McpServerConfig } from './config.ts'
import { authSecretRef } from './config.ts'

const REFERENCE = /\$\{([A-Za-z0-9_]+)\}/g

export function secretRefsOf(server: McpServerConfig): ReadonlySet<string> {
  const values = [
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
    authSecretRef(server.auth),
    server.auth?.type === 'managed_oauth' ? server.auth.clientSecret : undefined,
  ]
  const names = new Set<string>()
  for (const value of values) {
    if (value === undefined) continue
    for (const match of value.matchAll(REFERENCE)) names.add(match[1]!)
  }
  return names
}

/** Names of the servers whose configuration reads `secret`, in config order. */
export function serversUsingSecret(config: McpConfig, secret: string, options: { readonly enabledOnly?: boolean } = {}): string[] {
  return Object.values(config.servers)
    .filter((server) => options.enabledOnly !== true || server.enabled)
    .filter((server) => secretRefsOf(server).has(secret))
    .map((server) => server.name)
}
