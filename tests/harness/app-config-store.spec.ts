import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AppConfigStore, type ConfigRead } from '../../src/harness/config/store.ts'
import { AppConfigError, type AppConfigDocument } from '../../src/harness/config/types.ts'

/** Hash of the canonical JSON encoding, pinned independently of store internals. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
/** Canonical JSON of the empty document {v:1} — the missing-file baseline. */
const EMPTY_HASH = sha256('{"v":1}')

function validOf(read: ConfigRead): Extract<ConfigRead, { kind: 'valid' }> {
  if (read.kind !== 'valid') {
    throw new Error(`expected kind valid, got ${read.kind}${read.kind === 'invalid' ? `: ${read.error}` : ''}`)
  }
  return read
}
function missingOf(read: ConfigRead): Extract<ConfigRead, { kind: 'missing' }> {
  if (read.kind !== 'missing') throw new Error(`expected kind missing, got ${read.kind}`)
  return read
}
function invalidOf(read: ConfigRead): Extract<ConfigRead, { kind: 'invalid' }> {
  if (read.kind !== 'invalid') throw new Error(`expected kind invalid, got ${read.kind}`)
  return read
}

describe('AppConfigStore', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'app-config-store-'))
    file = path.join(dir, 'app-config.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('missing_is_empty_v1: read of a missing file canonicalizes {v:1} and creates nothing', async () => {
    const store = new AppConfigStore(file)
    const read = missingOf(await store.read())
    expect(read.document).toEqual({ v: 1 })
    expect(read.hash).toBe(EMPTY_HASH)
    // Reading must not create the file (or any temp artifact).
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(`${file}.tmp-1-aaaa`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('sparse_save_roundtrips an exact sparse document across a restart', async () => {
    const store = new AppConfigStore(file)
    const document: AppConfigDocument = { v: 1, limits: { toolTimeoutMs: 300000 } }
    const saved = await store.save(document, EMPTY_HASH)
    expect(saved.document).toEqual({ v: 1, limits: { toolTimeoutMs: 300000 } })
    // Written bytes are canonical: keys sorted, no whitespace.
    expect(await readFile(file, 'utf8')).toBe('{"limits":{"toolTimeoutMs":300000},"v":1}')
    // Restart: a fresh store over the same file reads the identical sparse document.
    const reread = validOf(await new AppConfigStore(file).read())
    expect(reread.document).toEqual({ v: 1, limits: { toolTimeoutMs: 300000 } })
    expect(reread.hash).toBe(saved.hash)
  })

  it('canonical_hash_ignores_whitespace_and_key_order', async () => {
    const store = new AppConfigStore(file)
    await writeFile(file, '{"v":1,"limits":{"toolTimeoutMs":150000}}')
    const first = validOf(await store.read())
    await writeFile(file, '\n  {  "limits" : { "toolTimeoutMs" : 150000 } ,\n "v" : 1 }  \n')
    const second = validOf(await store.read())
    expect(second.hash).toBe(first.hash)
    expect(second.document).toEqual(first.document)
  })

  it('stale_save_conflicts without touching the newer file', async () => {
    const store = new AppConfigStore(file)
    await writeFile(file, '{"v":1,"limits":{"toolTimeoutMs":1000}}')
    const stale = validOf(await store.read())
    // External edit after the stale observation.
    const newer = '{"v":1,"limits":{"toolTimeoutMs":2000}}'
    await writeFile(file, newer)
    const error = await store.save({ v: 1, limits: { toolTimeoutMs: 3000 } }, stale.hash).then(
      () => { throw new Error('expected save to reject') },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppConfigError)
    expect((error as AppConfigError).code).toBe('conflict')
    // The file bytes are untouched by the rejected save.
    expect(await readFile(file, 'utf8')).toBe(newer)
  })

  it('invalid_and_future_versions_are_read_invalid_and_never_overwritten', async () => {
    const store = new AppConfigStore(file)
    const cases: readonly string[] = [
      '{ broken json',
      '{"v":2}',
      '{"v":1,"unknown":{"section":true}}',
      '{"v":1,"limits":{"notALimitKey":5}}',
    ]
    for (const raw of cases) {
      await writeFile(file, raw)
      const read = invalidOf(await store.read())
      expect(read.error.length).toBeGreaterThan(0)
      // Save must reject (no silent repair, no overwrite of unsupported content).
      const error = await store.save({ v: 1 }, EMPTY_HASH).then(
        () => { throw new Error(`expected save to reject for ${raw}`) },
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(AppConfigError)
      expect((error as AppConfigError).code).toBe('invalid')
      // Original bytes preserved.
      expect(await readFile(file, 'utf8')).toBe(raw)
    }
  })

  it('save_rejects_non_finite_limit_as_invalid_not_bare_error', async () => {
    const store = new AppConfigStore(file)
    // NaN passes the structural AppConfigDocument type but not parseLimitOverrides.
    const document = { v: 1, limits: { toolTimeoutMs: Number.NaN } } as AppConfigDocument
    const error = await store.save(document, EMPTY_HASH).then(
      () => { throw new Error('expected save to reject') },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppConfigError)
    expect((error as AppConfigError).code).toBe('invalid')
    // Nothing was written: the file stays absent.
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('read_permission_error_is_io_not_missing', async () => {
    const store = new AppConfigStore(file, {
      read: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
    })
    const error = await store.read().then(
      () => { throw new Error('expected read to reject') },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppConfigError)
    expect((error as AppConfigError).code).toBe('io')
  })

  it('failed_atomic_write_preserves_existing_bytes', async () => {
    const original = '{"v":1,"limits":{"toolTimeoutMs":1000}}'
    await writeFile(file, original)
    const store = new AppConfigStore(file, {
      write: async () => { throw new Error('disk full') },
    })
    const current = validOf(await store.read())
    const error = await store.save({ v: 1, limits: { toolTimeoutMs: 9000 } }, current.hash).then(
      () => { throw new Error('expected save to reject') },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppConfigError)
    expect((error as AppConfigError).code).toBe('io')
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('queued_saves_recheck_hash: same baseline, one success one conflict', async () => {
    const store = new AppConfigStore(file)
    const baseline = missingOf(await store.read())
    const first = store.save({ v: 1, limits: { toolTimeoutMs: 1000 } }, baseline.hash)
    const second = store.save({ v: 1, limits: { toolTimeoutMs: 2000 } }, baseline.hash)
    const settled = await Promise.allSettled([first, second])
    const fulfilled = settled.filter(s => s.status === 'fulfilled')
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(AppConfigError)
    expect((rejected[0]?.reason as AppConfigError).code).toBe('conflict')
    // The winning document is what is on disk, and its hash is self-consistent.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ document: AppConfigDocument; hash: string }>).value
    expect(await readFile(file, 'utf8')).toBe('{"limits":{"toolTimeoutMs":' +
      String(winner.document.limits?.toolTimeoutMs) + '},"v":1}')
    const reread = validOf(await store.read())
    expect(reread.hash).toBe(winner.hash)
  })
})
