# Workbench File Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user edit and save project text files from the workbench file viewer, refusing a save when the file changed on disk.

**Architecture:** Reads gain `editable` and a content `hash`. A new `saveProjectFile` in `src/web/project-files-write.ts`, reached through `PUT …/projects/:pid/file`, checks the hash under the same per-file lock the agent tools use and writes atomically with the agent tools' encoding helpers. On the web side, drafts live in `useWorkbenchFiles` so they survive tab switches; a new `FileEditor` component holds the textarea, toolbar and conflict banner; `FileViewer` switches between view and edit.

**Tech Stack:** TypeScript, Node `fs/promises`, React 19, Vitest (+ jsdom), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-13-workbench-file-editing-design.md` (commit `fce7d22` on `feat/file-editing`).

**Workspace:** worktree `/Users/dungnt/workspace/dnt-harness/.worktrees/file-editing`, branch `feat/file-editing`, base `0e58609`. All paths are relative to it. Never edit the main checkout.

## Global Constraints

- pnpm; no new dependency.
- Only project-file tabs are editable. Memory tabs (`memoryTabOf(path) !== null`) and skill tabs (`skillTabName(path) !== null`) stay read-only.
- `editable` is true only for files that are fully read (≤ `MAX_FILE_BYTES` = 1 MiB), not binary, valid UTF-8 (with or without BOM).
- A save never overwrites a file whose current sha256 differs from `expectedHash`: answer 409 with `currentHash`.
- The file keeps its encoding, BOM and dominant line ending (`encodeForWrite`). Writes are atomic (`replaceFile`) and serialised with the agent tools (`withFileLock` on `canonical(path)`).
- Path rules equal the explorer's (`target()` in `project-files-write.ts`): no root, no `.`/`..`, no `.git` in any case, parent contained, protected storage refused. A link out of the project is refused.
- Saves are a direct user action independent of any session mode; archived workspaces refuse them.
- Error statuses: 400 invalid/refused, 404 missing, 409 stale hash, 413 too large.
- UI copy English. Confirm with `window.confirm` (existing pattern). Cmd/Ctrl+S saves, Escape cancels.
- Commit messages: conventional commits.
- Gates per task: the task's own specs + `pnpm run typecheck`. Final: `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`.

## Review Focus

1. A save after the agent changed the file answers 409 and the agent's bytes survive (Task 2 test).
2. A CRLF or BOM file saved from the viewer keeps CRLF/BOM; the BOM character the read path puts in `content` is not doubled (Task 2 test).
3. A draft survives switching to another tab and back (Task 5 test).
4. Closing a tab with unsaved changes asks first; cancelling keeps the tab and the draft (Task 4 test).
5. Overwrite after a conflict saves against the server's `currentHash`, not the stale one (Task 6 test).

## File Map

| File | Task | Responsibility |
|---|---|---|
| `src/web/project-files.ts` | 1 | `editable`, `hash` on reads |
| `tests/web/project-files-read.spec.ts` (new) | 1 | read flag tests |
| `src/web/project-files-write.ts` | 2 | `saveProjectFile`, `ProjectWriteError` 413 + `currentHash` |
| `tests/web/project-files-save.spec.ts` (new) | 2 | save unit tests |
| `src/web/server.ts` | 3 | `PUT …/file`, `readJson(req, limit)` |
| `tests/web/server-project-files.spec.ts` | 3 | HTTP tests |
| `docs/web.md` | 3 | route row + Files description |
| `web/lib/api.ts` | 4 | `ProjectFileView.editable/hash`, `saveProjectFile`, `SaveConflictError` |
| `web/hooks/useWorkbenchFiles.ts` | 4 | drafts, close confirm, beforeunload |
| `web/hooks/useWorkbenchFiles.spec.ts` | 4 | draft tests |
| `web/components/workbench/FileEditor.tsx` (new) | 5 | textarea, toolbar, keys |
| `web/components/workbench/file-editor.spec.tsx` (new) | 5 | editor tests |
| `web/components/workbench/FileViewer.tsx` | 6 | Edit button, save flow, conflict banner |
| `web/components/workbench/FilesWorkspace.tsx`, `Workbench.tsx` | 6 | pass draft props; dirty dot on tabs |
| `web/components/workbench/file-viewer-edit.spec.tsx` (new) | 6 | viewer edit tests |

---

### Task 1: `editable` and `hash` on project file reads

**Files:**
- Modify: `src/web/project-files.ts` (`ProjectFile`, `readProjectFile`)
- Test: `tests/web/project-files-read.spec.ts` (new)

**Interfaces:**
- Consumes: `decodeDocument`, `hashBytes`, `BinaryFileError` from `src/capabilities/fs/text-document.ts`.
- Produces (Tasks 2, 4): `ProjectFile.editable: boolean`, `ProjectFile.hash?: string` (sha256 hex of the full stored bytes, present iff `!truncated`).

- [ ] **Step 1: Write the failing tests**

Create `tests/web/project-files-read.spec.ts`:

```ts
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES, readProjectFile } from '../../src/web/project-files.ts'

let root = ''
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-read-flags-'))
  await fs.writeFile(path.join(root, 'plain.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'crlf.txt'), 'a\r\nb\r\n')
  await fs.writeFile(path.join(root, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# t\n')]))
  await fs.writeFile(path.join(root, 'empty.txt'), '')
  await fs.writeFile(path.join(root, 'nul.bin'), Buffer.from([0x41, 0x00, 0x42]))
  await fs.writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]))
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1))
})

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('readProjectFile edit flags', () => {
  it('marks plain, CRLF, BOM and empty UTF-8 files editable with the hash of their bytes', async () => {
    for (const name of ['plain.ts', 'crlf.txt', 'bom.md', 'empty.txt']) {
      const file = await readProjectFile(root, name)
      expect(file.editable, name).toBe(true)
      expect(file.hash, name).toBe(sha(await fs.readFile(path.join(root, name))))
    }
  })

  it('keeps content exactly as before (CRLF and BOM character included)', async () => {
    expect((await readProjectFile(root, 'crlf.txt')).content).toBe('a\r\nb\r\n')
    expect((await readProjectFile(root, 'bom.md')).content).toBe('\uFEFF# t\n')
  })

  it('marks binary, invalid UTF-8 and UTF-16 files not editable', async () => {
    for (const name of ['nul.bin', 'latin1.txt', 'utf16.txt']) {
      expect((await readProjectFile(root, name)).editable, name).toBe(false)
    }
  })

  it('gives a truncated file no hash and no edit', async () => {
    const big = await readProjectFile(root, 'big.txt')
    expect(big.truncated).toBe(true)
    expect(big.editable).toBe(false)
    expect(big.hash).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/web/project-files-read.spec.ts`
Expected: FAIL — `editable` is `undefined`.

- [ ] **Step 3: Implement**

In `src/web/project-files.ts`:

1. Add `import { BinaryFileError, decodeDocument, hashBytes } from '../capabilities/fs/text-document.ts'`.
2. Extend `ProjectFile`:

```ts
  /** True when the viewer may edit and save this file: whole, text, valid UTF-8. */
  readonly editable: boolean
  /** sha256 of the stored bytes; present only when the whole file was read. */
  readonly hash?: string
```

3. Add this helper above `readProjectFile`:

```ts
/** Whether whole-file bytes can round-trip through the viewer's editor. */
function editableBytes(bytes: Buffer): boolean {
  try {
    const doc = decodeDocument(bytes, 'file')
    return doc.writable && doc.encoding === 'utf8'
  } catch (error) {
    if (error instanceof BinaryFileError) return false
    throw error
  }
}
```

4. In `readProjectFile`, replace the `return { … }` with:

```ts
    const truncated = stat.size > MAX_FILE_BYTES
    const whole = !truncated && bytesRead === stat.size
    return {
      path: rel,
      size: stat.size,
      binary,
      truncated,
      content: binary ? '' : body.toString('utf8'),
      editable: whole && !binary && editableBytes(body),
      ...(whole ? { hash: hashBytes(body) } : {}),
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/web/project-files-read.spec.ts tests/web/server-project-files.spec.ts`
Expected: PASS (the second file proves existing reads are unchanged).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck`

```bash
git add src/web/project-files.ts tests/web/project-files-read.spec.ts
git commit -m "feat(web): report editable and content hash on project file reads"
```

---

### Task 2: `saveProjectFile`

**Files:**
- Modify: `src/web/project-files-write.ts`
- Test: `tests/web/project-files-save.spec.ts` (new)

**Interfaces:**
- Consumes: `target()` (private, same file), `resolveGrantedPath`, `within` (`grants.ts`), `canonical`, `withFileLock`, `replaceFile` (`src/capabilities/fs/observation.ts`), `decodeDocument`, `encodeForWrite`, `hashBytes`, `BinaryFileError` (`text-document.ts`), `MAX_FILE_BYTES` (`project-files.ts`).
- Produces (Task 3):
  - `ProjectWriteError` now `constructor(readonly status: 400 | 404 | 409 | 413, message: string, readonly currentHash?: string)`
  - `saveProjectFile(root: string, rawPath: string, content: string, expectedHash: string, deniedRoots?: readonly string[]): Promise<{ path: string; size: number; hash: string }>`

- [ ] **Step 1: Write the failing tests**

Create `tests/web/project-files-save.spec.ts`:

```ts
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectWriteError, saveProjectFile } from '../../src/web/project-files-write.ts'
import { MAX_FILE_BYTES } from '../../src/web/project-files.ts'

let root = ''
let outside = ''
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (rel: string): Promise<Buffer> => fs.readFile(path.join(root, rel))
const hashOf = async (rel: string): Promise<string> => sha(await bytesOf(rel))

async function failure(promise: Promise<unknown>): Promise<ProjectWriteError> {
  try { await promise } catch (error) { if (error instanceof ProjectWriteError) return error; throw error }
  throw new Error('expected a ProjectWriteError')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-save-root-'))
  outside = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-save-out-'))
  await fs.mkdir(path.join(root, 'src'))
  await fs.mkdir(path.join(root, '.git'))
  await fs.writeFile(path.join(root, '.git', 'config'), '[core]\n')
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\n')
  await fs.writeFile(path.join(root, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# t\n')]))
  await fs.writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await fs.writeFile(path.join(root, 'nul.bin'), Buffer.from([0x41, 0x00, 0x42]))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

describe('saveProjectFile', () => {
  it('saves new content and returns the new size and hash', async () => {
    const result = await saveProjectFile(root, 'src/a.ts', 'export const a = 2\n', await hashOf('src/a.ts'))
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(result).toEqual({ path: 'src/a.ts', size: 19, hash: await hashOf('src/a.ts') })
  })

  it('keeps CRLF line endings whatever the editor sent', async () => {
    await saveProjectFile(root, 'crlf.txt', 'one\ntwo\nthree\n', await hashOf('crlf.txt'))
    expect((await bytesOf('crlf.txt')).toString('utf8')).toBe('one\r\ntwo\r\nthree\r\n')
  })

  it('keeps one BOM, whether or not the content carries the BOM character', async () => {
    await saveProjectFile(root, 'bom.md', '\uFEFF# changed\n', await hashOf('bom.md'))
    expect([...(await bytesOf('bom.md')).subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x23])
    await saveProjectFile(root, 'bom.md', '# again\n', await hashOf('bom.md'))
    const bytes = await bytesOf('bom.md')
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe('# again\n')
  })

  it('answers 409 with the current hash when the file changed since it was read, and writes nothing', async () => {
    const stale = await hashOf('src/a.ts')
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'agent edit\n')
    const error = await failure(saveProjectFile(root, 'src/a.ts', 'mine\n', stale))
    expect(error.status).toBe(409)
    expect(error.currentHash).toBe(await hashOf('src/a.ts'))
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('agent edit\n')
  })

  it('answers 404 for a missing file and 400 for a folder', async () => {
    expect((await failure(saveProjectFile(root, 'src/nope.ts', 'x', sha('')))).status).toBe(404)
    expect((await failure(saveProjectFile(root, 'src', 'x', sha('')))).status).toBe(400)
  })

  it('refuses binary and non-UTF-8 files', async () => {
    expect((await failure(saveProjectFile(root, 'nul.bin', 'x', await hashOf('nul.bin')))).status).toBe(400)
    expect((await failure(saveProjectFile(root, 'latin1.txt', 'x', await hashOf('latin1.txt')))).status).toBe(400)
    expect([...(await bytesOf('latin1.txt'))]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a])
  })

  it('answers 413 when the saved file would exceed the viewer limit', async () => {
    const error = await failure(saveProjectFile(root, 'src/a.ts', 'x'.repeat(MAX_FILE_BYTES + 1), await hashOf('src/a.ts')))
    expect(error.status).toBe(413)
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })

  it('refuses the root, traversal, absolute paths and .git in any case', async () => {
    for (const raw of ['', '../x', path.join(outside, 'secret.txt'), '.git/config', '.GIT/config']) {
      expect((await failure(saveProjectFile(root, raw, 'x', sha('')))).status, raw).toBe(400)
    }
    expect(await fs.readFile(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  it('refuses a symlink that leads out of the project', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    const error = await failure(saveProjectFile(root, 'leak.txt', 'pwned\n', sha('outside\n')))
    expect(error.status).toBe(400)
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('saves through an in-project symlink and keeps the link', async () => {
    await fs.symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts'))
    await saveProjectFile(root, 'alias.ts', 'via link\n', await hashOf('src/a.ts'))
    expect((await fs.lstat(path.join(root, 'alias.ts'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('via link\n')
  })

  it('refuses a symlink whose target is inside .git', async () => {
    await fs.symlink(path.join(root, '.git', 'config'), path.join(root, 'gitcfg'))
    const error = await failure(saveProjectFile(root, 'gitcfg', 'x\n', await hashOf('.git/config')))
    expect(error.status).toBe(400)
    expect(await fs.readFile(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  it('refuses protected storage', async () => {
    const denied = [path.join(root, 'src')]
    expect((await failure(saveProjectFile(root, 'src/a.ts', 'x', await hashOf('src/a.ts'), denied))).status).toBe(400)
  })

  it('leaves no temporary file behind', async () => {
    await saveProjectFile(root, 'src/a.ts', 'b\n', await hashOf('src/a.ts'))
    expect((await fs.readdir(path.join(root, 'src'))).sort()).toEqual(['a.ts'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/web/project-files-save.spec.ts`
Expected: FAIL — `saveProjectFile` is not exported.

- [ ] **Step 3: Implement**

In `src/web/project-files-write.ts`:

1. Widen the error:

```ts
export class ProjectWriteError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, message: string, readonly currentHash?: string) {
    super(message)
    this.name = 'ProjectWriteError'
  }
}
```

2. Add imports:

```ts
import { canonical, replaceFile, withFileLock } from '../capabilities/fs/observation.ts'
import { BinaryFileError, decodeDocument, encodeForWrite, hashBytes } from '../capabilities/fs/text-document.ts'
import { MAX_FILE_BYTES } from './project-files.ts'
```

(keep `import type { ProjectEntry } from './project-files.ts'`, merge into one import if you prefer).

3. Add at the end of the file:

```ts
/**
 * Save the viewer's edited text over an existing project file. Refuses when
 * the stored bytes no longer hash to `expectedHash` (409, with the current
 * hash), so a change the agent or another tab made is never overwritten
 * silently. Keeps the file's encoding, BOM and dominant line ending, writes
 * atomically, and serialises with the agent's file tools on the same lock.
 */
export async function saveProjectFile(
  root: string,
  rawPath: string,
  content: string,
  expectedHash: string,
  deniedRoots?: readonly string[],
): Promise<{ path: string; size: number; hash: string }> {
  const t = await target(root, rawPath, deniedRoots)
  let resolved: string
  try {
    resolved = await resolveGrantedPath(root, t.rel, deniedRoots)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  const stat = await fs.stat(resolved).catch(() => null)
  if (stat === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  if (!stat.isFile()) refuse(`'${t.rel}' is not a file`)
  const file = await canonical(resolved)
  // A link inside the project may point into `.git` or protected storage.
  const rootReal = await fs.realpath(root).catch(() => root)
  const relReal = path.relative(rootReal, file).split(path.sep)
  if (relReal.some(isGitName)) refuse("'.git' is protected")
  if ((await protection(root, file, deniedRoots)).inside) refuse(`path '${t.rel}' is inside protected storage`)
  return withFileLock(file, undefined, async () => {
    const bytes = await fs.readFile(file)
    const current = hashBytes(bytes)
    if (current !== expectedHash) {
      throw new ProjectWriteError(409, `'${t.rel}' changed on disk since it was opened`, current)
    }
    let doc
    try {
      doc = decodeDocument(bytes, t.rel)
    } catch (error) {
      if (error instanceof BinaryFileError) refuse(`'${t.rel}' is a binary file`)
      throw error
    }
    if (!doc.writable || doc.encoding !== 'utf8') refuse(`'${t.rel}' is not UTF-8 text and cannot be edited here`)
    // The read path hands the BOM back as a leading U+FEFF; encodeForWrite adds it again.
    const text = doc.bom && content.startsWith('\uFEFF') ? content.slice(1) : content
    const next = encodeForWrite(text, doc)
    if (next.length > MAX_FILE_BYTES) {
      throw new ProjectWriteError(413, `'${t.rel}' would be larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB`)
    }
    await replaceFile(file, next)
    return { path: t.rel, size: next.length, hash: hashBytes(next) }
  })
}
```

Note: `protection()` and `isGitName()` already exist in this file. `refuse()` returns `never`, so the `resolved`/`doc` definite-assignment checks pass; if TypeScript still complains, initialise with a `let resolved = ''` style and keep behaviour identical.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/web/project-files-save.spec.ts tests/web/project-files-write.spec.ts tests/web/project-files-read.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck`

```bash
git add src/web/project-files-write.ts tests/web/project-files-save.spec.ts
git commit -m "feat(web): save edited project files with a stale-hash check"
```

---

### Task 3: `PUT …/file` route and docs

**Files:**
- Modify: `src/web/server.ts` (project files block ~L7064–7110; `handleProjectFileWrite` neighbourhood ~L7979; `readJson` ~L9356)
- Modify: `tests/web/server-project-files.spec.ts` (append)
- Modify: `docs/web.md`

**Interfaces:**
- Consumes (Task 2): `saveProjectFile`, `ProjectWriteError` (with `currentHash`).
- Produces (Task 4): HTTP `PUT /api/workspaces/:wid/projects/:pid/file` body `{path, content, expectedHash}` → 200 `{path, size, hash}` | 409 `{error, currentHash}` | 400/404/413 `{error}`. GET `…/file` now also returns `editable` and `hash`.

- [ ] **Step 1: Write the failing HTTP tests**

Append to `tests/web/server-project-files.spec.ts` (reuses `server`, `wsId`; registers its own project):

```ts
describe('saving a file from the viewer', () => {
  let saveRoot = ''
  let saveProjectId = ''
  const fileUrl = (rel = '') => `${server.url}/api/workspaces/${wsId}/projects/${saveProjectId}/file${rel === '' ? '' : `?path=${encodeURIComponent(rel)}`}`
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(fileUrl(), { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const read = async (rel: string) => (await (await fetch(fileUrl(rel))).json()) as { content: string; editable: boolean; hash?: string }

  beforeAll(async () => {
    saveRoot = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-save-'))
    await fs.writeFile(path.join(saveRoot, 'note.md'), 'old\n', 'utf8')
    const created = await fetch(`${server.url}/api/workspaces/${wsId}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Saves', path: saveRoot }),
    })
    saveProjectId = ((await created.json()) as { id: string }).id
  })

  afterAll(async () => { await fs.rm(saveRoot, { recursive: true, force: true }) })

  it('reads report editable and hash, and a PUT with that hash saves', async () => {
    const before = await read('note.md')
    expect(before.editable).toBe(true)
    expect(typeof before.hash).toBe('string')
    const saved = await put({ path: 'note.md', content: 'new\n', expectedHash: before.hash })
    expect(saved.status).toBe(200)
    const body = (await saved.json()) as { path: string; size: number; hash: string }
    expect(body).toMatchObject({ path: 'note.md', size: 4 })
    expect((await read('note.md')).hash).toBe(body.hash)
    expect(await fs.readFile(path.join(saveRoot, 'note.md'), 'utf8')).toBe('new\n')
  })

  it('answers 409 with currentHash for a stale hash', async () => {
    const stale = (await read('note.md')).hash
    await fs.writeFile(path.join(saveRoot, 'note.md'), 'agent\n', 'utf8')
    const response = await put({ path: 'note.md', content: 'mine\n', expectedHash: stale })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; currentHash: string }
    expect(body.currentHash).toBe((await read('note.md')).hash)
    expect(await fs.readFile(path.join(saveRoot, 'note.md'), 'utf8')).toBe('agent\n')
  })

  it('validates the body', async () => {
    const hash = (await read('note.md')).hash
    expect((await put({ content: 'x', expectedHash: hash })).status).toBe(400)
    expect((await put({ path: 'note.md', expectedHash: hash })).status).toBe(400)
    expect((await put({ path: 'note.md', content: 'x' })).status).toBe(400)
    expect((await put({ path: 'missing.md', content: 'x', expectedHash: hash })).status).toBe(404)
  })

  it('accepts a body above the general JSON limit for a large file', async () => {
    const hash = (await read('note.md')).hash
    const content = `${'"\\'.repeat(200_000)}\n`
    const response = await put({ path: 'note.md', content, expectedHash: hash })
    expect(response.status).toBe(200)
    expect((await fs.readFile(path.join(saveRoot, 'note.md'), 'utf8')).length).toBe(content.length)
  })

  it('refuses a cross-site save', async () => {
    const hash = (await read('note.md')).hash
    expect((await put({ path: 'note.md', content: 'evil\n', expectedHash: hash }, { origin: 'http://evil.example' })).status).toBe(403)
  })

  it('keeps other methods on file refused', async () => {
    expect((await fetch(fileUrl('note.md'), { method: 'POST' })).status).toBe(405)
    expect((await fetch(fileUrl('note.md'), { method: 'DELETE' })).status).toBe(405)
  })
})
```

The existing test `fails closed for unknown projects and rejects writes` sends a `PUT` with a non-JSON body `'x'` to `…/file`; after this task it must get **400** (bad body) instead of 405. Update that single assertion from `toBe(405)` to `toBe(400)` and keep everything else in that test.

Also add, inside the existing `describe('explorer writes in an archived workspace', …)` test (after the DELETE assertion), a save attempt that must be refused with 404 (the `ScopeError` mapping):

```ts
      const read = (await (await fetch(`${server.url}/api/workspaces/${ws.id}/projects/${project.id}/file?path=README.md`)).json()) as { hash: string }
      expect((await fetch(`${server.url}/api/workspaces/${ws.id}/projects/${project.id}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'README.md', content: 'x', expectedHash: read.hash }),
      })).status).toBe(404)
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/web/server-project-files.spec.ts`
Expected: the new save tests FAIL with 405.

- [ ] **Step 3: `readJson` limit**

Change `readJson` to accept an optional limit, default unchanged:

```ts
async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
```

and use `limit` instead of `MAX_BODY_BYTES` inside it.

- [ ] **Step 4: Route the PUT**

Add `saveProjectFile` to the existing import from `./project-files-write.ts`, and `MAX_FILE_BYTES` to the existing import from `./project-files.ts`.

In the project files block, change the `writing` line to:

```ts
      const kind = wsProjectFilesMatch[3]
      const writing = (kind === 'files' && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE'))
        || (kind === 'file' && req.method === 'PUT')
```

and the dispatch to:

```ts
      if (writing) {
        if (kind === 'file') await handleProjectFileSave(req, project.path, deps.deniedRoots, send)
        else await handleProjectFileWrite(req, query, project.path, deps.deniedRoots, send)
        return
      }
```

(Inside the existing `try` below, `const kind = wsProjectFilesMatch[3]` is declared again; remove that inner duplicate and use the outer `kind`.)

Update the section comment above the block to mention "PUT on `file` saves an edited file (`handleProjectFileSave`)".

Add below `handleProjectFileWrite`:

```ts
/**
 * Viewer saves on `…/projects/:pid/file`: PUT `{path, content, expectedHash}`.
 * A stale hash answers 409 with `currentHash`; containment, encoding and the
 * atomic write live in `saveProjectFile`.
 */
async function handleProjectFileSave(
  req: IncomingMessage,
  root: string,
  deniedRoots: readonly string[] | undefined,
  send: (status: number, body: unknown) => void,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    // JSON escaping can double a file, so the body may exceed the general cap.
    body = await readJson(req, 4 * MAX_FILE_BYTES)
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : String(error) })
    return
  }
  const rawPath = body['path']
  const content = body['content']
  const expectedHash = body['expectedHash']
  if (typeof rawPath !== 'string') { send(400, { error: "'path' must be a string" }); return }
  if (typeof content !== 'string') { send(400, { error: "'content' must be a string" }); return }
  if (typeof expectedHash !== 'string' || expectedHash === '') { send(400, { error: "'expectedHash' must be a non-empty string" }); return }
  try {
    send(200, await saveProjectFile(root, rawPath, content, expectedHash, deniedRoots))
  } catch (error) {
    if (!(error instanceof ProjectWriteError)) throw error
    send(error.status, error.currentHash !== undefined ? { error: error.message, currentHash: error.currentHash } : { error: error.message })
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run tests/web/server-project-files.spec.ts tests/web/project-files-save.spec.ts`
Expected: PASS.

- [ ] **Step 6: Docs**

In `docs/web.md`:

- In the route table, directly after the `POST\|PATCH\|DELETE …/:wid/projects/:pid/files` row, add:

```
| `PUT …/:wid/projects/:pid/file` | save an edited project file from the viewer: body `{path, content, expectedHash}`. The stored bytes must still hash to `expectedHash` (from the last `GET …/file`), else 409 with `currentHash`; the file keeps its encoding, BOM and dominant line ending and is replaced atomically under the agent tools' file lock. Only whole UTF-8 text files up to 1 MiB (`editable` on the read); the same path rules as explorer writes; a direct user action independent of session mode; archived workspaces refuse it |
```

- In the `GET …(files\|file\|search)` row, mention that file reads return `editable` and `hash`.
- Where the Files workbench view is described as browse/create/rename/delete (~L845 table row and the Files paragraph ~L908), add "edit file contents (Edit/Save in the viewer)".

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm run typecheck`

```bash
git add src/web/server.ts tests/web/server-project-files.spec.ts docs/web.md
git commit -m "feat(web): PUT project file to save viewer edits"
```

---

### Task 4: Web API and draft state

**Files:**
- Modify: `web/lib/api.ts` (`ProjectFileView`, after `deleteProjectEntry`)
- Modify: `web/hooks/useWorkbenchFiles.ts`
- Modify: `web/hooks/useWorkbenchFiles.spec.ts` (append)

**Interfaces:**
- Consumes (Task 3): HTTP contract.
- Produces (Tasks 5, 6):
  - `ProjectFileView` gains `readonly editable?: boolean` and `readonly hash?: string` (optional: memory and skill reads may omit them).
  - `class SaveConflictError extends Error { readonly currentHash: string }`
  - `saveProjectFile(workspaceId, projectId, path, content, expectedHash): Promise<{ path: string; size: number; hash: string }>` — throws `SaveConflictError` on 409, `HttpError` otherwise.
  - `export interface FileDraft { readonly text: string; readonly baseHash: string; readonly dirty: boolean }`
  - `FilesState.drafts: Readonly<Record<string, FileDraft>>`
  - `WorkbenchFiles.setDraft(path: string, draft: FileDraft | null): void`
  - `WorkbenchFiles.closeFile(path)` asks `window.confirm` when that path's draft is dirty.
  - pure `closeFileWithDraft(state, path, confirm: (message: string) => boolean): FilesState`

- [ ] **Step 1: Write the failing tests**

Append to `web/hooks/useWorkbenchFiles.spec.ts` (keep the existing imports; add `closeFileWithDraft` to the import from `./useWorkbenchFiles.ts`). Existing tests build `state` objects without `drafts`; give the shared `state` constant `drafts: {}` and add `drafts: {}` to any literal `FilesState` in existing assertions/inputs so they still type-check, without changing what they assert.

```ts
describe('drafts', () => {
  const draft = (text: string, dirty = true) => ({ text, baseHash: 'h', dirty })
  const withDrafts = {
    folder: '',
    openFiles: ['a.ts', 'src/b.ts', 'src/deep/c.ts'],
    activeFile: 'a.ts',
    focus: null,
    drafts: { 'src/b.ts': draft('B'), 'src/deep/c.ts': draft('C'), 'a.ts': draft('A', false) },
  }

  it('moves drafts with a renamed folder', () => {
    expect(renameFileTabs(withDrafts, 'src', 'lib').drafts).toEqual({ 'lib/b.ts': draft('B'), 'lib/deep/c.ts': draft('C'), 'a.ts': draft('A', false) })
  })

  it('drops drafts under a deleted path', () => {
    expect(removeFileTabs(withDrafts, 'src').drafts).toEqual({ 'a.ts': draft('A', false) })
  })

  it('asks before closing a tab with unsaved changes and keeps it when refused', () => {
    const asked: string[] = []
    const kept = closeFileWithDraft(withDrafts, 'src/b.ts', (message) => { asked.push(message); return false })
    expect(kept).toBe(withDrafts)
    expect(asked).toEqual(['Discard unsaved changes to b.ts?'])
  })

  it('closes and drops the draft when confirmed', () => {
    const next = closeFileWithDraft(withDrafts, 'src/b.ts', () => true)
    expect(next.openFiles).toEqual(['a.ts', 'src/deep/c.ts'])
    expect(next.drafts['src/b.ts']).toBeUndefined()
  })

  it('closes a clean draft without asking', () => {
    const next = closeFileWithDraft(withDrafts, 'a.ts', () => { throw new Error('must not ask') })
    expect(next.openFiles).toEqual(['src/b.ts', 'src/deep/c.ts'])
    expect(next.drafts['a.ts']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run web/hooks/useWorkbenchFiles.spec.ts`
Expected: FAIL — `closeFileWithDraft` is not exported / `drafts` undefined.

- [ ] **Step 3: Implement the draft state**

In `web/hooks/useWorkbenchFiles.ts`:

1. Add:

```ts
/** Unsaved editor text for one open file, kept while its tab is open. */
export interface FileDraft {
  readonly text: string
  /** Hash of the file the edit started from; the save sends it back. */
  readonly baseHash: string
  readonly dirty: boolean
}
```

2. `FilesState` gains `readonly drafts: Readonly<Record<string, FileDraft>>`; `EMPTY` gains `drafts: {}`.
3. `WorkbenchFiles` gains `readonly setDraft: (path: string, draft: FileDraft | null) => void`.
4. `closeFileTab` also drops `drafts[path]` (when present).
5. `renameFileTabs`: also move drafts — include draft keys in the `touched` check, and rebuild `drafts` with `moved(key, from, to)`.
6. `removeFileTabs`: also drop drafts at or under `path` (include them in the early-return check).
7. Add:

```ts
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Close a tab, asking first when it holds unsaved changes; a refusal keeps everything. */
export function closeFileWithDraft(state: FilesState, path: string, confirm: (message: string) => boolean): FilesState {
  if (state.drafts[path]?.dirty === true && !confirm(`Discard unsaved changes to ${baseName(path)}?`)) return state
  return closeFileTab(state, path)
}
```

8. In the hook:

```ts
  const closeFile = useCallback((path: string) => setState((current) => closeFileWithDraft(current, path, (message) => window.confirm(message))), [])
  const setDraft = useCallback((path: string, draft: FileDraft | null) => setState((current) => {
    if (draft === null) {
      if (current.drafts[path] === undefined) return current
      const { [path]: _gone, ...rest } = current.drafts
      return { ...current, drafts: rest }
    }
    return { ...current, drafts: { ...current.drafts, [path]: draft } }
  }), [])
  const anyDirty = Object.values(state.drafts).some((draft) => draft.dirty)
  useEffect(() => {
    if (!anyDirty) return
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])
```

Note: `window.confirm` runs inside a state updater here; React may call updaters twice in StrictMode development. To avoid a double prompt, perform the confirm outside the updater instead: read the current draft through a ref kept in sync with `state` (`const latest = useRef(state); latest.current = state`), call `closeFileWithDraft(latest.current, path, confirm)` once to decide, and only if it did not return the same state, `setState((current) => closeFileTab(current, path))`. Return `setDraft` from the hook.

- [ ] **Step 4: Add the API**

In `web/lib/api.ts`:

1. Extend `ProjectFileView`:

```ts
  /** Project files only: the viewer may edit and save this file. */
  readonly editable?: boolean
  /** Project files only: sha256 of the stored bytes, sent back on save. */
  readonly hash?: string
```

2. After `deleteProjectEntry`, add:

```ts
/** The file changed on disk since it was opened; `currentHash` is what is there now. */
export class SaveConflictError extends Error {
  constructor(readonly currentHash: string) {
    super('The file changed on disk since it was opened.')
    this.name = 'SaveConflictError'
  }
}

/** Save the viewer's text; refuses (SaveConflictError) when the file no longer hashes to `expectedHash`. */
export async function saveProjectFile(workspaceId: string, projectId: string, path: string, content: string, expectedHash: string): Promise<{ path: string; size: number; hash: string }> {
  const response = await apiFetch(`${projectBase(workspaceId, projectId)}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, expectedHash }),
  })
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { currentHash?: unknown }
    if (typeof body.currentHash === 'string') throw new SaveConflictError(body.currentHash)
  }
  return json<{ path: string; size: number; hash: string }>(response)
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run web/hooks/useWorkbenchFiles.spec.ts web/lib/product-ui.spec.tsx web/components/workbench/file-browser.spec.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` (fix any `FilesState` literal elsewhere that now needs `drafts: {}`).

```bash
git add web/lib/api.ts web/hooks/useWorkbenchFiles.ts web/hooks/useWorkbenchFiles.spec.ts
git commit -m "feat(web): save API and unsaved-draft state for workbench files"
```

---

### Task 5: `FileEditor` component

**Files:**
- Create: `web/components/workbench/FileEditor.tsx`
- Test: `web/components/workbench/file-editor.spec.tsx` (new)

**Interfaces:**
- Consumes: `Button` (`web/components/ui/Button.tsx`), `ErrorNotice`.
- Produces (Task 6):

```ts
FileEditor(props: {
  path: string
  text: string
  dirty: boolean
  saving: boolean
  error: string | null
  /** Shown above the editor when the file changed on disk. */
  conflict: boolean
  onChange: (text: string) => void
  onSave: () => void
  onCancel: () => void
  onReload: () => void
  onOverwrite: () => void
})
```

Pure presentation + key handling; the viewer owns state and confirmations.

**Behavior:**
1. Toolbar (`h-9`, border-b): left "Editing" label plus, when `dirty`, a pill `Unsaved`; right **Cancel** (`variant="outline"`) and **Save** (`variant="primary"`, disabled when `saving` or `!dirty`, label `Saving…` while saving).
2. When `conflict`: a `role="alert"` banner (`bg-warn-soft text-warn`) reading `This file changed on disk since you opened it.` with buttons **Reload** and **Overwrite**.
3. When `error !== null`: `<ErrorNotice raw={error} />` under the toolbar.
4. A `<textarea aria-label={`Edit ${path}`}>` filling the rest (`min-h-0 flex-1 resize-none font-mono text-[12.5px] leading-5 p-3 bg-bg outline-none`), `spellCheck={false}`, `autoCorrect="off"`, `autoCapitalize="off"`, `wrap="off"`, `disabled={saving}`. It receives focus on mount.
5. Keys on the textarea:
   - Cmd/Ctrl+S → `preventDefault()`, `onSave()` (also when not dirty — the viewer ignores it).
   - Escape → `preventDefault()`, `onCancel()`.
   - Tab (no modifiers) → `preventDefault()`, insert the indent unit at the selection (replacing it) and move the caret after it. The unit is `\t` when any line of `text` starts with a tab, else two spaces. Call `onChange` with the new text, then restore the caret with `requestAnimationFrame`/`setSelectionRange`.
   - Shift+Tab is left to the browser (focus moves).

- [ ] **Step 1: Write the failing tests**

Create `web/components/workbench/file-editor.spec.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileEditor } from './FileEditor.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove() })

function props(over: Partial<Parameters<typeof FileEditor>[0]> = {}) {
  return {
    path: 'src/a.ts', text: 'a\n', dirty: false, saving: false, error: null, conflict: false,
    onChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(), onReload: vi.fn(), onOverwrite: vi.fn(),
    ...over,
  }
}

async function mount(p: ReturnType<typeof props>) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<FileEditor {...p} />))
  return host.querySelector('textarea')!
}

const key = (target: Element, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!

it('focuses the textarea and labels it with the path', async () => {
  const area = await mount(props())
  expect(document.activeElement).toBe(area)
  expect(area.getAttribute('aria-label')).toBe('Edit src/a.ts')
  expect(area.value).toBe('a\n')
})

it('saves on Cmd+S and Ctrl+S, cancels on Escape', async () => {
  const p = props({ dirty: true })
  const area = await mount(p)
  await key(area, { key: 's', metaKey: true })
  await key(area, { key: 's', ctrlKey: true })
  await key(area, { key: 'Escape' })
  expect(p.onSave).toHaveBeenCalledTimes(2)
  expect(p.onCancel).toHaveBeenCalledTimes(1)
})

it('inserts two spaces on Tab, or a tab when the file is tab-indented', async () => {
  const spaces = props({ text: 'ab' })
  const area = await mount(spaces)
  area.setSelectionRange(1, 1)
  await key(area, { key: 'Tab' })
  expect(spaces.onChange).toHaveBeenLastCalledWith('a  b')
  await act(async () => root!.unmount()); root = undefined; host.remove()

  const tabs = props({ text: '\tx\nab' })
  const area2 = await mount(tabs)
  area2.setSelectionRange(4, 5)
  await key(area2, { key: 'Tab' })
  expect(tabs.onChange).toHaveBeenLastCalledWith('\tx\na\t')
})

it('shows Unsaved only when dirty and disables Save when clean or saving', async () => {
  await mount(props())
  expect(host.textContent).not.toContain('Unsaved')
  expect(button('Save').disabled).toBe(true)
  await act(async () => root!.render(<FileEditor {...props({ dirty: true })} />))
  expect(host.textContent).toContain('Unsaved')
  expect(button('Save').disabled).toBe(false)
  await act(async () => root!.render(<FileEditor {...props({ dirty: true, saving: true })} />))
  expect(button('Saving…').disabled).toBe(true)
  expect(host.querySelector('textarea')!.disabled).toBe(true)
})

it('shows the conflict banner with Reload and Overwrite', async () => {
  const p = props({ dirty: true, conflict: true })
  await mount(p)
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('This file changed on disk since you opened it.')
  await act(async () => button('Reload').click())
  await act(async () => button('Overwrite').click())
  expect(p.onReload).toHaveBeenCalledTimes(1)
  expect(p.onOverwrite).toHaveBeenCalledTimes(1)
})

it('reports typing through onChange', async () => {
  const p = props()
  const area = await mount(p)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'b\n')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(p.onChange).toHaveBeenLastCalledWith('b\n')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run web/components/workbench/file-editor.spec.tsx`
Expected: FAIL — cannot resolve `./FileEditor.tsx`.

- [ ] **Step 3: Implement per the behavior list**

Write `FileEditor.tsx`. Keep it under ~120 lines; export a small pure helper `indentUnit(text: string): '\t' | '  '` if it helps readability.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run web/components/workbench/file-editor.spec.tsx`
Expected: PASS, no act() warnings.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm run typecheck
git add web/components/workbench/FileEditor.tsx web/components/workbench/file-editor.spec.tsx
git commit -m "feat(web): file editor with save, cancel and conflict actions"
```

---

### Task 6: Edit flow in the viewer and dirty tabs

**Files:**
- Modify: `web/components/workbench/FileViewer.tsx`
- Modify: `web/components/workbench/FilesWorkspace.tsx` (the `<FileViewer … />` element)
- Modify: `web/components/workbench/Workbench.tsx` (tab strip ~L322–339)
- Test: `web/components/workbench/file-viewer-edit.spec.tsx` (new)

**Interfaces:**
- Consumes: Task 4 (`saveProjectFile`, `SaveConflictError`, `ProjectFileView.editable/hash`, `FileDraft`, `files.drafts`, `files.setDraft`), Task 5 (`FileEditor`), `writeErrorText` (`web/lib/file-tree.ts`).
- Produces: `FileViewer` props gain `draft: FileDraft | null` and `onDraft: (draft: FileDraft | null) => void`.

**Behavior:**
1. `FilesWorkspace` passes `draft={files.drafts[files.activeFile] ?? null}` and `onDraft={(d) => files.setDraft(files.activeFile!, d)}` (capture the path in a const first).
2. **Edit button:** in the path bar, before Reload, an `IconButton` labelled `Edit file` (`pencil` icon) only when the tab is a project file (`skill === null && memory === null`), `file.editable === true`, `file.hash !== undefined`, and `draft === null`.
3. Clicking Edit → `onDraft({ text: file.content, baseHash: file.hash, dirty: false })`.
4. While `draft !== null` the content area renders `FileEditor` instead of the highlighted view (the language/copy bar stays). `onChange(text)` → `onDraft({ ...draft, text, dirty: text !== file.content || draft.baseHash !== file.hash })`.
5. **Save** (and Cmd+S): ignored when `!draft.dirty` or already saving. Calls `saveProjectFile(workspaceId, projectId, path, draft.text, draft.baseHash)`. Success → set `file` to `{ ...file, content: draft.text, size: result.size, hash: result.hash }`, `onDraft(null)`, clear error/conflict. `SaveConflictError` → set `conflict = currentHash` (keep draft). Other errors → `error = writeErrorText(cause)` (keep draft).
6. **Cancel / Escape:** when dirty, `window.confirm('Discard unsaved changes?')`; on yes (or when clean) `onDraft(null)` and clear error/conflict.
7. **Reload** (conflict): `window.confirm('Discard your changes and load the file from disk?')`; on yes `onDraft(null)`, clear conflict, `void load()`.
8. **Overwrite** (conflict): `window.confirm('Overwrite the file on disk with your changes?')`; on yes save again with `expectedHash = conflict` (the current hash), same success/failure handling.
9. The existing Reload-file icon button in the path bar, while a dirty draft exists, asks the same Reload confirmation before discarding.
10. Saving/conflict/error state is local to `FileViewer` (it remounts per tab; only the draft must survive).
11. **Dirty tab marker** in `Workbench.tsx`: when `files.drafts[path]?.dirty === true`, render inside the tab button, after the name, `<span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-fg-muted" />`.

- [ ] **Step 1: Write the failing tests**

Create `web/components/workbench/file-viewer-edit.spec.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileViewer } from './FileViewer.tsx'
import type { FileDraft } from '../../hooks/useWorkbenchFiles.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class SaveConflictError extends Error { constructor(readonly currentHash: string) { super('conflict') } }
let disk = { content: 'one\n', hash: 'h1', editable: true }
const readProjectFile = vi.fn(async (_ws: string, _p: string, path: string) => ({ path, size: disk.content.length, binary: false, truncated: false, ...disk }))
const saveProjectFile = vi.fn(async (_ws: string, _p: string, path: string, content: string, expected: string) => {
  if (expected !== disk.hash) throw new SaveConflictError(disk.hash)
  disk = { ...disk, content, hash: `h-${content.length}` }
  return { path, size: content.length, hash: disk.hash }
})

vi.mock('../../lib/api.ts', () => ({
  readProjectFile: (...a: [string, string, string]) => readProjectFile(...a),
  saveProjectFile: (...a: [string, string, string, string, string]) => saveProjectFile(...a),
  SaveConflictError,
  readMemoryFile: vi.fn(async () => ({ path: 'MEMORY.md', size: 3, binary: false, truncated: false, content: 'm\n' })),
  getSkillFile: vi.fn(async () => ({ path: 'SKILL.md', bytes: 3, content: 's\n' })),
  projectMediaUrl: () => '/media',
  mediaKindOf: () => null,
}))

let root: Root | undefined
let host: HTMLDivElement
let confirmSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  disk = { content: 'one\n', hash: 'h1', editable: true }
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.clearAllMocks(); confirmSpy.mockRestore() })

/** Owns the draft like useWorkbenchFiles, so remounting the viewer keeps it. */
function Harness({ path, viewerKey }: { path: string; viewerKey: number }) {
  const [draft, setDraft] = useState<FileDraft | null>(null)
  ;(globalThis as { __draft?: FileDraft | null }).__draft = draft
  return <FileViewer key={viewerKey} workspaceId="w1" projectId="p1" projectPath="/proj" path={path} draft={draft} onDraft={setDraft} />
}

async function mount(path = 'src/a.ts', viewerKey = 1) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<Harness path={path} viewerKey={viewerKey} />))
  await act(async () => { await vi.waitFor(() => expect(host.textContent).not.toContain('Loading file')) })
}

const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!
const area = () => host.querySelector('textarea')!
const type = (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area(), text)
  area().dispatchEvent(new Event('input', { bubbles: true }))
})
const save = () => act(async () => { area().dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })) })

it('edits, saves with Cmd+S and returns to the highlighted view', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  expect(area().value).toBe('one\n')
  await type('two\n')
  expect(host.textContent).toContain('Unsaved')
  await save()
  expect(saveProjectFile).toHaveBeenCalledWith('w1', 'p1', 'src/a.ts', 'two\n', 'h1')
  expect(host.querySelector('textarea')).toBeNull()
  expect(host.textContent).toContain('two')
  expect((globalThis as { __draft?: FileDraft | null }).__draft).toBeNull()
})

it('keeps the draft on a conflict and Overwrite saves against the current hash', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('changed on disk')
  expect(area().value).toBe('mine\n')
  await act(async () => button('Overwrite').click())
  expect(saveProjectFile).toHaveBeenLastCalledWith('w1', 'p1', 'src/a.ts', 'mine\n', 'h-agent')
  expect(host.querySelector('textarea')).toBeNull()
})

it('Reload after a conflict drops the draft and shows the disk content', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  await act(async () => button('Reload').click())
  await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('agent')) })
  expect(host.querySelector('textarea')).toBeNull()
})

it('asks before cancelling a dirty edit and keeps it when refused', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('changed\n')
  confirmSpy.mockReturnValueOnce(false)
  await act(async () => button('Cancel').click())
  expect(area().value).toBe('changed\n')
  await act(async () => button('Cancel').click())
  expect(host.querySelector('textarea')).toBeNull()
})

it('keeps the draft when the viewer remounts (tab switch)', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('draft\n')
  await act(async () => root!.render(<Harness path="src/a.ts" viewerKey={2} />))
  await act(async () => { await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull()) })
  expect(area().value).toBe('draft\n')
})

it('offers no Edit for memory, skill, binary or non-editable files', async () => {
  await mount('memory://workspace/MEMORY.md')
  expect(byLabel('Edit file')).toBeNull()
  await act(async () => root!.unmount()); root = undefined; host.remove()
  disk = { ...disk, editable: false }
  await mount('src/b.ts')
  expect(byLabel('Edit file')).toBeNull()
})
```

`memory://workspace/MEMORY.md` is the real memory-tab format (`memoryTabPath` in `web/lib/project-paths.ts`). The Harness owns the draft with `useState` but the `FileViewer` remount happens via `key`, mirroring `FilesWorkspace`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run web/components/workbench/file-viewer-edit.spec.tsx`
Expected: FAIL — no `Edit file` button / unknown props.

- [ ] **Step 3: Implement the behavior list**

Edit `FileViewer.tsx`, `FilesWorkspace.tsx`, `Workbench.tsx` per items 1–11. Keep `FileViewer.tsx` readable; if the edit-flow state grows it, extract a small `useFileEditing` hook in the same folder.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run web/components/workbench/file-viewer-edit.spec.tsx web/components/workbench/file-viewer-skill.spec.tsx web/components/workbench/file-editor.spec.tsx web/hooks/useWorkbenchFiles.spec.ts web/lib/product-ui.spec.tsx`
Expected: PASS, no act() warnings.

- [ ] **Step 5: Full gates and commit**

Run: `pnpm test && pnpm run typecheck && pnpm run build:web`. Known pre-existing load flakes: `tests/web/server-g1.spec.ts` steer tests, `tests/web/server-g4.spec.ts` concurrency peak, `tests/harness/subagent-stability.spec.ts` cancelled child, `tests/web/path-scope-guard.spec.ts`; if any fail, re-run that file alone and report.

```bash
git add web/components/workbench/FileViewer.tsx web/components/workbench/FilesWorkspace.tsx web/components/workbench/Workbench.tsx web/components/workbench/file-viewer-edit.spec.tsx
git commit -m "feat(web): edit and save project files in the workbench viewer"
```

---
