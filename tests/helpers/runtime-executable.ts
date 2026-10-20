import { existsSync } from 'node:fs'
import path from 'node:path'

export const REQUIRED_BUN_VERSION = '1.4.3'

const exeName = process.platform === 'win32' ? 'bun.exe' : 'bun'

function candidatesIn(dir: string): string[] {
  // npm-global installs put a .cmd/.ps1 shim on PATH; the real binary lives in node_modules/bun/bin.
  return [path.join(dir, exeName), path.join(dir, 'node_modules', 'bun', 'bin', exeName)]
}

/**
 * Absolute path of a real Bun executable for child-process tests.
 * Never returns a Windows shell shim, so callers can spawn it without `shell: true`.
 */
export function bunExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DNT_BUN_EXECUTABLE
  if (override) {
    if (!existsSync(override)) throw new Error(`DNT_BUN_EXECUTABLE does not exist: ${override}`)
    if (/\.(cmd|bat|ps1)$/i.test(override)) throw new Error(`DNT_BUN_EXECUTABLE must be the real binary, not a shell shim: ${override}`)
    return override
  }
  if (process.versions.bun) return process.execPath
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const home = env.BUN_INSTALL ?? (env.USERPROFILE ?? env.HOME ? path.join((env.USERPROFILE ?? env.HOME)!, '.bun') : undefined)
  if (home) dirs.push(path.join(home, 'bin'))
  for (const dir of dirs) {
    for (const candidate of candidatesIn(dir)) if (existsSync(candidate)) return candidate
  }
  throw new Error('Bun executable not found. Install Bun 1.4.3 or set DNT_BUN_EXECUTABLE to its absolute path.')
}
