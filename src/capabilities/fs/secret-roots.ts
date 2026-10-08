/**
 * Well-known credential locations under the user's home. Hosts add them to
 * the file tools' `deniedRoots`, so Read/Write/Edit/Glob/Grep refuse them in
 * EVERY mode — including Full access, whose `outOfGrant: 'allow'` would
 * otherwise let a model read `~/.ssh/id_ed25519` without a prompt. They also
 * join the folder-grant protected roots, so they cannot be granted either.
 *
 * Scope: this is a file-tool restriction only. `Bash` still runs with host
 * privileges (there is no OS sandbox), so this narrows accidental and
 * prompt-injected exposure through the structured tools; it is not a
 * security boundary against a shell.
 */
import path from 'node:path'

/** Paths relative to the home directory. Files and folders are both fine. */
export const SECRET_HOME_ENTRIES: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.password-store',
  '.config/gh',
  '.config/gcloud',
  '.config/hub',
  'Library/Keychains',
]

export function defaultSecretRoots(home: string): string[] {
  return SECRET_HOME_ENTRIES.map((entry) => path.join(home, ...entry.split('/')))
}
