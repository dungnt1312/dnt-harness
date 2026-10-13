# File Explorer Actions and Name Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the workbench file explorer create files and folders, rename, delete (with confirmation), and search file names.

**Architecture:** A new server module `src/web/project-files-write.ts` owns every write and is reached through `POST|PATCH|DELETE` on the existing `…/projects/:pid/files` route; `project-files.ts` stays read-only. The web side adds three API calls, two pure tab-state functions, a small tree-state helper module, and the UI in `FileBrowser.tsx` split into focused components.

**Tech Stack:** TypeScript, Node `fs/promises`, React 19, Vitest (+ jsdom for web specs), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-13-file-explorer-actions-design.md` (commit `b4cbc3a`).

**Workspace:** all work happens in the worktree `/Users/dungnt/workspace/dnt-harness/.worktrees/file-explorer-actions` on branch `feat/file-explorer-actions`. Every path below is relative to that worktree. Never edit the main checkout.

## Global Constraints

- Use pnpm; add no new dependency.
- Writes are a direct user action, independent of any session mode. No mode or approval check.
- Write routes call `requireWorkspace(deps, wsId, true)`; reads keep `false`.
- The project root itself and any path with a `.git` segment are never created, renamed or deleted.
- A name is 1–255 UTF-8 bytes, has no `/`, `\` or NUL, is not `.`, `..` or `.git`, has no leading/trailing whitespace, and passes `blockedReason` from `src/capabilities/fs/grants.ts`.
- Never overwrite: an existing destination answers 409. Missing entry or parent answers 404. Invalid input or refused path answers 400.
- Symlinks in the last path segment are never followed for rename or delete.
- Rename stays in the same parent folder (no move).
- Delete is permanent, after a confirmation dialog.
- Search reuses `GET …/search` with `limit=50`, debounced 200 ms; hidden files and `node_modules` stay excluded.
- Row actions follow the hover-reveal convention: absolute, `invisible opacity-0` until row hover or focus-within, always visible under `pointer: coarse`.
- Inline name input: Enter submits, Escape cancels, blur cancels without submitting.
- UI copy is English, matching the existing UI.
- Commit messages use conventional commits (`feat(web): …`, `test(web): …`, `docs(web): …`).
- Gates per task: the task's own specs. Final: `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`.

## Review Focus

1. Deleting a symlink that points outside the project removes the link and leaves the target untouched (Task 1 test).
2. Renaming a folder that has open tabs inside it rewrites those tabs to the new path (Task 4 test).
3. A case-only rename (`Readme.md` → `README.md`) succeeds on a case-insensitive volume instead of answering 409 (Task 1 test, skipped on case-sensitive volumes).
4. Pressing Enter twice while a create request is pending sends one request only (Task 5 test).
5. A slow search response for an older query never replaces the results of a newer query (Task 7 test).

## File Map

| File | Task | Responsibility |
|---|---|---|
| `src/web/project-files.ts` | 1 | export `normalizeRelative`; header comment points to the write module |
| `src/web/project-files-write.ts` (new) | 1 | create / rename / delete with containment and name rules |
| `tests/web/project-files-write.spec.ts` (new) | 1 | unit tests for the write module |
| `src/web/server.ts` | 2 | route `POST|PATCH|DELETE …/files` |
| `tests/web/server-project-files.spec.ts` | 2 | HTTP tests for the write routes |
| `docs/web.md` | 2 | route table row |
| `web/lib/api.ts` | 3 | `createProjectEntry`, `renameProjectEntry`, `deleteProjectEntry` |
| `web/lib/file-tree.ts` (new) | 3 | pure path helpers: target folder, ancestors, drop paths, error text |
| `web/lib/file-tree.spec.ts` (new) | 3 | tests for the helpers |
| `web/hooks/useWorkbenchFiles.ts` | 4 | `renameFileTabs`, `removeFileTabs`, `renamePath`, `removePath` |
| `web/hooks/useWorkbenchFiles.spec.ts` (new) | 4 | pure tab-state tests |
| `web/components/workbench/FileNameInput.tsx` (new) | 5 | inline name input |
| `web/components/workbench/file-name-input.spec.tsx` (new) | 5 | input tests |
| `web/components/workbench/FileBrowser.tsx` | 6, 7 | header actions, row menu, drafts, delete dialog, search box |
| `web/components/workbench/FilesWorkspace.tsx` | 6 | pass `renamePath` / `removePath` |
| `web/components/workbench/file-browser.spec.tsx` (new) | 6, 7 | mounted explorer tests |
| `web/components/workbench/FileSearchResults.tsx` (new) | 7 | search result list |

---

### Task 1: Server write module

**Files:**
- Modify: `src/web/project-files.ts` (export `normalizeRelative`, header comment)
- Create: `src/web/project-files-write.ts`
- Test: `tests/web/project-files-write.spec.ts`

**Interfaces:**
- Consumes: `resolveGrantedPath`, `within`, `blockedReason` from `src/capabilities/fs/grants.ts`; `ProjectEntry` and `normalizeRelative` from `src/web/project-files.ts`.
- Produces (used by Task 2):
  - `class ProjectWriteError extends Error { readonly status: 400 | 404 | 409 }`
  - `createProjectEntry(root: string, rawPath: string, kind: 'file' | 'dir', deniedRoots?: readonly string[]): Promise<ProjectEntry>`
  - `renameProjectEntry(root: string, rawPath: string, newName: string, deniedRoots?: readonly string[]): Promise<{ path: string; kind: 'file' | 'dir' }>`
  - `deleteProjectEntry(root: string, rawPath: string, deniedRoots?: readonly string[]): Promise<{ path: string }>`

- [ ] **Step 1: Export the normalizer from the read module**

In `src/web/project-files.ts`, change `function normalizeRelative(raw: string): string {` to `export function normalizeRelative(raw: string): string {`. Replace the last sentence of the header comment, `application-internal storage are refused. Nothing here writes.`, with:

```ts
 * application-internal storage are refused. Nothing here writes; creating,
 * renaming and deleting live in `project-files-write.ts`.
```

- [ ] **Step 2: Write the failing tests**

Create `tests/web/project-files-write.spec.ts`:

```ts
/**
 * Explorer writes: create, rename and delete stay inside the project root,
 * never overwrite, never follow a link in the last segment, and refuse the
 * root itself and `.git`.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProjectEntry,
  deleteProjectEntry,
  ProjectWriteError,
  renameProjectEntry,
} from '../../src/web/project-files-write.ts'

let root = ''
let outside = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-write-root-'))
  outside = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-write-outside-'))
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'x\n', 'utf8')
  await fs.writeFile(path.join(root, 'README.md'), '# r\n', 'utf8')
  await fs.mkdir(path.join(root, '.git'))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n', 'utf8')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

const exists = (rel: string): Promise<boolean> => fs.lstat(path.join(root, rel)).then(() => true, () => false)

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ProjectWriteError) return error.status
    throw error
  }
  return 200
}

describe('createProjectEntry', () => {
  it('creates an empty file and a folder', async () => {
    expect(await createProjectEntry(root, 'src/new.ts', 'file')).toEqual({ name: 'new.ts', path: 'src/new.ts', kind: 'file', size: 0 })
    expect(await fs.readFile(path.join(root, 'src', 'new.ts'), 'utf8')).toBe('')
    expect(await createProjectEntry(root, 'docs', 'dir')).toEqual({ name: 'docs', path: 'docs', kind: 'dir' })
    expect((await fs.stat(path.join(root, 'docs'))).isDirectory()).toBe(true)
  })

  it('accepts either separator', async () => {
    expect((await createProjectEntry(root, 'src\\other.ts', 'file')).path).toBe('src/other.ts')
  })

  it('answers 409 when the name exists and never overwrites', async () => {
    expect(await status(createProjectEntry(root, 'README.md', 'file'))).toBe(409)
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# r\n')
    expect(await status(createProjectEntry(root, 'src', 'dir'))).toBe(409)
  })

  it('answers 404 when the parent folder is missing', async () => {
    expect(await status(createProjectEntry(root, 'missing/a.ts', 'file'))).toBe(404)
    expect(await status(createProjectEntry(root, 'missing/a', 'dir'))).toBe(404)
  })

  it('answers 400 when the parent is a file', async () => {
    expect(await status(createProjectEntry(root, 'README.md/a.ts', 'file'))).toBe(400)
  })
})

describe('renameProjectEntry', () => {
  it('renames a file and a folder in place', async () => {
    expect(await renameProjectEntry(root, 'README.md', 'NOTES.md')).toEqual({ path: 'NOTES.md', kind: 'file' })
    expect(await exists('NOTES.md')).toBe(true)
    expect(await exists('README.md')).toBe(false)
    expect(await renameProjectEntry(root, 'src', 'lib')).toEqual({ path: 'lib', kind: 'dir' })
    expect(await exists('lib/index.ts')).toBe(true)
  })

  it('answers 409 when the destination exists', async () => {
    await fs.writeFile(path.join(root, 'other.md'), 'o\n', 'utf8')
    expect(await status(renameProjectEntry(root, 'README.md', 'other.md'))).toBe(409)
    expect(await fs.readFile(path.join(root, 'other.md'), 'utf8')).toBe('o\n')
  })

  it('answers 404 for a missing source and 400 for the same name', async () => {
    expect(await status(renameProjectEntry(root, 'nope.md', 'x.md'))).toBe(404)
    expect(await status(renameProjectEntry(root, 'README.md', 'README.md'))).toBe(400)
  })

  it('allows a case-only rename on a case-insensitive volume', async () => {
    const insensitive = await fs.stat(path.join(root, 'readme.md')).then(() => true, () => false)
    if (!insensitive) return
    expect(await renameProjectEntry(root, 'README.md', 'Readme.md')).toEqual({ path: 'Readme.md', kind: 'file' })
    expect(await fs.readdir(root)).toContain('Readme.md')
  })

  it('renames a symlink itself, not its target', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    expect(await renameProjectEntry(root, 'link.txt', 'moved.txt')).toEqual({ path: 'moved.txt', kind: 'file' })
    expect((await fs.lstat(path.join(root, 'moved.txt'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })
})

describe('deleteProjectEntry', () => {
  it('deletes a file and a non-empty folder', async () => {
    expect(await deleteProjectEntry(root, 'README.md')).toEqual({ path: 'README.md' })
    expect(await exists('README.md')).toBe(false)
    expect(await deleteProjectEntry(root, 'src')).toEqual({ path: 'src' })
    expect(await exists('src')).toBe(false)
  })

  it('deletes a symlink pointing outside without touching its target', async () => {
    await fs.symlink(outside, path.join(root, 'out-link'))
    expect(await deleteProjectEntry(root, 'out-link')).toEqual({ path: 'out-link' })
    expect(await exists('out-link')).toBe(false)
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('deletes a broken symlink', async () => {
    await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'))
    expect(await deleteProjectEntry(root, 'broken')).toEqual({ path: 'broken' })
    expect(await exists('broken')).toBe(false)
  })

  it('answers 404 for a missing entry', async () => {
    expect(await status(deleteProjectEntry(root, 'nope.md'))).toBe(404)
  })
})

describe('refusals', () => {
  it('refuses the project root for every operation', async () => {
    for (const raw of ['', '.', '/', './']) {
      expect(await status(deleteProjectEntry(root, raw))).toBe(400)
      expect(await status(renameProjectEntry(root, raw, 'x'))).toBe(400)
      expect(await status(createProjectEntry(root, raw, 'dir'))).toBe(400)
    }
    expect(await exists('README.md')).toBe(true)
  })

  it('refuses .git and anything under it', async () => {
    expect(await status(deleteProjectEntry(root, '.git'))).toBe(400)
    expect(await status(createProjectEntry(root, '.git/hooks', 'dir'))).toBe(400)
    expect(await status(renameProjectEntry(root, '.git', 'git'))).toBe(400)
    expect(await status(renameProjectEntry(root, 'README.md', '.git'))).toBe(400)
    expect(await status(createProjectEntry(root, 'src/.git', 'dir'))).toBe(400)
    expect(await exists('.git')).toBe(true)
  })

  it('refuses traversal and absolute paths', async () => {
    for (const raw of ['../x', `../${path.basename(outside)}/secret.txt`, path.join(outside, 'secret.txt'), 'C:/x']) {
      expect(await status(deleteProjectEntry(root, raw))).toBe(400)
      expect(await status(createProjectEntry(root, raw, 'file'))).toBe(400)
    }
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('refuses a parent folder that is a symlink out of the root', async () => {
    await fs.symlink(outside, path.join(root, 'escape'))
    expect(await status(createProjectEntry(root, 'escape/new.txt', 'file'))).toBe(400)
    expect(await status(deleteProjectEntry(root, 'escape/secret.txt'))).toBe(400)
    expect(await status(renameProjectEntry(root, 'escape/secret.txt', 'x.txt'))).toBe(400)
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })

  it('refuses invalid names', async () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', ' lead', 'trail ', 'x'.repeat(256)]) {
      expect(await status(renameProjectEntry(root, 'README.md', name)), JSON.stringify(name)).toBe(400)
    }
    expect(await status(createProjectEntry(root, 'src/ spaced', 'file'))).toBe(400)
    expect(await status(createProjectEntry(root, 'trailing ', 'file'))).toBe(400)
    expect(await exists('trailing')).toBe(false)
    expect(await exists('README.md')).toBe(true)
  })

  it('refuses paths inside denied roots', async () => {
    const denied = [path.join(root, 'src')]
    expect(await status(deleteProjectEntry(root, 'src', denied))).toBe(400)
    expect(await status(createProjectEntry(root, 'src/new.ts', 'file', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, 'src', 'lib', denied))).toBe(400)
    expect(await exists('src/index.ts')).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/web/project-files-write.spec.ts`
Expected: FAIL — cannot resolve `../../src/web/project-files-write.ts`.

- [ ] **Step 4: Write the module**

Create `src/web/project-files-write.ts`:

```ts
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { blockedReason, resolveGrantedPath, within } from '../capabilities/fs/grants.ts'
import { normalizeRelative, type ProjectEntry } from './project-files.ts'

/**
 * Explorer writes for the web workbench: create a file or folder, rename in
 * place, delete. Only the parent folder is resolved through the granted-path
 * rules; the last segment is then handled with `lstat`, so a link there is
 * renamed or removed itself and never followed. The project root and `.git`
 * are never touched. Check-then-act leaves a small race window: this is
 * application-level containment, not an OS sandbox.
 */

export class ProjectWriteError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'ProjectWriteError'
  }
}

const MAX_NAME_BYTES = 255

/** Why `name` cannot be one path segment, or undefined when it can. */
function nameProblem(name: string): string | undefined {
  if (name === '') return 'name must not be empty'
  if (name === '.' || name === '..') return `'${name}' is not a valid name`
  if (/[/\\\0]/.test(name)) return 'name must not contain /, \\ or NUL'
  if (name !== name.trim()) return 'name must not start or end with whitespace'
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return `name must be at most ${MAX_NAME_BYTES} bytes`
  if (name === '.git') return "'.git' is protected"
  return blockedReason(name, name)
}

interface Target {
  /** Root-relative path with `/` separators. */
  readonly rel: string
  /** The resolved parent folder. */
  readonly parentAbs: string
  readonly parentRel: string
  readonly name: string
  /** `parentAbs` joined with `name`; never resolved through a link. */
  readonly abs: string
}

function refuse(message: string): never {
  throw new ProjectWriteError(400, message)
}

async function target(root: string, raw: string, deniedRoots: readonly string[] | undefined): Promise<Target> {
  // The normalizer trims; refuse instead so a name is never silently changed.
  if (raw !== raw.trim()) refuse('path must not start or end with whitespace')
  const rel = normalizeRelative(raw)
  if (path.isAbsolute(raw.trim()) || /^[a-zA-Z]:/.test(rel)) refuse('path must be relative to the project root')
  if (rel === '') refuse('the project root itself cannot be changed')
  const segments = rel.split('/')
  if (segments.includes('..')) refuse(`path '${rel}' escapes the project root`)
  if (segments.includes('.git')) refuse("'.git' is protected")
  const name = segments[segments.length - 1] as string
  const parentRel = segments.slice(0, -1).join('/')
  let parentAbs: string
  try {
    parentAbs = await resolveGrantedPath(root, parentRel === '' ? '.' : parentRel, deniedRoots)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  const abs = path.join(parentAbs, name)
  for (const denied of deniedRoots ?? []) {
    if (within(denied, abs)) refuse(`path '${rel}' is inside protected storage`)
  }
  return { rel, parentAbs, parentRel, name, abs }
}

async function requireFolder(abs: string, rel: string): Promise<void> {
  const stat = await fs.stat(abs).catch(() => null)
  if (stat === null) throw new ProjectWriteError(404, `folder '${rel || '.'}' does not exist`)
  if (!stat.isDirectory()) refuse(`'${rel}' is not a folder`)
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined

export async function createProjectEntry(root: string, rawPath: string, kind: 'file' | 'dir', deniedRoots?: readonly string[]): Promise<ProjectEntry> {
  const t = await target(root, rawPath, deniedRoots)
  const problem = nameProblem(t.name)
  if (problem !== undefined) refuse(problem)
  await requireFolder(t.parentAbs, t.parentRel)
  try {
    if (kind === 'file') await fs.writeFile(t.abs, '', { flag: 'wx' })
    else await fs.mkdir(t.abs)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') throw new ProjectWriteError(409, `'${t.rel}' already exists`)
    if (codeOf(error) === 'ENOENT') throw new ProjectWriteError(404, `folder '${t.parentRel || '.'}' does not exist`)
    throw error
  }
  return kind === 'file' ? { name: t.name, path: t.rel, kind: 'file', size: 0 } : { name: t.name, path: t.rel, kind: 'dir' }
}

export async function renameProjectEntry(root: string, rawPath: string, newName: string, deniedRoots?: readonly string[]): Promise<{ path: string; kind: 'file' | 'dir' }> {
  const t = await target(root, rawPath, deniedRoots)
  const problem = nameProblem(newName)
  if (problem !== undefined) refuse(problem)
  if (newName === t.name) refuse('the new name is the same as the current one')
  const source = await fs.lstat(t.abs).catch(() => null)
  if (source === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  const destAbs = path.join(t.parentAbs, newName)
  for (const denied of deniedRoots ?? []) {
    if (within(denied, destAbs)) refuse(`'${newName}' is inside protected storage`)
  }
  const existing = await fs.lstat(destAbs).catch(() => null)
  // Same inode means a case-only rename on a case-insensitive volume.
  if (existing !== null && !(existing.ino === source.ino && existing.dev === source.dev)) {
    throw new ProjectWriteError(409, `'${newName}' already exists`)
  }
  await fs.rename(t.abs, destAbs)
  const destRel = t.parentRel === '' ? newName : `${t.parentRel}/${newName}`
  // A link reports the kind of what it points to; a broken one counts as a file.
  const kind = source.isDirectory() || (source.isSymbolicLink() && (await fs.stat(destAbs).then((s) => s.isDirectory(), () => false))) ? 'dir' : 'file'
  return { path: destRel, kind }
}

export async function deleteProjectEntry(root: string, rawPath: string, deniedRoots?: readonly string[]): Promise<{ path: string }> {
  const t = await target(root, rawPath, deniedRoots)
  const source = await fs.lstat(t.abs).catch(() => null)
  if (source === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  // `rm` removes a link itself and never descends into its target.
  await fs.rm(t.abs, { recursive: source.isDirectory(), force: false })
  return { path: t.rel }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/web/project-files-write.spec.ts tests/web/server-project-files.spec.ts`
Expected: PASS (the second file proves the read module still behaves).

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/web/project-files.ts src/web/project-files-write.ts tests/web/project-files-write.spec.ts
git commit -m "feat(web): explorer write module for create, rename and delete"
```

---

### Task 2: Write routes and route docs

**Files:**
- Modify: `src/web/server.ts` (the `wsProjectFilesMatch` block, about line 6978; one import)
- Modify: `docs/web.md` (the `(files\|file\|search)` route-table row, about line 162)
- Test: `tests/web/server-project-files.spec.ts`

**Interfaces:**
- Consumes (Task 1): `createProjectEntry`, `renameProjectEntry`, `deleteProjectEntry`, `ProjectWriteError` from `src/web/project-files-write.ts`.
- Produces (used by Task 3): HTTP contract

| Method | URL | Body | Success |
|---|---|---|---|
| `POST` | `/api/workspaces/:wid/projects/:pid/files` | `{ "path": string, "kind": "file" \| "dir" }` | 201 `ProjectEntry` |
| `PATCH` | same | `{ "path": string, "name": string }` | 200 `{ path, kind }` |
| `DELETE` | same + `?path=` | none | 200 `{ deleted: true, path }` |

Errors: `{ error: string }` with 400 / 404 / 409.

- [ ] **Step 1: Write the failing HTTP tests**

Append this block to the end of `tests/web/server-project-files.spec.ts` (it reuses the file's `server`, `wsId`, `home` and `idle` fixtures; it registers its own project so the listing assertions above stay unchanged):

```ts
describe('explorer writes', () => {
  let writeRoot = ''
  let writeProjectId = ''
  const base = () => `${server.url}/api/workspaces/${wsId}/projects/${writeProjectId}/files`
  const json = (method: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base(), { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const remove = (rel: string) => fetch(`${base()}?path=${encodeURIComponent(rel)}`, { method: 'DELETE' })

  beforeAll(async () => {
    writeRoot = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-write-'))
    await fs.writeFile(path.join(writeRoot, 'README.md'), 'r\n', 'utf8')
    await fs.mkdir(path.join(writeRoot, '.git'))
    const created = await fetch(`${server.url}/api/workspaces/${wsId}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Writes', path: writeRoot }),
    })
    writeProjectId = ((await created.json()) as { id: string }).id
  })

  afterAll(async () => {
    await fs.rm(writeRoot, { recursive: true, force: true })
  })

  it('creates, renames and deletes through the files route', async () => {
    const made = await json('POST', { path: 'notes', kind: 'dir' })
    expect(made.status).toBe(201)
    expect(await made.json()).toEqual({ name: 'notes', path: 'notes', kind: 'dir' })
    expect((await json('POST', { path: 'notes/a.md', kind: 'file' })).status).toBe(201)

    const renamed = await json('PATCH', { path: 'notes/a.md', name: 'b.md' })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ path: 'notes/b.md', kind: 'file' })

    const deleted = await remove('notes')
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: true, path: 'notes' })
    expect(await fs.stat(path.join(writeRoot, 'notes')).then(() => true, () => false)).toBe(false)
  })

  it('maps write errors to 400, 404 and 409', async () => {
    expect((await json('POST', { path: 'README.md', kind: 'file' })).status).toBe(409)
    expect((await json('POST', { path: 'missing/a.md', kind: 'file' })).status).toBe(404)
    expect((await remove('nope.md')).status).toBe(404)
    expect((await remove('')).status).toBe(400)
    expect((await remove('.git')).status).toBe(400)
    expect((await remove('../x')).status).toBe(400)
    expect((await json('PATCH', { path: 'README.md', name: 'a/b' })).status).toBe(400)
  })

  it('validates request bodies', async () => {
    expect((await json('POST', { path: 'x', kind: 'link' })).status).toBe(400)
    expect((await json('POST', { kind: 'file' })).status).toBe(400)
    expect((await json('PATCH', { path: 'README.md' })).status).toBe(400)
    expect((await json('PATCH', { path: 'README.md', name: 3 })).status).toBe(400)
  })

  it('refuses a cross-site write', async () => {
    expect((await json('POST', { path: 'evil.txt', kind: 'file' }, { origin: 'http://evil.example' })).status).toBe(403)
    expect(await fs.stat(path.join(writeRoot, 'evil.txt')).then(() => true, () => false)).toBe(false)
  })

  it('keeps every other kind read-only', async () => {
    for (const kind of ['file', 'search', 'git', 'media']) {
      const response = await fetch(`${server.url}/api/workspaces/${wsId}/projects/${writeProjectId}/${kind}?path=README.md`, { method: 'DELETE' })
      expect(response.status, kind).toBe(405)
    }
    expect(await fs.readFile(path.join(writeRoot, 'README.md'), 'utf8')).toBe('r\n')
  })
})

describe('explorer writes in an archived workspace', () => {
  it('refuses writes but still serves reads', async () => {
    const archivedRoot = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-archived-'))
    try {
      await fs.writeFile(path.join(archivedRoot, 'README.md'), 'r\n', 'utf8')
      const ws = (await (await fetch(`${server.url}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Archived explorer' }),
      })).json()) as { id: string }
      const project = (await (await fetch(`${server.url}/api/workspaces/${ws.id}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Archived', path: archivedRoot }),
      })).json()) as { id: string }
      expect((await fetch(`${server.url}/api/workspaces/${ws.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })).status).toBe(200)

      const filesUrl = `${server.url}/api/workspaces/${ws.id}/projects/${project.id}/files`
      expect((await fetch(`${filesUrl}?path=`)).status).toBe(200)
      expect((await fetch(`${filesUrl}?path=README.md`, { method: 'DELETE' })).status).toBe(404)
      expect(await fs.readFile(path.join(archivedRoot, 'README.md'), 'utf8')).toBe('r\n')
    } finally {
      await fs.rm(archivedRoot, { recursive: true, force: true })
    }
  })
})
```

Note on the archived status: `requireActive` throws a `ScopeError` (`workspace-archived`), and the server's top-level handler maps `ScopeError` to 404, the same status `tests/web/server-g2.spec.ts` asserts for other archived writes. Assert 404, do not add a new mapping.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/web/server-project-files.spec.ts`
Expected: FAIL — the new write tests get 405 (`method not allowed`).

- [ ] **Step 3: Add the import**

In `src/web/server.ts`, next to the existing import of `listProjectEntries` / `readProjectFile` / `ProjectFileError` from `./project-files.ts`, add:

```ts
import { createProjectEntry, deleteProjectEntry, ProjectWriteError, renameProjectEntry } from './project-files-write.ts'
```

- [ ] **Step 4: Route the write methods**

In the `wsProjectFilesMatch` block, replace these lines:

```ts
      const wsId = decodeURIComponent(wsProjectFilesMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const project = deps.workspaces.getProject(decodeURIComponent(wsProjectFilesMatch[2] ?? '') as ProjectId, wsId)
      // HEAD joins GET: a media element asks for headers before it streams.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
```

with:

```ts
      const wsId = decodeURIComponent(wsProjectFilesMatch[1] ?? '') as WorkspaceId
      const writing = wsProjectFilesMatch[3] === 'files' && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE')
      // Writes need a live workspace; an archived one stays browsable.
      requireWorkspace(deps, wsId, writing)
      const project = deps.workspaces.getProject(decodeURIComponent(wsProjectFilesMatch[2] ?? '') as ProjectId, wsId)
      if (writing) {
        await handleProjectFileWrite(req, query, project.path, deps.deniedRoots, send)
        return
      }
      // HEAD joins GET: a media element asks for headers before it streams.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
```

- [ ] **Step 5: Add the write handler**

Add this function in `src/web/server.ts` directly above `function requireWorkspace(` (about line 7613):

```ts
/**
 * Explorer writes on `…/projects/:pid/files`: POST creates, PATCH renames in
 * place, DELETE removes. A direct user action like the workbench terminal, so
 * no session mode applies; containment lives in `project-files-write.ts`.
 */
async function handleProjectFileWrite(
  req: IncomingMessage,
  query: URLSearchParams,
  root: string,
  deniedRoots: readonly string[] | undefined,
  send: (status: number, body: unknown) => void,
): Promise<void> {
  try {
    if (req.method === 'DELETE') {
      const removed = await deleteProjectEntry(root, query.get('path') ?? '', deniedRoots)
      send(200, { deleted: true, path: removed.path })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const rawPath = body['path']
    if (typeof rawPath !== 'string') {
      send(400, { error: "'path' must be a string" })
      return
    }
    if (req.method === 'POST') {
      const kind = body['kind']
      if (kind !== 'file' && kind !== 'dir') {
        send(400, { error: "'kind' must be 'file' or 'dir'" })
        return
      }
      send(201, await createProjectEntry(root, rawPath, kind, deniedRoots))
      return
    }
    const name = body['name']
    if (typeof name !== 'string') {
      send(400, { error: "'name' must be a string" })
      return
    }
    send(200, await renameProjectEntry(root, rawPath, name, deniedRoots))
  } catch (error) {
    if (!(error instanceof ProjectWriteError)) throw error
    send(error.status, { error: error.message })
  }
}
```

If `send` inside the route block has a different signature from `(status: number, body: unknown) => void`, adapt the parameter type to the actual one; do not change `send` itself.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/web/server-project-files.spec.ts tests/web/project-files-write.spec.ts`
Expected: PASS.

- [ ] **Step 7: Update the route docs**

In `docs/web.md`, replace the row

```
| `GET …/:wid/projects/:pid/(files\|file\|search)` | read-only project browsing: one directory listing, one file body, and a bounded file-name search for composer mentions |
```

with these two rows:

```
| `GET …/:wid/projects/:pid/(files\|file\|search)` | project browsing: one directory listing, one file body, and a bounded file-name search (composer mentions and the explorer search box) |
| `POST\|PATCH\|DELETE …/:wid/projects/:pid/files` | explorer writes, a direct user action independent of any session mode: `POST {path, kind: 'file'\|'dir'}` creates (201), `PATCH {path, name}` renames in the same folder, `DELETE ?path=` deletes permanently (folders recursively). Never overwrites (409), refuses the project root, `.git`, traversal, links out of the root in a parent folder and protected storage (400); a link in the last segment is renamed or removed itself, never followed. Archived workspaces refuse writes |
```

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: no errors.

```bash
git add src/web/server.ts tests/web/server-project-files.spec.ts docs/web.md
git commit -m "feat(web): POST/PATCH/DELETE on the project files route"
```

---

### Task 3: Web API calls and explorer path helpers

**Files:**
- Modify: `web/lib/api.ts` (after `readProjectFile`, about line 534)
- Create: `web/lib/file-tree.ts`
- Test: `web/lib/file-tree.spec.ts` (new)

**Interfaces:**
- Consumes (Task 2): the HTTP contract above.
- Produces (used by Tasks 4, 6 and 7):
  - `createProjectEntry(workspaceId: string, projectId: string, path: string, kind: 'file' | 'dir'): Promise<ProjectEntry>`
  - `renameProjectEntry(workspaceId: string, projectId: string, path: string, name: string): Promise<{ path: string; kind: 'file' | 'dir' }>`
  - `deleteProjectEntry(workspaceId: string, projectId: string, path: string): Promise<{ deleted: true; path: string }>`
  - from `web/lib/file-tree.ts`: `interface Selection { path: string; kind: 'file' | 'dir' }`, `isAtOrUnder(path, target): boolean`, `parentOf(path): string`, `joinPath(folder, name): string`, `ancestorsOf(folder): string[]`, `targetFolder(selected: Selection | null): string`, `dropKeysUnder<T>(record, path)`, `dropUnderSet(set, path)`, `writeErrorText(error: unknown): string`

- [ ] **Step 1: Write the failing helper tests**

Create `web/lib/file-tree.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ancestorsOf, dropKeysUnder, dropUnderSet, isAtOrUnder, joinPath, parentOf, targetFolder, writeErrorText } from './file-tree.ts'

describe('explorer path helpers', () => {
  it('matches a path itself and its descendants, not a sibling prefix', () => {
    expect(isAtOrUnder('src', 'src')).toBe(true)
    expect(isAtOrUnder('src/a.ts', 'src')).toBe(true)
    expect(isAtOrUnder('srcx/a.ts', 'src')).toBe(false)
  })

  it('splits and joins root-relative paths', () => {
    expect(parentOf('a.ts')).toBe('')
    expect(parentOf('src/deep/a.ts')).toBe('src/deep')
    expect(joinPath('', 'a.ts')).toBe('a.ts')
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts')
    expect(ancestorsOf('')).toEqual([])
    expect(ancestorsOf('src/deep')).toEqual(['src', 'src/deep'])
  })

  it('creates inside a selected folder, beside a selected file, else at the root', () => {
    expect(targetFolder(null)).toBe('')
    expect(targetFolder({ path: 'src', kind: 'dir' })).toBe('src')
    expect(targetFolder({ path: 'src/a.ts', kind: 'file' })).toBe('src')
    expect(targetFolder({ path: 'a.ts', kind: 'file' })).toBe('')
  })

  it('drops cached folders and open state at or under a path, keeping identity when nothing changes', () => {
    const nodes = { '': 1, src: 2, 'src/deep': 3, srcx: 4 }
    expect(dropKeysUnder(nodes, 'src')).toEqual({ '': 1, srcx: 4 })
    expect(dropKeysUnder(nodes, 'docs')).toBe(nodes)
    const open = new Set(['src', 'src/deep', 'srcx'])
    expect([...dropUnderSet(open, 'src')]).toEqual(['srcx'])
    expect(dropUnderSet(open, 'docs')).toBe(open)
  })

  it('reads the server error message out of an HTTP error body', () => {
    expect(writeErrorText({ status: 409, body: '{"error":"\'a.ts\' already exists"}' })).toBe("'a.ts' already exists")
    expect(writeErrorText({ status: 502, body: 'Bad gateway' })).toBe('Bad gateway')
    expect(writeErrorText(new Error('offline'))).toBe('offline')
    expect(writeErrorText('boom')).toBe('boom')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run web/lib/file-tree.spec.ts`
Expected: FAIL — cannot resolve `./file-tree.ts`.

- [ ] **Step 3: Write the helpers**

Create `web/lib/file-tree.ts`:

```ts
/**
 * Pure path helpers for the workbench explorer. Paths are root-relative with
 * `/` separators; '' is the project root.
 */

/** The explorer row the user last clicked. */
export interface Selection {
  readonly path: string
  readonly kind: 'file' | 'dir'
}

/** `path` is `target` itself or lies inside the folder `target`. */
export const isAtOrUnder = (path: string, target: string): boolean => path === target || path.startsWith(`${target}/`)

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/** Every folder from the top down to `folder` itself; [] for the root. */
export function ancestorsOf(folder: string): string[] {
  if (folder === '') return []
  const segments = folder.split('/')
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

/** Where "New file" and "New folder" land: a selected folder, a selected file's folder, else the root. */
export function targetFolder(selected: Selection | null): string {
  if (selected === null) return ''
  return selected.kind === 'dir' ? selected.path : parentOf(selected.path)
}

/** The record without keys at or under `path`; the same object when none matched. */
export function dropKeysUnder<T>(record: Readonly<Record<string, T>>, path: string): Readonly<Record<string, T>> {
  const kept = Object.entries(record).filter(([key]) => !isAtOrUnder(key, path))
  return kept.length === Object.keys(record).length ? record : Object.fromEntries(kept)
}

/** The set without members at or under `path`; the same set when none matched. */
export function dropUnderSet(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const kept = [...set].filter((member) => !isAtOrUnder(member, path))
  return kept.length === set.size ? set : new Set(kept)
}

/**
 * The message to show for a failed explorer write. An `HttpError` carries
 * the server's `{"error": "…"}` body; it is read structurally so callers that
 * mock `api.ts` still work.
 */
export function writeErrorText(error: unknown): string {
  const body = typeof error === 'object' && error !== null ? (error as { body?: unknown }).body : undefined
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
        return (parsed as { error: string }).error
      }
    } catch {
      // Not JSON: show the body as it came.
    }
    if (body !== '') return body
  }
  return error instanceof Error ? error.message : String(error)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run web/lib/file-tree.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the API calls**

In `web/lib/api.ts`, directly after the `readProjectFile` function, add:

```ts
/** Explorer writes; the server never overwrites (409) and refuses the root and `.git` (400). */
export function createProjectEntry(workspaceId: string, projectId: string, path: string, kind: 'file' | 'dir'): Promise<ProjectEntry> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, kind }),
  }).then((r) => json<ProjectEntry>(r))
}

/** Rename in the same folder; resolves with the entry's new root-relative path. */
export function renameProjectEntry(workspaceId: string, projectId: string, path: string, name: string): Promise<{ path: string; kind: 'file' | 'dir' }> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/files`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
  }).then((r) => json<{ path: string; kind: 'file' | 'dir' }>(r))
}

/** Permanent delete; a folder goes with everything inside it. */
export function deleteProjectEntry(workspaceId: string, projectId: string, path: string): Promise<{ deleted: true; path: string }> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    .then((r) => json<{ deleted: true; path: string }>(r))
}
```

`web/lib/api.ts` has uncommitted edits in the main checkout from other work; this worktree is clean, so edit only the lines above.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: no errors.

```bash
git add web/lib/api.ts web/lib/file-tree.ts web/lib/file-tree.spec.ts
git commit -m "feat(web): explorer write API calls and path helpers"
```

---

### Task 4: Open-tab rename and remove

**Files:**
- Modify: `web/hooks/useWorkbenchFiles.ts`
- Test: `web/hooks/useWorkbenchFiles.spec.ts` (new)

**Interfaces:**
- Consumes (Task 3): `isAtOrUnder` from `web/lib/file-tree.ts`.
- Produces (used by Task 6):
  - `renameFileTabs(state: FilesState, from: string, to: string): FilesState`
  - `removeFileTabs(state: FilesState, path: string): FilesState`
  - `WorkbenchFiles.renamePath(from: string, to: string): void` and `WorkbenchFiles.removePath(path: string): void`

- [ ] **Step 1: Write the failing tab-state tests**

Create `web/hooks/useWorkbenchFiles.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { removeFileTabs, renameFileTabs } from './useWorkbenchFiles.ts'

const state = {
  folder: 'src',
  openFiles: ['README.md', 'src/a.ts', 'src/deep/b.ts', 'srcx/c.ts'],
  activeFile: 'src/deep/b.ts',
  focus: { line: 4, seq: 2 },
}

describe('renameFileTabs', () => {
  it('rewrites a renamed file tab and keeps its focus', () => {
    expect(renameFileTabs(state, 'src/deep/b.ts', 'src/deep/z.ts')).toEqual({
      ...state,
      openFiles: ['README.md', 'src/a.ts', 'src/deep/z.ts', 'srcx/c.ts'],
      activeFile: 'src/deep/z.ts',
    })
  })

  it('rewrites every tab under a renamed folder and the shown folder, not a sibling prefix', () => {
    expect(renameFileTabs(state, 'src', 'lib')).toEqual({
      ...state,
      folder: 'lib',
      openFiles: ['README.md', 'lib/a.ts', 'lib/deep/b.ts', 'srcx/c.ts'],
      activeFile: 'lib/deep/b.ts',
    })
  })

  it('returns the same state when nothing matches', () => {
    expect(renameFileTabs(state, 'docs', 'notes')).toBe(state)
  })
})

describe('removeFileTabs', () => {
  it('closes a deleted file tab and reveals its right neighbour', () => {
    expect(removeFileTabs({ ...state, activeFile: 'src/a.ts' }, 'src/a.ts')).toEqual({
      folder: 'src',
      openFiles: ['README.md', 'src/deep/b.ts', 'srcx/c.ts'],
      activeFile: 'src/deep/b.ts',
      focus: null,
    })
  })

  it('closes every tab under a deleted folder and resets the shown folder', () => {
    expect(removeFileTabs(state, 'src')).toEqual({
      folder: '',
      openFiles: ['README.md', 'srcx/c.ts'],
      activeFile: 'srcx/c.ts',
      focus: null,
    })
  })

  it('keeps the front tab and its focus when the deleted path is elsewhere', () => {
    const next = removeFileTabs(state, 'README.md')
    expect(next.openFiles).toEqual(['src/a.ts', 'src/deep/b.ts', 'srcx/c.ts'])
    expect(next.activeFile).toBe('src/deep/b.ts')
    expect(next.focus).toEqual({ line: 4, seq: 2 })
  })

  it('shows the fixed view when the last tab goes', () => {
    expect(removeFileTabs({ folder: '', openFiles: ['a.ts'], activeFile: 'a.ts', focus: null }, 'a.ts'))
      .toEqual({ folder: '', openFiles: [], activeFile: null, focus: null })
  })

  it('returns the same state when nothing matches', () => {
    expect(removeFileTabs(state, 'docs')).toBe(state)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run web/hooks/useWorkbenchFiles.spec.ts`
Expected: FAIL — `removeFileTabs` / `renameFileTabs` are not exported.

- [ ] **Step 3: Implement the tab-state functions**

In `web/hooks/useWorkbenchFiles.ts`:

1. Change `interface FilesState {` to `export interface FilesState {`.
2. Add `renamePath` and `removePath` to `WorkbenchFiles`:

```ts
export interface WorkbenchFiles extends FilesState {
  readonly setFolder: (folder: string) => void
  readonly openFile: (path: string, focus?: FileFocus) => void
  readonly closeFile: (path: string) => void
  readonly showFixedView: () => void
  /** A file or folder was renamed in the explorer: rewrite its open tabs. */
  readonly renamePath: (from: string, to: string) => void
  /** A file or folder was deleted in the explorer: close its open tabs. */
  readonly removePath: (path: string) => void
}
```

3. Add `import { isAtOrUnder } from '../lib/file-tree.ts'` to the imports, and add these functions after `closeFileTab`:

```ts
const moved = (path: string, from: string, to: string): string => isAtOrUnder(path, from) ? `${to}${path.slice(from.length)}` : path

/** Rewrites every tab, the front tab and the shown folder at or under `from`. */
export function renameFileTabs(state: FilesState, from: string, to: string): FilesState {
  const touched = state.openFiles.some((file) => isAtOrUnder(file, from)) || isAtOrUnder(state.folder, from)
  if (!touched) return state
  return {
    ...state,
    folder: moved(state.folder, from, to),
    openFiles: state.openFiles.map((file) => moved(file, from, to)),
    activeFile: state.activeFile === null ? null : moved(state.activeFile, from, to),
  }
}

/** Closes every tab at or under `path`, revealing a neighbour like {@link closeFileTab}. */
export function removeFileTabs(state: FilesState, path: string): FilesState {
  const doomed = state.openFiles.filter((file) => isAtOrUnder(file, path))
  const folderGone = state.folder !== '' && isAtOrUnder(state.folder, path)
  if (doomed.length === 0 && !folderGone) return state
  let next: FilesState = folderGone ? { ...state, folder: '' } : state
  const frontGone = next.activeFile !== null && isAtOrUnder(next.activeFile, path)
  if (!frontGone) {
    return { ...next, openFiles: next.openFiles.filter((file) => !isAtOrUnder(file, path)) }
  }
  // Close the front tab last so the neighbour it reveals is a survivor.
  for (const file of doomed) if (file !== next.activeFile) next = { ...next, openFiles: next.openFiles.filter((open) => open !== file) }
  return closeFileTab(next, next.activeFile as string)
}
```

4. In `useWorkbenchFiles`, add the callbacks and return them:

```ts
  const renamePath = useCallback((from: string, to: string) => setState((current) => renameFileTabs(current, from, to)), [])
  const removePath = useCallback((path: string) => setState((current) => removeFileTabs(current, path)), [])

  return { ...state, setFolder, openFile, closeFile, showFixedView, renamePath, removePath }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run web/hooks/useWorkbenchFiles.spec.ts web/lib/product-ui.spec.tsx`
Expected: PASS (the second file covers the existing `closeFileTab` behavior).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: no errors.

```bash
git add web/hooks/useWorkbenchFiles.ts web/hooks/useWorkbenchFiles.spec.ts
git commit -m "feat(web): rewrite or close open tabs after an explorer rename or delete"
```

---

### Task 5: Inline name input

**Files:**
- Create: `web/components/workbench/FileNameInput.tsx`
- Test: `web/components/workbench/file-name-input.spec.tsx` (new)

**Interfaces:**
- Consumes: `TextInput` from `web/components/ui/TextInput.tsx`.
- Produces (used by Task 6):
  `FileNameInput({ initial, label, selectStem, onSubmit, onCancel }: { initial: string; label: string; selectStem: boolean; onSubmit: (name: string) => Promise<string | null>; onCancel: () => void })`.
  `onSubmit` resolves `null` on success (the parent then unmounts the input) or an error message to show under the input, keeping it open.

- [ ] **Step 1: Write the failing tests**

Create `web/components/workbench/file-name-input.spec.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileNameInput } from './FileNameInput.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

async function mount(props: Partial<Parameters<typeof FileNameInput>[0]> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn(async () => null)
  const onCancel = props.onCancel ?? vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <FileNameInput initial={props.initial ?? ''} label={props.label ?? 'File name'} selectStem={props.selectStem ?? false} onSubmit={onSubmit} onCancel={onCancel} />,
  ))
  const input = host.querySelector('input')!
  return { input, onSubmit, onCancel }
}

const type = async (input: HTMLInputElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = async (input: HTMLInputElement, name: string) => act(async () => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
})

it('focuses and selects the stem of a file name', async () => {
  const { input } = await mount({ initial: 'notes.test.md', selectStem: true })
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'notes.test'.length])
  expect(input.getAttribute('aria-label')).toBe('File name')
})

it('selects the whole name when there is no stem to keep', async () => {
  const { input } = await mount({ initial: '.env', selectStem: true })
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4])
})

it('submits the typed name on Enter', async () => {
  const { input, onSubmit } = await mount()
  await type(input, 'a.ts')
  await key(input, 'Enter')
  expect(onSubmit).toHaveBeenCalledWith('a.ts')
})

it('sends one request when Enter is pressed twice while pending', async () => {
  let release: (value: string | null) => void = () => {}
  const onSubmit = vi.fn(() => new Promise<string | null>((resolve) => { release = resolve }))
  const { input } = await mount({ onSubmit })
  await type(input, 'a.ts')
  await key(input, 'Enter')
  await key(input, 'Enter')
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(input.disabled).toBe(true)
  await act(async () => release(null))
})

it('shows a server error and stays open for another try', async () => {
  const onSubmit = vi.fn(async () => "'a.ts' already exists")
  const { input } = await mount({ onSubmit })
  await type(input, 'a.ts')
  await key(input, 'Enter')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("'a.ts' already exists")
  expect(input.disabled).toBe(false)
  expect(input.getAttribute('aria-invalid')).toBe('true')
})

it('cancels on Escape, on blur and on an empty Enter', async () => {
  const first = await mount({ initial: 'x' })
  await key(first.input, 'Escape')
  expect(first.onCancel).toHaveBeenCalledTimes(1)
  // React's onBlur listens for the bubbling `focusout`.
  await act(async () => first.input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(first.onCancel).toHaveBeenCalledTimes(2)
  await type(first.input, '   ')
  await key(first.input, 'Enter')
  expect(first.onSubmit).not.toHaveBeenCalled()
  expect(first.onCancel).toHaveBeenCalledTimes(3)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run web/components/workbench/file-name-input.spec.tsx`
Expected: FAIL — cannot resolve `./FileNameInput.tsx`.

- [ ] **Step 3: Write the component**

Create `web/components/workbench/FileNameInput.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { TextInput } from '../ui/TextInput.tsx'

/**
 * Inline name editor for an explorer row. Enter submits, Escape and blur
 * cancel without submitting, so a stray click never creates or renames
 * anything. `onSubmit` resolves null on success or the error to show.
 */
export function FileNameInput({ initial, label, selectStem, onSubmit, onCancel }: {
  readonly initial: string
  readonly label: string
  /** Select the name without its extension (rename of a file). */
  readonly selectStem: boolean
  readonly onSubmit: (name: string) => Promise<string | null>
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = ref.current
    if (input === null) return
    input.focus()
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length)
  }, [initial, selectStem])

  const submit = async (): Promise<void> => {
    if (pending.current) return
    if (value.trim() === '') { onCancel(); return }
    pending.current = true
    setBusy(true)
    setError(null)
    const problem = await onSubmit(value)
    pending.current = false
    if (problem === null) return
    setBusy(false)
    setError(problem)
    ref.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') { event.preventDefault(); void submit() }
    else if (event.key === 'Escape') { event.preventDefault(); onCancel() }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
      <TextInput
        ref={ref}
        className="h-7 px-2 text-[13px]"
        aria-label={label}
        value={value}
        disabled={busy}
        invalid={error !== null}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { if (!pending.current) onCancel() }}
      />
      {error !== null ? <p role="alert" className="m-0 text-xs text-bad">{error}</p> : null}
    </div>
  )
}
```

The `busy` state stays true after a successful submit on purpose: the parent unmounts the input right after, and re-enabling it would flash.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run web/components/workbench/file-name-input.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: no errors.

```bash
git add web/components/workbench/FileNameInput.tsx web/components/workbench/file-name-input.spec.tsx
git commit -m "feat(web): inline name input for explorer create and rename"
```

---

### Task 6: Explorer actions in the tree

**Files:**
- Modify: `web/components/workbench/FileBrowser.tsx`
- Modify: `web/components/workbench/FilesWorkspace.tsx` (line 86, the `<FileBrowser … />` element)
- Test: `web/components/workbench/file-browser.spec.tsx` (new)

**Interfaces:**
- Consumes: Task 3 (`createProjectEntry`, `renameProjectEntry`, `deleteProjectEntry`, every helper in `web/lib/file-tree.ts`), Task 4 (`WorkbenchFiles.renamePath`, `WorkbenchFiles.removePath`), Task 5 (`FileNameInput`); existing `Menu`, `menuItemClass` (`web/components/ui/Menu.tsx`), `ConfirmDialog` (default export, `web/components/common/ConfirmDialog.tsx`), `IconButton`, `Icon` (names `plus`, `folder`, `dots`, `pencil`, `trash`, `refresh`).
- Produces (used by Task 7): new `FileBrowser` props `onRenamed: (from: string, to: string) => void` and `onRemoved: (path: string) => void`; a header element with the slot where Task 7 places the search box.

**Behavior this task must deliver** (from the spec, sections 5 and the Global Constraints):

1. Header: project name, then `IconButton`s labelled exactly **New file**, **New folder**, **Refresh files** (the existing one).
2. Clicking any row sets `selected: Selection` (`{ path, kind }`); a folder row still toggles open, a file row still opens. "New" lands in `targetFolder(selected)`.
3. "New file"/"New folder": expand every folder in `ancestorsOf(target)` (load any not cached), then render a draft row as the **first** child of that folder (or first in the root list) holding a `FileNameInput` labelled `New file name` / `New folder name`, indented to the child depth, with the matching `FileTypeIcon`. On submit call `createProjectEntry(ws, project.id, joinPath(target, name), kind)`. Success: clear the draft, `await load(target)`, set `selected` to the new entry, and for a file call `onOpenFile(newPath)`. Failure: return `writeErrorText(error)`.
4. Each row is wrapped in `<div className="group/row relative">`. The row button gets `pr-8` so text never runs under the menu trigger. A `Menu` with `label={`Actions for ${entry.name}`}`, `align="end"`, trigger `<Icon name="dots" size={14} />`, sits absolutely on the right with this class:
   `absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-faint hover:text-fg opacity-0 invisible transition-opacity group-hover/row:visible group-hover/row:opacity-100 group-focus-within/row:visible group-focus-within/row:opacity-100 focus-visible:visible focus-visible:opacity-100 [@media(pointer:coarse)]:visible [@media(pointer:coarse)]:opacity-100`.
   Its items are `<button role="menuitem" className={menuItemClass}>` **Rename** (`pencil`) and **Delete** (`trash`, `text-bad`), each calling `close()` first.
5. Rename: the row is replaced by a `FileNameInput` labelled `New name for ${entry.name}`, `initial=entry.name`, `selectStem={entry.kind === 'file'}`. On submit call `renameProjectEntry(ws, project.id, entry.path, name)`. Success: drop cached nodes and open state at or under the old path (`dropKeysUnder`, `dropUnderSet`); if the old folder was open, add the new path to the open set; `await load(parentOf(entry.path))`; if the folder was open, `await load(newPath)`; update `selected` to the new path if it pointed at the old one; call `onRenamed(entry.path, newPath)`.
6. Delete: open `ConfirmDialog` with `title={`Delete ${entry.name}?`}`, `confirmLabel="Delete"`, `tone="danger"` and body `This file will be deleted permanently.` or `This folder and everything inside it will be deleted permanently.` While the request runs pass `busy`. Success: close the dialog, drop cached nodes/open state at or under the path, clear `selected` if it was at or under the path, `await load(parentOf(path))`, call `onRemoved(path)`. Failure: keep the dialog open and show `<ErrorNotice raw={writeErrorText(error)} />` inside its body.
7. Only one draft or rename editor exists at a time; starting another replaces it.
8. `FilesWorkspace` passes `onRenamed={files.renamePath}` and `onRemoved={files.removePath}`.

Keep `FileBrowser.tsx` readable: move the row (button + menu + rename editor) into a `FileRow` component and the draft row into a `DraftRow` component in the same file, or a sibling file `FileTreeRows.tsx` if `FileBrowser.tsx` would exceed about 300 lines. Thread state through one `actions` object prop rather than many separate callback props.

- [ ] **Step 1: Write the failing tests**

Create `web/components/workbench/file-browser.spec.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileBrowser } from './FileBrowser.tsx'
import type { ProjectListing } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** In-memory project the mocked API reads and writes. */
let tree: Record<string, { name: string; path: string; kind: 'dir' | 'file' }[]>

const listProjectFiles = vi.fn(async (_ws: string, _p: string, folder: string): Promise<ProjectListing> => ({ path: folder, entries: [...(tree[folder] ?? [])] }))
const createProjectEntry = vi.fn(async (_ws: string, _p: string, path: string, kind: 'file' | 'dir') => {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const entry = { name: path.slice(slash + 1), path, kind }
  tree[folder] = [...(tree[folder] ?? []), entry]
  if (kind === 'dir') tree[path] = []
  return entry
})
const renameProjectEntry = vi.fn(async (_ws: string, _p: string, path: string, name: string) => {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const next = folder === '' ? name : `${folder}/${name}`
  const kind = tree[folder]!.find((entry) => entry.path === path)!.kind
  tree[folder] = tree[folder]!.map((entry) => entry.path === path ? { name, path: next, kind } : entry)
  if (tree[path] !== undefined) {
    tree[next] = tree[path]!.map((entry) => ({ ...entry, path: `${next}/${entry.name}` }))
    delete tree[path]
  }
  return { path: next, kind }
})
const deleteProjectEntry = vi.fn(async (_ws: string, _p: string, path: string) => {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  tree[folder] = tree[folder]!.filter((entry) => entry.path !== path)
  delete tree[path]
  return { deleted: true as const, path }
})
const searchProjectFiles = vi.fn(async () => ({ query: '', matches: [], truncated: false }))

vi.mock('../../lib/api.ts', () => ({
  listProjectFiles: (...args: [string, string, string]) => listProjectFiles(...args),
  createProjectEntry: (...args: [string, string, string, 'file' | 'dir']) => createProjectEntry(...args),
  renameProjectEntry: (...args: [string, string, string, string]) => renameProjectEntry(...args),
  deleteProjectEntry: (...args: [string, string, string]) => deleteProjectEntry(...args),
  searchProjectFiles: (...args: unknown[]) => searchProjectFiles(...(args as [])),
}))

let root: Root | undefined
let host: HTMLDivElement
const onOpenFile = vi.fn()
const onRenamed = vi.fn()
const onRemoved = vi.fn()

beforeEach(() => {
  tree = {
    '': [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'README.md', path: 'README.md', kind: 'file' }],
    src: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }],
  }
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  vi.clearAllMocks()
})

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <FileBrowser workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} activeFile={null} onOpenFile={onOpenFile} onRenamed={onRenamed} onRemoved={onRemoved} />,
  ))
}

const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
/** Rows of the tree only (the root `<ul aria-label="Project files">`), never search results. */
const treeRows = () => [...(host.querySelector('[aria-label="Project files"]')?.querySelectorAll<HTMLButtonElement>('li button[title]') ?? [])]
const row = (name: string) => treeRows().find((button) => button.textContent === name)!
const rowNames = () => treeRows().map((button) => button.textContent)
const click = async (element: HTMLElement) => act(async () => element.click())
const typeInto = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const enter = async (input: HTMLInputElement) => act(async () => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
const menuItem = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((button) => button.textContent?.includes(text))!

it('creates a file inside the selected folder and opens it', async () => {
  await mount()
  await click(row('src'))
  await click(byLabel('New file'))
  const input = byLabel('New file name') as HTMLInputElement
  await typeInto(input, 'util.ts')
  await enter(input)
  expect(createProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'src/util.ts', 'file')
  expect(rowNames()).toContain('util.ts')
  expect(onOpenFile).toHaveBeenCalledWith('src/util.ts')
})

it('creates a folder at the root when nothing is selected', async () => {
  await mount()
  await click(byLabel('New folder'))
  const input = byLabel('New folder name') as HTMLInputElement
  await typeInto(input, 'docs')
  await enter(input)
  expect(createProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'docs', 'dir')
  expect(rowNames()).toContain('docs')
  expect(onOpenFile).not.toHaveBeenCalled()
})

it('keeps the draft open with the server error when the name exists', async () => {
  createProjectEntry.mockRejectedValueOnce(Object.assign(new Error('HTTP 409'), { status: 409, body: '{"error":"\'README.md\' already exists"}' }))
  await mount()
  await click(byLabel('New file'))
  const input = byLabel('New file name') as HTMLInputElement
  await typeInto(input, 'README.md')
  await enter(input)
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("'README.md' already exists")
  expect(byLabel('New file name')).toBeTruthy()
})

it('renames a folder, reloads its parent and reports the move', async () => {
  await mount()
  await click(row('src'))
  expect(rowNames()).toContain('index.ts')
  await click(byLabel('Actions for src'))
  await click(menuItem('Rename'))
  const input = byLabel('New name for src') as HTMLInputElement
  expect(input.value).toBe('src')
  await typeInto(input, 'lib')
  await enter(input)
  expect(renameProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'src', 'lib')
  expect(onRenamed).toHaveBeenCalledWith('src', 'lib')
  expect(rowNames()).toEqual(['lib', 'index.ts', 'README.md'])
  expect(row('index.ts').title).toBe('lib/index.ts')
})

it('deletes after confirmation and reports the removal', async () => {
  await mount()
  await click(byLabel('Actions for README.md'))
  await click(menuItem('Delete'))
  const dialog = document.body.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Delete README.md?')
  expect(dialog.textContent).toContain('This file will be deleted permanently.')
  expect(deleteProjectEntry).not.toHaveBeenCalled()
  await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!)
  expect(deleteProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'README.md')
  expect(onRemoved).toHaveBeenCalledWith('README.md')
  expect(rowNames()).toEqual(['src'])
})

it('warns that a folder delete takes its contents', async () => {
  await mount()
  await click(byLabel('Actions for src'))
  await click(menuItem('Delete'))
  expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain('This folder and everything inside it will be deleted permanently.')
})

it('cancelling the delete dialog deletes nothing', async () => {
  await mount()
  await click(byLabel('Actions for README.md'))
  await click(menuItem('Delete'))
  const dialog = document.body.querySelector('[role="dialog"]')!
  await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!)
  expect(deleteProjectEntry).not.toHaveBeenCalled()
  expect(rowNames()).toContain('README.md')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run web/components/workbench/file-browser.spec.tsx`
Expected: FAIL — no element labelled `New file`.

- [ ] **Step 3: Implement the behavior list above**

Edit `FileBrowser.tsx` and `FilesWorkspace.tsx` to deliver items 1–8. If Radix `Menu` or `Modal` fails in jsdom for a missing `ResizeObserver` or `matchMedia`, stub them at the top of the spec the way `web/components/workbench/terminal.mounted.spec.tsx` and `web/lib/product-ui.spec.tsx` do; do not change the shared components. Reuse the existing `load`, `nodes`, `open`, `generation` and `FolderRows` structure; do not change how folders lazy-load. Keep the existing `title={entry.path}` on the row button (tests and the existing `product-ui.spec.tsx` rely on it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run web/components/workbench/file-browser.spec.tsx web/lib/product-ui.spec.tsx`
Expected: PASS (the second file still browses folders and opens files through the same tree).

- [ ] **Step 5: Typecheck, build and commit**

Run: `pnpm run typecheck && pnpm run build:web`
Expected: no errors; the build completes.

```bash
git add web/components/workbench/FileBrowser.tsx web/components/workbench/FilesWorkspace.tsx web/components/workbench/file-browser.spec.tsx
git commit -m "feat(web): create, rename and delete from the file explorer"
```

If you split rows into `FileTreeRows.tsx`, add it to the same commit.

---

### Task 7: Explorer name search

**Files:**
- Create: `web/components/workbench/FileSearchResults.tsx`
- Modify: `web/components/workbench/FileBrowser.tsx` (header search box and result mode)
- Test: `web/components/workbench/file-browser.spec.tsx` (append)

**Interfaces:**
- Consumes: `searchProjectFiles(workspaceId, projectId, query, limit)` and `ProjectSearchResult` / `ProjectMatch` from `web/lib/api.ts` (already exist); `parentOf` from `web/lib/file-tree.ts`; `TextInput`, `Icon` (`search`, `close`), `FileTypeIcon`, `Spinner`, `ErrorNotice`.
- Produces: nothing used later.

**Behavior this task must deliver:**

1. Under the header row, a `TextInput` with `aria-label="Search files"`, `placeholder="Search files"`, leading `<Icon name="search" size={13} />`, and, when non-empty, a trailing `IconButton` labelled `Clear search` (`close` icon).
2. Typing debounces 200 ms (`SEARCH_DEBOUNCE_MS = 200`, a named constant), then calls `searchProjectFiles(workspaceId, project.id, query.trim(), 50)`. Every call increments a request generation in a ref; a response whose generation is not the latest is discarded. A blank query (after trim) never calls the API.
3. While the trimmed query is non-empty, the tree area renders `FileSearchResults` instead of the tree. The tree component stays mounted but hidden (`hidden` class) so its expanded folders and cache survive; do not unmount it.
4. `FileSearchResults` props: `{ status: 'loading' | 'ready' | 'error'; result: ProjectSearchResult | null; error: string | null; activeFile: string | null; onOpen: (path: string) => void }`. It renders:
   - `loading` with no result yet: `<Spinner />` and `Searching…` (`role="status"`);
   - `error`: `<ErrorNotice raw={error} />`;
   - zero matches: `No matching files`;
   - otherwise a `<ul aria-label="Search results">` where each item is a button with `title={match.path}`, a `FileTypeIcon`, the file name, and the parent folder (`parentOf(match.path)`, omitted for the root) in `text-fg-faint`; the active file gets `bg-hover`;
   - when `result.truncated`: a footer `Results may be incomplete.`
5. Clicking a result calls `onOpenFile(match.path)`; the query stays so the user can open another.
6. Escape in the search box, or **Clear search**, empties the query and returns to the tree.

- [ ] **Step 1: Write the failing tests**

Append to `web/components/workbench/file-browser.spec.tsx`:

```tsx
describe('explorer search', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  const search = () => byLabel('Search files') as HTMLInputElement
  const settle = async (ms = 250) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  it('debounces, lists matches with their folder, and opens a result', async () => {
    searchProjectFiles.mockResolvedValueOnce({ query: 'ind', truncated: false, matches: [{ name: 'index.ts', path: 'src/index.ts', score: 3 }] } as never)
    await mount()
    await typeInto(search(), 'ind')
    expect(searchProjectFiles).not.toHaveBeenCalled()
    await settle()
    expect(searchProjectFiles).toHaveBeenCalledWith('ws1', 'p1', 'ind', 50)
    const results = host.querySelector('[aria-label="Search results"]')!
    expect(results.textContent).toContain('index.ts')
    expect(results.textContent).toContain('src')
    await click(results.querySelector<HTMLButtonElement>('button[title="src/index.ts"]')!)
    expect(onOpenFile).toHaveBeenCalledWith('src/index.ts')
  })

  it('says when nothing matches and when results may be incomplete', async () => {
    searchProjectFiles.mockResolvedValueOnce({ query: 'zzz', truncated: true, matches: [] } as never)
    await mount()
    await typeInto(search(), 'zzz')
    await settle()
    expect(host.textContent).toContain('No matching files')
    expect(host.textContent).toContain('Results may be incomplete.')
  })

  it('ignores a slow response for an older query', async () => {
    let releaseOld: (value: unknown) => void = () => {}
    searchProjectFiles
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }) as never)
      .mockResolvedValueOnce({ query: 'new', truncated: false, matches: [{ name: 'new.ts', path: 'new.ts', score: 3 }] } as never)
    await mount()
    await typeInto(search(), 'old')
    await settle()
    await typeInto(search(), 'new')
    await settle()
    await act(async () => releaseOld({ query: 'old', truncated: false, matches: [{ name: 'old.ts', path: 'old.ts', score: 3 }] }))
    const results = host.querySelector('[aria-label="Search results"]')!
    expect(results.textContent).toContain('new.ts')
    expect(results.textContent).not.toContain('old.ts')
  })

  it('returns to the tree with its folders still open on Escape', async () => {
    await mount()
    await click(row('src'))
    expect(rowNames()).toContain('index.ts')
    await typeInto(search(), 'x')
    await settle()
    await act(async () => search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(search().value).toBe('')
    expect(host.querySelector('[aria-label="Search results"]')).toBeNull()
    expect(rowNames()).toContain('index.ts')
  })

  it('never searches a blank query', async () => {
    await mount()
    await typeInto(search(), '   ')
    await settle()
    expect(searchProjectFiles).not.toHaveBeenCalled()
  })
})
```

Also add `describe` to the `vitest` import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run web/components/workbench/file-browser.spec.tsx`
Expected: the new `explorer search` tests FAIL (no element labelled `Search files`); the Task 6 tests still pass.

- [ ] **Step 3: Implement the behavior list above**

Create `FileSearchResults.tsx` per item 4 and wire items 1–3, 5 and 6 into `FileBrowser.tsx`. Clear the pending debounce timer on unmount and whenever the query changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run web/components/workbench/file-browser.spec.tsx web/lib/product-ui.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `pnpm test && pnpm run typecheck && pnpm run build:web`
Expected: all pass. If `pnpm test` shows failures, re-run only those files on `b4cbc3a` (`git stash; pnpm exec vitest run <file>; git stash pop`) and report any that also fail there as pre-existing rather than fixing them.

```bash
git add web/components/workbench/FileSearchResults.tsx web/components/workbench/FileBrowser.tsx web/components/workbench/file-browser.spec.tsx
git commit -m "feat(web): file-name search in the explorer"
```

---
