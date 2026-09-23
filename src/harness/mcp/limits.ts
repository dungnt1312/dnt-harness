/**
 * Hard ceilings for bytes this process chooses to buffer. The runtime's own
 * HTTP header parser has a separate limit this module does not raise.
 */
export const MCP_LIMITS = {
  /** One JSON-RPC frame or stdio line, after UTF-8 decode. */
  maxFrameBytes: 1_048_576,
  /** Accumulated SSE body for a single response. */
  maxSseBytes: 2_097_152,
  /** tools/list pages followed before the cursor is treated as a loop. */
  maxToolPages: 32,
  /** Tools retained from one server. */
  maxTools: 256,
  /** JSON-RPC id / session id character cap. */
  maxIdLength: 128,
  /** Schema nesting accepted from a server. */
  maxSchemaDepth: 8,
  /** Outbound redirect hops. */
  maxRedirects: 3,
  /** Response headers this client will keep. */
  maxHeaderBytes: 16_384,
} as const

export type McpLimitName = keyof typeof MCP_LIMITS
