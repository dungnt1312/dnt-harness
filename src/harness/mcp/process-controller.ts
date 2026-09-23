/**
 * What this host is willing to claim about a stdio child.
 *
 * `hard` is reserved for a tested Windows Job Object or a delegated Linux
 * cgroup v2. This build does not ship that helper, so hard limits are
 * refused. Best-effort means a watchdog in this process, not a sandbox:
 * the child still runs as the user.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { detectLinuxCgroup } from './process-controller-linux.ts'
import { detectWindowsJobObject } from './process-controller-windows.ts'

export type Containment = 'hard' | 'best_effort' | 'unavailable'

export interface ContainmentReport {
  readonly level: Containment
  readonly platform: NodeJS.Platform
  readonly detail: string
}

const AMBIENT_ALLOW = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'systemdrive',
  'temp', 'tmp', 'home', 'userprofile', 'homedrive', 'homepath',
  'lang', 'lc_all', 'tz',
])

/** Environment passed to a stdio server: platform basics plus explicit config. */
export function minimalStdioEnv(
  explicit: Readonly<Record<string, string>>,
  passEnv: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!AMBIENT_ALLOW.has(key.toLowerCase())) continue
    env[key] = value
  }
  for (const name of passEnv) {
    if (name.toLowerCase() === 'node_options') continue
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (key.toLowerCase() === 'node_options') continue
    env[key] = value
  }
  return env
}

export async function containmentCapability(): Promise<ContainmentReport> {
  if (process.platform === 'win32') return detectWindowsJobObject()
  if (process.platform === 'linux') return detectLinuxCgroup()
  return {
    level: 'best_effort',
    platform: process.platform,
    detail: 'no tested hard-containment primitive; cleanup is best effort and is not a sandbox',
  }
}

export async function assertHardContainmentAvailable(): Promise<void> {
  const report = await containmentCapability()
  if (report.level !== 'hard') {
    throw new Error(`containment_unavailable: ${report.detail}`)
  }
}

/**
 * Resolve a command to a canonical file before spawn. `shell` is not used.
 * A path that does not stay on the resolved file is refused.
 */
export async function resolveCanonicalExecutable(command: string): Promise<{ readonly path: string; readonly sha256: string }> {
  if (command.trim() === '' || command.includes('\0') || /[\r\n]/.test(command)) {
    throw new Error('stdio command is empty or contains a newline')
  }
  const candidate = path.isAbsolute(command) ? command : await findOnPath(command)
  const real = await fs.realpath(candidate)
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new Error(`stdio command is not a file: ${real}`)
  const bytes = await fs.readFile(real)
  return { path: real, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function findOnPath(command: string): Promise<string> {
  if (command.includes('/') || command.includes('\\') || command.includes('..')) {
    throw new Error('relative stdio commands are refused; pass an absolute executable path')
  }
  const pathValue = process.env['PATH'] ?? process.env['Path'] ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = path.join(dir, process.platform === 'win32' && path.extname(command) === '' ? `${command}${extension}` : command)
      try {
        const stat = await fs.stat(candidate)
        if (stat.isFile()) return candidate
      } catch {
        // keep searching
      }
    }
  }
  throw new Error(`stdio command '${command}' was not found on PATH`)
}
