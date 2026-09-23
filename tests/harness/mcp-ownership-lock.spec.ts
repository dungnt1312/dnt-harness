import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DataHomeLock, OwnershipError } from 'mini-dsh'

let home = ''

afterEach(async () => {
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

describe('data-home ownership lock', () => {
  it('refuses a second live owner and fences the epoch after the holder is gone', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-lock-'))
    let now = 1_000
    const alive = new Set<number>([process.pid])
    const first = await DataHomeLock.acquire(home, { leaseMs: 100, now: () => now, isAlive: (pid) => alive.has(pid) })
    await expect(DataHomeLock.acquire(home, { leaseMs: 100, now: () => now, isAlive: (pid) => alive.has(pid) })).rejects.toBeInstanceOf(OwnershipError)
    await first.assertHeld()
    await first.abandon()
    alive.delete(process.pid)
    now += 500
    const second = await DataHomeLock.acquire(home, { leaseMs: 100, now: () => now, isAlive: () => false })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    await expect(first.assertHeld()).rejects.toBeInstanceOf(OwnershipError)
    await second.release()
  })
})
