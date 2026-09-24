/**
 * The shared model catalog: verified capabilities for exact model IDs plus
 * narrowly-scoped family patterns, the documented context-window resolution
 * chain, and the thinking/reasoning controls the OpenAI-completions
 * transport may send. Ported from dntspace-app's `lib/models.ts`,
 * `lib/modelContextLimits.ts`, and `providers/client.rs` — do not replace
 * the exact tables with name guesses: accepted request fields vary per
 * model, and a wrong field can fail the whole request.
 *
 * This module is pure TypeScript (no node imports): the web client bundles
 * it for badges and the server resolves budgets and request overrides with
 * it — one source of truth on both sides of the wire.
 */

// ── reasoning vocabulary ──────────────────────────────────────────

export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ReasoningCapability {
  /** Explicit levels that may override the provider/model default. */
  readonly levels: readonly ReasoningLevel[]
  /** Whether the provider documents a real disable-thinking request. */
  readonly canDisable: boolean
  /** The completions transport can send this model's documented override. */
  readonly transportSupported?: boolean
  /** The provider always reasons and exposes no useful user control. */
  readonly alwaysOn?: boolean
}

export type ThinkingLevel = 'off' | ReasoningLevel

const EFFORT_5: readonly ReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const GEMINI_STANDARD: readonly ReasoningLevel[] = ['low', 'medium', 'high']

/** Every level a settings field or REST body may carry. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

// ── capability catalog (exact IDs) ────────────────────────────────

export interface ModelMetadata {
  /** Primary task the model is intended to perform. */
  readonly kind: 'chat' | 'image' | 'video'
  /** Whether the model accepts image input natively. */
  readonly vision: boolean | 'unknown'
  /** Officially documented context window, when available. */
  readonly contextTokens?: number
  /** Officially documented maximum output, when available. */
  readonly maxOutputTokens?: number
  /** Current documented lifecycle. */
  readonly status?: 'available' | 'preview' | 'legacy' | 'shut_down'
}

export type ModelInfo = ModelMetadata & { readonly reasoning?: ReasoningCapability }

const CATALOG_CONTEXT_1M = 1_048_576
const OUTPUT_64K = 65_536
const OUTPUT_128K = 131_072
const TEXT_VISION_1M: ModelMetadata = {
  kind: 'chat',
  vision: true,
  contextTokens: CATALOG_CONTEXT_1M,
  maxOutputTokens: OUTPUT_128K,
}

/**
 * Verified capabilities for exact registry IDs. Unknown fields are
 * deliberately omitted: a model name alone must not make the UI claim
 * vision or a context window it does not have.
 */
const MODEL_CATALOG: Readonly<Record<string, ModelMetadata>> = {
  'gpt-5.5': TEXT_VISION_1M,
  'gpt-5.6': TEXT_VISION_1M,
  'gpt-5.6-sol': TEXT_VISION_1M,
  'gpt-5.6-terra': TEXT_VISION_1M,
  'gpt-5.6-luna': TEXT_VISION_1M,

  'grok-4.20-0309-non-reasoning': { kind: 'chat', vision: true, contextTokens: 1_000_000 },
  'grok-4.20-0309-reasoning': { kind: 'chat', vision: true, contextTokens: 1_000_000 },
  'grok-4.3': { kind: 'chat', vision: true, contextTokens: 1_000_000 },
  'grok-4.5': { kind: 'chat', vision: true, contextTokens: 500_000 },
  'grok-imagine-image': { kind: 'image', vision: true },
  'grok-imagine-video': { kind: 'video', vision: true },

  'gemini-2.5-pro': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K },
  'gemini-2.5-flash': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K },
  'gemini-2.5-flash-lite': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K },
  'gemini-3.6-flash': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K },
  'gemini-3.5-flash': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K },
  'gemini-3.5-flash-lite': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K },
  'gemini-3.1-pro-preview': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K, status: 'preview' },
  'gemini-3-flash-preview': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K, status: 'preview' },
  'gemini-3-pro-preview': { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K, status: 'shut_down' },
  'claude-fable-5': TEXT_VISION_1M,
  'claude-opus-5': TEXT_VISION_1M,
  'claude-sonnet-5': TEXT_VISION_1M,
  // The one current Claude whose window differs from the family 1M.
  'claude-haiku-4.5': { kind: 'chat', vision: true, contextTokens: 200_000, maxOutputTokens: OUTPUT_64K },

  'glm-5.2': { kind: 'chat', vision: false, contextTokens: 1_000_000, maxOutputTokens: OUTPUT_128K },
  'glm-5.1': { kind: 'chat', vision: false, contextTokens: 200_000, maxOutputTokens: OUTPUT_128K },
  'glm-5': { kind: 'chat', vision: false, contextTokens: 200_000, maxOutputTokens: OUTPUT_128K },
  'glm-4.7': { kind: 'chat', vision: false, contextTokens: 200_000, maxOutputTokens: OUTPUT_128K },

  'kimi-k3': { kind: 'chat', vision: 'unknown', contextTokens: 1_000_000 },
  'kimi-k2.7-code': { kind: 'chat', vision: true, contextTokens: 256_000 },
  'kimi-k2.6': { kind: 'chat', vision: true, contextTokens: 256_000 },

  'minimax-m3': { kind: 'chat', vision: 'unknown', contextTokens: 1_000_000 },
}

const REASONING_MODELS: Readonly<Record<string, ReasoningCapability>> = {
  // Gateways commonly expose this family through Chat Completions while
  // translating reasoning upstream, so keep the selector usable.
  'gpt-5.5': { levels: ['low', 'medium', 'high', 'xhigh'], canDisable: true, transportSupported: true },
  'gpt-5.6': { levels: EFFORT_5, canDisable: true, transportSupported: true },
  'gpt-5.6-sol': { levels: EFFORT_5, canDisable: true, transportSupported: true },
  'gpt-5.6-terra': { levels: EFFORT_5, canDisable: true, transportSupported: true },
  'gpt-5.6-luna': { levels: EFFORT_5, canDisable: true, transportSupported: true },

  'grok-4.20-0309-reasoning': { levels: [], canDisable: false },
  'grok-4.3': { levels: ['low', 'medium', 'high', 'xhigh'], canDisable: true, transportSupported: true },
  'grok-4.5': { levels: ['low', 'medium', 'high', 'xhigh'], canDisable: false, transportSupported: true },

  // Gemini 3.x uses the Interactions API; the completions adapter supports 2.5.
  'gemini-3.6-flash': { levels: ['minimal', 'low', 'medium', 'high'], canDisable: false },
  'gemini-3.5-flash': { levels: ['minimal', 'low', 'medium', 'high'], canDisable: false },
  'gemini-2.5-pro': { levels: GEMINI_STANDARD, canDisable: false, transportSupported: true },
  'gemini-2.5-flash': { levels: GEMINI_STANDARD, canDisable: false, transportSupported: true },
  'gemini-2.5-flash-lite': { levels: GEMINI_STANDARD, canDisable: false, transportSupported: true },

  // Anthropic adaptive thinking requires a Messages API adapter; gateway
  // aliases routed through OpenAI-compat endpoints still carry budget_tokens.
  'claude-fable-5': { levels: EFFORT_5, canDisable: false },
  'claude-opus-5': { levels: EFFORT_5, canDisable: true },
  'claude-sonnet-5': { levels: EFFORT_5, canDisable: true },

  // kiro-claude-* variants route through an OpenAI-compatible gateway that
  // forwards Anthropic extended_thinking fields.
  'kiro-claude-opus': { levels: EFFORT_5, canDisable: true, transportSupported: true },
  'kiro-claude-sonnet': { levels: EFFORT_5, canDisable: true, transportSupported: true },
  'kiro-claude-haiku': { levels: EFFORT_5, canDisable: true, transportSupported: true },

  // Alibaba Qwen hybrid-thinking models use OpenAI-compatible controls.
  'qwen3.7-max': { levels: ['minimal', 'low', 'medium', 'high'], canDisable: true, transportSupported: true },
  'qwen3.7-plus': { levels: ['minimal', 'low', 'medium', 'high'], canDisable: true, transportSupported: true },
  'qwen3.7-max-preview': { levels: [], canDisable: false, alwaysOn: true },

  // Zhipu GLM.
  'glm-5.2': { levels: ['high', 'max'], canDisable: true, transportSupported: true },
  'glm-5.1': { levels: [], canDisable: true, transportSupported: true },
  'glm-5': { levels: [], canDisable: true, transportSupported: true },
  'glm-4.7': { levels: [], canDisable: true, transportSupported: true },

  // Moonshot Kimi.
  'kimi-k3': { levels: ['low', 'high', 'max'], canDisable: false, transportSupported: true },
  'kimi-k2.7-code': { levels: [], canDisable: false, alwaysOn: true },
  'kimi-k2.6': { levels: [], canDisable: true, transportSupported: true },
  'kimi-k2.5': { levels: [], canDisable: true, transportSupported: true },

  // MiniMax OpenAI-compatible API.
  'minimax-m3': { levels: [], canDisable: true, transportSupported: true },
  'minimax-m2.7': { levels: [], canDisable: false, alwaysOn: true },
  'minimax-m2': { levels: [], canDisable: false, alwaysOn: true },
}

// ── pattern resolution (gateway aliases, snapshots, new releases) ─

interface ModelPattern<T> {
  /** Anchored against the normalized model ID's final path segment. */
  readonly pattern: RegExp
  readonly value: T
}

/** Strip provider prefixes (`models/`) and lowercase for lookup. */
function normalizeModelId(modelId: string | null | undefined): string {
  const id = modelId?.trim().toLowerCase() ?? ''
  return id.startsWith('models/') ? id.slice('models/'.length) : id
}

function resolveCatalogValue<T>(
  modelId: string | null | undefined,
  exact: Readonly<Record<string, T>>,
  patterns: readonly ModelPattern<T>[],
  fallbackPatterns: readonly ModelPattern<T>[] = [],
): T | undefined {
  const id = normalizeModelId(modelId)
  const direct = exact[id]
  if (direct !== undefined) return direct
  // Gateways frequently namespace an upstream ID (`openai/gpt-…`); match
  // only the final segment against explicit, anchored family patterns.
  const bareId = id.split('/').pop() ?? id
  return (
    patterns.find((rule) => rule.pattern.test(bareId))?.value
    ?? fallbackPatterns.find((rule) => rule.pattern.test(bareId))?.value
  )
}

const FALLBACK_REASONING: Readonly<Record<string, ReasoningCapability>> = {
  openai: { levels: EFFORT_5, canDisable: true, transportSupported: true },
  deepseek: { levels: ['low', 'high', 'xhigh', 'max'], canDisable: true, transportSupported: true },
  grok: { levels: ['low', 'medium', 'high', 'xhigh'], canDisable: true, transportSupported: true },
  glm: { levels: ['high', 'max'], canDisable: true, transportSupported: true },
  kimi: { levels: ['low', 'high', 'max'], canDisable: false, transportSupported: true },
  qwen: { levels: ['minimal', 'low', 'medium', 'high'], canDisable: true, transportSupported: true },
  // Claude models routed through an OpenAI-compatible gateway that forwards
  // Anthropic extended_thinking fields.
  claude: { levels: EFFORT_5, canDisable: true, transportSupported: true },
}

/**
 * Last-resort provider-family rules for gateway aliases and newly released
 * models. They intentionally come after exact IDs and verified family
 * rules. Media-output models are excluded first — they never reason.
 */
const REASONING_FALLBACK_PATTERNS: readonly ModelPattern<ReasoningCapability>[] = [
  { pattern: /(?:gpt-image|dall-e|sora|grok-imagine|imagen)/, value: { levels: [], canDisable: false } },
  { pattern: /(?:gpt|o[1-9])/, value: FALLBACK_REASONING.openai! },
  { pattern: /deepseek/, value: FALLBACK_REASONING.deepseek! },
  { pattern: /grok/, value: FALLBACK_REASONING.grok! },
  { pattern: /glm/, value: FALLBACK_REASONING.glm! },
  { pattern: /kimi/, value: FALLBACK_REASONING.kimi! },
  { pattern: /qwen/, value: FALLBACK_REASONING.qwen! },
  { pattern: /claude/, value: FALLBACK_REASONING.claude! },
]
const REASONING_MODEL_PATTERNS: readonly ModelPattern<ReasoningCapability>[] = [
  { pattern: /^gpt-5\.5(?:[-:].*)?$/, value: REASONING_MODELS['gpt-5.5']! },
  { pattern: /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:[-:].*)?$/, value: REASONING_MODELS['gpt-5.6']! },
  { pattern: /^grok-4\.20-0309-reasoning(?:[-:].*)?$/, value: REASONING_MODELS['grok-4.20-0309-reasoning']! },
  { pattern: /^grok-4\.3(?:[-:].*)?$/, value: REASONING_MODELS['grok-4.3']! },
  { pattern: /^grok-4\.5(?:[-:].*)?$/, value: REASONING_MODELS['grok-4.5']! },
  { pattern: /^gemini-2\.5-(?:pro|flash|flash-lite)(?:[-:].*)?$/, value: REASONING_MODELS['gemini-2.5-flash']! },
  { pattern: /^gemini-3\.6-flash(?:[-:].*)?$/, value: REASONING_MODELS['gemini-3.6-flash']! },
  { pattern: /^claude-(?:fable-5|opus-5|sonnet-5)(?:[-:].*)?$/, value: REASONING_MODELS['claude-sonnet-5']! },
  { pattern: /^kiro-claude-(?:opus|sonnet|haiku)(?:[-:].*)?$/, value: REASONING_MODELS['kiro-claude-sonnet']! },
  { pattern: /^glm-5\.2(?:[-:].*)?$/, value: REASONING_MODELS['glm-5.2']! },
  { pattern: /^glm-5\.1(?:[-:].*)?$/, value: REASONING_MODELS['glm-5.1']! },
  { pattern: /^glm-5(?:[-:].*)?$/, value: REASONING_MODELS['glm-5']! },
  { pattern: /^glm-4\.7(?:[-:].*)?$/, value: REASONING_MODELS['glm-4.7']! },
  { pattern: /^kimi-k3(?:[-:].*)?$/, value: REASONING_MODELS['kimi-k3']! },
  { pattern: /^kimi-k2\.7-code(?:[-:].*)?$/, value: REASONING_MODELS['kimi-k2.7-code']! },
  { pattern: /^kimi-k2\.6(?:[-:].*)?$/, value: REASONING_MODELS['kimi-k2.6']! },
  { pattern: /^qwen3\.7-(?:max|plus)(?!-preview)(?:[-:].*)?$/, value: REASONING_MODELS['qwen3.7-max']! },
  { pattern: /^minimax-m3(?:[-:].*)?$/, value: REASONING_MODELS['minimax-m3']! },
]
const MODEL_CATALOG_PATTERNS: readonly ModelPattern<ModelMetadata>[] = [
  { pattern: /^gpt-5\.5(?:[-:].*)?$/, value: TEXT_VISION_1M },
  { pattern: /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:[-:].*)?$/, value: TEXT_VISION_1M },
  { pattern: /^grok-4\.20-0309-(?:reasoning|non-reasoning)(?:[-:].*)?$/, value: { kind: 'chat', vision: true, contextTokens: 1_000_000 } },
  { pattern: /^grok-4\.3(?:[-:].*)?$/, value: { kind: 'chat', vision: true, contextTokens: 1_000_000 } },
  { pattern: /^grok-4\.5(?:[-:].*)?$/, value: { kind: 'chat', vision: true, contextTokens: 500_000 } },
  { pattern: /^gemini-2\.5-(?:pro|flash|flash-lite)(?:[-:].*)?$/, value: { ...TEXT_VISION_1M, maxOutputTokens: OUTPUT_64K } },
  { pattern: /^claude-(?:fable-5|opus-5|sonnet-5)(?:[-:].*)?$/, value: TEXT_VISION_1M },
  { pattern: /^claude-haiku-4\.5(?:[-:].*)?$/, value: MODEL_CATALOG['claude-haiku-4.5']! },
  { pattern: /^glm-5\.2(?:[-:].*)?$/, value: MODEL_CATALOG['glm-5.2']! },
  { pattern: /^glm-5\.1(?:[-:].*)?$/, value: MODEL_CATALOG['glm-5.1']! },
  { pattern: /^glm-5(?:[-:].*)?$/, value: MODEL_CATALOG['glm-5']! },
  { pattern: /^glm-4\.7(?:[-:].*)?$/, value: MODEL_CATALOG['glm-4.7']! },
  { pattern: /^kimi-k2\.7-code(?:[-:].*)?$/, value: MODEL_CATALOG['kimi-k2.7-code']! },
  { pattern: /^kimi-k2\.6(?:[-:].*)?$/, value: MODEL_CATALOG['kimi-k2.6']! },
]

/**
 * Metadata family fallback for ids the anchored rules and exact catalog do
 * not know (a new GPT/Claude/Gemini release, a gateway alias). Vision only:
 * every documented model in these families accepts images (verified against
 * vendor docs, 2026-09), and the context window still resolves through the
 * known-family rules — these families' windows vary by SKU, so guessing one
 * here would be worse than the heuristic.
 */
const MODEL_METADATA_FALLBACK_PATTERNS: readonly ModelPattern<ModelMetadata>[] = [
  { pattern: /gpt/, value: { kind: 'chat', vision: true } },
  { pattern: /claude/, value: { kind: 'chat', vision: true } },
  { pattern: /gemini/, value: { kind: 'chat', vision: true } },
]

/** Returns verified catalog metadata and reasoning controls for an exact ID. */
export function getModelInfo(modelId: string | null | undefined): ModelInfo | null {
  const metadata = resolveCatalogValue(modelId, MODEL_CATALOG, MODEL_CATALOG_PATTERNS, MODEL_METADATA_FALLBACK_PATTERNS)
  const reasoning = resolveCatalogValue(modelId, REASONING_MODELS, REASONING_MODEL_PATTERNS, REASONING_FALLBACK_PATTERNS)
  if (metadata === undefined && reasoning === undefined) return null
  return {
    ...(metadata ?? { kind: 'chat', vision: 'unknown' }),
    ...(reasoning !== undefined ? { reasoning } : {}),
  }
}

/** The documented reasoning capability for an exact model ID. */
export function getReasoningCapability(modelId: string | null | undefined): ReasoningCapability | null {
  return resolveCatalogValue(modelId, REASONING_MODELS, REASONING_MODEL_PATTERNS, REASONING_FALLBACK_PATTERNS) ?? null
}

/**
 * The concrete level used when no explicit thinking level is chosen: the
 * provider-standard "medium" when documented, else "high", else the highest
 * available level, else "off".
 */
export function defaultThinkingLevel(capability: ReasoningCapability): ThinkingLevel {
  const levels = capability.levels
  if (levels.includes('medium')) return 'medium'
  if (levels.includes('high')) return 'high'
  if (levels.length > 0) return levels[levels.length - 1]!
  return 'off'
}

/** Whether the composer should render a working thinking control for this model. */
export function supportsReasoningControl(modelId: string | null | undefined): boolean {
  const capability = getReasoningCapability(modelId)
  return (
    capability !== null
    && capability.transportSupported === true
    && capability.alwaysOn !== true
    && (capability.canDisable || capability.levels.length > 0)
  )
}

/**
 * The thinking level a request for THIS model may actually carry: the
 * requested level when the model documents it, else `undefined` — no
 * override is sent and the model's own default stands.
 *
 * A chosen level is a preference, not a capability. Switching to a model
 * that does not document it must never keep carrying the old level as if
 * the new model supported it: the adapter would silently send nothing
 * while the UI kept claiming the old level. Resolving here keeps the
 * control, the chip, and the wire body saying the same thing.
 */
export function expressibleThinkingLevel(
  modelId: string | null | undefined,
  level: string | null | undefined,
): ThinkingLevel | undefined {
  if (level === undefined || level === null || level === '') return undefined
  if (!isThinkingLevel(level)) return undefined
  const capability = getReasoningCapability(modelId)
  if (capability === null || capability.transportSupported !== true || capability.alwaysOn === true) return undefined
  // `off` is only real where the provider documents a disable request;
  // everywhere else the documented level list is the whole vocabulary.
  if (level === 'off') return capability.canDisable ? 'off' : undefined
  return capability.levels.includes(level) ? level : undefined
}

// ── context limits ────────────────────────────────────────────────

/** Fallback when no override, catalog entry, or known-family rule applies. */
export const DEFAULT_CONTEXT_LIMIT = 256_000

export const CONTEXT_1M = 1_048_576
export const CONTEXT_500K = 500_000
export const CONTEXT_256K = 256_000
export const CONTEXT_200K = 200_000
export const CONTEXT_128K = 128_000

/** Format for compact UI labels (e.g. 200000 → "200k", 1048576 → "1M"). */
export function formatContextLimit(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1_000_000) {
    // One decimal, with a cosmetic ".0" stripped: 1_048_576 reads "1M".
    const m = (n / 1_000_000).toFixed(1).replace(/\.0$/, '')
    return `${m}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * Pragmatic known-family limits (case-insensitive substring, most specific
 * first). Values are approximations from vendor docs (~2026), slightly
 * conservative when a family has mixed SKUs.
 */
export function knownModelLimit(modelId: string): number | null {
  const m = modelId.toLowerCase()

  // ── Anthropic Claude ────────────────────────────────────────────
  if (m.includes('claude')) {
    if (m.includes('haiku')) return CONTEXT_200K
    if (m.includes('claude-3') || m.includes('claude3')) return CONTEXT_200K
    if (
      m.includes('opus') || m.includes('sonnet')
      || m.includes('claude-4') || m.includes('claude4')
      || m.includes('claude-5') || m.includes('claude5')
    ) return CONTEXT_1M
    return CONTEXT_200K
  }

  // ── OpenAI ─────────────────────────────────────────────────────
  if (m.includes('gpt-4.1') || m.includes('gpt4.1')) return CONTEXT_1M
  if (m.includes('gpt-4o') || m.includes('gpt4o') || m.includes('chatgpt-4o')) return CONTEXT_128K
  if (m.includes('gpt-5') || m.includes('gpt5')) return CONTEXT_1M
  if (
    m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')
    || m.includes('-o1') || m.includes('-o3') || m.includes('-o4')
  ) return CONTEXT_200K
  if (m.includes('gpt-4-turbo') || m.includes('gpt-4-0125') || m.includes('gpt-4-1106')) return CONTEXT_128K
  if (m.includes('gpt-4') || m.includes('gpt4')) return CONTEXT_128K
  if (m.includes('codex') || m.includes('auto-review')) return CONTEXT_200K

  // ── Google Gemini ──────────────────────────────────────────────
  if (m.includes('gemini')) return CONTEXT_1M

  // ── xAI Grok ───────────────────────────────────────────────────
  if (m.includes('grok')) {
    if (m.includes('build')) return CONTEXT_256K
    if (m.includes('4.5') || m.includes('4-5')) return CONTEXT_500K
    if (m.includes('4.3') || m.includes('4.20') || m.includes('4-3') || m.includes('4-20') || m.includes('multi-agent')) return CONTEXT_1M
    if (m.includes('grok-4') || m.includes('grok4')) return CONTEXT_500K
    return CONTEXT_128K
  }

  // ── Zhipu GLM ──────────────────────────────────────────────────
  if (m.includes('glm') || m.includes('codegeex')) {
    if (m.includes('5.2') || m.includes('5-2') || m.includes('long')) return CONTEXT_1M
    if (m.includes('glm-5') || m.includes('glm5') || m.includes('4.7') || m.includes('4.6') || m.includes('4-7') || m.includes('4-6') || m.includes('turbo')) return CONTEXT_200K
    if (m.includes('4.5') || m.includes('4-5') || m.includes('flash') || m.includes('air')) return CONTEXT_128K
    return CONTEXT_128K
  }

  // ── DeepSeek ───────────────────────────────────────────────────
  if (m.includes('deepseek')) {
    if (m.includes('v4') || m.includes('deepseek-4')) return CONTEXT_1M
    return CONTEXT_128K
  }

  // ── Qwen ───────────────────────────────────────────────────────
  if (m.includes('qwen')) {
    if (m.includes('long') || m.includes('1m') || m.includes('1000k')) return CONTEXT_1M
    return CONTEXT_128K
  }

  // ── Mistral / Meta / others common in OpenAI-compatible proxies ─
  if (
    m.includes('mistral') || m.includes('mixtral') || m.includes('codestral')
    || m.includes('magistral') || m.includes('pixtral') || m.includes('devstral')
  ) return CONTEXT_128K
  if (m.includes('llama')) return CONTEXT_128K
  if (m.includes('kimi') || m.includes('moonshot')) return CONTEXT_128K
  if (m.includes('command-r') || m.includes('command_r') || m.includes('cohere')) return CONTEXT_128K
  if (m.includes('yi-') || m.startsWith('yi') || m.includes('01-ai')) return CONTEXT_128K
  if (m.includes('minimax')) {
    if (m.includes('m3')) return CONTEXT_1M
    return CONTEXT_200K
  }

  return null
}

/** Bare model segment for wire ids like `cliproxy/grok-4.5`. */
export function bareModelId(modelId: string): string {
  const parts = modelId.split('/')
  return parts[parts.length - 1] ?? modelId
}

/**
 * The effective context window used when the operator leaves the settings
 * field empty: verified catalog value → known-family rule (bare segment
 * retry for namespaced ids) → the 256k default.
 */
export function resolveContextLimit(modelId: string): number {
  return (
    getModelInfo(modelId)?.contextTokens
    ?? knownModelLimit(modelId)
    ?? knownModelLimit(bareModelId(modelId))
    ?? DEFAULT_CONTEXT_LIMIT
  )
}

// ── thinking overrides on the wire ────────────────────────────────

const LEVELS_4: readonly string[] = ['low', 'medium', 'high', 'xhigh']
const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const QWEN_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high']
const CLAUDE_BUDGET: Readonly<Record<string, number>> = { low: 1_024, medium: 5_000, high: 16_000, xhigh: 32_000, max: 64_000 }

/**
 * Apply only documented OpenAI-completions thinking controls for the given
 * model, mutating the request body in place. Unknown or unsupported
 * (model, level) pairs leave the body untouched — never guess a field the
 * provider did not document, and never send `reasoning_effort` to a model
 * that would reject it. `off` (or an empty/auto level) means "explicitly
 * disable" when the provider documents a disable request, else nothing.
 */
export function applyThinkingOverride(body: Record<string, unknown>, model: string, level: string | undefined): void {
  if (level === undefined || level === '' || level === 'auto') return
  const raw = model.trim().toLowerCase()
  const id = raw.split('/').pop() ?? raw

  const setEffort = (value: string): void => { body['reasoning_effort'] = value }
  const setThinking = (type: string): void => { body['thinking'] = { type } }

  // Exact vendor IDs and their documented dated/region variants.
  if (id.startsWith('gpt-5.6')) {
    if (level === 'off') setEffort('none')
    else if (EFFORT_LEVELS.includes(level)) setEffort(level)
  } else if (id.startsWith('gpt-5.5')) {
    if (level === 'off') setEffort('none')
    else if (LEVELS_4.includes(level)) setEffort(level)
  } else if (id.startsWith('grok-4.3')) {
    if (level === 'off') setEffort('none')
    else if (LEVELS_4.includes(level)) setEffort(level)
  } else if (id.startsWith('grok-4.5')) {
    if (LEVELS_4.includes(level)) setEffort(level)
  } else if (id.startsWith('glm-5.2')) {
    if (level === 'off' || level === 'minimal' || level === 'none') setThinking('disabled')
    else if (level === 'high' || level === 'max') setEffort(level)
  } else if (
    id.startsWith('glm-5.1') || id === 'glm-5' || id.startsWith('glm-5-')
    || id.startsWith('glm-4.7') || id.startsWith('kimi-k2.6') || id.startsWith('kimi-k2.5')
  ) {
    if (level === 'off') setThinking('disabled')
  } else if (id.startsWith('kimi-k3')) {
    if (level === 'low' || level === 'high' || level === 'max') setEffort(level)
  } else if (id.startsWith('minimax-m3')) {
    if (level === 'off') setThinking('disabled')
  } else if (id.startsWith('qwen3.7-max') || id.startsWith('qwen3.7-plus')) {
    // Chat Completions has a boolean hybrid-thinking control; it cannot
    // faithfully express effort levels, so only toggle thinking.
    if (level === 'off') body['enable_thinking'] = false
    else if (QWEN_LEVELS.includes(level)) body['enable_thinking'] = true
  } else if (id.includes('deepseek')) {
    if (level === 'off') setThinking('disabled')
    else if (level === 'low' || level === 'high' || level === 'xhigh' || level === 'max') setEffort(level)
  } else if (id.includes('claude') || id.includes('kiro-claude')) {
    // Gateway Claude variants forward Anthropic extended_thinking fields;
    // map effort levels to budget_tokens that approximate them. Checked
    // BEFORE the OpenAI-family fallback — `claude-opus` would otherwise
    // false-positive the o-series heuristic below.
    if (level === 'off') setThinking('disabled')
    else if (level in CLAUDE_BUDGET) body['thinking'] = { type: 'enabled', budget_tokens: CLAUDE_BUDGET[level] }
  } else if (id.includes('gpt-') || /^o\d/.test(id) || /-o\d/.test(id)) {
    // OpenAI-family fallback for gateway aliases and new releases (gpt-*,
    // o1/o3/o4…): an o-series id must have a digit after the o.
    if (level === 'off') setEffort('none')
    else if (EFFORT_LEVELS.includes(level)) setEffort(level)
  } else if (id.includes('grok')) {
    if (level === 'off') setEffort('none')
    else if (LEVELS_4.includes(level)) setEffort(level)
  } else if (id.includes('glm')) {
    if (level === 'off') setThinking('disabled')
    else if (level === 'high' || level === 'max') setEffort(level)
  } else if (id.includes('kimi')) {
    if (level === 'low' || level === 'high' || level === 'max') setEffort(level)
  } else if (id.includes('qwen')) {
    if (level === 'off') body['enable_thinking'] = false
    else if (QWEN_LEVELS.includes(level)) body['enable_thinking'] = true
  }
}
