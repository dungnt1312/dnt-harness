/**
 * Environment for processes whose command text or output reaches the model
 * (Bash tool, hooks). The host process may hold provider keys and other
 * credentials; a model-written `env` would otherwise read them straight into
 * the transcript and the provider request. This is redaction, not a sandbox:
 * a host-privileged command can still read files the user can read.
 *
 * Removed:
 *  - names a bin registered as harness-owned (keys loaded from the repo `.env`);
 *  - `MINI_DSH_*` host configuration;
 *  - names that look like credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, …).
 *
 * `MINI_DSH_CHILD_PASS_ENV=NAME1,NAME2` lets an operator pass named variables
 * through on purpose (e.g. `GH_TOKEN` for the `gh` CLI).
 */

const harnessOwned = new Set<string>(['DEEPSEEK_API_KEY'])

const SECRET_NAME = /(^|_)(API_?KEY|ACCESS_?KEY|SECRET(_?KEY)?|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?)$/i

/** Mark environment variable names the harness itself owns (never passed to children). */
export function markHarnessSecretEnv(names: Iterable<string>): void {
  for (const name of names) harnessOwned.add(name.toUpperCase())
}

function passList(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env['MINI_DSH_CHILD_PASS_ENV'] ?? ''
  return new Set(raw.split(',').map((name) => name.trim().toUpperCase()).filter((name) => name !== ''))
}

/** True when `name` would be withheld from a model-driven child process. */
export function isWithheldEnv(name: string, pass: ReadonlySet<string> = new Set()): boolean {
  const upper = name.toUpperCase()
  if (pass.has(upper)) return false
  if (harnessOwned.has(upper)) return true
  if (upper.startsWith('MINI_DSH_')) return true
  return SECRET_NAME.test(upper)
}

/** The host environment with harness and credential-looking variables removed, plus `extra`. */
export function scrubbedChildEnv(
  extra: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const pass = passList(source)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isWithheldEnv(key, pass)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}
