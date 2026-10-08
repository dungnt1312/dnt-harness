import { mkdir as fsMkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadProviderStore, loadProviders, maskKey, parseProviderStore, parseProviders, saveProviderStore, saveProviders, slugify, validateModelAliasName } from '../../src/web/provider-store.ts'

let dir = ''

/** Wrap entries in the only accepted on-disk shape. */
function envelope(providers: readonly unknown[]): string {
  return JSON.stringify({ version: 2, defaults: { provider: null, model: null, thinkingLevel: null }, providers })
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dnt-harness-providers-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('provider store', () => {
  it('missing or malformed file yields an empty list', () => {
    expect(loadProviders(path.join(dir, 'absent.json'))).toEqual([])
    expect(parseProviders('not json')).toEqual([])
    expect(parseProviders('{"id":"x"}')).toEqual([]) // object, not array
    expect(parseProviders('[{"nope":1}]')).toEqual([]) // junk entry dropped
  })

  it('round-trips through save + load', async () => {
    const file = path.join(dir, 'providers.json')
    await saveProviders(file, [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1', models: ['deepseek-chat'], enabled: true },
      { id: 'proxy', name: 'cliproxy1', baseUrl: 'http://10.0.0.1:8000/v1', apiKey: '', models: [], enabled: false },
    ])
    const loaded = loadProviders(file)
    expect(loaded).toHaveLength(2)
    expect(loaded[0]?.name).toBe('DeepSeek')
    expect(loaded[1]?.enabled).toBe(false)
    const onDisk = await readFile(file, 'utf8')
    expect(onDisk).toContain('api.deepseek.com')
  })


  it('drops a legacy bare array rather than migrating it', () => {
    expect(parseProviderStore(JSON.stringify([{
      id: 'alpha', name: 'Alpha', baseUrl: 'http://x/v1', apiKey: 'secret',
      models: ['first', 'preferred'], enabled: true,
    }]))).toEqual({ version: 2, defaults: { provider: null, model: null, thinkingLevel: null }, providers: [], aliases: [], aliasGeneration: 0 })
  })

  it('ignores a stored defaultModel field: model choice is never per provider', () => {
    const store = parseProviderStore(JSON.stringify({
      version: 2,
      defaults: { provider: null, model: null, thinkingLevel: null },
      providers: [{ id: 'a', name: 'A', baseUrl: 'http://x/v1', apiKey: '', models: ['first', 'second'], defaultModel: 'second', enabled: true }],
    }))
    expect(store.providers[0]).toEqual({ id: 'a', name: 'A', baseUrl: 'http://x/v1', apiKey: '', models: ['first', 'second'], enabled: true })
  })

  it('round-trips a versioned envelope including explicit global defaults', async () => {
    const file = path.join(dir, 'envelope.json')
    await saveProviderStore(file, {
      version: 2,
      defaults: { provider: 'beta', model: 'b2', thinkingLevel: 'high' },
      providers: [{ id: 'beta', name: 'Beta', baseUrl: 'http://x/v1', apiKey: '', models: ['b1', 'b2'], enabled: true }],
      aliases: [{ name: 'fast', provider: 'beta', model: 'b2', thinkingLevel: null, revision: 1 }],
      aliasGeneration: 1,
    })
    expect(loadProviderStore(file)).toMatchObject({ defaults: { provider: 'beta', model: 'b2', thinkingLevel: 'high' }, aliases: [{ name: 'fast', provider: 'beta', model: 'b2', thinkingLevel: null, revision: 1 }] })
    expect((await readFile(file, 'utf8')).trimStart()).toMatch(/^\{/)
  })

  it('uses null defaults when no enabled provider has a model', () => {
    expect(parseProviderStore(JSON.stringify({ version: 2, defaults: { provider: null, model: null, thinkingLevel: null }, providers: [] })).defaults)
      .toEqual({ provider: null, model: null, thinkingLevel: null })
    expect(parseProviderStore(envelope([{ id: 'a', name: 'A', baseUrl: 'http://x', apiKey: '', models: [], enabled: true }])).defaults)
      .toEqual({ provider: null, model: null, thinkingLevel: null })
  })

  it('loads old v2 files without aliases and retains broken alias targets', async () => {
    const old = parseProviderStore(envelope([]))
    expect(old).toMatchObject({ aliases: [], aliasGeneration: 0 })
    const parsed = parseProviderStore(JSON.stringify({ version: 2, defaults: { provider: null, model: null, thinkingLevel: null }, providers: [], aliases: [{ name: 'broken', provider: 'gone', model: 'removed', thinkingLevel: null, revision: 2 }] }))
    expect(parsed).toMatchObject({ aliases: [expect.objectContaining({ name: 'broken' })], aliasGeneration: 2 })
    const file = path.join(dir, 'retain-aliases.json')
    await saveProviderStore(file, parsed)
    await saveProviders(file, [{ id: 'new', name: 'New', baseUrl: 'http://x', apiKey: '', models: ['m'], enabled: true }])
    expect(loadProviderStore(file).aliases[0]?.name).toBe('broken')
  })

  it('surfaces non-ENOENT load errors instead of treating them as an empty store', async () => {
    const directory = path.join(dir, 'not-a-file')
    await fsMkdir(directory)
    expect(() => loadProviderStore(directory)).toThrow()
  })

  it('validates plain alias names', () => {
    expect(validateModelAliasName(' Fast ')).toBe('Fast')
    for (const invalid of ['', ' ', 'inherit', 'a b', 'p:m', '@x', 'a\nb']) expect(() => validateModelAliasName(invalid)).toThrow()
  })

  it('slugify produces stable url-safe ids', () => {
    expect(slugify('GLM Coding Lite!')).toBe('glm-coding-lite')
    expect(slugify('   ')).toBe('provider')
  })

  it('maskKey hides everything but the tail', () => {
    expect(maskKey('sk-abcd1234')).toBe('••••1234')
    expect(maskKey('abc')).toBe('••••')
    // A keyless provider must not look like it holds a hidden secret.
    expect(maskKey('')).toBe('')
  })

  it('seeds the first advertised model as the fallback pair', () => {
    const seeded = parseProviders(envelope([{
      id: 'deepseek',
      name: 'deepseek',
      baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
      apiKey: 'env-key',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      enabled: true,
    }]))
    expect(seeded[0]?.models[0]).toBe('deepseek-chat')
  })

  it('parses per-model settings and drops junk fields', () => {
    const loaded = parseProviders(envelope([{
      id: 'p', name: 'P', baseUrl: 'http://x/v1', apiKey: '',
      models: ['a'],
      modelSettings: {
        a: { contextTokens: 300_000, vision: true, thinkingLevel: 'high' },
        b: { contextTokens: -5, vision: 'yes', thinkingLevel: 'ultra' },
      },
    }]))
    expect(loaded[0]?.modelSettings).toEqual({ a: { contextTokens: 300_000, vision: true, thinkingLevel: 'high' } })
  })

  it('legacy contextLimits migrate into modelSettings.contextTokens', () => {
    const loaded = parseProviders(envelope([{
      id: 'p', name: 'P', baseUrl: 'http://x/v1', apiKey: '',
      models: ['a', 'b'],
      contextLimits: { a: 128_000, b: 0 },
    }]))
    expect(loaded[0]?.modelSettings).toEqual({ a: { contextTokens: 128_000 } })
  })
})
