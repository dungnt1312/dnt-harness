# File explorer: basic actions and name search

Status: revision 1, awaiting written-spec review.

## Decision

The workbench file explorer (`web/components/workbench/FileBrowser.tsx`) is
read-only today. The user asked for basic actions and search
(2026-10-13 09:10) and chose, one question at a time:

| Question | Choice |
|---|---|
| Actions | create file, create folder, rename, delete (with confirmation) |
| Search | file **names** only, reusing the existing search endpoint |
| Delete | permanent delete after confirmation; no trash |
| Policy | a direct user action, independent of any session's mode |
| API shape | REST verbs on the existing `…/files` route |
| UI | header buttons + search box, per-row hover `⋯` menu, inline naming |
| `.git` | protected: never created, renamed or deleted through the explorer |

## Scope

**In:** create file, create folder, rename in place, delete file or folder,
file-name search inside the explorer, keeping open file tabs consistent
after a rename or delete, server and web tests, `docs/web.md` update.

**Out:** move or drag-and-drop, duplicate, upload, copy/cut/paste,
context (right-click) menu, content search, trash/undo, editing file
contents, a per-project or per-mode switch for explorer writes.

## Current state (verified)

- `src/web/project-files.ts` lists, reads, searches and serves media, and its
  header says "Nothing here writes".
- `src/web/server.ts` routes `GET|HEAD /api/workspaces/:wid/projects/:pid/(files|file|search|git|media)`
  and answers 405 to every other method. Reads call
  `requireWorkspace(deps, wsId, false)`.
- `crossSiteWrite(req)` runs before every route (`server.ts`), so a new
  unsafe method is Origin-checked without extra code. Pairing/CSRF auth also
  applies to every non-public `/api/` path.
- `resolveGrantedPath(root, target, deniedRoots)`
  (`src/capabilities/fs/grants.ts`) checks lexical containment, then the
  realpath of the existing portion, then `deniedRoots`, and returns the
  **lexical** absolute path. A symlink whose target lies outside the root
  therefore fails the check when resolved as a full path.
- `searchProjectFiles` matches names (prefix 3, name contains 2, path
  contains 1), skips dot-entries, symlinks and `node_modules`, returns files
  only, caps results at 50 and the walk at 20 000 entries (`truncated`).
  Only the composer `@` picker calls it today.
- `web/components/common/ConfirmDialog.tsx`, `web/components/ui/Menu.tsx`
  and `web/components/ui/TextInput.tsx` exist.
- Row actions in the workbench follow the hover-reveal convention used in
  `GitPanel.tsx`: absolutely positioned, `invisible` until row hover or
  focus-within, always visible under `pointer: coarse`.

## 1. Server: `src/web/project-files-write.ts`

A new module so `project-files.ts` stays read-only. Three functions:

```ts
createProjectEntry(root, rawPath, kind: 'file' | 'dir', deniedRoots?): Promise<ProjectEntry>
renameProjectEntry(root, rawPath, newName, deniedRoots?): Promise<{ path: string; kind: 'file' | 'dir' }>
deleteProjectEntry(root, rawPath, deniedRoots?): Promise<{ path: string }>
```

`ProjectEntry` is the existing type from `project-files.ts`.

### Errors

`class ProjectWriteError extends Error { status: 400 | 404 | 409 }`.
400 is invalid input or a refused path, 404 is a missing entry or parent,
409 is an existing destination. Unexpected filesystem errors propagate as
500 through the existing handler.

### Path resolution

1. Normalize `rawPath` with the same rules as `project-files.ts`
   (`normalizeRelative`; absolute and drive-letter paths are refused). The
   helper is exported from `project-files.ts` and reused, not copied.
2. Refuse the empty path (the project root) for every operation.
3. Refuse any path with a segment equal to `.git`.
4. Split into parent and last segment. Resolve the **parent** with
   `resolveGrantedPath(root, parent, deniedRoots)`; any error becomes a 400.
   Join the last segment to the resolved parent.
5. Operate on that joined path with `lstat`, never following a symlink in
   the last segment. Deleting or renaming a link affects the link itself,
   including a broken link or one pointing outside the project.
6. Also refuse the joined path if it falls inside `deniedRoots`, so the last
   segment cannot name protected storage.

### Name validation (create and rename)

A name is valid when it is non-empty, at most 255 UTF-8 bytes, contains no
`/`, `\` or NUL, is not `.` or `..`, is not `.git`, and passes
`blockedReason` (Windows device names). Leading or trailing whitespace is
refused rather than trimmed, so the created name is exactly what was typed.

### Operations

- **Create file:** parent must exist and be a directory (404 otherwise).
  `fs.writeFile(abs, '', { flag: 'wx' })`; `EEXIST` becomes 409.
- **Create folder:** `fs.mkdir(abs)` without `recursive`; `EEXIST` becomes
  409, `ENOENT` becomes 404.
- **Rename:** source must exist (`lstat`, 404 otherwise). The destination is
  the same parent with `newName`. If the destination exists and is not the
  same inode as the source, answer 409. The same inode means a case-only
  rename on a case-insensitive volume, which is allowed. Then
  `fs.rename(src, dest)`. A rename to the identical name is a 400.
- **Delete:** source must exist (`lstat`, 404 otherwise).
  `fs.rm(abs, { recursive: true, force: false })`. `fs.rm` removes a
  symlink without following it.

Check-then-act leaves a small race window. This is application-level
containment, not an OS sandbox, matching the note in
`src/capabilities/fs/tools.ts`.

## 2. Server routes

The existing regex match for `…/projects/:pid/files` gains three methods.
Every other kind keeps GET/HEAD only.

| Method | Body / query | Success |
|---|---|---|
| `POST …/files` | `{ path, kind: 'file' \| 'dir' }` | 201 `ProjectEntry` |
| `PATCH …/files` | `{ path, name }` | 200 `{ path, kind }` |
| `DELETE …/files` | `?path=` | 200 `{ deleted: true, path }` |

Write methods call `requireWorkspace(deps, wsId, true)`, so an archived
workspace is refused. Bodies are read with the existing `readJson`; a wrong
type for `path`, `kind` or `name` is a 400. `ProjectWriteError` maps to its
status; nothing else changes in the read path.

## 3. Web API: `web/lib/api.ts`

```ts
createProjectEntry(workspaceId, projectId, path, kind): Promise<ProjectEntry>
renameProjectEntry(workspaceId, projectId, path, name): Promise<{ path: string; kind: 'file' | 'dir' }>
deleteProjectEntry(workspaceId, projectId, path): Promise<{ deleted: true; path: string }>
```

They follow the existing `apiFetch` + `json<T>` pattern and reuse
`projectBase`. `searchProjectFiles` already exists and is reused.

## 4. Open tabs: `web/hooks/useWorkbenchFiles.ts`

Two pure functions beside `closeFileTab`, exported for tests:

- `renameFileTabs(state, from, to)` rewrites `openFiles`, `activeFile` and
  `folder` for `from` itself and every path under `from + '/'`.
- `removeFileTabs(state, path)` closes `path` and every tab under it, with
  the same "reveal the neighbour" rule `closeFileTab` uses for the front tab.

`WorkbenchFiles` gains `renamePath(from, to)` and `removePath(path)`, which
`FilesWorkspace` passes to `FileBrowser`.

## 5. Explorer UI: `FileBrowser.tsx`

### Header

Project name, then icon buttons **New file**, **New folder** and the
existing **Refresh**, and below them a search box.

### Rows

Each row gets a `⋯` button (Rename, Delete) using `Menu`, placed with the
hover-reveal convention so it takes no layout space and stays reachable by
keyboard and touch.

### Target folder for "New"

The folder a row belongs to: a selected folder row is the target, a file
row's parent is the target, otherwise the root. The explorer tracks one
`selected` path, set when a row is clicked. The target folder is expanded
before the draft row appears.

### Inline naming

Create and rename show a `TextInput` in the row position. Enter submits.
Escape cancels. Blur cancels without submitting, whatever the value, so a
stray click never creates or renames anything. While the request runs the input
is disabled. A server error shows under the input and keeps it open.
Rename pre-selects the name without its extension for files.

### Delete

`ConfirmDialog` with the entry name. For a folder the text says the folder
and everything inside it will be deleted permanently. After success the
parent folder reloads and `removePath` runs.

### Refresh after a write

The parent folder of the affected path is reloaded with the existing
`load(folder)`. After a rename or delete of a folder, every cached node and
open-state entry at or under the old path is dropped; a renamed folder that
was expanded is re-added to the open set under its new path and loaded
again. The tree never shows a stale path.

### Search

- Typing debounces about 200 ms and calls `searchProjectFiles(…, query, 50)`.
  A newer query discards older responses (request generation, as `load`
  already does).
- While the query is non-empty the tree is replaced by a result list: file
  name with the parent path dimmed, matching the existing file icons.
  Clicking a result opens it as a tab.
- Escape or clearing the box returns to the tree with its expansion state
  intact.
- `truncated` shows "Results may be incomplete". No results shows
  "No matching files". Errors show `ErrorNotice`.
- Hidden files and `node_modules` are not searched and folders are not
  returned. These are existing endpoint limits, kept as-is.

## 6. Testing

**Server** (`tests/web/server-project-files.spec.ts`, plus a unit spec for
`project-files-write.ts` if that file's tests grow large):

- create file and folder; 409 on an existing name; 404 on a missing parent;
- rename file and folder; 409 on an existing destination; case-only rename
  succeeds where the temp volume is case-insensitive (skipped otherwise);
- delete file, non-empty folder, a symlink pointing outside the root (the
  target survives), and a broken symlink;
- refusals: project root, `..` escape, a parent that is a symlink out of the
  root, `.git` and paths under it, invalid names, `deniedRoots`;
- archived workspace refused for writes but not reads;
- cross-site `Origin` refused for a write;
- methods other than GET/HEAD on `file`, `search`, `git`, `media` still 405.

**Web:**

- `renameFileTabs` / `removeFileTabs` pure-function tests;
- `FileBrowser` tests with mocked API: create, rename, delete with
  confirmation, server error shown inline, search results, stale-response
  discard, Escape returning to the tree.

**Gates:** affected specs first, then `pnpm test`, `pnpm run typecheck`,
`pnpm run build:web`.

## 7. Documentation

`docs/web.md`: the route table row for `(files|file|search)` gains the three
write methods and their rules; "read-only project browsing" is reworded.
The header comment of `project-files.ts` points to the new write module.

## Constraints during implementation

`src/web/server.ts`, `web/lib/api.ts` and `docs/web.md` have uncommitted
changes from other work. Edits must be additive and must not revert or
reformat those changes.
