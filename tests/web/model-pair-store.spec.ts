/**
 * The three provider/model references (image generation, image understanding,
 * video generation): one persistence contract, three Settings-fix resolvers.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLANK_PAIR, loadPair, parsePair, savePair, validatePairBody } from '../../src/web/model-pair-store.ts'
import { resolveImageApi } from '../../src/web/image-generation-store.ts'
import { resolveVisionApi } from '../../src/web/image-understanding-store.ts'
import { resolveVideoApi } from '../../src/web/video-generation-store.ts'
import type { ProviderConfig } from '../../src/web/provider-store.ts'

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'proxy', name: 'Proxy', baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'k', models: [], enabled: true, ...overrides,
})

describe('model pair persistence', () => {
  it('round-trips through disk and treats a missing or broken file as not configured', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-model-pair-'))
    try {
      const file = path.join(dir, 'nested', 'video-generation.json')
      expect(loadPair(file)).toEqual(BLANK_PAIR)
      await savePair(file, { provider: 'proxy', model: 'grok-imagine-video' })
      expect(loadPair(file)).toEqual({ provider: 'proxy', model: 'grok-imagine-video' })
      await fs.writeFile(file, '{not json')
      expect(loadPair(file)).toEqual(BLANK_PAIR)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps only a complete pair', () => {
    expect(parsePair({ provider: 'p' })).toEqual(BLANK_PAIR)
    expect(parsePair({ provider: ' p ', model: ' m ' })).toEqual({ provider: 'p', model: 'm' })
    expect(parsePair([])).toEqual(BLANK_PAIR)
    expect(parsePair(null)).toEqual(BLANK_PAIR)
  })

  it('validates a PUT body: complete pair, explicit clear, or a reason', () => {
    const known = (id: string): boolean => id === 'proxy'
    expect(validatePairBody({ provider: 'proxy', model: 'm' }, known)).toEqual({ ok: true, pair: { provider: 'proxy', model: 'm' } })
    expect(validatePairBody({ provider: null, model: null }, known)).toEqual({ ok: true, pair: BLANK_PAIR })
    expect(validatePairBody({ provider: '', model: '' }, known)).toEqual({ ok: true, pair: BLANK_PAIR })
    expect(validatePairBody({ provider: 'x' }, known)).toMatchObject({ ok: false, error: expect.stringMatching(/provider' and 'model/) })
    expect(validatePairBody({}, known)).toMatchObject({ ok: false })
    expect(validatePairBody({ provider: 'nope', model: 'm' }, known)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown provider 'nope'/) })
  })
})

describe('resolvers name the Settings fix', () => {
  it('image and video generation resolve to an endpoint', () => {
    for (const [resolve, label] of [[resolveImageApi, /Image generation/], [resolveVideoApi, /Video generation/]] as const) {
      expect(resolve(BLANK_PAIR, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/not configured/) })
      expect(resolve(BLANK_PAIR, [provider()])).toMatchObject({ reason: expect.stringMatching(label) })
      expect(resolve({ provider: 'gone', model: 'm' }, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) })
      expect(resolve({ provider: 'proxy', model: 'm' }, [provider({ enabled: false })])).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) })
      expect(resolve({ provider: 'proxy', model: 'm' }, [provider({ baseUrl: '  ' })])).toMatchObject({ ok: false, reason: expect.stringMatching(/no base URL/) })
      expect(resolve({ provider: 'proxy', model: 'm' }, [provider()])).toEqual({ ok: true, config: { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'k', model: 'm' } })
    }
  })

  it('image understanding resolves to a provider id and model, not an endpoint', () => {
    expect(resolveVisionApi(BLANK_PAIR, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/not configured/) })
    expect(resolveVisionApi({ provider: 'gone', model: 'm' }, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) })
    expect(resolveVisionApi({ provider: 'proxy', model: 'm' }, [provider({ enabled: false })])).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) })
    expect(resolveVisionApi({ provider: 'proxy', model: 'gpt-4o' }, [provider()])).toEqual({ ok: true, config: { provider: 'proxy', model: 'gpt-4o' } })
  })
})
