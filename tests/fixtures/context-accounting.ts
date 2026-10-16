import type { ContextManifest } from '../../src/harness/context/builder.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import type { TokenUsage } from '../../src/harness/llm/types.ts'

export function manifest(contextId?: string): ContextManifest {
  return {
    ...(contextId !== undefined ? { contextId } : {}), modeId: 'default', modeRevision: 1,
    model: 'scripted', provider: 'scripted',
    budget: { usedTokens: 6_000, availableTokens: 250_880, contextLimitTokens: 256_000, estimated: true },
    breakdown: { systemPrompt: 1_000, systemTools: 2_000, mcpTools: 0, metaContext: 0, skills: 0, messages: 3_000 },
    history: { setting: 'compact', includedTurns: 1, omittedTurns: 0 },
    sources: { skills: [], memory: [], toolNames: [], toolSchemas: 0 }, omissions: [], sections: [],
  }
}
export function row(seq: number, payload: Record<string, unknown>): SessionEvent {
  return { seq, timestamp: seq, ...payload } as unknown as SessionEvent
}
export function attempt(seq: number, contextId: string, attemptId: string, usage: TokenUsage,
  state: 'end'|'uncertain'|'reconciled' = 'end'): SessionEvent {
  return row(seq, { type: state === 'end' ? 'model/attempt' : `execution/${state}`, fact: {
    contextId, attemptId, usage, state, requestId: 'logical-owner', attempt: 1,
    transportSettled: state !== 'uncertain', committed: false,
    provider: 'scripted', model: 'scripted', attribution: { sessionId: 's', turnId: 't', stepId: 'step' },
  } })
}
