/**
 * Frozen MCP production boundaries (phase 1). Later phases consume these
 * names; they do not invent parallel outcome, receipt, or version vocabularies.
 *
 * Nothing here dispatches a tool call. The receipt contract exists so phase 4
 * can record intent before the one allowed transport dispatch.
 */

/** The only protocol version this release negotiates. */
export const MCP_ACCEPTED_PROTOCOL_VERSION = '2025-06-18' as const

/**
 * Stable diagnostic categories. A version outside the accepted set fails as
 * `unsupported_protocol_version` until a later release adds it explicitly.
 */
export type McpDiagnostic =
  | 'unsupported_protocol_version'
  | 'malformed_negotiation'
  | 'dispatch_not_sent'
  | 'dispatch_possibly_sent'
  | 'indeterminate_outcome'
  | 'audit_fault'
  | 'metadata_rejected'
  | 'config_unreadable'

export interface ProtocolVersionEntry {
  readonly version: typeof MCP_ACCEPTED_PROTOCOL_VERSION
  readonly status: 'accepted'
  /** How a version enters or leaves the accepted set. */
  readonly changePolicy: string
}

/**
 * Update procedure: a new version is added only with a reviewed fixture, a
 * deprecation note for the version it replaces, and a diagnostic mapping.
 * Silent acceptance of older or future versions is forbidden.
 */
export const PROTOCOL_VERSION_TABLE: readonly ProtocolVersionEntry[] = [
  {
    version: MCP_ACCEPTED_PROTOCOL_VERSION,
    status: 'accepted',
    changePolicy: 'Add a version only with a reviewed fixture and an explicit diagnostic mapping. Anything else is unsupported_protocol_version.',
  },
]

/** Whether a negotiated version is accepted by this release. */
export function acceptProtocolVersion(version: string):
  | { readonly accepted: true; readonly version: typeof MCP_ACCEPTED_PROTOCOL_VERSION }
  | { readonly accepted: false; readonly diagnostic: 'unsupported_protocol_version' } {
  if (version === MCP_ACCEPTED_PROTOCOL_VERSION) return { accepted: true, version }
  return { accepted: false, diagnostic: 'unsupported_protocol_version' }
}

/**
 * What the transport may honestly say after one attempt to send `tools/call`.
 *
 * - `not_dispatched`: the bytes never left the client. A later automatic
 *   attempt of the SAME invocation is still forbidden once phase 4 lands; the
 *   caller records a local error instead of replaying.
 * - `possibly_dispatched`: the request may have reached the server (write
 *   callback/backpressure uncertainty, HTTP fetch already started, redirect
 *   already followed, cancellation after send, reconnect, re-auth, or process
 *   death after the write). The outcome is `indeterminate`. Never retry.
 */
export type DispatchReceipt =
  | { readonly kind: 'not_dispatched'; readonly reason: DispatchNotSentReason }
  | { readonly kind: 'possibly_dispatched'; readonly reason: DispatchMaybeSentReason }

export type DispatchNotSentReason =
  | 'not_connected'
  | 'write_rejected_before_flush'
  | 'cancelled_before_send'
  | 'local_policy_denied'

export type DispatchMaybeSentReason =
  | 'write_accepted_or_buffered'
  | 'http_fetch_started'
  | 'redirect_followed'
  | 'cancelled_after_send'
  | 'reconnect_after_send'
  | 'reauth_after_send'
  | 'process_died_after_send'
  | 'response_lost'

/**
 * Classify a transport-level failure that happened around a single dispatch.
 * `sent` is true once the client can no longer prove the request stayed local.
 */
/** A tools/call that ended without a normal result, with an honest receipt. */
export class McpDispatchError extends Error {
  constructor(message: string, readonly receipt: DispatchReceipt) {
    super(message)
    this.name = 'McpDispatchError'
  }
}

export function receiptForTransportFailure(sent: boolean, reason: DispatchNotSentReason | DispatchMaybeSentReason): DispatchReceipt {
  if (!sent) {
    const local = reason as DispatchNotSentReason
    return { kind: 'not_dispatched', reason: local }
  }
  return { kind: 'possibly_dispatched', reason: reason as DispatchMaybeSentReason }
}

/** Server-supplied tool metadata is untrusted model context, never host policy. */
export interface UntrustedToolMetadata {
  readonly provenance: 'mcp-server'
  readonly server: string
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  /** Annotations are displayed data. They never lower an approval requirement. */
  readonly annotations?: Readonly<Record<string, unknown>>
}

export const MCP_METADATA_DESCRIPTION_MAX = 4_096
export const MCP_METADATA_NAME_MAX = 128

/**
 * Bound and label server metadata. A description that tries to impersonate
 * host policy is truncated and kept as data; it is never parsed as policy.
 * Returns undefined when the name itself is unusable.
 */
export function boundToolMetadata(input: {
  readonly server: string
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
  readonly annotations?: Readonly<Record<string, unknown>>
}): UntrustedToolMetadata | undefined {
  const name = input.name.trim()
  if (name === '' || name.length > MCP_METADATA_NAME_MAX) return undefined
  const raw = input.description ?? ''
  const description = raw.length > MCP_METADATA_DESCRIPTION_MAX ? raw.slice(0, MCP_METADATA_DESCRIPTION_MAX) : raw
  return {
    provenance: 'mcp-server',
    server: input.server,
    name,
    description,
    inputSchema: input.inputSchema,
    ...(input.annotations !== undefined ? { annotations: input.annotations } : {}),
  }
}

/**
 * Annotations never reduce approval. `readOnlyHint` and any instruction-like
 * text stay informational; the host policy decision is unchanged.
 */
export function annotationMayReduceApproval(_annotations: Readonly<Record<string, unknown>> | undefined): false {
  return false
}

/**
 * Deployment facts this release is willing to claim.
 * Hard containment is not claimed here — phase 6 proves platform primitives.
 */
export const DEPLOYMENT_BOUNDARY = {
  ownersPerDataHome: 1,
  processModel: 'pm2-fork-single-instance',
  clusterMode: 'rejected',
  /** Oldest binary/schema this release can still read without a migration. */
  minimumSafeRollbackFloor: { binary: '0.1.0', configSchema: 1 as const },
  localAuthProfile: 'loopback-single-user',
  nonLoopback: 'requires-authenticated-tls-profile',
  sameUserMalwareProtection: false,
  sameOriginXssProtection: false,
  envMinimizationIsSandbox: false,
} as const
