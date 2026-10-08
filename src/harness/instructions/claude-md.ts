/**
 * Claude Code memory files (CLAUDE.md), read the way Claude Code reads them,
 * plus one dnt-harness layer: the workspace folder, laid out like `~/.claude`.
 *
 * Order (later = more specific = wins on conflict):
 *   1. user       `~/.claude/CLAUDE.md`
 *   2. workspace  `<data>/workspaces/<ws>/CLAUDE.md`
 *   3. project    for each directory from the outermost ancestor of the
 *                 project root down to the root itself: `CLAUDE.md`,
 *                 `.claude/CLAUDE.md`, `CLAUDE.local.md`
 *
 * `AGENTS.md` is read through imports (`@AGENTS.md`), as Claude does, and as
 * a fallback in a directory that carries no CLAUDE.md of its own.
 *
 * Imports: `@path` tokens outside code (fenced blocks and inline spans),
 * relative to the importing file, `~/` for home, or absolute. Depth 5, every
 * file loaded at most once (cycles end silently), bounded size.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const CLAUDE_MD_MAX_FILE_BYTES = 40_000
export const CLAUDE_MD_MAX_TOTAL_BYTES = 200_000
export const CLAUDE_MD_MAX_IMPORT_DEPTH = 5

export type ClaudeMdLayer = 'user' | 'workspace' | 'project' | 'local'

export interface ClaudeMdFile {
  readonly layer: ClaudeMdLayer
  readonly path: string
  readonly content: string
  /** Set when the file (or the total budget) cut it short. */
  readonly truncated?: boolean
  /** The file that imported this one, when it arrived through `@path`. */
  readonly importedFrom?: string
}

export interface ClaudeMdSources {
  /** `~/.claude`; omitted skips the user layer (tests, headless). */
  readonly userDir?: string
  /** `<data>/workspaces/<ws>` — the workspace layer. */
  readonly workspaceDir?: string
  /** The bound project root. */
  readonly projectRoot?: string
  /** Home directory used for `~/` imports and the ancestor walk stop. */
  readonly home?: string
  /**
   * Folders no `@import` may read (credential roots such as `~/.ssh`, the
   * app's own storage). Checked after symlink resolution.
   */
  readonly deniedRoots?: readonly string[]
}

/**
 * Read at most `limit` bytes of a regular file. Never loads more than the cap,
 * so a huge or endless file cannot exhaust memory. `size` is the full size.
 */
async function readBounded(file: string, limit: number): Promise<{ text: string; size: number } | undefined> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) return undefined
    const want = Math.max(0, Math.min(limit, stat.size))
    const buffer = Buffer.alloc(want)
    const { bytesRead } = want > 0 ? await handle.read(buffer, 0, want, 0) : { bytesRead: 0 }
    // A cut inside a multi-byte character decodes to U+FFFD; drop it.
    return { text: buffer.subarray(0, bytesRead).toString('utf8').replace(/\uFFFD$/, ''), size: stat.size }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function within(child: string, root: string): boolean {
  const relative = path.relative(root, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Directories from the outermost ancestor down to `root`, never including home or the filesystem root above it. */
export function projectDirectoryChain(root: string, home: string = homedir()): string[] {
  const resolved = path.resolve(root)
  const homeResolved = path.resolve(home)
  const chain: string[] = [resolved]
  let current = resolved
  for (;;) {
    const parent = path.dirname(current)
    if (parent === current) break // filesystem root
    if (parent === homeResolved || parent === path.parse(parent).root) break
    // Only walk while still under home; outside home stop at the root itself.
    if (!isInside(parent, homeResolved)) break
    chain.unshift(parent)
    current = parent
  }
  return chain
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** `@path` tokens outside fenced code blocks and inline code spans. */
export function importTokens(content: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const withoutCode = line.replace(/`[^`]*`/g, ' ')
    for (const match of withoutCode.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s`'"<>()[\]{}]+)/g)) {
      const token = match[1] ?? ''
      // `@scope/pkg`-like or email-like tokens without a path shape still
      // resolve as relative files; missing files are skipped silently.
      if (token !== '') out.push(token.replace(/[.,;:!?]+$/, ''))
    }
  }
  return out
}

function resolveImport(token: string, fromFile: string, home: string): string {
  if (token.startsWith('~/')) return path.join(home, token.slice(2))
  if (path.isAbsolute(token)) return token
  return path.resolve(path.dirname(fromFile), token)
}

/**
 * Load every CLAUDE.md for the given sources in context order. Missing files
 * are skipped; unreadable ones too — a memory file never fails a request.
 */
export async function loadClaudeMd(sources: ClaudeMdSources): Promise<ClaudeMdFile[]> {
  const home = sources.home ?? homedir()
  const files: ClaudeMdFile[] = []
  const seen = new Set<string>()
  let total = 0
  const real = async (target: string): Promise<string | undefined> => {
    try { return await fs.realpath(target) } catch { return undefined }
  }
  const denied: string[] = []
  for (const root of sources.deniedRoots ?? []) denied.push((await real(root)) ?? path.resolve(root))

  /**
   * `importRoot` bounds where `@imports` of this layer may land (after
   * symlinks): the user layer stays under home, the workspace layer in its
   * folder, the project layers in the project chain. A repository's
   * CLAUDE.md therefore cannot pull in `~/.ssh/…` or another workspace's data.
   */
  const push = async (layer: ClaudeMdLayer, file: string, depth: number, importRoot: string, importedFrom?: string): Promise<boolean> => {
    const key = await real(path.resolve(file))
    if (key === undefined) return false
    if (seen.has(key)) return true
    if (importedFrom !== undefined) {
      if (!within(key, importRoot)) return false
      // A denied root that contains the layer itself (the workspace layer
      // lives in app storage) does not block that layer's own imports.
      if (denied.some((root) => within(key, root) && !within(importRoot, root))) return false
    }
    seen.add(key)
    if (total >= CLAUDE_MD_MAX_TOTAL_BYTES) return true
    const room = Math.min(CLAUDE_MD_MAX_FILE_BYTES, CLAUDE_MD_MAX_TOTAL_BYTES - total)
    const read = await readBounded(key, room)
    if (read === undefined) return false
    const content = read.text
    const truncated = read.size > Buffer.byteLength(content, 'utf8')
    total += Buffer.byteLength(content, 'utf8')
    files.push({ layer, path: file, content, ...(truncated ? { truncated } : {}), ...(importedFrom !== undefined ? { importedFrom } : {}) })
    if (depth < CLAUDE_MD_MAX_IMPORT_DEPTH) {
      for (const token of importTokens(content)) {
        await push(layer, resolveImport(token, file, home), depth + 1, importRoot, file)
      }
    }
    return true
  }

  const homeRoot = (await real(home)) ?? path.resolve(home)
  if (sources.userDir !== undefined) await push('user', path.join(sources.userDir, 'CLAUDE.md'), 0, homeRoot)
  if (sources.workspaceDir !== undefined) {
    await push('workspace', path.join(sources.workspaceDir, 'CLAUDE.md'), 0, (await real(sources.workspaceDir)) ?? path.resolve(sources.workspaceDir))
  }
  if (sources.projectRoot !== undefined) {
    const chain = projectDirectoryChain(sources.projectRoot, home)
    // Imports from the project's files stay inside the outermost directory of
    // its chain (the project itself when it lives outside home).
    const projectRoot = (await real(chain[0] ?? sources.projectRoot)) ?? path.resolve(chain[0] ?? sources.projectRoot)
    for (const dir of chain) {
      const hasMain = await push('project', path.join(dir, 'CLAUDE.md'), 0, projectRoot)
      const hasDotClaude = await push('project', path.join(dir, '.claude', 'CLAUDE.md'), 0, projectRoot)
      if (!hasMain && !hasDotClaude) await push('project', path.join(dir, 'AGENTS.md'), 0, projectRoot)
      await push('local', path.join(dir, 'CLAUDE.local.md'), 0, projectRoot)
    }
  }
  return files
}

/** One text block for the context builder: each file headed by its path. */
export function renderClaudeMd(files: readonly ClaudeMdFile[]): string {
  return files
    .filter((file) => file.content.trim() !== '')
    .map((file) => {
      const label = file.importedFrom !== undefined ? `${file.path} (imported by ${file.importedFrom})` : `${file.path} (${file.layer} instructions)`
      return `Contents of ${label}:\n\n${file.content.trim()}${file.truncated === true ? '\n\n[truncated: file exceeds the CLAUDE.md size limit]' : ''}`
    })
    .join('\n\n')
}
