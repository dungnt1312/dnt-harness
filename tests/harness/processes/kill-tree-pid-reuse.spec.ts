import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const spawnCalls: Array<{ command: string; args: readonly string[] }> = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: readonly string[]) => {
      spawnCalls.push({ command, args })
      return new EventEmitter()
    },
  }
})

const { killTree } = await import('../../../src/capabilities/shell/bash.ts')

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function fakeChild(state: { exitCode: number | null; signalCode: NodeJS.Signals | null }): ChildProcess & { kills: string[] } {
  const kills: string[] = []
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: state.exitCode,
    signalCode: state.signalCode,
    kills,
    kill: (signal: string) => { kills.push(signal); return true },
  }) as unknown as ChildProcess & { kills: string[] }
}

const pidKills = (): number => spawnCalls.filter((call) => call.command === 'taskkill').length

beforeEach(() => {
  spawnCalls.length = 0
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
})

it('never taskkills the PID of a root that has already exited, but still sweeps by tag', () => {
  const child = fakeChild({ exitCode: 0, signalCode: null })
  killTree(child, 'bash.exe', 'tag-1')
  vi.advanceTimersByTime(1_000)
  expect(pidKills()).toBe(0)
  expect(child.kills).toEqual([])
  expect(spawnCalls.some((call) => call.command === 'bash.exe')).toBe(true)
})

it('treats a signal-terminated root as exited', () => {
  const child = fakeChild({ exitCode: null, signalCode: 'SIGKILL' })
  killTree(child, 'bash.exe', 'tag-2')
  vi.advanceTimersByTime(1_000)
  expect(pidKills()).toBe(0)
})

it('skips the delayed second pass when the root exits after the first', () => {
  const child = fakeChild({ exitCode: null, signalCode: null })
  killTree(child, 'bash.exe', 'tag-3')
  expect(pidKills()).toBe(1)
  ;(child as { exitCode: number | null }).exitCode = 1
  vi.advanceTimersByTime(1_000)
  expect(pidKills()).toBe(1)
  expect(child.kills).toEqual([])
})

it('still kills the tree of a live root twice', () => {
  const child = fakeChild({ exitCode: null, signalCode: null })
  killTree(child, 'bash.exe', 'tag-4')
  vi.advanceTimersByTime(1_000)
  expect(pidKills()).toBe(2)
})
