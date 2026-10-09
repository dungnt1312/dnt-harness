import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLANK_IMAGE_UNDERSTANDING, loadImageUnderstandingSettings, parseImageUnderstandingSettings, resolveVisionApi, saveImageUnderstandingSettings } from '../../src/web/image-understanding-store.ts'
import type { ProviderConfig } from '../../src/web/provider-store.ts'

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'vision', name: 'Vision', baseUrl: 'http://vision/v1', apiKey: 'k', models: [], enabled: true, ...overrides })

describe('image understanding settings', () => {
  it('round-trips and soft-fails missing or malformed files', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-vision-settings-'))
    const file = path.join(dir, 'image-understanding.json')
    expect(loadImageUnderstandingSettings(file)).toEqual(BLANK_IMAGE_UNDERSTANDING)
    await saveImageUnderstandingSettings(file, { provider: 'vision', model: 'gpt-4o' })
    expect(loadImageUnderstandingSettings(file)).toEqual({ provider: 'vision', model: 'gpt-4o' })
    await fs.writeFile(file, 'bad')
    expect(loadImageUnderstandingSettings(file)).toEqual(BLANK_IMAGE_UNDERSTANDING)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('keeps complete pairs and resolves against live providers', () => {
    expect(parseImageUnderstandingSettings({ provider: 'p' })).toEqual(BLANK_IMAGE_UNDERSTANDING)
    expect(parseImageUnderstandingSettings({ provider: ' vision ', model: ' gpt-4o ' })).toEqual({ provider: 'vision', model: 'gpt-4o' })
    expect(resolveVisionApi(BLANK_IMAGE_UNDERSTANDING, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/not configured/) })
    expect(resolveVisionApi({ provider: 'gone', model: 'm' }, [provider()])).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) })
    expect(resolveVisionApi({ provider: 'vision', model: 'gpt-4o' }, [provider({ enabled: false })])).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) })
    expect(resolveVisionApi({ provider: 'vision', model: 'gpt-4o' }, [provider()])).toEqual({ ok: true, config: { provider: 'vision', model: 'gpt-4o' } })
  })
})
