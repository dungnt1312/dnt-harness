/**
 * Budget arithmetic for context assembly. Token counts are ESTIMATES
 * (chars/4) — honest, labeled as such, and configurable per model. The
 * budget is the context window minus the output reserve and a safety
 * margin; tool schemas are part of the cost.
 */
import type { ContentPart } from '../llm/types.ts'

export interface BudgetConfig {
  /** The model's context window (an estimate unless verified). */
  readonly contextLimitTokens: number
  /** Reserved for the model's reply. */
  readonly outputReserveTokens: number
  /** Safety margin absorbing estimation error. */
  readonly marginTokens: number
}

/** Budget config plus the honesty flag for the estimate. */
export type ResolvedBudget = BudgetConfig & { readonly verified?: boolean }

export const DEFAULT_BUDGET: ResolvedBudget = {
  // Matches the model catalog's DEFAULT_CONTEXT_LIMIT (256k): modern
  // chat/reasoning windows are 128k–1M, and a 32k fallback rejected
  // requests whose fixed cost alone exceeded it.
  contextLimitTokens: 256_000,
  outputReserveTokens: 4_096,
  marginTokens: 1_024,
  verified: false,
}

/**
 * Budget fractions for a request the provider already rejected as too large.
 * The estimate is chars/4, so a real tokenizer (non-English text, code) can
 * run well above it; each level assumes the window is that much smaller.
 */
const SQUEEZE_FACTORS: readonly number[] = [1, 0.7, 0.45, 0.25]
/** Highest squeeze level; beyond it the provider's refusal is final. */
export const MAX_SQUEEZE_LEVEL = SQUEEZE_FACTORS.length - 1

/** The budget to assemble under after `level` provider rejections for size. */
export function squeezeBudget<T extends BudgetConfig>(budget: T, level: number | undefined): T {
  const factor = SQUEEZE_FACTORS[Math.min(Math.max(Math.floor(level ?? 0), 0), MAX_SQUEEZE_LEVEL)] ?? 1
  return factor === 1 ? budget : { ...budget, contextLimitTokens: Math.floor(budget.contextLimitTokens * factor) }
}

/** Estimate one string's token cost (chars/4, rounded up). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Flat per-image estimate. Real image cost depends on the model's tiling of
 * the decoded dimensions, which this layer deliberately does not decode; the
 * whole budget is already a labeled estimate, and a fixed figure in the range
 * vision models charge for a full-detail image keeps it from being wildly
 * optimistic when several screenshots are attached.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_200

/** Estimate a message body that may carry images alongside its text. */
export function estimateContentTokens(content: string | readonly ContentPart[]): number {
  if (typeof content === 'string') return estimateTokens(content)
  return content.reduce(
    (total, part) => total + (part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKEN_ESTIMATE),
    0,
  )
}

/** The tokens available for assembled content after reserve and margin. */
export function budgetFor(config: BudgetConfig): number {
  return Math.max(config.contextLimitTokens - config.outputReserveTokens - config.marginTokens, 0)
}

/** The schema overhead for one request, in estimated tokens. */
export function schemaCost(schemas: readonly { name: string; description: string; parameters: unknown }[]): number {
  return estimateTokens(JSON.stringify(schemas))
}

/** The truthful failure when trimming cannot make a request fit. */
export class ContextBudgetError extends Error {
  constructor(
    readonly neededTokens: number,
    readonly availableTokens: number,
  ) {
    super(`context budget exceeded: assembled content needs ~${neededTokens} tokens, budget allows ~${availableTokens} after reserve and margin; reduce history/skills/memory or raise the model limit`)
    this.name = 'ContextBudgetError'
  }
}
