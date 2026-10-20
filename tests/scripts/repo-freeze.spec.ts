import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RepoSafetyError,
  assertDisposable,
  buildDisposableCopy,
  compareFingerprints,
  createDisposableDir,
  describeDrift,
  diffManifests,
  freezeSource,
  git as hardenedGit,
  gitPath,
  isSensitivePath,
  resolveGitExecutable,
  safeAbs,
  sourceFingerprint,
  targetManifest,
  unsafeComponent,
  verifyDisposableCopy,
  type Snapshot,
} from '../../scripts/e2e/repo-freeze.mjs'
import { runContestant, runFailed, runProcess } from '../../scripts/e2e/agent-run.mjs'
import { gitShellPath, isolatedGitEnvironment } from '../helpers/git-test-process.ts'

const win32 = process.platform === 'win32'
let tmp: string
let env: Record<string, string>

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-')))
  const globalConfig = path.join(tmp, 'fixture-gitconfig')
  fs.writeFileSync(globalConfig, '[user]\n\tname = fixture\n\temail = fixture@example.com\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
  env = isolatedGitEnvironment(process.env, globalConfig)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

/** Fixture-side git (normal, unhardened: it builds the source state). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8')
}
function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}
function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
}
function newRepo(name = 'source'): string {
  const root = path.join(tmp, name)
  fs.mkdirSync(root)
  g(root, 'init', '-q')
  return root
}
function rawIndex(root: string): string {
  return createHash('sha256').update(fs.readFileSync(path.join(root, '.git', 'index'))).digest('hex')
}
const registry = () => path.join(tmp, 'work', 'disposable-registry.json')
const copyDir = (name: string) => path.join(tmp, 'work', name)

function copyOf(snapshot: Snapshot, name = 'copy'): string {
  const dir = buildDisposableCopy(snapshot, copyDir(name), registry())
  verifyDisposableCopy(snapshot, dir)
  return dir
}

/** HEAD=A, index=B, worktree=C on one file plus a staged-only file. */
function layeredRepo(): string {
  const root = newRepo()
  write(root, 'app.txt', 'A\n')
  write(root, 'keep.txt', 'keep\n')
  g(root, 'add', '.')
  g(root, 'commit', '-qm', 'A')
  write(root, 'app.txt', 'B\n')
  write(root, 'staged-only.txt', 'staged only\n')
  g(root, 'add', 'app.txt', 'staged-only.txt')
  write(root, 'app.txt', 'C\n')
  return root
}

describe('RH2-A/B layered freeze and copy', () => {
  it('keeps staged-only content and source untouched (regression for git reset)', () => {
    const root = layeredRepo()
    const before = { index: rawIndex(root), fp: sourceFingerprint(root), cached: g(root, 'diff', '--cached', '--name-status') }
    const snapshot = freezeSource(root)
    const dir = copyOf(snapshot)

    // copy: staged-only file is in the copy's index, not lost
    expect(g(dir, 'diff', '--cached', '--name-status').trim().split('\n').sort()).toEqual(['A\tstaged-only.txt', 'M\tapp.txt'])
    expect(g(dir, 'show', 'HEAD:app.txt')).toBe('A\n')
    expect(g(dir, 'show', ':app.txt')).toBe('B\n')
    expect(read(dir, 'app.txt')).toBe('C\n')
    expect(g(dir, 'show', ':staged-only.txt')).toBe('staged only\n')

    // source: raw index bytes, HEAD, staged diff and worktree unchanged
    expect(rawIndex(root)).toBe(before.index)
    expect(compareFingerprints(before.fp, sourceFingerprint(root))).toEqual([])
    expect(g(root, 'diff', '--cached', '--name-status')).toBe(before.cached)
    expect(read(root, 'app.txt')).toBe('C\n')
  })

  it('gives each run an independent repo and detects drift without restoring', () => {
    const root = layeredRepo()
    const snapshot = freezeSource(root)
    const first = copyOf(snapshot, 'run-1')
    const second = copyOf(snapshot, 'run-2')
    const before = targetManifest(first)

    // simulated agent: modify, delete, add, and stage in the first copy
    write(first, 'app.txt', 'agent\n')
    fs.rmSync(path.join(first, 'keep.txt'))
    write(first, 'new.txt', 'x')
    g(first, 'add', 'new.txt')
    const drift = diffManifests(before, targetManifest(first))
    expect(drift.drifted).toBe(true)
    expect(drift.files).toEqual({ added: ['new.txt'], modified: ['app.txt'], deleted: ['keep.txt'] })
    expect(describeDrift(drift)).toContain('index added: new.txt#0')
    // artifacts preserved, other copy and source unaffected
    expect(read(first, 'app.txt')).toBe('agent\n')
    expect(() => verifyDisposableCopy(snapshot, second)).not.toThrow()
    expect(compareFingerprints(snapshot.fingerprint, sourceFingerprint(root))).toEqual([])
    expect(diffManifests(targetManifest(second), targetManifest(second)).drifted).toBe(false)
  })

  it('refuses to reuse an existing directory for a copy', () => {
    const snapshot = freezeSource(layeredRepo())
    fs.mkdirSync(copyDir('taken'), { recursive: true })
    expect(() => buildDisposableCopy(snapshot, copyDir('taken'), registry())).toThrow(/existing directory/)
  })

  it('verification catches a tampered copy before any agent run', () => {
    const snapshot = freezeSource(layeredRepo())
    const dir = buildDisposableCopy(snapshot, copyDir('copy'), registry())
    write(dir, 'app.txt', 'tampered\n')
    expect(() => verifyDisposableCopy(snapshot, dir)).toThrow(/worktree bytes differ: app.txt/)
  })
})

describe('RH2-C staged rename/delete/add and special names', () => {
  it('preserves staged rename, delete, add, intent-to-add, unstaged delete, spaces and binary bytes', () => {
    const root = newRepo()
    write(root, 'old name.txt', 'rename me\n')
    write(root, 'gone.txt', 'delete me\n')
    write(root, 'dir with space/unstaged-del.txt', 'u\n')
    write(root, 'crlf.txt', 'line1\r\nline2\r\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'base')
    g(root, 'mv', 'old name.txt', 'new name.txt')
    g(root, 'rm', '-q', 'gone.txt')
    write(root, 'added file.bin', Buffer.from([0, 1, 2, 255, 13, 10]))
    g(root, 'add', 'added file.bin')
    write(root, 'ita.txt', 'intent\n')
    g(root, 'add', '-N', 'ita.txt')
    fs.rmSync(path.join(root, 'dir with space', 'unstaged-del.txt'))
    const indexBefore = rawIndex(root)

    const snapshot = freezeSource(root)
    const dir = copyOf(snapshot)
    expect(g(dir, 'diff', '--cached', '--name-status', '-M').trim().split('\n').sort()).toEqual(
      ['A\tadded file.bin', 'D\tgone.txt', 'R100\told name.txt\tnew name.txt'].sort(),
    )
    // intent-to-add entry survives as such (empty blob placeholder in the index)
    expect(g(dir, 'ls-files', '--', 'ita.txt')).toBe('ita.txt\n')
    expect(snapshot.entries.find((e) => e.path === 'ita.txt')?.ita).toBe(true)
    expect(g(dir, 'diff', '--name-status').trim().split('\n').sort()).toEqual(['A\tita.txt', 'D\tdir with space/unstaged-del.txt'])
    expect(fs.readFileSync(path.join(dir, 'added file.bin'))).toEqual(Buffer.from([0, 1, 2, 255, 13, 10]))
    expect(fs.readFileSync(path.join(dir, 'crlf.txt'), 'utf8')).toBe('line1\r\nline2\r\n')
    expect(rawIndex(root)).toBe(indexBefore)
  })

  it.skipIf(win32)('handles Git-valid special characters on POSIX', () => {
    const root = newRepo()
    const names = ['tab\tname.txt', 'new\nline.txt', 'quote"star*.txt', 'colon:q?.txt', 'trailing dot.', 'ünïcødé.txt']
    for (const name of names) write(root, name, `${name}\n`)
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'odd')
    write(root, 'tab\tname.txt', 'changed\n')
    g(root, 'add', 'tab\tname.txt')
    const snapshot = freezeSource(root)
    const dir = copyOf(snapshot)
    expect(g(dir, 'ls-files', '-z').split('\0').filter(Boolean).sort()).toEqual([...names].sort())
    expect(g(dir, 'show', ':tab\tname.txt')).toBe('changed\n')
  })

  it.skipIf(win32)('preserves executable bit and symlinks on POSIX', () => {
    const root = newRepo()
    write(root, 'run.sh', '#!/bin/sh\n')
    fs.chmodSync(path.join(root, 'run.sh'), 0o755)
    fs.symlinkSync('run.sh', path.join(root, 'link'))
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'x')
    const dir = copyOf(freezeSource(root))
    expect(g(dir, 'ls-files', '-s')).toMatch(/100755 \S+ 0\trun\.sh/)
    expect(fs.readlinkSync(path.join(dir, 'link'))).toBe('run.sh')
  })
})

describe('malicious source config never executes', () => {
  it('ignores fsmonitor, hooks, filters, textconv and external diff', () => {
    const root = newRepo()
    write(root, 'a.txt', 'one\n')
    write(root, '.gitattributes', '*.txt filter=evil diff=evil\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'base')
    write(root, 'a.txt', 'two\n')
    const sentinel = path.join(tmp, 'pwned')
    const script = path.join(tmp, 'evil.sh')
    fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${gitShellPath(sentinel)}\ncat\n`)
    fs.chmodSync(script, 0o755)
    const cmd = `sh ${gitShellPath(script)}`
    const hooks = path.join(root, 'evil-hooks')
    fs.mkdirSync(hooks)
    for (const hook of ['post-checkout', 'post-index-change', 'reference-transaction', 'pre-commit']) {
      fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\n${cmd}\n`)
      fs.chmodSync(path.join(hooks, hook), 0o755)
    }
    for (const [key, value] of [
      ['core.fsmonitor', cmd],
      ['core.hooksPath', hooks],
      ['filter.evil.clean', cmd],
      ['filter.evil.smudge', cmd],
      ['filter.evil.process', cmd],
      ['diff.evil.textconv', cmd],
      ['diff.evil.command', cmd],
      ['diff.external', cmd],
      ['core.pager', cmd],
    ] as const) g(root, 'config', key, value)
    fs.rmSync(sentinel, { force: true }) // the fixture commit itself may have run hooks
    const before = { index: rawIndex(root), fp: sourceFingerprint(root) }

    const snapshot = freezeSource(root)
    const dir = copyOf(snapshot)
    const drift = diffManifests(targetManifest(dir), targetManifest(dir))
    expect(drift.drifted).toBe(false)
    expect(compareFingerprints(before.fp, sourceFingerprint(root))).toEqual([])

    expect(fs.existsSync(sentinel)).toBe(false)
    // Worktree bytes were read raw (no clean filter), so the copy holds them verbatim.
    expect(read(dir, 'a.txt')).toBe('two\n')
    // The copy does not inherit the source config.
    expect(g(dir, 'config', '--local', '--list')).not.toMatch(/evil|fsmonitor|hookspath/i)
    expect(rawIndex(root)).toBe(before.index)
  })
})

describe('untracked and sensitive path policy', () => {
  function withUntracked(): string {
    const root = newRepo()
    write(root, 'tracked.txt', 't\n')
    write(root, '.gitignore', 'ignored.log\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'base')
    write(root, 'ignored.log', 'never copy\n')
    write(root, 'notes/todo.txt', 'untracked\n')
    return root
  }

  it('copies no untracked or ignored files by default', () => {
    const root = withUntracked()
    write(root, '.env', 'SECRET=1\n')
    const snapshot = freezeSource(root)
    expect(snapshot.untracked).toEqual([])
    expect(snapshot.untrackedSkipped).toBe(2)
    const dir = copyOf(snapshot)
    for (const p of ['.env', 'ignored.log', 'notes/todo.txt']) expect(fs.existsSync(path.join(dir, p))).toBe(false)
  })

  it('opt-in copies plain untracked files, never ignored ones', () => {
    const root = withUntracked()
    const snapshot = freezeSource(root, { includeUntracked: true })
    expect(snapshot.untracked.map((f) => f.path)).toEqual(['notes/todo.txt'])
    const dir = copyOf(snapshot)
    expect(read(dir, 'notes/todo.txt')).toBe('untracked\n')
    expect(fs.existsSync(path.join(dir, 'ignored.log'))).toBe(false)
    expect(g(dir, 'status', '--porcelain', '-uall')).toBe('?? notes/todo.txt\n')
  })

  it('refuses sensitive untracked files on opt-in and reports paths only', () => {
    const root = withUntracked()
    write(root, 'config/id_rsa', 'PRIVATE-KEY-MATERIAL')
    let error: unknown
    try { freezeSource(root, { includeUntracked: true }) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(RepoSafetyError)
    expect((error as Error).message).toContain('config/id_rsa (sensitive)')
    expect((error as Error).message).not.toContain('PRIVATE-KEY-MATERIAL')
  })

  it.each(['.env', '.env.local', 'deploy/server.pem', 'tls.key', '.npmrc', 'credentials.json', '.netrc'])(
    'refuses sensitive tracked path %s',
    (name) => {
      const root = newRepo()
      write(root, name, 'TOP-SECRET')
      g(root, 'add', '.')
      g(root, 'commit', '-qm', 'secret')
      expect(() => freezeSource(root)).toThrow(RepoSafetyError)
      try { freezeSource(root) } catch (error) {
        expect((error as Error).message).toContain(name)
        expect((error as Error).message).not.toContain('TOP-SECRET')
      }
    },
  )
})

describe('refusals', () => {
  function committed(): string {
    const root = newRepo()
    write(root, 'a.txt', 'a\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'a')
    return root
  }
  const blob = (root: string) => g(root, 'rev-parse', 'HEAD:a.txt').trim()

  it('refuses submodule entries', () => {
    const root = committed()
    g(root, 'update-index', '--add', '--cacheinfo', `160000,${g(root, 'rev-parse', 'HEAD').trim()},sub`)
    expect(() => freezeSource(root)).toThrow(/submodules[\s\S]*sub/)
  })

  it('refuses unmerged entries', () => {
    const root = committed()
    const id = blob(root)
    execFileSync('git', ['update-index', '--index-info'], { cwd: root, env, input: `0 ${'0'.repeat(40)}\ta.txt\n100644 ${id} 1\ta.txt\n100644 ${id} 2\ta.txt\n` })
    expect(() => freezeSource(root)).toThrow(/unmerged[\s\S]*a\.txt/)
  })

  it('refuses symlinks on Windows', () => {
    const root = committed()
    g(root, 'update-index', '--add', '--cacheinfo', `120000,${blob(root)},link`)
    expect(() => freezeSource(root, { platform: 'win32' })).toThrow(/symlinks[\s\S]*link/)
  })

  it('refuses Windows-invalid paths instead of normalizing them', () => {
    const root = committed()
    g(root, '-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob(root)},CON.txt`)
    expect(() => freezeSource(root, { platform: 'win32' })).toThrow(/not representable on Windows[\s\S]*CON\.txt/)
  })

  it('refuses skip-worktree entries', () => {
    const root = committed()
    g(root, 'update-index', '--skip-worktree', 'a.txt')
    expect(() => freezeSource(root)).toThrow(/skip-worktree/)
  })

  it('refuses a non-repository source', () => {
    fs.mkdirSync(path.join(tmp, 'plain'))
    expect(() => freezeSource(path.join(tmp, 'plain'))).toThrow(RepoSafetyError)
  })
})

describe('RH2-E disposable markers', () => {
  it('accepts only directories created by the script with a matching registry token', () => {
    const dir = copyDir('mine')
    createDisposableDir(dir, registry())
    expect(() => assertDisposable(dir, registry())).not.toThrow()
  })

  it('refuses an ordinary checkout and never writes a marker onto it', () => {
    const root = committed2()
    expect(() => assertDisposable(root, registry())).toThrow(/non-disposable/)
    expect(fs.existsSync(path.join(root, '.git', 'dnt-disposable.json'))).toBe(false)
    expect(() => createDisposableDir(root, registry())).toThrow(/existing directory/)
    expect(fs.existsSync(path.join(root, '.git', 'dnt-disposable.json'))).toBe(false)
  })

  it('rejects a forged marker (repo content or copied token)', () => {
    const root = committed2()
    fs.writeFileSync(path.join(root, '.git', 'dnt-disposable.json'), JSON.stringify({ token: 'forged' }))
    expect(() => assertDisposable(root, registry())).toThrow(/not one this script created/)

    // a genuine token copied onto another repo does not transfer
    const mine = copyDir('mine')
    createDisposableDir(mine, registry())
    fs.copyFileSync(path.join(mine, '.git', 'dnt-disposable.json'), path.join(root, '.git', 'dnt-disposable.json'))
    expect(() => assertDisposable(root, registry())).toThrow(/not one this script created/)
  })

  function committed2(): string {
    const root = newRepo('checkout')
    write(root, 'a.txt', 'a\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'a')
    return root
  }
})

describe('C1 git executable resolution', () => {
  const exeName = win32 ? 'git.exe' : 'git'

  function plantGit(dir: string, sentinel: string): void {
    fs.mkdirSync(dir, { recursive: true })
    if (win32) {
      // Any foreign executable: if it ran, git output parsing would fail.
      fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), path.join(dir, exeName))
      fs.writeFileSync(path.join(dir, 'git.cmd'), `@echo pwned> "${sentinel}"\r\n`)
    } else {
      fs.writeFileSync(path.join(dir, exeName), `#!/bin/sh\necho pwned > '${sentinel}'\nexit 0\n`)
      fs.chmodSync(path.join(dir, exeName), 0o755)
    }
  }

  it('skips relative, empty and excluded PATH entries', () => {
    const real = gitPath()
    const planted = path.join(tmp, 'planted')
    plantGit(planted, path.join(tmp, 'sentinel'))
    const PATH = ['', '.', 'relative-bin', planted, path.dirname(real)].join(path.delimiter)
    expect(resolveGitExecutable({ PATH }, [planted]).toLowerCase()).toBe(real.toLowerCase())
    expect(resolveGitExecutable({ PATH }, []).toLowerCase()).toBe(path.join(planted, exeName).toLowerCase())
    expect(() => resolveGitExecutable({ PATH: ['.', 'bin'].join(path.delimiter) })).toThrow(/not found/)
    expect(path.isAbsolute(real)).toBe(true)
  })

  it('a git executable planted in the source or copy root never runs', () => {
    const root = layeredRepo()
    const sentinel = path.join(tmp, 'sentinel')
    plantGit(root, sentinel)
    const snapshot = freezeSource(root, { includeUntracked: false })
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/)
    const dir = copyOf(snapshot)
    plantGit(dir, sentinel)
    expect(() => targetManifest(dir)).not.toThrow()
    expect(compareFingerprints(snapshot.fingerprint, sourceFingerprint(root))).toEqual([])
    expect(fs.existsSync(sentinel)).toBe(false)
  })
})

describe('C2 partial clones and lazy fetch', () => {
  it('refuses a partial clone without fetching or running uploadpack', () => {
    const origin = newRepo('origin')
    write(origin, 'a.txt', 'a\n')
    g(origin, 'add', '.')
    g(origin, 'commit', '-qm', 'a')
    g(origin, 'config', 'uploadpack.allowFilter', 'true')
    const url = `file://${win32 ? '/' : ''}${origin.replaceAll('\\', '/')}`
    g(tmp, '-c', 'protocol.file.allow=always', 'clone', '-q', '--filter=blob:none', '--no-checkout', url, 'partial')
    const partial = path.join(tmp, 'partial')
    const sentinel = path.join(tmp, 'uploadpack-ran')
    const script = path.join(tmp, 'evil-upload-pack.sh')
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> ${gitShellPath(sentinel)}\nexec git-upload-pack "$@"\n`)
    fs.chmodSync(script, 0o755)
    g(partial, 'config', 'remote.origin.uploadpack', `sh ${gitShellPath(script)}`)
    g(partial, 'config', 'protocol.file.allow', 'always')
    const objectsBefore = g(partial, 'count-objects', '-v')
    // Index the missing blob so a naive freeze would need it.
    const blob = g(origin, 'rev-parse', 'HEAD:a.txt').trim()
    // --info-only: the fixture git must not lazily fetch it either.
    g(partial, 'update-index', '--add', '--info-only', '--cacheinfo', `100644,${blob},a.txt`)

    expect(() => freezeSource(partial)).toThrow(/partial clone/)
    // Even a direct read of the missing object cannot trigger a lazy fetch.
    expect(hardenedGit(partial, ['cat-file', '-p', blob], { allowFail: true })).toBeNull()
    expect(fs.existsSync(sentinel)).toBe(false)
    expect(g(partial, 'count-objects', '-v')).toBe(objectsBefore)
  })
})

describe('H1 history and HEAD-tree exposure', () => {
  it('copies only the HEAD commit: no history, no other refs', () => {
    const root = newRepo()
    write(root, '.env', 'OLD-SECRET\n')
    write(root, 'a.txt', 'a\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'with secret')
    const secretBlob = g(root, 'rev-parse', 'HEAD:.env').trim()
    g(root, 'rm', '-q', '.env')
    g(root, 'commit', '-qm', 'remove secret')
    g(root, 'branch', 'other', 'HEAD~1')
    g(root, 'tag', 'v1', 'HEAD~1')

    const dir = copyOf(freezeSource(root))
    expect(g(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(g(dir, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/main')
    expect(() => g(dir, 'cat-file', '-e', secretBlob)).toThrow()
    expect(g(dir, 'log', '--format=%s')).toBe('remove secret\n')
  })

  it('refuses sensitive paths still present in the HEAD tree even when unstaged from the index', () => {
    const root = newRepo()
    write(root, 'deploy/server.key', 'KEY-MATERIAL')
    write(root, 'a.txt', 'a\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'key')
    g(root, 'rm', '-q', '--cached', 'deploy/server.key')
    fs.rmSync(path.join(root, 'deploy', 'server.key'))
    let error: unknown
    try { freezeSource(root) } catch (caught) { error = caught }
    expect((error as Error).message).toMatch(/HEAD commit[\s\S]*deploy\/server\.key/)
    expect((error as Error).message).not.toContain('KEY-MATERIAL')
  })

  it.each(['infra/prod.tfstate', 'infra/prod.tfstate.backup', '.docker/config.json', 'kubeconfig', '.kube/config', '.aws/credentials', 'a/.aws/config', 'release.gpg', 'key.asc', '.yarnrc.yml', '.yarnrc', '.pypirc'])(
    'treats %s as sensitive',
    (p) => expect(isSensitivePath(p)).toBe(true),
  )
  it.each(['src/env.ts', 'docs/keys.md', 'docker/config.json', 'kube.yaml'])('does not flag %s', (p) => expect(isSensitivePath(p)).toBe(false))
})

describe('M1 unsafe destination components', () => {
  it.each([
    ['.git', 'linux'], ['.GIT', 'linux'], ['.g\u200Cit', 'linux'], ['\uFEFF.git', 'darwin'], ['git~1', 'linux'], ['GIT~12', 'win32'],
    ['.git.', 'win32'], ['.git ', 'win32'], ['a:b', 'win32'], ['file.txt:stream', 'win32'], ['x.', 'win32'], ['..', 'linux'], ['', 'linux'],
  ] as const)('rejects %j on %s', (part, platform) => {
    expect(unsafeComponent(part, platform)).not.toBeNull()
    expect(() => safeAbs(tmp, `dir/${part}/f`, platform)).toThrow(RepoSafetyError)
  })

  it('allows ordinary names (and POSIX colons)', () => {
    expect(unsafeComponent('a:b', 'linux')).toBeNull()
    expect(unsafeComponent('.gitignore', 'win32')).toBeNull()
    expect(unsafeComponent('git~x', 'win32')).toBeNull()
  })

  it('verification rejects a copy whose hooks or config were tampered with', () => {
    const snapshot = freezeSource(layeredRepo())
    const hooked = buildDisposableCopy(snapshot, copyDir('hooked'), registry())
    fs.mkdirSync(path.join(hooked, '.git', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(hooked, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\n')
    expect(() => verifyDisposableCopy(snapshot, hooked)).toThrow(/copy has hooks/)
    const configured = buildDisposableCopy(snapshot, copyDir('configured'), registry())
    g(configured, 'config', 'core.fsmonitor', 'evil')
    expect(() => verifyDisposableCopy(snapshot, configured)).toThrow(/unexpected keys/)
  })
})

describe('M2 metadata drift', () => {
  it('detects config, hooks, info and any ref (notes/stash) changes on the target', () => {
    const dir = copyOf(freezeSource(layeredRepo()))
    const before = targetManifest(dir)
    g(dir, 'config', 'alias.x', '!echo')
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n')
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'app.txt\n')
    g(dir, 'notes', 'add', '-m', 'note', 'HEAD')
    const lines = describeDrift(diffManifests(before, targetManifest(dir)))
    expect(lines).toEqual(expect.arrayContaining(['git config changed', 'git hooks changed', 'git info changed', 'ref added: refs/notes/commits']))
  })

  it('source fingerprint covers config, hooks, all refs, info and the object store', () => {
    const root = layeredRepo()
    const before = sourceFingerprint(root)
    g(root, 'config', 'core.fsmonitor', 'evil')
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'x'), '')
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), '* filter=x\n')
    g(root, 'update-ref', 'refs/stash-like/x', 'HEAD')
    execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, env, input: 'loose object\n' })
    expect(compareFingerprints(before, sourceFingerprint(root))).toEqual(expect.arrayContaining(['config', 'hooks', 'info', 'objects', 'refs']))
  })
})

describe('M3/M4 contestant run: error, timeout, drift', () => {
  const node = process.execPath

  it('reports agent edits as drift, fails the run and preserves the target', async () => {
    const root = layeredRepo()
    const snapshot = freezeSource(root)
    const entry = await runContestant({
      snapshot, targetDir: copyDir('agent'), registry: registry(), sourceBefore: snapshot.fingerprint, sourceRoot: root,
      launch: (target) => runProcess(node, ['-e', "require('fs').writeFileSync('app.txt','agent'); process.exit(3)"], { cwd: target, timeoutMs: 20_000 }),
    })
    expect(entry.ran).toBe(true)
    expect(entry.result.code).toBe(3)
    expect(entry.drift).toContain('file modified: app.txt')
    expect(runFailed(entry)).toBe(true)
    expect(read(entry.target, 'app.txt')).toBe('agent')
    expect(entry.sourceChanged).toEqual([])
    expect(read(root, 'app.txt')).toBe('C\n')
  })

  it('a clean, successful agent run passes', async () => {
    const root = layeredRepo()
    const snapshot = freezeSource(root)
    const entry = await runContestant({
      snapshot, targetDir: copyDir('clean'), registry: registry(), sourceBefore: snapshot.fingerprint, sourceRoot: root,
      launch: (target) => runProcess(node, ['-e', "require('fs').readFileSync('app.txt')"], { cwd: target, timeoutMs: 20_000 }),
    })
    expect(entry.drift).toEqual([])
    expect(runFailed(entry)).toBe(false)
  })

  it('detects an agent that writes to the source by absolute path', async () => {
    const root = layeredRepo()
    const snapshot = freezeSource(root)
    const victim = path.join(root, 'app.txt')
    const entry = await runContestant({
      snapshot, targetDir: copyDir('escape'), registry: registry(), sourceBefore: snapshot.fingerprint, sourceRoot: root,
      launch: () => runProcess(node, ['-e', `require('fs').writeFileSync(${JSON.stringify(victim)}, 'escaped')`], { timeoutMs: 20_000 }),
    })
    expect(entry.sourceChanged).toContain('tracked:app.txt')
    expect(runFailed(entry)).toBe(true)
  })

  it('a launcher that throws still yields a failed, drift-checked result', async () => {
    const snapshot = freezeSource(layeredRepo())
    const entry = await runContestant({
      snapshot, targetDir: copyDir('throws'), registry: registry(),
      launch: async () => { throw new Error('spawn exploded') },
    })
    expect(entry.result.code).toBe(-1)
    expect(entry.result.stderr).toContain('spawn exploded')
    expect(runFailed(entry)).toBe(true)
  })

  it('copy failure means the agent never runs', async () => {
    const snapshot = freezeSource(layeredRepo())
    fs.mkdirSync(copyDir('exists'), { recursive: true })
    let launched = false
    const entry = await runContestant({
      snapshot, targetDir: copyDir('exists'), registry: registry(),
      launch: async () => { launched = true; return { code: 0, ms: 0, timedOut: false, stdout: '', stderr: '' } },
    })
    expect(launched).toBe(false)
    expect(entry.ran).toBe(false)
    expect(runFailed(entry)).toBe(true)
  })

  it('timeout kills the whole process tree and fails the run', async () => {
    const root = layeredRepo()
    const snapshot = freezeSource(root)
    const sentinel = path.join(tmp, 'grandchild-survived')
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'), 3000)`
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`
    const entry = await runContestant({
      snapshot, targetDir: copyDir('timeout'), registry: registry(), sourceBefore: snapshot.fingerprint, sourceRoot: root,
      launch: (target) => runProcess(node, ['-e', parent], { cwd: target, timeoutMs: 1_000 }),
    })
    expect(entry.result.timedOut).toBe(true)
    expect(runFailed(entry)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    expect(fs.existsSync(sentinel)).toBe(false)
    expect(entry.sourceChanged).toEqual([])
  }, 30_000)
})
