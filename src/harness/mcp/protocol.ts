/**
 * Checks for the pinned MCP `2025-06-18` tool profile. A bad envelope fails
 * before the client sends `notifications/initialized`.
 */
import { acceptProtocolVersion, boundToolMetadata, MCP_METADATA_NAME_MAX } from './boundaries.ts'
import { MCP_LIMITS } from './limits.ts'

export class ProtocolError extends Error {
  constructor(readonly diagnostic: string, message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export function assertInitializeResult(result: unknown): void {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProtocolError('malformed_negotiation', 'initialize result is not an object')
  }
  const record = result as Record<string, unknown>
  if (typeof record['protocolVersion'] !== 'string') {
    throw new ProtocolError('unsupported_protocol_version', 'initialize result omitted protocolVersion')
  }
  const accepted = acceptProtocolVersion(record['protocolVersion'])
  if (!accepted.accepted) {
    throw new ProtocolError('unsupported_protocol_version', `protocol ${record['protocolVersion']} is not accepted`)
  }
  const capabilities = record['capabilities']
  if (capabilities !== undefined && (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities))) {
    throw new ProtocolError('malformed_negotiation', 'initialize capabilities must be an object')
  }
  const info = record['serverInfo']
  if (info !== undefined) {
    if (info === null || typeof info !== 'object' || Array.isArray(info)) {
      throw new ProtocolError('malformed_negotiation', 'serverInfo must be an object')
    }
    const name = (info as Record<string, unknown>)['name']
    if (name !== undefined && (typeof name !== 'string' || name.length > MCP_METADATA_NAME_MAX)) {
      throw new ProtocolError('malformed_negotiation', 'serverInfo.name is unusable')
    }
  }
}

/** Reject a tools/list page that repeats a cursor or runs past the page cap. */
export function assertCursor(cursor: string | undefined, seen: ReadonlySet<string>, page: number): void {
  if (page > MCP_LIMITS.maxToolPages) throw new ProtocolError('malformed_negotiation', 'tools/list exceeded the page cap')
  if (cursor === undefined || cursor === '') return
  if (cursor.length > MCP_LIMITS.maxIdLength) throw new ProtocolError('malformed_negotiation', 'tools/list cursor is too long')
  if (seen.has(cursor)) throw new ProtocolError('malformed_negotiation', 'tools/list repeated a cursor')
}

export function assertSessionId(sessionId: string): void {
  if (sessionId.length === 0 || sessionId.length > MCP_LIMITS.maxIdLength || /[\r\n]/.test(sessionId)) {
    throw new ProtocolError('malformed_negotiation', 'MCP session id is unusable')
  }
}

/** Bound one server tool before it is shown to the model. */
export function vettedTool(server: string, tool: { readonly name: string; readonly description?: string; readonly inputSchema: unknown; readonly annotations?: Readonly<Record<string, unknown>> }): ReturnType<typeof boundToolMetadata> {
  if (schemaDepth(tool.inputSchema) > MCP_LIMITS.maxSchemaDepth) {
    throw new ProtocolError('metadata_rejected', `tool '${tool.name}' schema is too deep`)
  }
  return boundToolMetadata({
    server,
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  })
}

function schemaDepth(value: unknown, depth = 0): number {
  if (depth > MCP_LIMITS.maxSchemaDepth) return depth
  if (value === null || typeof value !== 'object') return depth
  let max = depth
  for (const child of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, schemaDepth(child, depth + 1))
  }
  return max
}
