// Read-only source freeze + independent disposable repositories for the
// A/B benchmark (compare-opencode-dnt.mjs).
//
// Source rules: every Git call runs an absolute git executable resolved from
// absolute PATH entries (never the repo dir: Windows CreateProcess searches
// the cwd first), with `-C <repo>` from a neutral scratch cwd, a scrubbed
// environment (every inherited GIT_* dropped; no system/global config, no
// grafts/replace objects, no transport at all: GIT_ALLOW_PROTOCOL=none) and
// `-c` overrides (no hooks, fsmonitor, external diff, attributes file).
// Commands are read-only: no checkout/add/reset/restore, no index refresh,
// no `git status`. Worktree bytes are read with fs and hashed in JS
// (`blob <len>\0<bytes>`), so clean/smudge filters are never consulted.
// Partial clones are refused (a missing blob would trigger a lazy fetch).
//
// Copies are fresh `git init` repos (empty template, autocrlf=false) rebuilt
// from a pack holding ONLY the HEAD commit + its tree and the staged blobs
// (shallow at HEAD; no history, no other branches/tags/remotes), an explicit
// index manifest and a separate worktree layer: HEAD=A, index=B, worktree=C
// stays A/B/C. The sensitive-path policy is applied to the HEAD tree, the
// index and opted-in untracked files. A copy is NOT a filesystem sandbox: an
// agent running as the same OS user can still reach the source by path.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class RepoSafetyError extends Error {
  /** @param {string} message @param {string[]} [paths] */
  constructor(message, paths = []) {
    super(paths.length > 0 ? `${message}:\n  ${paths.join('\n  ')}` : message)
    this.name = 'RepoSafetyError'
    this.paths = paths
  }
}

// ---- hardened git runner ----------------------------------------------------

const win32 = process.platform === 'win32'

let scratch
/** Neutral directory owned by this process: git's cwd and config/template home. */
export function scratchDir() {
  if (!scratch) {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dnt-repo-freeze-')))
    fs.writeFileSync(path.join(scratch, 'empty-gitconfig'), '')
    fs.mkdirSync(path.join(scratch, 'empty-template'))
  }
  return scratch
}
const emptyGlobalConfig = () => path.join(scratchDir(), 'empty-gitconfig')
const emptyTemplate = () => path.join(scratchDir(), 'empty-template')
const noHooksDir = () => path.join(scratchDir(), 'no-hooks-here')
const noGraftFile = () => path.join(scratchDir(), 'no-grafts-here')

const normCase = (p) => (win32 ? p.toLowerCase() : p)
function isInside(child, parent) {
  const rel = path.relative(normCase(parent), normCase(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
function realOrResolved(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function envValue(env, name) {
  if (!win32) return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/**
 * Absolute git executable from absolute PATH entries only (empty, relative and
 * drive-relative entries are skipped, as are `excludeDirs`). Windows looks for
 * git.exe only, never .cmd/.bat shims.
 */
export function resolveGitExecutable(env = process.env, excludeDirs = []) {
  const override = envValue(env, 'DNT_GIT_EXECUTABLE')
  if (override) {
    if (!path.isAbsolute(override) || !fs.statSync(override).isFile()) {
      throw new Error(`DNT_GIT_EXECUTABLE must be an absolute path to git: ${override}`)
    }
    return override
  }
  const name = win32 ? 'git.exe' : 'git'
  const excluded = excludeDirs.map(realOrResolved)
  for (const raw of (envValue(env, 'PATH') ?? '').split(path.delimiter)) {
    const dir = raw.replace(/^"(.*)"$/su, '$1')
    const absolute = win32 ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u.test(dir) : dir.startsWith('/')
    if (!absolute) continue
    const real = realOrResolved(dir)
    if (excluded.some((ex) => isInside(real, ex))) continue
    const candidate = path.join(real, name)
    try {
      if (!fs.statSync(candidate).isFile()) continue
      if (!win32) fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error('git executable not found in absolute PATH entries')
}

let gitExecutable
export function gitPath() {
  gitExecutable ??= resolveGitExecutable(process.env, [process.cwd()])
  return gitExecutable
}

export function hardenedGitEnv(base = process.env) {
  // Drop every inherited GIT_* (DIR, CONFIG_*, TRACE*, EXEC_PATH, ...).
  const env = Object.fromEntries(
    Object.entries(base).filter(([key, value]) => value !== undefined && !/^GIT_/iu.test(key)),
  )
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig(),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: noGraftFile(),
    GIT_LITERAL_PATHSPECS: '1',
    // No transport of any kind, whatever repo config says (protocol.*.allow).
    GIT_ALLOW_PROTOCOL: 'none',
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C',
  }
}

export function hardenedGitArgs() {
  return [
    '--no-pager',
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.useBuiltinFSMonitor=false',
    '-c', `core.hooksPath=${noHooksDir()}`,
    '-c', 'diff.external=',
    '-c', 'core.attributesFile=',
    '-c', 'core.untrackedCache=false',
    '-c', 'protocol.allow=never',
  ]
}

/** Runs hardened git against repository dir `dir`; returns raw stdout. */
export function git(dir, args, { input, allowFail = false } = {}) {
  const exe = gitPath()
  const target = path.resolve(dir) // relative to the caller, not to the scratch cwd
  if (isInside(realOrResolved(exe), realOrResolved(target))) {
    throw new RepoSafetyError(`refusing to run a git executable located inside ${target}: ${exe}`)
  }
  const result = spawnSync(exe, [...hardenedGitArgs(), '-C', target, ...args], {
    cwd: scratchDir(),
    env: hardenedGitEnv(),
    input,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (allowFail) return null
    throw new Error(`git ${args.slice(0, 2).join(' ')} failed (${result.status}): ${result.stderr.toString('utf8').trim()}`)
  }
  return result.stdout
}
const gitText = (dir, args, options) => {
  const out = git(dir, args, options)
  return out === null ? null : out.toString('utf8')
}

// ---- hashing / path policy ----------------------------------------------------

export function gitBlobId(bytes, format = 'sha1') {
  const hash = crypto.createHash(format === 'sha256' ? 'sha256' : 'sha1')
  hash.update(`blob ${bytes.length}\0`)
  hash.update(bytes)
  return hash.digest('hex')
}
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu

/** Why a Git path cannot be represented faithfully on Windows, or null. */
export function windowsPathProblem(gitPath) {
  for (const part of gitPath.split('/')) {
    if (/[<>:"|?*\\\u0000-\u001f]/u.test(part)) return 'reserved character'
    if (/[. ]$/u.test(part)) return 'trailing dot or space'
    if (WINDOWS_RESERVED.test(part)) return 'reserved device name'
  }
  return null
}

// Conservative: refuses common secret-bearing names. Only paths are ever
// reported, never contents.
const SENSITIVE_BASENAMES = [
  /^\.env(?:$|\.)/iu,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc)$/iu,
  /\.tfstate(?:$|\.)/iu,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)/iu,
  /^credentials?(?:$|\.)/iu,
  /^kubeconfig/iu,
  /^\.yarnrc/iu,
  /^(?:\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.htpasswd|\.pgpass)$/iu,
  /^secrets?\.(?:json|ya?ml|toml|env|ini)$/iu,
  /^service[-_]?account.*\.json$/iu,
]
const SENSITIVE_PATHS = [
  /(?:^|\/)\.docker\/config\.json$/iu,
  /(?:^|\/)\.kube\/config$/iu,
  /(?:^|\/)\.(?:aws|ssh|gnupg)\//iu,
]
export function isSensitivePath(gitPath) {
  const base = gitPath.split('/').pop() ?? gitPath
  return SENSITIVE_BASENAMES.some((re) => re.test(base)) || SENSITIVE_PATHS.some((re) => re.test(gitPath))
}

// HFS+ ignores these code points, so ".g\u200Cit" is ".git" on macOS.
const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/gu

/** Why a path component must never be written into a copy, or null. */
export function unsafeComponent(part, platform = process.platform) {
  if (part === '' || part === '.' || part === '..') return 'empty or dot component'
  if (part.replace(HFS_IGNORABLE, '').toLowerCase() === '.git') return '.git component'
  if (/^git~\d+$/iu.test(part)) return '8.3 alias of .git'
  if (platform === 'win32') {
    if (part.includes(':')) return 'NTFS alternate data stream'
    if (part.includes('\\')) return 'backslash'
    if (/[. ]$/u.test(part)) return 'trailing dot or space'
    if (part.replace(/[. ]+$/u, '').toLowerCase() === '.git') return '.git component'
  }
  return null
}

// ---- repository metadata ----------------------------------------------------------

function splitZ(buf) {
  return buf.toString('utf8').split('\0').filter((s) => s.length > 0)
}

function parseIndex(dir) {
  return splitZ(git(dir, ['ls-files', '-s', '-v', '-z'])).map((record) => {
    const match = /^(\S) (\d{6}) ([0-9a-f]+) (\d)\t(.*)$/su.exec(record)
    if (!match) throw new Error(`unexpected ls-files record: ${JSON.stringify(record.slice(0, 80))}`)
    return { tag: match[1], mode: match[2], oid: match[3], stage: Number(match[4]), path: match[5] }
  })
}

function parseTree(dir, treeish) {
  return splitZ(git(dir, ['ls-tree', '-r', '-z', '--full-tree', treeish])).map((record) => {
    const match = /^(\d{6}) (\S+) ([0-9a-f]+)\t(.*)$/su.exec(record)
    if (!match) throw new Error(`unexpected ls-tree record: ${JSON.stringify(record.slice(0, 80))}`)
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] }
  })
}

function headInfo(dir) {
  const head = gitText(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowFail: true })?.trim() || null
  const headRef = gitText(dir, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })?.trim() || null
  return { head, headRef }
}

/** Every ref (heads, tags, remotes, stash, notes, ...) as name -> oid. */
function allRefs(dir) {
  const text = gitText(dir, ['for-each-ref', '--format=%(objectname) %(refname)'])
  return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ')
    return [line.slice(space + 1), line.slice(0, space)]
  }))
}

function gitDirs(root) {
  const [gitDir, commonDir] = gitText(root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
    .trim().split(/\r?\n/u).map((p) => path.resolve(p))
  return { gitDir, commonDir }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Sorted digest of every file under `dir` (missing dir -> ''). */
function hashTree(dir) {
  const lines = []
  const visit = (abs, rel) => {
    for (const d of safeReaddir(abs)) {
      const childAbs = path.join(abs, d.name)
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isSymbolicLink()) lines.push(`${childRel} -> ${fs.readlinkSync(childAbs)}`)
      else if (d.isDirectory()) visit(childAbs, childRel)
      else lines.push(`${childRel} ${sha256(fs.readFileSync(childAbs))}`)
    }
  }
  visit(dir, '')
  return lines.sort().join('\n')
}
const fileDigest = (file) => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : 'absent')

/** Config, hooks and info/ of a repository: anything that changes how git behaves there. */
function metaFingerprint(root) {
  const { gitDir, commonDir } = gitDirs(root)
  return {
    config: fileDigest(path.join(commonDir, 'config')),
    configWorktree: fileDigest(path.join(gitDir, 'config.worktree')),
    hooks: sha256(hashTree(path.join(commonDir, 'hooks'))),
    info: sha256(hashTree(path.join(commonDir, 'info'))),
  }
}

/** Pack names/sizes, loose-object fan-out counts and objects/info listing. */
function objectSummary(commonDir) {
  const objects = path.join(commonDir, 'objects')
  const parts = []
  for (const d of safeReaddir(objects).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(objects, d.name)
    if (/^[0-9a-f]{2}$/u.test(d.name)) parts.push(`${d.name}:${safeReaddir(abs).length}`)
    else if (d.isDirectory()) {
      for (const f of safeReaddir(abs).map((e) => e.name).sort()) {
        parts.push(`${d.name}/${f}:${fs.statSync(path.join(abs, f)).size}`)
      }
    } else parts.push(d.name)
  }
  return sha256(parts.join('\n'))
}

function emptyTreeId(dir) {
  return gitText(dir, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim()
}

/** Intent-to-add paths (index entries `git add -N` created). */
function itaPaths(dir, head) {
  const base = head ?? emptyTreeId(dir)
  const names = (flag) =>
    new Set(splitZ(git(dir, ['diff-index', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z', flag, base])))
  const invisible = names('--ita-invisible-in-index')
  return new Set([...names('--ita-visible-in-index')].filter((p) => !invisible.has(p)))
}

const absOf = (root, gitPath) => path.join(root, ...gitPath.split('/'))

/** Raw worktree layer of one path: bytes + mode, or null when absent. */
function readWorktree(root, gitPath, platform) {
  let stat
  try {
    stat = fs.lstatSync(absOf(root, gitPath))
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
  if (stat.isSymbolicLink()) {
    return { mode: '120000', bytes: fs.readlinkSync(absOf(root, gitPath), { encoding: 'buffer' }) }
  }
  if (stat.isFile()) {
    const exec = platform !== 'win32' && (stat.mode & 0o111) !== 0
    return { mode: exec ? '100755' : '100644', bytes: fs.readFileSync(absOf(root, gitPath)) }
  }
  return { mode: 'other', bytes: Buffer.alloc(0) }
}

function untrackedPaths(root) {
  return splitZ(git(root, ['ls-files', '-o', '--exclude-standard', '-z']))
}

/** Partial clones would lazily fetch missing blobs through repo-configured transports. */
function assertNotPartialClone(root) {
  const { commonDir } = gitDirs(root)
  const reasons = []
  const config = gitText(root, ['config', '--local', '-z', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], { allowFail: true }) ?? ''
  for (const record of config.split('\0').filter(Boolean)) {
    const [key, value = ''] = record.split('\n')
    if (/^extensions\.partialclone$/iu.test(key) || /^(?:true|yes|on|1|)$/iu.test(value.trim())) reasons.push(key)
  }
  for (const d of safeReaddir(path.join(commonDir, 'objects', 'pack'))) {
    if (d.name.endsWith('.promisor')) reasons.push(`objects/pack/${d.name}`)
  }
  if (reasons.length > 0) throw new RepoSafetyError('refusing to copy: partial clone (missing objects would be fetched)', reasons)
}

/**
 * Fingerprint of everything RH2-A promises not to touch: HEAD, all refs, raw
 * index bytes, index entries, config/hooks/info, object store summary,
 * tracked worktree bytes and untracked (non-ignored) file bytes.
 */
export function sourceFingerprint(source) {
  const root = gitText(source, ['rev-parse', '--show-toplevel']).trim()
  const { gitDir, commonDir } = gitDirs(root)
  const fp = { ...headInfo(root), refs: JSON.stringify(allRefs(root)), ...metaFingerprint(root) }
  fp.objects = objectSummary(commonDir)
  fp.rawIndex = fileDigest(path.join(gitDir, 'index'))
  fp.entries = sha256(git(root, ['ls-files', '-s', '-z']))
  for (const entry of parseIndex(root)) {
    // Never stat device names / reserved characters on Windows.
    if (win32 && windowsPathProblem(entry.path)) { fp[`tracked:${entry.path}`] = 'unrepresentable'; continue }
    const layer = readWorktree(root, entry.path, process.platform)
    fp[`tracked:${entry.path}`] = layer ? `${layer.mode}:${sha256(layer.bytes)}` : 'absent'
  }
  for (const p of untrackedPaths(root)) {
    if (win32 && windowsPathProblem(p.replace(/\/$/u, ''))) { fp[`untracked:${p}`] = 'unrepresentable'; continue }
    const layer = readWorktree(root, p.replace(/\/$/u, ''), process.platform)
    fp[`untracked:${p}`] = layer ? `${layer.mode}:${sha256(layer.bytes)}` : 'absent'
  }
  return fp
}

/** Keys whose values differ between two fingerprints. */
export function compareFingerprints(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => before[key] !== after[key]).sort()
}

// ---- freeze ----------------------------------------------------------------------

/**
 * Freezes the source repository without mutating it. Throws RepoSafetyError
 * for unsupported or unsafe states instead of copying partially.
 */
export function freezeSource(source, { includeUntracked = false, platform = process.platform } = {}) {
  const top = gitText(source, ['rev-parse', '--show-toplevel'], { allowFail: true })
  if (!top) throw new RepoSafetyError(`not a Git worktree: ${source}`)
  const root = fs.realpathSync(top.trim())
  assertNotPartialClone(root)
  const objectFormat = gitText(root, ['rev-parse', '--show-object-format']).trim()
  if (objectFormat !== 'sha1') throw new RepoSafetyError(`unsupported object format ${objectFormat}`)
  const before = sourceFingerprint(root)

  const { head, headRef } = headInfo(root)
  const ita = itaPaths(root, head)
  const index = parseIndex(root)
  const headTree = head ? parseTree(root, head) : []

  const problems = { unmerged: [], flags: [], submodule: [], symlink: [], windows: [], sensitive: [], headSensitive: [], mode: [] }
  for (const entry of index) {
    if (entry.stage !== 0) problems.unmerged.push(entry.path)
    else if (entry.tag !== 'H') problems.flags.push(`${entry.path} (${entry.tag === 'S' ? 'skip-worktree' : 'assume-unchanged'})`)
    if (entry.mode === '160000') problems.submodule.push(entry.path)
    else if (entry.mode === '120000' && platform === 'win32') problems.symlink.push(entry.path)
    else if (!['100644', '100755', '120000'].includes(entry.mode)) problems.mode.push(`${entry.path} (${entry.mode})`)
    if (platform === 'win32') {
      const why = windowsPathProblem(entry.path)
      if (why) problems.windows.push(`${entry.path} (${why})`)
    }
    if (isSensitivePath(entry.path)) problems.sensitive.push(entry.path)
  }
  for (const entry of headTree) if (isSensitivePath(entry.path)) problems.headSensitive.push(entry.path)
  const refusals = [
    ['unmerged index entries (resolve the merge first)', problems.unmerged],
    ['skip-worktree/assume-unchanged entries are not supported', problems.flags],
    ['submodules are not supported', problems.submodule],
    ['symlinks are not supported on Windows', problems.symlink],
    ['unsupported index modes', problems.mode],
    ['paths not representable on Windows (refused, not normalized)', problems.windows],
    ['sensitive tracked paths (prepare a sanitized fixture)', problems.sensitive],
    ['sensitive paths in the HEAD commit (prepare a sanitized fixture)', problems.headSensitive],
  ]
  for (const [message, paths] of refusals) {
    if (paths.length > 0) throw new RepoSafetyError(`refusing to copy: ${message}`, [...new Set(paths)])
  }

  const entries = index.map(({ mode, oid, path: p }) => ({ mode, oid, path: p, ita: ita.has(p) }))
  const worktree = []
  for (const entry of entries) {
    const layer = readWorktree(root, entry.path, platform)
    if (!layer) {
      if (entry.ita) throw new RepoSafetyError('refusing to copy: intent-to-add path missing from worktree', [entry.path])
      worktree.push({ path: entry.path, state: 'deleted' })
      continue
    }
    if (layer.mode === 'other' || (layer.mode === '120000') !== (entry.mode === '120000')) {
      throw new RepoSafetyError('refusing to copy: worktree type differs from index (file/symlink/directory)', [entry.path])
    }
    // Windows has no executable bit: keep the index mode.
    const mode = platform === 'win32' ? entry.mode : layer.mode
    const oid = gitBlobId(layer.bytes, objectFormat)
    if (!entry.ita && oid === entry.oid && mode === entry.mode) worktree.push({ path: entry.path, state: 'same', mode, oid })
    else worktree.push({ path: entry.path, state: 'modified', mode, oid, bytes: layer.bytes })
  }

  const allUntracked = untrackedPaths(root)
  const untracked = []
  if (includeUntracked) {
    const bad = []
    for (const p of allUntracked) {
      if (p.endsWith('/')) { bad.push(`${p} (nested repository)`); continue }
      if (isSensitivePath(p)) { bad.push(`${p} (sensitive)`); continue }
      const why = platform === 'win32' ? windowsPathProblem(p) : null
      if (why) { bad.push(`${p} (${why})`); continue }
      const layer = readWorktree(root, p, platform)
      if (!layer || layer.mode === 'other' || layer.mode === '120000') { bad.push(`${p} (not a regular file)`); continue }
      untracked.push({ path: p, mode: platform === 'win32' ? '100644' : layer.mode, oid: gitBlobId(layer.bytes, objectFormat), bytes: layer.bytes })
    }
    if (bad.length > 0) throw new RepoSafetyError('refusing to copy untracked files', bad)
  }

  // HEAD commit + its tree/blobs only (no parents, no other refs) + staged blobs.
  const wanted = new Set(entries.filter((e) => !e.ita).map((e) => e.oid))
  if (head) {
    for (const line of gitText(root, ['rev-list', '--objects', '--no-walk', head]).split('\n')) {
      if (line) wanted.add(line.split(' ')[0])
    }
  }
  const pack = wanted.size > 0 ? git(root, ['pack-objects', '--stdout', '-q'], { input: `${[...wanted].join('\n')}\n` }) : null

  const drift = compareFingerprints(before, sourceFingerprint(root))
  if (drift.length > 0) throw new RepoSafetyError('source changed during freeze; aborting (nothing was repaired)', drift)

  return {
    root, objectFormat, head, headRef, entries, worktree, untracked,
    untrackedSkipped: includeUntracked ? 0 : allUntracked.length,
    pack, fingerprint: before,
  }
}

// ---- disposable copies ---------------------------------------------------------

const MARKER = 'dnt-disposable.json'

function readRegistry(registry) {
  try {
    return JSON.parse(fs.readFileSync(registry, 'utf8'))
  } catch {
    return {}
  }
}

function registryKey(dir) {
  return normCase(fs.realpathSync(dir))
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temp, content)
  fs.renameSync(temp, file)
}

/**
 * Creates a new directory (must not exist), initializes it and records it as
 * disposable. The marker is written only here, into a directory this call
 * created; its random token must also match the caller-owned registry, so a
 * marker committed into (or forged onto) a repository proves nothing.
 */
export function createDisposableDir(dir, registry) {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try {
    fs.mkdirSync(dir)
  } catch (error) {
    if (error.code === 'EEXIST') throw new RepoSafetyError(`refusing to reuse existing directory: ${dir}`)
    throw error
  }
  git(dir, ['init', '-q', `--template=${emptyTemplate()}`, '.'])
  const token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(path.join(dir, '.git', MARKER), `${JSON.stringify({ token, createdAt: new Date().toISOString() })}\n`)
  const entries = readRegistry(registry)
  entries[registryKey(dir)] = token
  writeFileAtomic(registry, `${JSON.stringify(entries, null, 2)}\n`)
  return token
}

/** Throws unless `dir` was created by createDisposableDir with this registry. */
export function assertDisposable(dir, registry) {
  const hint = 'use --repo-copy <source> to build a disposable copy (or point --repo at a copy this script created)'
  let marker
  try {
    if (!fs.lstatSync(path.join(dir, '.git')).isDirectory()) throw new Error('gitfile')
    marker = JSON.parse(fs.readFileSync(path.join(dir, '.git', MARKER), 'utf8'))
  } catch {
    throw new RepoSafetyError(`refusing non-disposable --repo target ${dir}; ${hint}`)
  }
  const expected = readRegistry(registry)[registryKey(dir)]
  if (typeof expected !== 'string' || typeof marker?.token !== 'string' || marker.token !== expected) {
    throw new RepoSafetyError(`disposable marker in ${dir} is not one this script created; ${hint}`)
  }
}

/** Absolute destination for `gitPath` inside `dir`; throws on any unsafe component. */
export function safeAbs(dir, gitPath, platform = process.platform) {
  for (const part of gitPath.split('/')) {
    const why = unsafeComponent(part, platform)
    if (why) throw new RepoSafetyError(`refusing unsafe path (${why})`, [gitPath])
  }
  return path.join(dir, ...gitPath.split('/'))
}

function writeLayer(dir, gitPath, mode, bytes) {
  const abs = safeAbs(dir, gitPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  if (mode === '120000') fs.symlinkSync(bytes.toString('utf8'), abs)
  else {
    fs.writeFileSync(abs, bytes, { flag: 'wx' })
    if (!win32) fs.chmodSync(abs, mode === '100755' ? 0o755 : 0o644)
  }
}

function catBlobs(dir, oids) {
  const out = new Map()
  if (oids.length === 0) return out
  const raw = git(dir, ['cat-file', '--batch'], { input: `${oids.join('\n')}\n` })
  let at = 0
  while (at < raw.length) {
    const nl = raw.indexOf(0x0a, at)
    const [oid, type, size] = raw.subarray(at, nl).toString('utf8').split(' ')
    if (type !== 'blob') throw new Error(`object ${oid} missing or not a blob in copy`)
    const start = nl + 1
    out.set(oid, raw.subarray(start, start + Number(size)))
    at = start + Number(size) + 1
  }
  return out
}

function expectedRefs(snapshot) {
  return snapshot.headRef && snapshot.head ? { [snapshot.headRef]: snapshot.head } : {}
}

/** Builds an independent repository at `dir` (must not exist) from a snapshot. */
export function buildDisposableCopy(snapshot, dir, registry) {
  createDisposableDir(dir, registry)
  const config = [
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['core.filemode', win32 ? 'false' : 'true'],
    ['core.symlinks', win32 ? 'false' : 'true'],
    ['core.protectNTFS', 'true'],
    ['core.protectHFS', 'true'],
    ['gc.auto', '0'],
    ['commit.gpgsign', 'false'],
    ['user.name', 'dnt benchmark'],
    ['user.email', 'benchmark@localhost'],
  ]
  for (const [key, value] of config) git(dir, ['config', key, value])
  if (snapshot.pack) git(dir, ['index-pack', '--stdin'], { input: snapshot.pack })
  // History is intentionally absent: HEAD is a shallow boundary.
  if (snapshot.head) fs.writeFileSync(path.join(dir, '.git', 'shallow'), `${snapshot.head}\n`)
  if (snapshot.headRef && snapshot.head) git(dir, ['update-ref', snapshot.headRef, snapshot.head])
  if (snapshot.headRef) git(dir, ['symbolic-ref', 'HEAD', snapshot.headRef])
  else if (snapshot.head) git(dir, ['update-ref', '--no-deref', 'HEAD', snapshot.head])
  const staged = snapshot.entries.filter((e) => !e.ita)
  if (staged.length > 0) {
    git(dir, ['update-index', '-z', '--index-info'], { input: staged.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join('') })
  }
  const metaBefore = metaFingerprint(dir)
  const blobs = catBlobs(dir, [...new Set(snapshot.worktree.filter((w) => w.state === 'same').map((w) => w.oid))])
  for (const layer of snapshot.worktree) {
    if (layer.state === 'same') writeLayer(dir, layer.path, layer.mode, blobs.get(layer.oid))
    else if (layer.state === 'modified') writeLayer(dir, layer.path, layer.mode, layer.bytes)
  }
  for (const file of snapshot.untracked) writeLayer(dir, file.path, file.mode, file.bytes)
  const metaChanged = compareFingerprints(metaBefore, metaFingerprint(dir))
  if (metaChanged.length > 0) throw new RepoSafetyError('writing the worktree changed the copy git metadata', metaChanged)
  const ita = snapshot.entries.filter((e) => e.ita).map((e) => e.path)
  if (ita.length > 0) git(dir, ['add', '-N', '--', ...ita])
  return dir
}

/** All files under `dir` except the top-level .git, as path -> {mode, oid}. */
export function walkFiles(dir, format = 'sha1') {
  const files = new Map()
  const visit = (abs, rel) => {
    for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
      if (!rel && dirent.name === '.git') continue
      const childAbs = path.join(abs, dirent.name)
      if (dirent.isDirectory()) visit(childAbs, childRel)
      else {
        const layer = readWorktree(dir, childRel, process.platform)
        files.set(childRel, { mode: layer.mode, oid: gitBlobId(layer.bytes, format) })
      }
    }
  }
  visit(dir, '')
  return files
}

/** Verifies HEAD, refs, metadata, index entries and worktree bytes of a copy. */
export function verifyDisposableCopy(snapshot, dir) {
  const problems = []
  const { head, headRef } = headInfo(dir)
  if (head !== snapshot.head) problems.push(`HEAD ${head} != ${snapshot.head}`)
  if (headRef !== snapshot.headRef) problems.push(`HEAD ref ${headRef} != ${snapshot.headRef}`)
  if (JSON.stringify(allRefs(dir)) !== JSON.stringify(expectedRefs(snapshot))) problems.push('refs differ')
  const meta = metaFingerprint(dir)
  if (meta.hooks !== sha256('')) problems.push('copy has hooks')
  if (meta.info !== sha256('')) problems.push('copy has info/ files')
  const config = git(dir, ['config', '--local', '--list'], { allowFail: true })?.toString('utf8') ?? ''
  if (/^(?:core\.(?:fsmonitor|hookspath|sshcommand|pager|editor|attributesfile)|filter\.|diff\.|include|remote\.|extensions\.)/imu.test(config)) {
    problems.push('copy config has unexpected keys')
  }
  const actual = parseIndex(dir).map((e) => `${e.stage} ${e.mode} ${e.oid} ${e.path}`)
  const expected = snapshot.entries.map((e) => `0 ${e.mode} ${e.oid} ${e.path}`)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push('index entries differ')
  const ita = itaPaths(dir, head)
  for (const e of snapshot.entries) if (e.ita !== ita.has(e.path)) problems.push(`intent-to-add flag differs: ${e.path}`)
  const want = new Map()
  for (const w of snapshot.worktree) if (w.state !== 'deleted') want.set(w.path, w)
  for (const u of snapshot.untracked) want.set(u.path, u)
  const have = walkFiles(dir, snapshot.objectFormat)
  for (const [p, w] of want) {
    const got = have.get(p)
    if (!got) problems.push(`missing worktree file: ${p}`)
    else if (got.oid !== w.oid) problems.push(`worktree bytes differ: ${p}`)
    else if (!win32 && got.mode !== w.mode) problems.push(`worktree mode differs: ${p}`)
  }
  for (const p of have.keys()) if (!want.has(p)) problems.push(`unexpected worktree file: ${p}`)
  if (problems.length > 0) throw new RepoSafetyError('reconstructed copy does not match the frozen source', problems)
}

// ---- drift on a disposable target -----------------------------------------------

export function targetManifest(dir) {
  const { head, headRef } = headInfo(dir)
  const index = Object.fromEntries(parseIndex(dir).map((e) => [`${e.path}#${e.stage}`, `${e.mode} ${e.oid}`]))
  const files = Object.fromEntries([...walkFiles(dir)].map(([p, f]) => [p, `${f.mode} ${f.oid}`]))
  return { head, headRef, refs: allRefs(dir), meta: metaFingerprint(dir), index, files }
}

function diffMaps(a, b) {
  const added = Object.keys(b).filter((k) => !(k in a)).sort()
  const deleted = Object.keys(a).filter((k) => !(k in b)).sort()
  const modified = Object.keys(a).filter((k) => k in b && a[k] !== b[k]).sort()
  return { added, modified, deleted }
}

/** Added/modified/deleted files, index entries and refs; HEAD moves; git metadata changes. */
export function diffManifests(before, after) {
  const files = diffMaps(before.files, after.files)
  const index = diffMaps(before.index, after.index)
  const refs = diffMaps(before.refs, after.refs)
  const head = before.head !== after.head || before.headRef !== after.headRef
  const meta = compareFingerprints(before.meta, after.meta)
  const count = [files, index, refs].reduce((n, d) => n + d.added.length + d.modified.length + d.deleted.length, 0)
  return { drifted: count > 0 || head || meta.length > 0, files, index, refs, head, meta }
}

export function describeDrift(drift) {
  const lines = []
  for (const [label, d] of [['file', drift.files], ['index', drift.index], ['ref', drift.refs]]) {
    for (const kind of ['added', 'modified', 'deleted']) for (const p of d[kind]) lines.push(`${label} ${kind}: ${p}`)
  }
  if (drift.head) lines.push('HEAD moved')
  for (const key of drift.meta) lines.push(`git ${key} changed`)
  return lines
}
