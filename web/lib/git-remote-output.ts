/**
 * Success messages for remote Git operations. A direct port of Zed's
 * `crates/git_ui/src/remote_output.rs` (`format_output`,
 * `extract_pull_request_link`, `extract_url`); the texts and the matching
 * rules are the same.
 */

export interface GitRemoteOutput {
  readonly stdout: string
  readonly stderr: string
}

/** Zed `RemoteAction`; remotes and branches are plain names. */
export type GitRemoteAction =
  | { readonly kind: 'fetch'; readonly remote?: string }
  | { readonly kind: 'pull'; readonly remote: string }
  | { readonly kind: 'push'; readonly branch: string; readonly remote: string }

/** Zed `SuccessMessage`: `log` is `ToastWithLog`, `action` is `PushPrLink`, neither is `Toast`. */
export interface GitSuccessMessage {
  readonly message: string
  readonly log?: GitRemoteOutput
  readonly action?: { readonly label: string; readonly url: string }
}

/** Zed `PULL_REQUEST_HINTS`: the first hint contained in a `remote:` line names the link. */
const PULL_REQUEST_HINTS: readonly (readonly [string, string])[] = [
  // GitHub: "Create a pull request for 'branch' on GitHub by visiting:"
  ['Create a pull request', 'Create Pull Request'],
  // Bitbucket: "Create pull request for branch:"
  ['Create pull request', 'Create Pull Request'],
  // GitLab: "To create a merge request for branch, visit:"
  ['create a merge request', 'Create Merge Request'],
  // GitLab: "View merge request for branch:"
  ['View merge request', 'View Merge Request'],
]

/** Rust `str::lines`: `\n` separated, a trailing `\r` stripped, no empty last line. */
function rustLines(text: string): string[] {
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function extractUrl(line: string): string | null {
  const https = line.indexOf('https://')
  const start = https >= 0 ? https : line.indexOf('http://')
  if (start < 0) return null
  const token = line.slice(start).split(/\s+/).find((word) => word !== '')
  if (token === undefined) return null
  return token.replace(/[,.)\]>]+$/, '')
}

/** The pull/merge request link a push printed in its `remote:` lines, if any. */
export function extractPullRequestLink(output: GitRemoteOutput): { label: string; url: string } | null {
  let pendingLabel: string | null = null
  for (const line of rustLines(output.stderr)) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('remote:')) {
      pendingLabel = null
      continue
    }
    const remoteLine = trimmed.slice('remote:'.length)
    const hint = PULL_REQUEST_HINTS.find(([text]) => remoteLine.includes(text))
    if (hint !== undefined) pendingLabel = hint[1]
    const url = extractUrl(remoteLine)
    if (url !== null && pendingLabel !== null) return { label: pendingLabel, url }
  }
  return null
}

/** Zed `get_changes`: the leading count of the last stdout line ("3 files changed, …"). */
function changedFiles(stdout: string): number | null {
  const last = rustLines(stdout).at(-1)
  if (last === undefined) return null
  const word = last.trim().split(/\s+/).find((part) => part !== '')
  if (word === undefined || !/^\+?\d+$/.test(word)) return null
  return Number(word)
}

const plural = (count: number): string => (count === 1 ? '' : 's')

export function formatRemoteOutput(action: GitRemoteAction, output: GitRemoteOutput): GitSuccessMessage {
  switch (action.kind) {
    case 'fetch':
      if (output.stderr === '') return { message: 'Fetch: Already up to date' }
      return {
        message: action.remote !== undefined ? `Synchronized with ${action.remote}` : 'Synchronized with remotes',
        log: output,
      }
    case 'pull': {
      if (output.stdout.endsWith('Already up to date.\n')) return { message: 'Pull: Already up to date' }
      if (output.stdout.startsWith('Updating')) {
        const files = changedFiles(output.stdout)
        return {
          message: files !== null ? `Received ${files} file change${plural(files)} from ${action.remote}` : `Fast forwarded from ${action.remote}`,
          log: output,
        }
      }
      if (output.stdout.startsWith('Merge')) {
        const files = changedFiles(output.stdout)
        return {
          message: files !== null ? `Merged ${files} file change${plural(files)} from ${action.remote}` : `Merged from ${action.remote}`,
          log: output,
        }
      }
      if (output.stdout.includes('Successfully rebased')) return { message: `Successfully rebased from ${action.remote}`, log: output }
      return { message: `Successfully pulled from ${action.remote}`, log: output }
    }
    case 'push': {
      if (output.stderr.endsWith('Everything up-to-date\n')) return { message: 'Push: Everything is up-to-date' }
      const message = `Pushed ${action.branch} to ${action.remote}`
      const link = extractPullRequestLink(output)
      return link !== null ? { message, action: link } : { message, log: output }
    }
  }
}
