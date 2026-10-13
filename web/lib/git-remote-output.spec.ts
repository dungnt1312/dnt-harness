import { describe, expect, it } from 'vitest'
import { extractPullRequestLink, formatRemoteOutput, type GitRemoteAction } from './git-remote-output.ts'

/** Zed `indoc!` for these fixtures: the lines, each ending in a newline. */
const lines = (...rows: string[]): string => rows.map((row) => `${row}\n`).join('')

const push: GitRemoteAction = { kind: 'push', branch: 'test_branch', remote: 'test_remote' }

describe('push links (ported from zed remote_output.rs tests)', () => {
  it('test_push_new_branch_pull_request', () => {
    const stderr = lines(
      'Total 0 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)',
      'remote:',
      "remote: Create a pull request for 'test' on GitHub by visiting:",
      'remote:      https://example.com/test/test/pull/new/test',
      'remote:',
      'To example.com:test/test.git',
      ' * [new branch]      test -> test',
    )
    const message = formatRemoteOutput(push, { stdout: '', stderr })
    expect(message.message).toBe('Pushed test_branch to test_remote')
    expect(message.action).toEqual({ label: 'Create Pull Request', url: 'https://example.com/test/test/pull/new/test' })
    expect(message.log).toBeUndefined()
  })

  it('test_push_new_branch_merge_request', () => {
    const stderr = lines(
      'Total 0 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)',
      'remote:',
      'remote: To create a merge request for test, visit:',
      'remote:   https://example.com/test/test/-/merge_requests/new?merge_request%5Bsource_branch%5D=test',
      'remote:',
      'To example.com:test/test.git',
      ' * [new branch]      test -> test',
    )
    const message = formatRemoteOutput(push, { stdout: '', stderr })
    expect(message.message).toBe('Pushed test_branch to test_remote')
    expect(message.action).toEqual({
      label: 'Create Merge Request',
      url: 'https://example.com/test/test/-/merge_requests/new?merge_request%5Bsource_branch%5D=test',
    })
  })

  it('test_push_new_branch_bitbucket_pull_request', () => {
    const stderr = lines(
      'remote:',
      'remote: Create pull request for test:',
      'remote:   https://bitbucket.example.com/projects/TEST/repos/test/pull-requests?create&sourceBranch=refs/heads/test',
    )
    expect(extractPullRequestLink({ stdout: '', stderr })).toEqual({
      label: 'Create Pull Request',
      url: 'https://bitbucket.example.com/projects/TEST/repos/test/pull-requests?create&sourceBranch=refs/heads/test',
    })
  })

  it('test_push_branch_existing_merge_request ignores URLs outside remote: lines', () => {
    const stderr = lines(
      '** WARNING: connection is not using a post-quantum key exchange algorithm.',
      '** This session may be vulnerable to "store now, decrypt later" attacks.',
      '** The server may need to be upgraded. See https://openssh.com/pq.html',
      'Total 0 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)',
      'remote:',
      'remote: View merge request for test:',
      'remote:    https://example.com/test/test/-/merge_requests/99999',
      'remote:',
      'To example.com:test/test.git',
      '    + 80bd3c83be...e03d499d2e test -> test',
    )
    const message = formatRemoteOutput(push, { stdout: '', stderr })
    expect(message.message).toBe('Pushed test_branch to test_remote')
    expect(message.action).toEqual({ label: 'View Merge Request', url: 'https://example.com/test/test/-/merge_requests/99999' })
  })

  it('test_push_new_branch_no_link keeps the log', () => {
    const stderr = lines('To http://example.com/test/test.git', ' * [new branch]      test -> test')
    const output = { stdout: '', stderr }
    const message = formatRemoteOutput(push, output)
    expect(message.log).toEqual(output)
    expect(message.action).toBeUndefined()
    expect(extractPullRequestLink(output)).toBeNull()
  })

  it('a URL on a remote: line without a hint is not a link', () => {
    const stderr = lines('remote: See https://example.com/docs for help')
    expect(extractPullRequestLink({ stdout: '', stderr })).toBeNull()
  })

  it('a non-remote line resets the pending hint', () => {
    const stderr = lines('remote: Create a pull request for x:', 'unrelated', 'remote: https://example.com/x')
    expect(extractPullRequestLink({ stdout: '', stderr })).toBeNull()
  })

  it('trailing punctuation is trimmed from the URL', () => {
    const stderr = lines('remote: Create a pull request for x:', 'remote: (https://example.com/x/pull/new/x).')
    expect(extractPullRequestLink({ stdout: '', stderr })?.url).toBe('https://example.com/x/pull/new/x')
  })

  it('an already up-to-date push is a plain toast', () => {
    const message = formatRemoteOutput(push, { stdout: '', stderr: 'Everything up-to-date\n' })
    expect(message).toEqual({ message: 'Push: Everything is up-to-date' })
  })
})

describe('fetch', () => {
  it('empty stderr is already up to date', () => {
    expect(formatRemoteOutput({ kind: 'fetch' }, { stdout: '', stderr: '' })).toEqual({ message: 'Fetch: Already up to date' })
  })

  it('output from one remote names it and keeps the log', () => {
    const output = { stdout: '', stderr: 'From x\n * branch main -> FETCH_HEAD\n' }
    expect(formatRemoteOutput({ kind: 'fetch', remote: 'origin' }, output)).toEqual({ message: 'Synchronized with origin', log: output })
  })

  it('output from all remotes', () => {
    const output = { stdout: '', stderr: 'From x\n' }
    expect(formatRemoteOutput({ kind: 'fetch' }, output)).toEqual({ message: 'Synchronized with remotes', log: output })
  })
})

describe('pull', () => {
  const pull: GitRemoteAction = { kind: 'pull', remote: 'origin' }

  it('already up to date', () => {
    expect(formatRemoteOutput(pull, { stdout: 'Already up to date.\n', stderr: '' })).toEqual({ message: 'Pull: Already up to date' })
  })

  it('fast-forward counts the changed files from the last line', () => {
    const output = { stdout: lines('Updating a..b', 'Fast-forward', ' a.txt | 1 +', ' 3 files changed, 4 insertions(+)'), stderr: '' }
    expect(formatRemoteOutput(pull, output)).toEqual({ message: 'Received 3 file changes from origin', log: output })
  })

  it('a single changed file is not pluralised', () => {
    const output = { stdout: lines('Updating a..b', 'Fast-forward', '1 file changed, 1 insertion(+)'), stderr: '' }
    expect(formatRemoteOutput(pull, output).message).toBe('Received 1 file change from origin')
  })

  it('fast-forward whose last line has no count falls back', () => {
    const output = { stdout: lines('Updating a..b', 'Fast-forward', ' create mode 100644 a.txt'), stderr: '' }
    expect(formatRemoteOutput(pull, output).message).toBe('Fast forwarded from origin')
  })

  it('merge counts the changed files', () => {
    const output = { stdout: lines("Merge made by the 'ort' strategy.", ' a.txt | 1 +', ' 2 files changed, 2 insertions(+)'), stderr: '' }
    expect(formatRemoteOutput(pull, output)).toEqual({ message: 'Merged 2 file changes from origin', log: output })
  })

  it('merge without a count falls back', () => {
    const output = { stdout: lines('Merge made by the ort strategy.', ' create mode 100644 a.txt'), stderr: '' }
    expect(formatRemoteOutput(pull, output).message).toBe('Merged from origin')
  })

  it('rebase', () => {
    const output = { stdout: 'Successfully rebased and updated refs/heads/main.\n', stderr: '' }
    expect(formatRemoteOutput(pull, output)).toEqual({ message: 'Successfully rebased from origin', log: output })
  })

  it('anything else', () => {
    const output = { stdout: 'something new\n', stderr: '' }
    expect(formatRemoteOutput(pull, output)).toEqual({ message: 'Successfully pulled from origin', log: output })
  })

  it('empty stdout is a plain success', () => {
    expect(formatRemoteOutput(pull, { stdout: '', stderr: '' }).message).toBe('Successfully pulled from origin')
  })
})
