/** Bounded filesystem discovery, with grants checked before every filesystem read. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { ToolExecution } from '../../harness/tools/types.ts'
import { grantedRoots, classifyGrantedRoots, resolveInGrants, within } from './grants.ts'

export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '.git', '.svn', '.hg',
  'node_modules', 'bower_components', 'vendor', 'Pods',
  'dist', 'build', 'out', 'target', 'obj',
  '.next', '.nuxt', '.output', '.svelte-kit', '.vite', '.turbo', '.parcel-cache', '.cache', '.docusaurus',
  'coverage', '.nyc_output',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.nox', '.eggs',
  '.gradle', '.terraform', '.idea', '.vscode',
]
const DEFAULT_IGNORED = new Set(DEFAULT_IGNORED_DIRS)
const WALK_BUDGET = 20_000
const BRACE_CAP = 64

/** Explicit choices only; nesting/ranges are deliberately not part of the tool contract. */
export function expandGlob(pattern: string): string[] {
  if (pattern.length > 4096) throw new Error('glob pattern is too long (maximum 4096 characters)')
  let choices = ['']
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '}') throw new Error('invalid glob pattern: unmatched closing brace')
    if (char !== '{') { choices = choices.map((prefix) => prefix + char); continue }
    const end = pattern.indexOf('}', i + 1)
    if (end === -1) throw new Error('invalid glob pattern: unclosed brace choices')
    const parts = pattern.slice(i + 1, end).split(',')
    if (parts.length < 2 || parts.some((part) => part === '' || part.includes('{'))) {
      throw new Error('invalid glob pattern: use nonempty {a,b} choices; nested braces are not supported')
    }
    if (choices.length * parts.length > BRACE_CAP) throw new Error(`glob brace choices exceed ${BRACE_CAP} expansions`)
    choices = choices.flatMap((prefix) => parts.map((part) => prefix + part))
    i = end
  }
  return [...new Set(choices.map((choice) => {
    if (path.isAbsolute(choice) || choice.includes('\\') || choice.split('/').includes('..')) {
      throw new Error('glob pattern must be relative to the search directory and cannot escape it')
    }
    return choice.split('/').filter((part) => part !== '.' && part !== '').join('/')
  }))]
}

/** Dynamic programming: O(segment.length × name.length), O(name.length) memory.
 * No regex backtracking, even for repeated `*literal` on a near-matching name.
 */
function segmentMatches(segment: string, name: string): boolean {
  if (!segment.includes('*')) return segment === name
  let previous = new Uint8Array(name.length + 1)
  previous[0] = 1
  for (let token = 0; token < segment.length; token++) {
    const char = segment[token]!
    const next = new Uint8Array(name.length + 1)
    if (char === '*') next[0] = previous[0]!
    for (let index = 1; index <= name.length; index++) {
      next[index] = char === '*'
        ? previous[index]! | next[index - 1]!
        : char === name[index - 1] ? previous[index - 1]! : 0
    }
    previous = next
  }
  return previous[name.length] === 1
}

interface Pattern { segments: string[] }
function compile(pattern: string): Pattern {
  return { segments: pattern.split('/') }
}
/** NFA over path segments: ** matches zero or more whole segments, never part of a directory name. */
function statesFor(pattern: Pattern, parts: string[]): Set<number> {
  const close = (states: Set<number>): Set<number> => {
    for (const index of states) if (pattern.segments[index] === '**') states.add(index + 1)
    return states
  }
  let states = close(new Set([0]))
  for (const part of parts) {
    const next = new Set<number>()
    for (const index of states) {
      if (pattern.segments[index] === '**') next.add(index)
      else if (pattern.segments[index] !== undefined && segmentMatches(pattern.segments[index]!, part)) next.add(index + 1)
    }
    states = close(next)
  }
  return states
}
function matches(pattern: Pattern, parts: string[]): boolean {
  return statesFor(pattern, parts).has(pattern.segments.length)
}
function couldDescend(pattern: Pattern, parts: string[]): boolean {
  return [...statesFor(pattern, parts)].some((index) => index < pattern.segments.length)
}
function explicitDirectory(pattern: Pattern, parts: string[]): boolean {
  const parentStates = statesFor(pattern, parts.slice(0, -1))
  const name = parts.at(-1)
  return [...parentStates].some((index) => index < pattern.segments.length - 1
    && pattern.segments[index] === name && !name?.includes('*'))
}

interface Layer { base: string; matcher: Ignore; rules: string; overrides: string[] }
export interface SearchResult { files: string[]; incomplete: Set<string> }

/** Override only the requested directory in each rule layer, not all ignores globally. */
function unignoreDirectory(layers: Layer[], dir: string): Layer[] {
  return layers.map((layer) => {
    const rel = path.relative(layer.base, dir).split(path.sep).join('/')
    if (!rel || !within(layer.base, dir)) return layer
    // Gitignore special characters must be escaped in this generated literal rule.
    const escaped = rel.replace(/[\\*?\[\]#! ]/g, '\\$&')
    const overrides = [...layer.overrides, `!/${escaped}/`]
    return { ...layer, overrides, matcher: ignore().add(layer.rules).add(overrides) }
  })
}
function isIgnored(layers: Layer[], full: string, directory: boolean): boolean {
  let ignored = false
  for (const layer of layers) {
    if (!within(layer.base, full)) continue
    const relative = path.relative(layer.base, full).split(path.sep).join('/')
    if (!relative) continue
    const result = layer.matcher.test(relative + (directory ? '/' : ''))
    if (result.ignored) ignored = true
    else if (result.unignored) ignored = false
  }
  return ignored
}

/** A selected scope must not make discovery follow symlinks that the ordinary walker skips. */
async function noSymlinkPath(root: string, target: string, exec: ToolExecution): Promise<boolean> {
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  let probe = root
  for (const part of parts) {
    probe = path.join(probe, part)
    await resolveInGrants(exec, probe, 'read')
    if (exec.signal?.aborted) throw new Error('cancelled: stop requested during search')
    try {
      const stat = await fs.lstat(probe)
      if (exec.signal?.aborted) throw new Error('cancelled: stop requested during search')
      if (stat.isSymbolicLink()) return false
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
      throw error
    }
  }
  return true
}

export async function searchFiles(
  base: string,
  exec: ToolExecution,
  options: { patterns?: string[]; includeIgnored?: boolean },
): Promise<SearchResult> {
  const result: SearchResult = { files: [], incomplete: new Set() }
  const checkAbort = (): void => { if (exec.signal?.aborted) throw new Error('cancelled: stop requested during search') }
  checkAbort()
  const patterns = options.patterns?.map(compile)
  const grant = classifyGrantedRoots(grantedRoots(exec), base)
  if (grant === undefined) throw new Error('search base is outside granted folders')
  const grantRoot = path.resolve(grant.path)
  if (!await noSymlinkPath(grantRoot, base, exec)) return result

  async function loadRules(dir: string, layers: Layer[]): Promise<Layer[]> {
    if (options.includeIgnored || exec.memoryRoots?.some((root) => within(root, dir))) return layers
    const file = path.join(dir, '.gitignore')
    try { await resolveInGrants(exec, file, 'read') } catch { return layers }
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return layers
      if (stat.size > 1024 * 1024) { result.incomplete.add('gitignore file exceeds 1 MiB'); return layers }
      const rules = await fs.readFile(file, 'utf8')
      return [...layers, { base: dir, rules, matcher: ignore().add(rules), overrides: [] }]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.incomplete.add('could not read gitignore rules')
      return layers
    }
  }

  // Read rules from the matched grant, never from parents outside tool authority.
  // Explicit scope may enter an ignored directory, but ordinary rules on its files still apply.
  let layers: Layer[] = []
  let ancestor = grantRoot
  layers = await loadRules(ancestor, layers)
  for (const part of path.relative(grantRoot, base).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part)
    if (!options.includeIgnored) layers = unignoreDirectory(layers, ancestor)
    layers = await loadRules(ancestor, layers)
  }

  // Jump to the common literal directory prefix without walking unrelated trees.
  const first = patterns?.[0]?.segments ?? []
  const prefix: string[] = []
  for (let i = 0; i < first.length - 1; i++) {
    const segment = first[i]!
    if (segment.includes('*') || !patterns?.every((pattern) => pattern.segments[i] === segment && i < pattern.segments.length - 1)) break
    prefix.push(segment)
  }
  let start = base
  for (const part of prefix) {
    checkAbort()
    start = path.join(start, part)
    try { await resolveInGrants(exec, start, 'read') }
    catch { return result } // Denied subtrees are excluded, as in broad discovery.
    try { if (!await noSymlinkPath(base, start, exec)) return result }
    catch {
      checkAbort()
      result.incomplete.add('could not inspect search directory')
      return result
    }
    if (!options.includeIgnored) layers = unignoreDirectory(layers, start)
    layers = await loadRules(start, layers)
  }

  const exact = patterns?.length === 1 && !patterns[0]!.segments.some((segment) => segment.includes('*'))
  if (exact) {
    checkAbort()
    const file = path.join(base, ...patterns[0]!.segments)
    try { await resolveInGrants(exec, file, 'read') } catch { return result }
    try {
      if (await noSymlinkPath(base, file, exec) && (await fs.lstat(file)).isFile()) result.files.push(file)
    } catch (error) {
      checkAbort()
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) result.incomplete.add('could not inspect requested file')
    }
    return result
  }

  // Each alternative carries its own ignore state. Reading a directory and
  // spending its node budget is still shared, so 64 choices cannot multiply IO.
  interface Branch { pattern: Pattern | undefined; layers: Layer[] }
  let left = WALK_BUDGET
  async function walk(dir: string, parts: string[], inherited: Branch[], alreadyLoaded = false): Promise<void> {
    checkAbort()
    const memoryRoot = exec.memoryRoots?.find((root) => within(root, dir))
    try { await resolveInGrants(exec, memoryRoot !== undefined && dir !== memoryRoot ? path.join(dir, 'MEMORY.md') : dir, 'read') }
    catch { return }
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) result.incomplete.add('could not read search directory')
      return
    }
    const localLayers = alreadyLoaded ? [] : await loadRules(dir, [])
    const branches = inherited.map((branch) => ({ ...branch, layers: [...branch.layers, ...localLayers] }))
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      checkAbort()
      if (left <= 0) { result.incomplete.add('walk budget exhausted'); break }
      left--
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      const relativeParts = [...parts, entry.name]
      if (entry.isDirectory()) {
        const children: Branch[] = []
        for (const branch of branches) {
          const pattern = branch.pattern
          if (pattern && !couldDescend(pattern, relativeParts)) continue
          const explicit = pattern !== undefined && explicitDirectory(pattern, relativeParts)
          if (!options.includeIgnored && !explicit && (DEFAULT_IGNORED.has(entry.name) || isIgnored(branch.layers, full, true))) continue
          children.push({ pattern, layers: explicit && !options.includeIgnored ? unignoreDirectory(branch.layers, full) : branch.layers })
        }
        if (children.length) await walk(full, relativeParts, children)
      } else if (entry.isFile()) {
        const accepted = branches.some(({ pattern, layers }) => {
          if (pattern && !matches(pattern, relativeParts)) return false
          const explicit = pattern?.segments.at(-1) === entry.name
          return options.includeIgnored || explicit || !isIgnored(layers, full, false)
        })
        if (!accepted) continue
        try { await resolveInGrants(exec, full, 'read'); result.files.push(full) } catch { /* excluded by grant policy */ }
      }
    }
  }
  const branches: Branch[] = patterns ? patterns.map((pattern) => ({ pattern, layers })) : [{ pattern: undefined, layers }]
  await walk(start, prefix, branches, true)
  return result
}

/** Whole rows only. Completeness takes priority over results; metadata is never cut.
 * totalMatches is Glob's discovered total (including rows outside its result cap).
 * Grep supplies its worker/size notes separately, never as result rows.
 */
export function searchOutput(
  lines: string[], incomplete: Set<string>, limit: number,
  options: { totalMatches?: number; notes?: string[] } = {},
): string {
  if (!Number.isFinite(limit) || limit < 64) throw new Error('search output limit must be at least 64 characters')
  limit = Math.floor(limit)
  let note = incomplete.size ? `… [search incomplete: ${[...incomplete].join('; ')}; narrow the search path]` : ''
  const truncation = '… [output truncated]'
  const total = options.totalMatches
  const extra = options.notes ?? []
  const remaining = (shown: number): string[] => total !== undefined
    ? total > shown ? [`… [+${total - shown} more matches]`] : []
    : shown < lines.length ? [truncation] : []
  // Reserve a whole omission footer before deciding how much reason text fits.
  const reserve = [...remaining(0), ...extra].join('\n').length
  if (note && note.length + reserve + (reserve ? 1 : 0) > limit) note = '… [search incomplete: partial]'
  let metadata = [...extra]
  // Size/truncation notes may exceed a tiny cap: preserve their existence, not
  // an arbitrary fragment that could masquerade as a filename or match.
  if ([...remaining(0), ...metadata, note].filter(Boolean).join('\n').length > limit) metadata = [truncation]
  for (let shown = lines.length; shown >= 0; shown--) {
    const footers = [...new Set([...remaining(shown), ...metadata, note].filter(Boolean))]
    const output = [...lines.slice(0, shown), ...footers].join('\n')
    if (output.length <= limit) return output || 'no matches'
  }
  // At least 64 characters fits the compact warning plus an omission footer.
  throw new Error('search output metadata exceeds output limit')
}
