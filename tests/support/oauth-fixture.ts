/**
 * A loopback MCP server with its own OAuth authorization server, shaped like
 * the hosted providers (Linear, Notion): 401 + Bearer challenge, RFC 9728
 * protected-resource metadata, RFC 8414 metadata, RFC 7591 registration,
 * an authorize endpoint that redirects with a code, token and revocation.
 * Every knob a test needs to break one step is an option.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface OAuthFixtureOptions {
  /** Path of the MCP endpoint. Default `/mcp`. */
  readonly mcpPath?: string
  /** Advertise PRM in the challenge header (default true). */
  readonly challengeMetadata?: boolean
  /** Serve PRM at the well-known path (default true). */
  readonly wellKnownPrm?: boolean
  /** Override the PRM `resource`. */
  readonly prmResource?: (origin: string) => string
  /** Override the AS issuer path, e.g. `/tenant`. Default '' (origin). */
  readonly issuerPath?: string
  /** Serve AS metadata via OIDC only (default false: RFC 8414). */
  readonly oidcOnly?: boolean
  /** Report this issuer instead of the real one. */
  readonly issuerOverride?: string
  readonly codeChallengeMethods?: readonly string[]
  /** Offer dynamic registration (default true). */
  readonly registration?: boolean
  /** Make registration answer with a client_secret. */
  readonly registrationReturnsSecret?: boolean
  readonly tokenEndpointAuthMethods?: readonly string[]
  readonly prmScopes?: readonly string[]
  readonly challengeScope?: string
  /** Scope the MCP endpoint requires; a token without it gets 403 insufficient_scope. */
  readonly requiredScope?: string
}

export interface OAuthFixture {
  readonly origin: string
  readonly mcpUrl: string
  readonly issuer: string
  readonly registrations: Array<Record<string, unknown>>
  readonly tokenRequests: URLSearchParams[]
  readonly revocations: URLSearchParams[]
  /** Every authorize request the browser made, as parsed URLs. */
  readonly authorizations: URL[]
  readonly requests: string[]
  /** Follow an authorization URL the way a browser would and return the callback URL. */
  authorize(authorizationUrl: string): Promise<URL>
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

export async function startOAuthFixture(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
  const mcpPath = options.mcpPath ?? '/mcp'
  const registrations: Array<Record<string, unknown>> = []
  const tokenRequests: URLSearchParams[] = []
  const revocations: URLSearchParams[] = []
  const authorizations: URL[] = []
  const requests: string[] = []
  const grantedScopes = new Map<string, string>()
  let tokenCounter = 0
  let origin = ''
  const issuerPath = options.issuerPath ?? ''
  const issuer = (): string => `${origin}${issuerPath}`
  const prmPath = `/.well-known/oauth-protected-resource${mcpPath}`

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    requests.push(`${req.method} ${url.pathname}`)
    const body = await readBody(req)

    if (url.pathname === mcpPath) {
      const auth = req.headers.authorization
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
      if (token === undefined || !grantedScopes.has(token)) {
        const params = [
          'realm="OAuth"',
          ...(options.challengeMetadata !== false ? [`resource_metadata="${origin}${prmPath}"`] : []),
          ...(options.challengeScope !== undefined ? [`scope="${options.challengeScope}"`] : []),
        ]
        json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer ${params.join(', ')}` })
        return
      }
      const granted = (grantedScopes.get(token) ?? '').split(' ')
      if (options.requiredScope !== undefined && !granted.includes(options.requiredScope)) {
        json(res, 403, { error: 'insufficient_scope' }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${options.requiredScope}"` })
        return
      }
      const rpc = JSON.parse(body) as { id?: number; method: string }
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } }
        : { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] }
      json(res, 200, { jsonrpc: '2.0', id: rpc.id, result })
      return
    }

    if (options.wellKnownPrm !== false && (url.pathname === prmPath || url.pathname === '/.well-known/oauth-protected-resource')) {
      json(res, 200, {
        resource: options.prmResource?.(origin) ?? `${origin}${mcpPath}`,
        authorization_servers: [issuer()],
        ...(options.prmScopes !== undefined ? { scopes_supported: options.prmScopes } : {}),
      })
      return
    }

    const metadata = {
      issuer: options.issuerOverride ?? issuer(),
      authorization_endpoint: `${issuer()}/authorize`,
      token_endpoint: `${issuer()}/token`,
      revocation_endpoint: `${issuer()}/revoke`,
      ...(options.registration !== false ? { registration_endpoint: `${issuer()}/register` } : {}),
      code_challenge_methods_supported: options.codeChallengeMethods ?? ['S256'],
      token_endpoint_auth_methods_supported: options.tokenEndpointAuthMethods ?? ['none', 'client_secret_post'],
    }
    const rfc8414 = `/.well-known/oauth-authorization-server${issuerPath}`
    const oidcInsert = `/.well-known/openid-configuration${issuerPath}`
    if (!options.oidcOnly && url.pathname === rfc8414) { json(res, 200, metadata); return }
    if (options.oidcOnly && url.pathname === oidcInsert) { json(res, 200, metadata); return }

    if (url.pathname === `${issuerPath}/register` && req.method === 'POST' && options.registration !== false) {
      const request = JSON.parse(body) as Record<string, unknown>
      registrations.push(request)
      json(res, 201, {
        ...request,
        client_id: `registered-${registrations.length}`,
        ...(options.registrationReturnsSecret === true ? { client_secret: 'issued-secret', token_endpoint_auth_method: 'client_secret_post' } : {}),
      })
      return
    }

    if (url.pathname === `${issuerPath}/authorize`) {
      authorizations.push(url)
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      redirect.searchParams.set('code', `code-for-${url.searchParams.get('scope') ?? ''}`)
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
      res.writeHead(302, { location: redirect.toString() })
      res.end()
      return
    }

    if (url.pathname === `${issuerPath}/token` && req.method === 'POST') {
      const form = new URLSearchParams(body)
      tokenRequests.push(form)
      tokenCounter += 1
      const scope = form.get('grant_type') === 'authorization_code'
        ? (form.get('code') ?? '').replace(/^code-for-/, '')
        : [...grantedScopes.values()].at(-1) ?? ''
      const access = `fixture-access-${tokenCounter}`
      grantedScopes.set(access, scope)
      json(res, 200, { access_token: access, refresh_token: `fixture-refresh-${tokenCounter}`, expires_in: 3600, token_type: 'Bearer' })
      return
    }

    if (url.pathname === `${issuerPath}/revoke` && req.method === 'POST') {
      revocations.push(new URLSearchParams(body))
      res.writeHead(200); res.end()
      return
    }

    json(res, 404, { error: 'not found' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    mcpUrl: `${origin}${mcpPath}`,
    get issuer() { return issuer() },
    registrations,
    tokenRequests,
    revocations,
    authorizations,
    requests,
    async authorize(authorizationUrl: string): Promise<URL> {
      const response = await fetch(authorizationUrl, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (location === null) throw new Error(`authorize did not redirect (HTTP ${response.status})`)
      return new URL(location)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
