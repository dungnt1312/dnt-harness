/**
 * Linux hard limits require a cgroup v2 the process is allowed to delegate
 * into. Reading the controllers file is not enough: without a writable
 * child cgroup, the host reports best effort and refuses hard limits.
 */
import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import type { ContainmentReport } from './process-controller.ts'

export async function detectLinuxCgroup(): Promise<ContainmentReport> {
  // Writable controllers are not a claim. This build does not put the child
  // in a cgroup, so hard limits stay refused on Linux too.
  void fs
  void constants
  return {
    level: 'best_effort',
    platform: 'linux',
    detail: 'MCP children are not placed in a cgroup in this build; hard limits are refused. This is not a sandbox',
  }
}
