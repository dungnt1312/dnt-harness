// Type declarations for agent-run.mjs (consumed by tests/scripts).
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Fingerprint, Snapshot } from './repo-freeze.mjs'

export interface RunResult { code: number | null; ms: number; timedOut: boolean; stdout: string; stderr: string }
export interface ContestantResult {
  result: RunResult
  drift: string[]
  sourceChanged: string[]
  target: string
  ran: boolean
}

export function killTree(child: ChildProcess): void
export function runProcess(cmd: string, args: string[], options?: SpawnOptions & { timeoutMs?: number }): Promise<RunResult>
export function runContestant(options: {
  snapshot: Snapshot | null
  targetDir: string
  registry: string
  sourceBefore?: Fingerprint | null
  sourceRoot?: string
  launch: (target: string) => Promise<RunResult>
}): Promise<ContestantResult>
export function runFailed(entry: ContestantResult, missing?: string[]): boolean
