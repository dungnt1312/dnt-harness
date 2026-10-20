/**
 * Effective model facts, resolved once and shared by the CLI and web hosts and
 * by the OpenAI-completions adapter: the selected pair, the thinking level the
 * model can express, the context budget, the output-cap policy (with its
 * source), wire compatibility, and a versioned route identity.
 *
 * Pure: no filesystem, web-server or network imports. Hosts load their config
 * the way they always have and pass normalized facts in; nothing here reads a
 * store a second time. Credentials never enter a result: the route identity
 * carries only an opaque credential generation (see {@link credentialGeneration}).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { expressibleThinkingLevel, isThinkingLevel, resolveOutputLimitSource, applyThinkingOverride, type ThinkingLevel } from './model-catalog.ts'
import { resolveModelBudget, type ResolvedBudget } from '../context/budget.ts'

// ── output-cap policy ─────────────────────────────────────────────

/** Sent when neither the operator nor the catalog knows the model's output limit. */
export const OUTPUT_TOKEN_FALLBACK = 32_000
/** Product output budget: no cap (operator, catalog, learned) ever exceeds it. */
export const OUTPUT_TOKEN_MAX = 256_000

export type OutputCapSource = 'override' | 'catalog' | 'family' | 'fallback'

/** The authoritative-or-guessed output cap for one model, before per-request bounds. */
export interface OutputPolicy {
  readonly cap: number
  readonly source: OutputCapSource
  /** True only for the fallback: the one value the adapter may relearn over. */
  readonly guessed: boolean
}

const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * Operator override (valid positive integer) → documented catalog/family value
 * → the 32,000-token fallback. Every value is bounded by {@link OUTPUT_TOKEN_MAX}.
 * Invalid overrides are ignored, never clamped into meaning.
 */
export function outputPolicy(model: string, override?: number): OutputPolicy {
  if (positiveInt(override)) return { cap: Math.min(override, OUTPUT_TOKEN_MAX), source: 'override', guessed: false }
  const documented = resolveOutputLimitSource(model)
  if (documented !== undefined) return { cap: Math.min(documented.tokens, OUTPUT_TOKEN_MAX), source: documented.source, guessed: false }
  return { cap: OUTPUT_TOKEN_FALLBACK, source: 'fallback', guessed: true }
}

/**
 * The host's remaining-window ceiling: a positive bound, `undefined` when the
 * host gave none (or a non-number), or `'exhausted'` when no room is left. An
 * exhausted ceiling is never read as "unset".
 */
export function outputCeiling(ceiling: number | undefined): number | 'exhausted' | undefined {
  if (ceiling === undefined || typeof ceiling !== 'number' || !Number.isFinite(ceiling)) return undefined
  const room = Math.floor(ceiling)
  return room < 1 ? 'exhausted' : room
}

/**
 * The output-token cap one request carries, or `undefined` to omit the field.
 *
 * - base: operator override, else catalog/family, else a learned value for a
 *   guessed cap (`null` = the endpoint taught us to send none), else 32,000.
 * - an explicit request may only lower the base; with no base it is the
 *   caller's own bounded intent and is sent as is.
 * - the remaining-window ceiling bounds an existing cap and never invents one,
 *   and nothing raises a cap above the ceiling (no 1,024 floor).
 */
export function outputTokenCap(model: string, overrides?: Readonly<Record<string, number>>, requested?: number, ceiling?: number, learned?: number | null): number | undefined {
  const policy = outputPolicy(model, overrides?.[model])
  const base = policy.guessed && learned !== undefined
    ? (learned === null ? undefined : Math.min(learned, OUTPUT_TOKEN_MAX))
    : policy.cap
  const ask = positiveInt(requested) ? requested : undefined
  const cap = base === undefined ? ask : ask === undefined ? base : Math.min(base, ask)
  if (cap === undefined) return undefined
  const bound = outputCeiling(ceiling)
  // An exhausted ceiling is rejected before the network by the adapter; this
  // pure helper never turns it into a cap of 0 or into "no bound".
  return typeof bound === 'number' ? Math.min(cap, bound) : cap
}

/**
 * Apply the documented thinking override for the FINAL cap. Claude-style
 * budget thinking needs a `max_tokens` above its budget: when no cap is sent
 * the budget is dropped rather than paired with an unknown gateway default.
 */
export function applyThinking(body: Record<string, unknown>, model: string, level: string | undefined, maxTokens: number | undefined): void {
  applyThinkingOverride(body, model, level, maxTokens)
  const thinking = body['thinking']
  if (maxTokens === undefined && thinking !== null && typeof thinking === 'object' && (thinking as { type?: unknown }).type === 'enabled') {
    delete body['thinking']
  }
}

// ── wire compatibility ────────────────────────────────────────────

/**
 * OpenAI itself, recognized by host only. A provider merely *named* "openai"
 * is often a relay (LiteLLM, Azure, vLLM, llama.cpp) that would reject `store`
 * or ignore `max_completion_tokens`, so the name never opts an endpoint in.
 */
const isOpenAiNative = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

/**
 * Providers documented to take the legacy `max_tokens` field even though
 * their endpoint is not OpenAI's; mirrors opencode's `openai-chat` list.
 */
const LEGACY_MAX_TOKENS_PROVIDERS: ReadonlySet<string> = new Set([
  'deepseek', 'moonshotai', 'togetherai', 'together', 'zai', 'zai-coding-plan',
  'zhipuai', 'zhipuai-coding-plan', 'nvidia', 'cerebras', 'chutes',
  'cloudflare-ai-gateway', 'cloudflare-workers-ai',
])
const LEGACY_MAX_TOKENS_HOSTS: readonly string[] = [
  'deepseek.com', 'api.moonshot.', 'api.together.', 'api.z.ai', 'open.bigmodel.cn',
  'integrate.api.nvidia.com', 'cerebras.ai', 'llm.chutes.ai',
  'gateway.ai.cloudflare.com', 'api.cloudflare.com',
]

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens'

/**
 * Which body field carries the output cap. OpenAI-native endpoints take
 * `max_completion_tokens` — the field their newer models require — while the
 * documented compatible families above keep `max_tokens`. An endpoint that
 * cannot be recognized keeps `max_tokens` too: an arbitrarily named gateway is
 * far more likely to be a compatible relay than OpenAI itself.
 */
export function detectMaxTokensField(name: string, baseUrl: string): MaxTokensField {
  if (LEGACY_MAX_TOKENS_PROVIDERS.has(name.toLowerCase())) return 'max_tokens'
  const url = baseUrl.toLowerCase()
  if (LEGACY_MAX_TOKENS_HOSTS.some((host) => url.includes(host))) return 'max_tokens'
  return isOpenAiNative(baseUrl) ? 'max_completion_tokens' : 'max_tokens'
}

/** Only OpenAI-native endpoints are known to accept an explicit `store`. */
export function detectSupportsStore(_name: string, baseUrl: string): boolean {
  return isOpenAiNative(baseUrl)
}

/**
 * Hosts documented to accept `prompt_cache_key` on Chat Completions (the set
 * opencode enables). DeepSeek caches by prefix on its own and is left out, as
 * opencode does. Azure is left to the explicit flag: older `api-version`s
 * reject unknown body fields. Exact host or a subdomain, never a substring.
 */
const PROMPT_CACHE_KEY_HOSTS: readonly string[] = [
  'api.openai.com', 'openrouter.ai', 'api.fireworks.ai',
  'api.cerebras.ai', 'api.deepinfra.com', 'api.moonshot.ai', 'api.moonshot.cn',
]

/** Whether the endpoint is known to accept `prompt_cache_key`. */
export function detectSupportsPromptCacheKey(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return PROMPT_CACHE_KEY_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))
}

export interface WireCompatibility {
  readonly maxTokensField: MaxTokensField
  readonly supportsStore: boolean
  readonly supportsPromptCacheKey: boolean
}

// ── route identity ────────────────────────────────────────────────

/**
 * A keyed one-way function over a credential (HMAC-SHA256 with a secret the
 * host owns). Injected by hosts so this module stays free of filesystem
 * access; see `credential-secret.ts` for the persisted per-install secret.
 */
export type CredentialHasher = (credential: string) => string

/** HMAC-SHA256 hasher for a given secret. */
export function hmacCredentialHasher(secret: Uint8Array | string): CredentialHasher {
  return (credential) => createHmac('sha256', secret).update('dnt-harness/route-credential/v2\u0000').update(credential).digest('hex')
}

/**
 * Used when a host injects nothing: a random secret for this process only, so
 * a fingerprint can never be precomputed from a guessed key, but identities do
 * not survive a restart (lineage keyed on them is process-local).
 */
const processLocalHasher: CredentialHasher = hmacCredentialHasher(randomBytes(32))

/**
 * An opaque generation for one provider credential: it changes whenever the
 * key (and with it, the account) changes and never contains the key. A keyed
 * HMAC truncated to 64 bits — an unsalted hash would let anyone holding the
 * route identity test candidate keys offline. Stable across restarts only when
 * the host injects its persisted hasher. An empty key (keyless local gateway)
 * is `none`.
 */
export function credentialGeneration(apiKey: string, hasher: CredentialHasher = processLocalHasher): string {
  if (apiKey === '') return 'none'
  return `k2:${hasher(apiKey).slice(0, 16)}`
}

/**
 * Version 1 route identity. Explicit fields only: normalized origin and path
 * (no query, fragment or URL credentials), wire model id, protocol and wire
 * profile, and the credential generation. Secrets, headers, timeouts and
 * display names are deliberately excluded, so renaming a provider or tuning a
 * timeout does not break lineage, while a new key, endpoint or model does.
 */
export interface RouteIdentity {
  readonly v: 1
  readonly origin: string
  readonly path: string
  readonly model: string
  readonly protocol: 'openai-chat'
  readonly profile: MaxTokensField
  readonly credential: string
}

/** Lowercased origin and slash-trimmed path; anything unparsable is `invalid`. */
export function normalizeRouteUrl(baseUrl: string): { readonly origin: string; readonly path: string } {
  try {
    const url = new URL(baseUrl.trim())
    const path = url.pathname.replace(/\/+$/, '')
    return { origin: url.origin.toLowerCase(), path: path === '' ? '/' : path }
  } catch {
    return { origin: 'invalid', path: '/' }
  }
}

export function routeIdentity(input: { readonly baseUrl: string; readonly model: string; readonly maxTokensField: MaxTokensField; readonly credentialGeneration: string }): RouteIdentity {
  const { origin, path } = normalizeRouteUrl(input.baseUrl)
  return { v: 1, origin, path, model: input.model, protocol: 'openai-chat', profile: input.maxTokensField, credential: input.credentialGeneration }
}

/** A stable string form of a route identity (fixed field order). */
export function routeKey(identity: RouteIdentity): string {
  return JSON.stringify([identity.v, identity.origin, identity.path, identity.model, identity.protocol, identity.profile, identity.credential])
}

// ── selection facts ───────────────────────────────────────────────

/** Per-model operator settings a host already loaded (provider-store shape). */
export interface EffectiveModelSettings {
  readonly contextTokens?: number
  readonly maxOutputTokens?: number
  readonly thinkingLevel?: string
}

/** One provider as the host sees it. The key never leaves the host: only its generation. */
export interface EffectiveProvider {
  readonly id: string
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly modelSettings?: Readonly<Record<string, EffectiveModelSettings>>
  readonly credentialGeneration: string
  readonly maxTokensField?: MaxTokensField
  readonly supportsStore?: boolean
  readonly supportsPromptCacheKey?: boolean
}

export interface EffectiveModelInput {
  /** The provider the host's own precedence selected, if any. */
  readonly provider?: EffectiveProvider
  /** The model the host's own precedence selected, if any. */
  readonly model?: string
  /**
   * The thinking preference after host precedence. `strict` marks an explicit
   * request (a CLI flag): an invalid or inexpressible level is an error rather
   * than silently dropped like a stored preference.
   */
  readonly thinking?: { readonly level: string | null | undefined; readonly strict?: boolean }
}

export interface EffectiveModel {
  readonly provider: string | undefined
  readonly model: string | undefined
  /** The level a request may carry for this model; `undefined` sends none. */
  readonly thinking: ThinkingLevel | undefined
  readonly budget: ResolvedBudget
  /** Absent without a model. */
  readonly output?: OutputPolicy
  /** Absent without a provider. */
  readonly compatibility?: WireCompatibility
  /** Absent without both a provider and a model. */
  readonly route?: RouteIdentity
}

export type EffectiveModelError =
  | { readonly code: 'unknown_model'; readonly message: string }
  | { readonly code: 'invalid_thinking'; readonly message: string }
  | { readonly code: 'unsupported_thinking'; readonly message: string }

export type EffectiveModelResult = { readonly ok: true; readonly value: EffectiveModel } | { readonly ok: false; readonly error: EffectiveModelError }

/**
 * Same rule on both hosts: a provider that advertises models only serves
 * those. Returns the shared message, or `undefined` when the model is fine.
 */
export function advertisedModelError(providerId: string, advertised: readonly string[], model: string | undefined): string | undefined {
  if (model === undefined || advertised.length === 0 || advertised.includes(model)) return undefined
  return `unknown model '${model}' for provider '${providerId}'; available: ${advertised.join(', ')}`
}

/** The context budget of a pair: operator override (verified) → catalog → family → 256k. */
export function effectiveBudget(model: string | undefined, settings?: EffectiveModelSettings): ResolvedBudget {
  if (model === undefined) return resolveModelBudget({})
  const contextTokens = settings?.contextTokens
  return resolveModelBudget({ model, ...(contextTokens !== undefined ? { contextTokens } : {}) })
}

/**
 * Resolve every fact for the host-selected pair. Precedence of the SELECTION
 * stays with each host (CLI flags/store, web session/global defaults); this
 * resolves what follows from it so neither host computes facts a second way.
 */
export function resolveEffectiveModel(input: EffectiveModelInput): EffectiveModelResult {
  const { provider, model } = input
  if (provider !== undefined) {
    const advertised = advertisedModelError(provider.id, provider.models, model)
    if (advertised !== undefined) return { ok: false, error: { code: 'unknown_model', message: advertised } }
  }
  const settings = provider !== undefined && model !== undefined ? provider.modelSettings?.[model] : undefined
  let thinking: ThinkingLevel | undefined
  const requested = input.thinking?.level
  if (input.thinking?.strict === true && requested !== undefined && requested !== null) {
    if (!isThinkingLevel(requested)) return { ok: false, error: { code: 'invalid_thinking', message: `thinking level '${requested}' is not recognized` } }
    thinking = expressibleThinkingLevel(model, requested)
    if (thinking === undefined) return { ok: false, error: { code: 'unsupported_thinking', message: `model '${model ?? '(none)'}' cannot express thinking level '${requested}'` } }
  } else {
    // A stored level is a preference, not a contract: an unsupported one is
    // simply not carried.
    thinking = expressibleThinkingLevel(model, requested ?? settings?.thinkingLevel)
  }
  const compatibility: WireCompatibility | undefined = provider === undefined ? undefined : {
    maxTokensField: provider.maxTokensField ?? detectMaxTokensField(provider.id, provider.baseUrl),
    supportsStore: provider.supportsStore ?? detectSupportsStore(provider.id, provider.baseUrl),
    supportsPromptCacheKey: provider.supportsPromptCacheKey ?? detectSupportsPromptCacheKey(provider.baseUrl),
  }
  return {
    ok: true,
    value: {
      provider: provider?.id,
      model,
      thinking,
      budget: effectiveBudget(model, settings),
      ...(model !== undefined ? { output: outputPolicy(model, settings?.maxOutputTokens) } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
      ...(provider !== undefined && model !== undefined && compatibility !== undefined
        ? { route: routeIdentity({ baseUrl: provider.baseUrl, model, maxTokensField: compatibility.maxTokensField, credentialGeneration: provider.credentialGeneration }) }
        : {}),
    },
  }
}
