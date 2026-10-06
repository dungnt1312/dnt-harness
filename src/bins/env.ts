import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { adoptLegacyEnv } from '../harness/app-home.ts'

export { resolveAppHome } from '../harness/app-home.ts'

/**
 * The repository root, resolved from this file's location (src/bins -> two
 * directories up), so a bin finds repo-shipped assets from any cwd.
 */
export function repoRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url))
}

/**
 * Load the repo-root `.env` for bins: first from the repository the bin file
 * lives in (so running from any cwd still finds it), then from the process
 * cwd. Variables already present in the environment always win. Pre-rename
 * `MINI_DSH_*` variables are then mirrored to their `DNT_HARNESS_*` names.
 */
export function loadRepoEnv(): void {
  // src/bins/env.ts -> the repo root is two directories up.
  const binRelative = fileURLToPath(new URL('../../.env', import.meta.url))
  for (const candidate of [binRelative, '.env']) {
    if (!existsSync(candidate)) continue
    try {
      process.loadEnvFile(candidate)
    } catch {
      // Malformed or unreadable: environment-only configuration continues.
    }
  }
  adoptLegacyEnv()
}

/** Read DEEPSEEK_API_KEY, treating blank values as absent. */
export function readApiKey(): string | undefined {
  const trimmed = process.env['DEEPSEEK_API_KEY']?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
