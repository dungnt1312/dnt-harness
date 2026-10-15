import type { AttemptFact } from '../llm/request-lifecycle.ts'
import type { TokenUsage } from '../llm/types.ts'
import { isValidContextId, isValidTokenUsage } from './context-metrics.ts'

export type ContextDisplayState =
  | { readonly kind: 'request'; readonly contextId?: string }
  | { readonly kind: 'post-compaction'; readonly compactionSeq: number; readonly coversSeq: number }
  | { readonly kind: 'unavailable'; readonly reason: 'legacy-compaction'|'preview-failed' }
export interface CacheTotals { readonly cacheableInputTokens: number; readonly cachedInputTokens: number }
export interface UsageView extends CacheTotals { readonly last?: TokenUsage }
export interface ManifestShape {
  readonly contextId?: string
  readonly model?: string
  readonly provider?: string
  readonly budget: { readonly usedTokens: number; readonly availableTokens: number; readonly contextLimitTokens?: number; readonly estimated: boolean }
  readonly history: { readonly setting: string }
}
export type AvailableContext<M extends ManifestShape> = M & { readonly display?: Exclude<ContextDisplayState,{kind:'unavailable'}>; readonly usage?: UsageView }
export interface UnavailableContext { readonly display: Extract<ContextDisplayState,{kind:'unavailable'}>; readonly usage: CacheTotals }
export type ContextResponse<M extends ManifestShape> = AvailableContext<M>|UnavailableContext
export interface ContextEvent<M extends ManifestShape> {
  readonly seq: number
  readonly type: string
  readonly turnId?: string
  readonly manifest?: M
  readonly fact?: AttemptFact
  readonly coversSeq?: number
  readonly summary?: string
  readonly error?: string
  readonly contextAfter?: M
  readonly contextEffect?: 'replaced'|'unchanged'
  readonly measurement?: { readonly unavailableReason?: 'preview-failed' }
}
export interface ContextReducer<M extends ManifestShape> {
  apply(events: readonly ContextEvent<M>[]): readonly string[]
  current(): ContextResponse<M>|null
  request(contextId: string): AvailableContext<M>|undefined
}
export function isAvailableContext<M extends ManifestShape>(view: ContextResponse<M>): view is AvailableContext<M> {
  return 'budget' in view
}

/** Pure, incremental, browser-safe projection. Its input is one session's log. */
export function createContextReducer<M extends ManifestShape>(initialSessionId?: string): ContextReducer<M> {
  let sessionId = initialSessionId
  const entries = new Map<string,{ manifest: M; turnId?: string; last?: TokenUsage; view: AvailableContext<M> }>()
  const attempts = new Map<string,TokenUsage>()
  let cacheableInputTokens = 0
  let cachedInputTokens = 0
  let latestManifest: M|undefined
  let currentKey: string|undefined
  let current: ContextResponse<M>|null = null
  let display: ContextDisplayState|undefined
  let lastSeq = 0
  const totals = (): CacheTotals => ({cacheableInputTokens,cachedInputTokens})
  const requestView = (entry: {manifest:M;last?:TokenUsage}): AvailableContext<M> => ({
    ...entry.manifest,
    display: {kind:'request',...(entry.manifest.contextId !== undefined ? {contextId:entry.manifest.contextId}: {})},
    usage: {...totals(),...(entry.last !== undefined ? {last:entry.last}: {})},
  })
  const refreshCurrentTotals = (): void => {
    if (current === null) return
    if (currentKey !== undefined && display?.kind === 'request') {
      const entry = entries.get(currentKey)
      if (entry !== undefined) { entry.view = requestView(entry); current = entry.view }
    } else current = {...current,usage:totals()}
  }
  return {
    current: () => current,
    request: id => entries.get(id)?.view,
    apply(events) {
      const changed = new Set<string>()
      for (const event of events) {
        if (event.seq <= lastSeq) continue
        lastSeq = event.seq
        if (event.type === 'context/manifest' && event.manifest !== undefined) {
          const m = event.manifest
          const key = isValidContextId(m.contextId) ? m.contextId : `legacy:${event.seq}`
          if (entries.has(key)) continue
          const entry = {manifest:m,...(event.turnId !== undefined ? {turnId:event.turnId}: {}),view:{} as AvailableContext<M>}
          entry.view = requestView(entry)
          entries.set(key,entry); latestManifest = m; currentKey = key
          display = entry.view.display; current = entry.view; changed.add(key)
          continue
        }
        if (['model/attempt','execution/uncertain','execution/reconciled'].includes(event.type)) {
          const f = event.fact
          if (f === undefined || f.state === 'start' || !isValidContextId(f.contextId) || !isValidTokenUsage(f.usage) || f.attribution === undefined) continue
          const entry = entries.get(f.contextId)
          if (entry === undefined || (entry.turnId !== undefined && entry.turnId !== f.attribution.turnId)
            || (entry.manifest.model !== undefined && f.model !== undefined && entry.manifest.model !== f.model)
            || (entry.manifest.provider !== undefined && f.provider !== undefined && entry.manifest.provider !== f.provider)) continue
          sessionId ??= f.attribution.sessionId
          if (f.attribution.sessionId !== sessionId || attempts.has(f.attemptId)) continue
          attempts.set(f.attemptId,{...f.usage})
          if (f.usage.cachedInputTokens !== undefined) {
            cacheableInputTokens += f.usage.inputTokens; cachedInputTokens += f.usage.cachedInputTokens
          }
          entry.last = {...f.usage}; entry.view = requestView(entry); changed.add(f.contextId)
          refreshCurrentTotals()
          continue
        }
        if (event.type === 'compaction/end' && event.error === undefined && typeof event.summary === 'string' && event.summary.trim() !== ''
          && event.coversSeq !== undefined && event.contextEffect !== 'unchanged'
          && (event.contextEffect === 'replaced' || latestManifest?.history.setting === 'compact')) {
          currentKey = undefined
          if (event.contextAfter !== undefined) {
            display = {kind:'post-compaction',compactionSeq:event.seq,coversSeq:event.coversSeq}
            current = {...event.contextAfter,display,usage:totals()}
          } else {
            display = {kind:'unavailable',reason:event.measurement?.unavailableReason ?? 'legacy-compaction'}
            current = {display,usage:totals()}
          }
        }
      }
      return [...changed]
    },
  }
}
export function deriveContextState<M extends ManifestShape>(events: readonly ContextEvent<M>[],sessionId: string): ContextResponse<M>|null {
  const reducer = createContextReducer<M>(sessionId)
  reducer.apply(events)
  return reducer.current()
}
