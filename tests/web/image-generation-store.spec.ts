import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLANK_IMAGE_SETTINGS, loadImageSettings, parseImageSettings, resolveImageApi, saveImageSettings } from '../../src/web/image-generation-store.ts'
import type { ProviderConfig } from '../../src/web/provider-store.ts'

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'proxy', name: 'Proxy', baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'k', models: [], enabled: true, ...overrides,
})

describe('image generation settings', () => {
  it('round-trips through disk and treats a missing or broken file as not configured', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-image-settings-'))
    const file = path.join(dir, 'image-generation.json')
    expect(loadImageSettings(file)).toEqual(BLANK_IMAGE_SETTINGS)
    await saveImageSettings(file, { provider: 'proxy', model: 'gpt-image-1' })
    expect(loadImageSettings(file)).toEqual({ provider: 'proxy', model: 'gpt-image-1' })
    await fs.writeFile(file, '{not json')
    expect(loadImageSettings(file)).toEqual(BLANK_IMAGE_SETTINGS)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('keeps only a complete pair', () => {
    expect(parseImageSettings({ provider: 'p' })).toEqual(BLANK_IMAGE_SETTINGS)
    expect(parseImageSettings({ provider: ' p ', model: ' m ' })).toEqual({ provider: 'p', model: 'm' })
    expect(parseImageSettings([])).toEqual(BLANK_IMAGE_SETTINGS)
  })

  it('resolves against the live provider list with a Settings fix for each failure', () => {
    expect(resolveImageApi(BLANK_IMAGE_SETTINGS, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/not configured/) })
    expect(resolveImageApi({ provider: 'gone', model: 'm' }, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) })
    expect(resolveImageApi({ provider: 'proxy', model: 'm' }, [provider({ enabled: false })])).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) })
    expect(resolveImageApi({ provider: 'proxy', model: 'm' }, [provider()])).toEqual({ ok: true, config: { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'k', model: 'm' } })
  })
})
