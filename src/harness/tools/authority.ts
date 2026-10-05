import type { ExecutionId, SessionId } from '../../util/brand.ts'
import type { ApprovalMode } from '../approval/resolution.ts'

/** Host facts refer to the exact finalized call, not model-supplied identity. */
export interface AuthorityFacts {
  readonly workspaceId: string
  readonly rootSessionId: SessionId
  readonly sessionId: SessionId
  readonly executionId: ExecutionId
  readonly callFingerprint: string
  readonly modeRevision: string | number
  readonly guardRevision?: string | number
  readonly guardHash?: string
}

export interface AskRequirement {
  readonly kind: 'tool-policy' | 'dangerous-command' | 'outside-path' | 'interaction'
  readonly subjectFingerprint?: string
  readonly version?: string | number
}

export type AuthorityDecision =
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly requirements: readonly AskRequirement[] }
  | { readonly kind: 'allow' }

export interface AuthorityInput {
  readonly permission: ApprovalMode
  readonly hardDenial?: string
  readonly requirements?: readonly AskRequirement[]
  /** Host resolvers must opt into scope validation; standalone policy stays compatible. */
  readonly scopeMode?: 'host' | 'standalone'
  readonly facts?: AuthorityFacts
}

/** No resource lookups or ambient scope. Hard restrictions always win. */
export function composeAuthority(input: AuthorityInput): AuthorityDecision {
  if (input.scopeMode === 'host') {
    const facts = input.facts
    if (facts === undefined || !facts.workspaceId || !facts.rootSessionId || !facts.sessionId || !facts.executionId || !facts.callFingerprint || facts.modeRevision === undefined) {
      return { kind: 'deny', reason: 'required host execution authority scope is missing' }
    }
  }
  if (input.hardDenial !== undefined) return { kind: 'deny', reason: input.hardDenial }
  if (input.permission === 'deny') return { kind: 'deny', reason: 'tool policy denies this call' }
  const requirements = [...(input.requirements ?? [])]
  if (input.permission === 'ask' && !requirements.some((requirement) => requirement.kind === 'tool-policy')) {
    requirements.unshift({ kind: 'tool-policy', ...(input.facts !== undefined ? { subjectFingerprint: input.facts.callFingerprint, version: input.facts.modeRevision } : {}) })
  }
  return requirements.length > 0 ? { kind: 'ask', requirements } : { kind: 'allow' }
}
