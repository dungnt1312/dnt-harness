/**
 * Where dnt-harness keeps its per-user state, and the pre-rename fallbacks.
 * The project was called mini-dsh; existing installs keep `~/.mini-dsh` and
 * `MINI_DSH_*` variables, and both keep working until the user moves them.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const HOME_DIR_NAME = '.dnt-harness'
export const LEGACY_HOME_DIR_NAME = '.mini-dsh'
export const ENV_PREFIX = 'DNT_HARNESS_'
export const LEGACY_ENV_PREFIX = 'MINI_DSH_'

/**
 * The application home under `base`: `<base>/.dnt-harness`, unless only the
 * pre-rename `<base>/.mini-dsh` exists — then that one, so sessions,
 * providers and secrets are never silently left behind. Rename the folder to
 * adopt the new name; nothing here moves data.
 */
export function resolveAppHome(base: string = homedir()): string {
  const current = path.join(base, HOME_DIR_NAME)
  const legacy = path.join(base, LEGACY_HOME_DIR_NAME)
  if (!existsSync(current) && existsSync(legacy)) return legacy
  return current
}

/**
 * Copy every `MINI_DSH_*` variable to its `DNT_HARNESS_*` name when the new
 * name is unset, so existing shells, PM2 configs and `.env` files keep working.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue
    const renamed = `${ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`
    if (env[renamed] === undefined) env[renamed] = value
  }
}
