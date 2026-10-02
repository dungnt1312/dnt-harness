/**
 * The rename from mini-dsh must not strand an existing install: the old home
 * folder and the old environment variables keep working.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptLegacyEnv, resolveAppHome } from '../../src/harness/app-home.ts'
import { isWithheldEnv } from '../../src/harness/child-env.ts'
import { migrateLegacyStorage } from '../../web/lib/legacy-storage.ts'

describe('app home after the rename', () => {
  it('uses .dnt-harness by default, the legacy .mini-dsh while only it exists, and the new one once both exist', async () => {
    const base = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-home-'))
    try {
      expect(resolveAppHome(base)).toBe(path.join(base, '.dnt-harness'))
      await fs.mkdir(path.join(base, '.mini-dsh'))
      expect(resolveAppHome(base)).toBe(path.join(base, '.mini-dsh'))
      await fs.mkdir(path.join(base, '.dnt-harness'))
      expect(resolveAppHome(base)).toBe(path.join(base, '.dnt-harness'))
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})

describe('legacy environment variables', () => {
  it('mirror MINI_DSH_* to DNT_HARNESS_* without overriding explicit new values', () => {
    const env: NodeJS.ProcessEnv = { MINI_DSH_AUTH: '1', MINI_DSH_BASH: '/old', DNT_HARNESS_BASH: '/new' }
    adoptLegacyEnv(env)
    expect(env['DNT_HARNESS_AUTH']).toBe('1')
    expect(env['DNT_HARNESS_BASH']).toBe('/new')
  })

  it('are withheld from model-driven children under both prefixes', () => {
    expect(isWithheldEnv('DNT_HARNESS_AUTH')).toBe(true)
    expect(isWithheldEnv('MINI_DSH_AUTH')).toBe(true)
  })
})

describe('legacy browser storage', () => {
  function memoryStorage(seed: Record<string, string>): Storage {
    const map = new Map(Object.entries(seed))
    return {
      get length() { return map.size },
      key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
      removeItem: (key: string) => { map.delete(key) },
      clear: () => map.clear(),
    }
  }

  it('copies mini-dsh.* keys to dnt-harness.* once and never overwrites a newer value', () => {
    const storage = memoryStorage({ 'mini-dsh.theme': 'dark', 'mini-dsh.drafts.v1': '{"a":1}', 'dnt-harness.drafts.v1': '{"b":2}', other: 'x' })
    expect(migrateLegacyStorage(storage)).toBe(1)
    expect(storage.getItem('dnt-harness.theme')).toBe('dark')
    expect(storage.getItem('dnt-harness.drafts.v1')).toBe('{"b":2}')
    expect(storage.getItem('mini-dsh.theme')).toBe('dark')
    expect(migrateLegacyStorage(storage)).toBe(0)
  })
})
