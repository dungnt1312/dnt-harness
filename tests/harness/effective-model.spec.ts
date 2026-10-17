/**
 * Phase 04 (plans/261017-runtime-provider-hardening): the shared effective
 * model resolver (PH-1), the output-cap policy as amended by the validation
 * session — 32k fallback plus bounded relearning, no unknown-omit (PH-2) —
 * exact-snapshot catalog precedence, the window ceiling, and the thinking
 * coupling with the final cap.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL_SECRET_FILE, loadCredentialHasher } from '../../src/harness/llm/credential-secret.ts'
import {
  OUTPUT_TOKEN_FALLBACK,
  advertisedModelError,
  applyThinking,
  credentialGeneration,
  hmacCredentialHasher,
  normalizeRouteUrl,
  outputCeiling,
  outputPolicy,
  outputTokenCap,
  resolveEffectiveModel,
  routeIdentity,
  routeKey,
  type EffectiveProvider,
} from '../../src/harness/llm/effective-model.ts'
import { resolveOutputLimit, resolveOutputLimitSource, getModelInfo } from '../../src/harness/llm/model-catalog.ts'

const provider = (overrides: Partial<EffectiveProvider> = {}): EffectiveProvider => ({
  id: 'gw', baseUrl: 'https://gw.example/v1', models: ['custom-model'], credentialGeneration: credentialGeneration('sk-one'), ...overrides,
})

describe('PH1: one resolver for CLI and web facts', () => {
  it('PH1-A: a custom model with context 32768 / output 4096 resolves both from the same store entry', () => {
    const result = resolveEffectiveModel({
      provider: provider({ modelSettings: { 'custom-model': { contextTokens: 32_768, maxOutputTokens: 4_096 } } }),
      model: 'custom-model',
    })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.budget).toMatchObject({ contextLimitTokens: 32_768, verified: true, windowSource: 'override' })
    expect(result.value.output).toEqual({ cap: 4_096, source: 'override', guessed: false })
    // The wire cap follows from the same policy the adapter applies.
    expect(outputTokenCap('custom-model', { 'custom-model': 4_096 }, undefined, 20_000)).toBe(4_096)
  })

  it('PH1-B: the same model id on two providers keeps its own overrides', () => {
    const a = resolveEffectiveModel({ provider: provider({ id: 'a', models: ['m'], modelSettings: { m: { contextTokens: 50_000, maxOutputTokens: 2_000 } } }), model: 'm' })
    const b = resolveEffectiveModel({ provider: provider({ id: 'b', models: ['m'], modelSettings: { m: { contextTokens: 90_000 } } }), model: 'm' })
    if (!a.ok || !b.ok) throw new Error('unexpected failure')
    expect(a.value.budget.contextLimitTokens).toBe(50_000)
    expect(b.value.budget.contextLimitTokens).toBe(90_000)
    expect(a.value.output?.source).toBe('override')
    expect(b.value.output).toEqual({ cap: OUTPUT_TOKEN_FALLBACK, source: 'fallback', guessed: true })
  })

  it('PH1-C: advertised-model and thinking validation are shared, strict for a flag, lenient for a preference', () => {
    expect(advertisedModelError('fake', ['m'], 'nope')).toBe("unknown model 'nope' for provider 'fake'; available: m")
    expect(advertisedModelError('fake', [], 'anything')).toBeUndefined()
    const unknown = resolveEffectiveModel({ provider: provider({ id: 'fake', models: ['m'] }), model: 'nope' })
    expect(unknown).toEqual({ ok: false, error: { code: 'unknown_model', message: "unknown model 'nope' for provider 'fake'; available: m" } })
    const invalid = resolveEffectiveModel({ provider: provider(), model: 'custom-model', thinking: { level: 'bogus', strict: true } })
    expect(invalid.ok === false && invalid.error.code).toBe('invalid_thinking')
    const unsupported = resolveEffectiveModel({ provider: provider(), model: 'custom-model', thinking: { level: 'high', strict: true } })
    expect(unsupported.ok === false && unsupported.error.message).toBe("model 'custom-model' cannot express thinking level 'high'")
    // A stored preference the model cannot express is simply not carried.
    const stored = resolveEffectiveModel({ provider: provider(), model: 'custom-model', thinking: { level: 'high' } })
    expect(stored.ok && stored.value.thinking).toBeUndefined()
    // The per-model default applies when no level is chosen.
    const perModel = resolveEffectiveModel({ provider: provider({ models: ['gpt-5.6'], modelSettings: { 'gpt-5.6': { thinkingLevel: 'xhigh' } } }), model: 'gpt-5.6', thinking: { level: null } })
    expect(perModel.ok && perModel.value.thinking).toBe('xhigh')
  })

  it('PH1-D: route identity is versioned, explicit, secret-free, and changes with endpoint, model, profile or credential', () => {
    const base = { baseUrl: 'https://user:pw@GW.Example:8443/v1/?api-key=SECRET#frag', model: 'm', maxTokensField: 'max_tokens' as const, credentialGeneration: credentialGeneration('sk-live-THEKEY123456') }
    const id = routeIdentity(base)
    expect(id).toEqual({ v: 1, origin: 'https://gw.example:8443', path: '/v1', model: 'm', protocol: 'openai-chat', profile: 'max_tokens', credential: id.credential })
    const serialized = routeKey(id)
    for (const secret of ['SECRET', 'pw', 'user', 'THEKEY123456', 'frag']) expect(serialized).not.toContain(secret)
    // Stable for the same facts; different when any routed fact changes.
    expect(routeKey(routeIdentity(base))).toBe(serialized)
    expect(routeKey(routeIdentity({ ...base, model: 'm2' }))).not.toBe(serialized)
    expect(routeKey(routeIdentity({ ...base, baseUrl: 'https://gw.example:8443/v2' }))).not.toBe(serialized)
    expect(routeKey(routeIdentity({ ...base, maxTokensField: 'max_completion_tokens' }))).not.toBe(serialized)
    expect(routeKey(routeIdentity({ ...base, credentialGeneration: credentialGeneration('sk-live-OTHERKEY9876') }))).not.toBe(serialized)
    // Trailing slashes and query noise do not change the route.
    expect(normalizeRouteUrl('https://gw.example/v1/')).toEqual(normalizeRouteUrl('https://gw.example/v1?x=1'))
    expect(normalizeRouteUrl('not a url')).toEqual({ origin: 'invalid', path: '/' })
  })

  it('credential generation is a keyed HMAC: opaque, rotation-sensitive, secret-dependent, none for keyless', () => {
    const key = 'sk-live-ABCDEFGH12345678'
    const hasher = hmacCredentialHasher(Buffer.alloc(32, 7))
    expect(credentialGeneration(key, hasher)).toBe(credentialGeneration(key, hasher))
    expect(credentialGeneration(key, hasher)).not.toBe(credentialGeneration(`${key}9`, hasher))
    expect(credentialGeneration(key, hasher)).not.toContain('ABCDEFGH')
    expect(credentialGeneration(key, hasher)).toMatch(/^k2:[0-9a-f]{16}$/)
    // Phase-04 review M3: not an unsalted hash — a different install secret
    // gives a different fingerprint, so it cannot be precomputed from a key.
    expect(credentialGeneration(key, hmacCredentialHasher(Buffer.alloc(32, 8)))).not.toBe(credentialGeneration(key, hasher))
    expect(credentialGeneration(key, hasher)).not.toBe(`k2:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`)
    // Without an injected hasher: a process-local secret (stable in-process).
    expect(credentialGeneration(key)).toBe(credentialGeneration(key))
    expect(credentialGeneration('')).toBe('none')
  })

  it('the per-install secret is created once, owner-only, reused across loads, and falls back in memory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'route-secret-'))
    try {
      const first = loadCredentialHasher(dir)
      const second = loadCredentialHasher(dir)
      expect(first.persistent).toBe(true)
      expect(credentialGeneration('sk-x-12345678', first.hash)).toBe(credentialGeneration('sk-x-12345678', second.hash))
      const file = path.join(dir, CREDENTIAL_SECRET_FILE)
      expect((await readFile(file, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/)
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o077).toBe(0)
      // An unusable directory (a file where the dir should be): in-memory fallback.
      const blocker = path.join(dir, 'not-a-dir')
      await writeFile(blocker, 'x')
      const fallback = loadCredentialHasher(path.join(blocker, 'nested'))
      expect(fallback.persistent).toBe(false)
      expect(credentialGeneration('sk-x-12345678', fallback.hash)).not.toBe(credentialGeneration('sk-x-12345678', first.hash))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a resolved model never carries the key, only its generation', () => {
    const result = resolveEffectiveModel({ provider: provider({ credentialGeneration: credentialGeneration('sk-secret-ZZZZYYYYXXXX') }), model: 'custom-model' })
    expect(JSON.stringify(result)).not.toContain('ZZZZYYYYXXXX')
    expect(result.ok && result.value.route?.credential).toMatch(/^k2:/)
    expect(result.ok && result.value.compatibility).toEqual({ maxTokensField: 'max_tokens', supportsStore: false, supportsPromptCacheKey: false })
  })
})

describe('PH2 (amended): output-cap policy', () => {
  it('PH2-A: exact snapshots win family rules; overrides win; invalid overrides are ignored', () => {
    const table: [string, number, 'catalog' | 'family'][] = [
      ['gpt-4o-2024-05-13', 4_096, 'catalog'],
      ['openai/gpt-4o-2024-05-13', 4_096, 'catalog'],
      ['gpt-4o', 16_384, 'family'],
      ['gpt-4o-2024-08-06', 16_384, 'family'],
      ['gpt-4o-mini', 16_384, 'family'],
      ['gpt-4-turbo', 4_096, 'catalog'],
      ['gpt-4-turbo-2024-04-09', 4_096, 'catalog'],
      ['gpt-4-0125-preview', 4_096, 'catalog'],
      ['gpt-4', 8_192, 'catalog'],
      ['gpt-4.1-mini', 32_768, 'family'],
      ['claude-opus-5', 128_000, 'catalog'],
      ['openai/claude-opus-5-20261001', 128_000, 'family'],
    ]
    for (const [model, tokens, source] of table) expect(resolveOutputLimitSource(model), model).toEqual({ tokens, source })
    expect(resolveOutputLimit('totally-unknown')).toBeUndefined()
    // The output-only table never changes what the UI shows.
    expect(getModelInfo('gpt-4-turbo')?.maxOutputTokens).toBeUndefined()
    expect(outputPolicy('gpt-4o', 2_000)).toEqual({ cap: 2_000, source: 'override', guessed: false })
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(outputPolicy('gpt-4o', invalid), String(invalid)).toEqual({ cap: 16_384, source: 'family', guessed: false })
    }
    expect(outputPolicy('gpt-4o', 1_000_000).cap).toBe(256_000)
  })

  it('PH2-B: unknown keeps the 32k fallback; a learned value replaces only that guess; the ceiling never invents a cap', () => {
    expect(outputTokenCap('mystery')).toBe(32_000)
    expect(outputTokenCap('mystery', undefined, 8_000)).toBe(8_000)
    // A learned limit replaces the guess…
    expect(outputTokenCap('mystery', undefined, undefined, undefined, 4_096)).toBe(4_096)
    // …but never an operator or catalog cap.
    expect(outputTokenCap('mystery', { mystery: 10_000 }, undefined, undefined, 4_096)).toBe(10_000)
    expect(outputTokenCap('gpt-4o', undefined, undefined, undefined, 4_096)).toBe(16_384)
    // Learned "send none": nothing is sent, and the ceiling does not create one.
    expect(outputTokenCap('mystery', undefined, undefined, 5_000, null)).toBeUndefined()
    // With no base, an explicit request is the caller's own bound (still under the ceiling).
    expect(outputTokenCap('mystery', undefined, 8_000, undefined, null)).toBe(8_000)
    expect(outputTokenCap('mystery', undefined, 8_000, 5_000, null)).toBe(5_000)
  })

  it('PH2-C: GPT-4 Turbo no longer defaults to the 32k guess', () => {
    expect(outputTokenCap('gpt-4-turbo')).toBe(4_096)
    expect(outputPolicy('gpt-4-turbo').guessed).toBe(false)
  })

  it('PH2-D: the ceiling bounds without a floor; zero/negative is exhausted, not unset; global max holds', () => {
    expect(outputTokenCap('mystery', undefined, undefined, 700)).toBe(700)
    expect(outputTokenCap('gpt-4o', undefined, 256, 1_000)).toBe(256)
    expect(outputCeiling(undefined)).toBeUndefined()
    expect(outputCeiling(0)).toBe('exhausted')
    expect(outputCeiling(-50)).toBe('exhausted')
    expect(outputCeiling(0.4)).toBe('exhausted')
    expect(outputCeiling(1_500.9)).toBe(1_500)
    expect(outputTokenCap('deepseek-flash')).toBe(256_000)
    expect(outputTokenCap('m', { m: 1_000_000 }, undefined, undefined)).toBe(256_000)
  })
})

describe('thinking coupling with the final cap', () => {
  it('drops Claude budget thinking when no cap is sent, and keeps it below a sent cap', () => {
    const none: Record<string, unknown> = {}
    applyThinking(none, 'claude-gateway-alias', 'high', undefined)
    expect(none['thinking']).toBeUndefined()
    const capped: Record<string, unknown> = {}
    applyThinking(capped, 'claude-gateway-alias', 'max', 4_096)
    expect(capped['thinking']).toEqual({ type: 'enabled', budget_tokens: 4_095 })
    const tiny: Record<string, unknown> = {}
    applyThinking(tiny, 'claude-gateway-alias', 'low', 1_024)
    expect(tiny['thinking']).toBeUndefined()
    // A disable request needs no cap and still goes out.
    const off: Record<string, unknown> = {}
    applyThinking(off, 'claude-gateway-alias', 'off', undefined)
    expect(off['thinking']).toEqual({ type: 'disabled' })
    // Effort-style thinking is unaffected by an absent cap.
    const effort: Record<string, unknown> = {}
    applyThinking(effort, 'gpt-5.6', 'high', undefined)
    expect(effort['reasoning_effort']).toBe('high')
  })
})
