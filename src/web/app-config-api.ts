import type { IncomingMessage } from 'node:http'
import type { AppConfigService } from '../harness/config/service.ts'
import { AppConfigError, type LimitEdit } from '../harness/config/types.ts'

const CONFIG_PATH = '/api/app-config'
const RELOAD_PATH = '/api/app-config/reload'

/** Request-shape refusal raised before the service is consulted. */
class BadRequest extends Error {}

/** Body keys must be exactly `allowed`; anything else is a malformed request. */
function requireKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new BadRequest(`unexpected request field '${key}'`)
  }
}

async function readBody(req: IncomingMessage, readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await readJson(req)
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error))
  }
}

function statusOf(error: AppConfigError): number {
  switch (error.code) {
    case 'invalid': return 400
    case 'conflict':
    case 'locked': return 409
    case 'io': return 500
  }
}

/**
 * HTTP adapter for the global configuration service. Authentication and CSRF
 * are enforced by the server before dispatch; this only checks the request
 * shape, delegates to the service, and maps its errors to statuses. Edit
 * contents (keys, values, batch rules) are validated by the service itself.
 * Returns false for paths it does not own.
 */
export async function handleAppConfigApi(
  req: IncomingMessage,
  pathname: string,
  service: AppConfigService,
  send: (status: number, body: unknown) => void,
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>,
): Promise<boolean> {
  if (pathname !== CONFIG_PATH && pathname !== RELOAD_PATH) return false
  const method = req.method ?? 'GET'
  try {
    if (pathname === CONFIG_PATH && method === 'GET') {
      send(200, await service.describe())
    } else if (pathname === CONFIG_PATH && method === 'PATCH') {
      const body = await readBody(req, readJson)
      requireKeys(body, ['expectedHash', 'edits'])
      const { expectedHash, edits } = body
      if (typeof expectedHash !== 'string') throw new BadRequest('expectedHash must be a string')
      if (!Array.isArray(edits)) throw new BadRequest('edits must be an array')
      // Each edit is re-validated by the service, which treats its input as untrusted.
      send(200, await service.edit(edits as LimitEdit[], expectedHash))
    } else if (pathname === RELOAD_PATH && method === 'POST') {
      requireKeys(await readBody(req, readJson), [])
      send(200, await service.reload())
    } else {
      send(405, { error: 'method not allowed' })
    }
  } catch (error) {
    if (error instanceof BadRequest) send(400, { error: error.message })
    else if (error instanceof AppConfigError) {
      send(statusOf(error), { error: error.message, code: error.code, ...(error.key !== undefined ? { key: error.key } : {}) })
    } else send(500, { error: error instanceof Error ? error.message : String(error) })
  }
  return true
}
