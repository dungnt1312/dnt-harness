# Workbench: edit project files in the viewer

Status: revision 1, approved in chat (2026-10-13 12:44, "chốt, làm theo đề xuất").

## Decision

The workbench file viewer (`web/components/workbench/FileViewer.tsx`) is
read-only. The user chose, one question at a time:

| Question | Choice |
|---|---|
| Editing level | quick edit with Save; a conflict is reported, never overwritten silently |
| Which files | project files only; memory and skill tabs stay read-only |
| Interaction | view as today, an **Edit** button switches to editing |
| Unsaved changes | confirm before closing a tab with unsaved edits (included) |

## Scope

**In:** an `editable` flag and content `hash` on project file reads; a save
route that refuses on a stale hash; an Edit/Save/Cancel flow in the viewer with
Cmd/Ctrl+S; a conflict banner with Reload and Overwrite; unsaved drafts that
survive tab switches; a dirty marker on tabs; confirmation before closing a
dirty tab or leaving the page; tests and docs.

**Out:** syntax highlighting while typing, an IDE editor (CodeMirror/Monaco),
find/replace, editing memory or skill files, editing binary or truncated
(> 1 MB) files, creating files from the viewer (the explorer's New file does
that), multi-user merge.

## Current state (verified)

- `readProjectFile` (`src/web/project-files.ts`) returns
  `{path, size, binary, truncated, content}`. It reads at most
  `MAX_FILE_BYTES` (1 MB), sniffs a NUL in the first 8 KB for `binary`, and
  decodes UTF-8 including a leading BOM character and raw CRLF. The memory
  route also calls it.
- `src/capabilities/fs/text-document.ts` has `decodeDocument` (hash, encoding,
  BOM, dominant EOL, `writable`), `encodeForWrite(text, existingDoc)` (keeps
  encoding, BOM, dominant EOL) and `hashBytes` (sha256). The agent's
  `Write`/`Edit` tools use them.
- `src/capabilities/fs/observation.ts` has `canonical(file)`,
  `withFileLock(file, signal, action)` (in-process serialisation keyed by the
  canonical path) and `replaceFile(file, bytes)` (temp file + rename, keeps
  permission bits).
- `src/web/project-files-write.ts` holds the explorer's containment rules
  (`target()`: no root, no `.` / `..` segments, no `.git` in any case, parent
  resolved through `resolveGrantedPath`, protected storage refused) and
  `ProjectWriteError(status: 400 | 404 | 409)`.
- `src/web/server.ts` routes `…/projects/:pid/(files|file|search|git|media)`;
  writes are POST/PATCH/DELETE on `files` via `handleProjectFileWrite`;
  `readJson` caps bodies at `MAX_BODY_BYTES = 1_000_000`.
- `FileViewer` is keyed by `${project.id}:${activeFile}` in
  `FilesWorkspace.tsx`, so it unmounts on every tab switch. Tabs render in
  `Workbench.tsx` with `files.closeFile(path)`.
- The web app already uses `window.confirm` for destructive confirmations
  (`AutomationsView.tsx`, `NotifyChannelsPanel.tsx`).

## 1. Reads: `hash` and `editable`

`ProjectFile` gains two fields:

- `editable: boolean` — true only when the file is not binary, not truncated,
  decodes with `decodeDocument` without `BinaryFileError`, is `writable`, and
  is UTF-8 (with or without BOM).
- `hash?: string` — `sha256` of the full stored bytes; present exactly when
  the whole file was read (`!truncated`).

The memory route keeps working (extra fields only). `content` is unchanged.

## 2. Save: `saveProjectFile`

In `src/web/project-files-write.ts`:

```ts
saveProjectFile(root, rawPath, content: string, expectedHash: string, deniedRoots?)
  : Promise<{ path: string; size: number; hash: string }>
```

1. Path rules: run the existing `target()` (root, `.`/`..`, `.git`, parent
   containment, protected storage).
2. Resolve the file itself with `resolveGrantedPath(root, rel, deniedRoots)`
   and then `canonical(...)`, so an in-project symlink is written through to
   its target and stays a link; a link out of the project is refused (400).
   The canonical path must not lie in protected storage and, relative to the
   real project root, must not contain a `.git` segment in any case (400).
3. `lstat`/`stat`: missing → 404; not a regular file → 400.
4. Inside `withFileLock(canonicalPath, undefined, …)`:
   - read the bytes; `hashBytes(bytes) !== expectedHash` →
     `ProjectWriteError(409)` carrying `currentHash`;
   - `decodeDocument` (binary → 400; `!writable` or not UTF-8 → 400);
   - drop one leading `\uFEFF` from `content` when the document has a BOM
     (the read path returns it inside `content`);
   - `encodeForWrite(text, doc)`; encoded size over `MAX_FILE_BYTES` → 413;
   - `replaceFile(canonicalPath, bytes)`; return the new size and hash.

`ProjectWriteError` gains status `413` and an optional `currentHash`.
A mixed-EOL file is saved with its dominant line ending, the same rule the
agent's `Write` follows.

## 3. Route

`PUT /api/workspaces/:wid/projects/:pid/file`, body
`{ path: string, content: string, expectedHash: string }`.

- Routed beside the explorer writes: `requireWorkspace(deps, wsId, true)`
  (archived → refused like other writes), no session-mode check.
- The body is read with a larger cap for this route only
  (`readJson(req, 4 * MAX_FILE_BYTES)`; JSON escaping can double a file).
  `readJson` gains an optional `limit` parameter; the default is unchanged.
- Responses: 200 `{path, size, hash}`; 409 `{error, currentHash}`;
  400/404/413 `{error}`.
- Every other method on `file` keeps answering 405 except GET/HEAD.

## 4. Draft state: `useWorkbenchFiles`

Drafts live in the hook, so they survive tab switches (the viewer remounts):

```ts
interface FileDraft { readonly text: string; readonly baseHash: string; readonly dirty: boolean }
drafts: Readonly<Record<string, FileDraft>>
setDraft(path, draft | null)
```

- `renameFileTabs` moves drafts at or under the old path; `removeFileTabs`
  drops them. Switching project clears them (existing reset).
- `closeFile(path)`: when the draft is dirty, `window.confirm("Discard unsaved
  changes to <name>?")`; cancel keeps the tab. Closing drops the draft.
- While any draft is dirty, a `beforeunload` listener asks the browser to
  confirm leaving.

## 5. Viewer UI

New `web/components/workbench/FileEditor.tsx` (textarea + toolbar + conflict
banner); `FileViewer.tsx` decides between view and edit.

- **Edit** button in the path bar only for project-file tabs whose read says
  `editable`. Clicking creates a draft `{text: file.content, baseHash: file.hash, dirty: false}`.
- Editing shows a monospace `<textarea>` (no spellcheck/autocorrect) filling
  the content area, and a toolbar with **Save**, **Cancel** and an
  "Unsaved" marker when dirty.
  - Cmd/Ctrl+S saves; Tab inserts the file's indent unit (`\t` when any line
    starts with a tab, else two spaces); Escape cancels.
  - Cancel/Escape with a dirty draft asks `window.confirm("Discard unsaved changes?")`.
- **Save:** `saveProjectFile(ws, project, path, text, baseHash)`. Success drops
  the draft, shows the saved content highlighted, and keeps the new hash.
- **409:** the draft stays; a banner says the file changed on disk, with
  **Reload** (confirm, then drop the draft and re-read) and **Overwrite**
  (confirm, then save again with `currentHash`).
- **Other errors:** `ErrorNotice` above the editor; the draft stays.
- Tabs with a dirty draft show a dot before the close button
  (`aria-label` "Unsaved changes").
- Opening a tab whose draft exists resumes editing it.

## 6. Testing

**Server:** save round-trip; CRLF, UTF-8 BOM and LF files keep their format;
stale hash → 409 with `currentHash`, file unchanged; missing → 404; folder,
`..`, absolute, `.git`, `.GIT/config`, symlink out of the project → 400;
in-project symlink saved through and still a link; binary/latin-1 → 400;
too large → 413; reads report `editable`/`hash` correctly (text, binary,
truncated, invalid UTF-8); archived workspace refused; cross-site PUT refused;
other kinds still 405.

**Web:** draft rename/remove/close-confirm pure functions; editor keys
(Cmd+S, Escape, Tab); save success; 409 Reload and Overwrite; Edit hidden for
memory, skill, binary and truncated files; draft survives a tab switch; dirty
dot on the tab.

**Gates:** affected specs, then `pnpm test`, `pnpm run typecheck`,
`pnpm run build:web`.

## 7. Documentation

`docs/web.md`: route-table row for `PUT …/file`, and the Files description
gains "edit file contents".
