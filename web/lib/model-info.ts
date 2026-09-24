/**
 * UI-side view over the shared model catalog (`src/harness/llm/model-catalog.ts`):
 * capability badges, effective context windows, and thinking-level
 * resolution. The web bundles the same pure module the server resolves
 * budgets with — never a divergent copy.
 */
import {
  defaultThinkingLevel,
  expressibleThinkingLevel,
  formatContextLimit,
  getModelInfo,
  getReasoningCapability,
  isThinkingLevel,
  resolveContextLimit,
  supportsReasoningControl,
  type ReasoningCapability,
  type ThinkingLevel,
} from '../../src/harness/llm/model-catalog.ts'
import type { ModelSettings } from './types.ts'

export { defaultThinkingLevel, expressibleThinkingLevel, formatContextLimit, getModelInfo, getReasoningCapability, isThinkingLevel, resolveContextLimit, supportsReasoningControl }
export type { ReasoningCapability, ThinkingLevel }

export const THINKING_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

/** Effective vision: operator override first, then the catalog value. */
export function modelVision(modelId: string, settings?: ModelSettings): boolean | 'unknown' {
  if (settings?.vision !== undefined) return settings.vision
  return getModelInfo(modelId)?.vision ?? 'unknown'
}

/**
 * The context window shown in settings: the operator override when set,
 * else the catalog resolution — with the label marking which one.
 */
export function modelContext(modelId: string, settings?: ModelSettings): { tokens: number; overridden: boolean; label: string } {
  if (settings?.contextTokens !== undefined && settings.contextTokens > 0) {
    return { tokens: settings.contextTokens, overridden: true, label: formatContextLimit(settings.contextTokens) }
  }
  const tokens = resolveContextLimit(modelId)
  return { tokens, overridden: false, label: formatContextLimit(tokens) }
}

/** Row badges: Text/Vision/Reasoning — catalog data and overrides, never name guesses. */
export function capabilityBadges(modelId: string, settings?: ModelSettings): { label: string; tone: 'gray' | 'blue' | 'green' }[] {
  const badges: { label: string; tone: 'gray' | 'blue' | 'green' }[] = []
  if (modelVision(modelId, settings) === true) badges.push({ label: 'vision', tone: 'blue' })
  if (getReasoningCapability(modelId) !== null) badges.push({ label: 'reasoning', tone: 'green' })
  if (badges.length === 0) badges.push({ label: 'text', tone: 'gray' })
  return badges
}

export interface EffectiveThinking {
  /** The level the NEXT request for this model really carries. */
  readonly level: ThinkingLevel
  /** True when the conversation's (or global) override is what is in effect. */
  readonly fromOverride: boolean
  /**
   * The saved level this model does not document, when one had to be dropped.
   * Present so the control can say why the chip moved instead of silently
   * showing a level the request will never carry.
   */
  readonly ignoredOverride?: ThinkingLevel
}

/**
 * The thinking level the NEXT request would carry: workspace override →
 * the provider entry's per-model default → the catalog default. Null when
 * the model exposes no usable control.
 *
 * Every candidate is filtered through {@link expressibleThinkingLevel} first:
 * a level is a preference, and a model that does not document it must not
 * leave this control claiming a level the request will never send. The saved
 * value is not erased — it applies again on a model that does document it
 * — but this model resolves to its own default in the meantime.
 */
export function effectiveThinking(modelId: string, workspaceOverride: string | null | undefined, settings?: ModelSettings): EffectiveThinking | null {
  const capability = getReasoningCapability(modelId)
  if (capability === null || !supportsReasoningControl(modelId)) return null
  const selected = expressibleThinkingLevel(modelId, workspaceOverride)
  if (selected !== undefined) return { level: selected, fromOverride: true }
  const configured = expressibleThinkingLevel(modelId, settings?.thinkingLevel)
  if (configured !== undefined) return { level: configured, fromOverride: false }
  const ignored = isThinkingLevel(workspaceOverride) ? workspaceOverride : undefined
  return {
    level: defaultThinkingLevel(capability),
    fromOverride: false,
    ...(ignored !== undefined ? { ignoredOverride: ignored } : {}),
  }
}
