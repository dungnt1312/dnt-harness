import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Icon from '../common/Icon.tsx'
import CopyButton from '../common/CopyButton.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { getSkillFile, readMemoryFile, readProjectFile, saveProjectFile, SaveConflictError, type ProjectFileView } from '../../lib/api.ts'
import { memoryTabOf, skillTabName } from '../../lib/project-paths.ts'
import { writeErrorText } from '../../lib/file-tree.ts'
import type { FileDraft, ViewMode, ViewerFocus } from '../../hooks/useWorkbenchFiles.ts'
import { ConflictBanner, EditBar } from './EditBar.tsx'
import { FilePreview } from './FilePreview.tsx'
import { TruncationNotice } from './TruncationNotice.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { MediaPreview } from '../common/MediaPreview.tsx'
import { cn } from '../../lib/cn.ts'
import { formatBytes } from '../../lib/format.ts'
import { languageOfFile } from '../../lib/highlight.ts'
import { detectIndent, eolOf, hasBom, indentLabel, inFormatOf, toEditorText } from '../../lib/code-text.ts'
import { previewKindOf } from '../../lib/preview.ts'

// CodeMirror and its grammars stay out of the main bundle: they load when the first file opens.
const CodePane = lazy(async () => import('./CodePane.tsx'))

/** A skill's SKILL.md in the shape the viewer renders a project file. */
async function readSkillMd(workspaceId: string, projectId: string, name: string): Promise<ProjectFileView> {
  const file = await getSkillFile(workspaceId, name, 'SKILL.md', projectId)
  return { path: file.path, size: file.bytes, binary: false, truncated: false, content: file.content }
}

/** Whether two reads of a file are the same bytes; a cut read has no hash, so its text decides. */
function sameDisk(a: ProjectFileView, b: ProjectFileView): boolean {
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash
  return a.size === b.size && a.content === b.content
}

type Ask = 'discard' | 'reload' | 'overwrite'

const ASKS: Readonly<Record<Ask, { readonly title: string; readonly body: string; readonly confirm: string }>> = {
  discard: { title: 'Discard unsaved changes?', body: 'Your edits to this file will be lost.', confirm: 'Discard' },
  reload: { title: 'Discard your changes?', body: 'Your edits are dropped and the file is loaded from disk.', confirm: 'Discard and reload' },
  overwrite: { title: 'Overwrite the file on disk?', body: 'The version on disk is replaced with your changes.', confirm: 'Overwrite' },
}

/** File view: path bar, language, copy, and one code surface that reads and, for project files, edits in place. */
export function FileViewer({ workspaceId, projectId, projectPath, path, focus = null, draft, onDraft, onSaved, viewMode, onViewMode, writeSeq }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly projectPath: string
  readonly path: string
  /** The window the caller opened this file at; null lands at the top. */
  readonly focus?: ViewerFocus | null
  /** The unsaved edit for this tab, owned by the caller so it survives tab switches. */
  readonly draft: FileDraft | null
  readonly onDraft: (draft: FileDraft | null) => void
  /** A save of `text` reached disk as `hash`; may arrive after this viewer unmounted. */
  readonly onSaved: (text: string, hash: string) => void
  /** The view the reader chose for this tab, kept by the caller across tab switches. */
  readonly viewMode?: ViewMode | undefined
  readonly onViewMode?: (mode: ViewMode) => void
  /** Seq of the latest agent Edit/Write that landed on this file; a change means the disk may have moved. */
  readonly writeSeq?: number | undefined
}) {
  const [file, setFile] = useState<ProjectFileView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  // Edit-flow state is local: the viewer remounts per tab, only the draft survives.
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** The disk hash reported by a refused save or a write seen since opening; non-null shows the conflict banner. */
  const [conflict, setConflict] = useState<string | null>(null)
  /** The disk text the editor is compared against while the reader inspects a conflict. */
  const [disk, setDisk] = useState<{ readonly text: string } | null>(null)
  const [comparing, setComparing] = useState(false)
  const [review, setReview] = useState<'edit' | 'changes'>('edit')
  const [ask, setAsk] = useState<Ask | null>(null)
  const [localMode, setLocalMode] = useState<ViewMode | undefined>(undefined)
  const savingRef = useRef(false)
  // A save outlives a tab switch; its result must not touch the draft of a viewer that is gone.
  const mounted = useRef(true)
  // load() and the agent-write refresh outlive the render that started them, so they read through refs.
  const fileRef = useRef<ProjectFileView | null>(null)
  const draftRef = useRef(draft)
  const onDraftRef = useRef(onDraft)
  fileRef.current = file
  draftRef.current = draft
  onDraftRef.current = onDraft
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // A skill tab reads SKILL.md from whichever layer owns the skill, which may
  // be outside the project folder.
  const skill = skillTabName(path)
  // A memory tab reads from the workspace's memory folders, also outside the project.
  const memory = memoryTabOf(path)

  const read = useCallback((): Promise<ProjectFileView> => (
    skill !== null
      ? readSkillMd(workspaceId, projectId, skill)
      : memory !== null
        ? readMemoryFile(workspaceId, memory.file, memory.projectId)
        : readProjectFile(workspaceId, projectId, path)
  ), [workspaceId, projectId, path, skill, memory?.file, memory?.projectId])

  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await read()
      if (generation.current === request) {
        setFile(next)
        // A clean draft is only a copy of the old disk text; showing it would hide the newer file.
        const kept = draftRef.current
        if (kept !== null && !kept.dirty && kept.baseHash !== next.hash && mounted.current) onDraftRef.current(null)
      }
    } catch (cause) {
      if (generation.current === request) setError(String(cause))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [read])

  useEffect(() => { void load() }, [load])

  // The agent wrote this file: read it again quietly. Only a real change shows: a clean view
  // follows the disk, an edit in progress gets the conflict banner instead of being replaced.
  const seenWrite = useRef(writeSeq)
  useEffect(() => {
    if (writeSeq === undefined || writeSeq === seenWrite.current) return
    seenWrite.current = writeSeq
    if (savingRef.current) return
    void read().then((next) => {
      const current = fileRef.current
      if (!mounted.current || savingRef.current || current === null || sameDisk(current, next)) return
      const kept = draftRef.current
      if (kept !== null && kept.dirty) {
        if (next.hash !== undefined) setConflict(next.hash)
        return
      }
      setFile(next)
      if (kept === null) return
      // A clean edit follows the new disk text and stays open when the file is still editable.
      if (next.editable === true && next.hash !== undefined) onDraftRef.current({ text: toEditorText(next.content), baseHash: next.hash, dirty: false })
      else onDraftRef.current(null)
    }, () => { /* the file may be mid-rewrite; the next write or Reload settles it */ })
  }, [writeSeq, read])

  const clearEditState = (): void => { setSaveError(null); setConflict(null); setComparing(false); setDisk(null) }
  // Leaving the edit also leaves its review of changes.
  useEffect(() => { if (draft === null) setReview('edit') }, [draft === null])

  /** Writes the draft; `expectedHash` is the draft's base unless Overwrite supplies the current disk hash. */
  const save = async (expectedHash: string, force = false): Promise<void> => {
    if (draft === null || file === null || (!draft.dirty && !force) || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const result = await saveProjectFile(workspaceId, projectId, path, draft.text, expectedHash)
      // The file is written whether or not this viewer is still around; the owner drops the
      // draft only if nothing newer was typed meanwhile.
      onSaved(draft.text, result.hash)
      if (!mounted.current) return
      // Stored in the file's own shape (its line endings and BOM), as the server wrote it.
      setFile({ ...file, content: inFormatOf(draft.text, file.content), size: result.size, hash: result.hash })
      clearEditState()
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof SaveConflictError) {
        setSaveError(null)
        setConflict(cause.currentHash)
      } else {
        setConflict(null)
        setSaveError(writeErrorText(cause))
      }
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }

  const discardEdit = (): void => {
    clearEditState()
    onDraft(null)
  }
  const cancelEdit = (): void => {
    if (savingRef.current) return
    if (draft?.dirty === true) setAsk('discard')
    else discardEdit()
  }

  /** Drops the draft and re-reads the file. */
  const reloadNow = (): void => {
    clearEditState()
    if (draft !== null) onDraft(null)
    void load()
  }
  const reloadFromDisk = (): void => {
    if (savingRef.current) return
    if (draft?.dirty === true || conflict !== null) setAsk('reload')
    else reloadNow()
  }

  /** Shows what is on disk now beside the edit; the fresh hash is what Overwrite then saves against. */
  const toggleCompare = async (): Promise<void> => {
    if (comparing) {
      setComparing(false)
      return
    }
    try {
      const fresh = await read()
      if (!mounted.current) return
      setDisk({ text: toEditorText(fresh.content) })
      if (fresh.hash !== undefined) setConflict(fresh.hash)
      setComparing(true)
    } catch (cause) {
      if (mounted.current) setSaveError(writeErrorText(cause))
    }
  }

  const confirmAsk = (): void => {
    const answered = ask
    setAsk(null)
    if (answered === 'discard') discardEdit()
    else if (answered === 'reload') reloadNow()
    else if (answered === 'overwrite' && conflict !== null) void save(conflict, true)
  }

  const nameForKind = skill !== null ? 'SKILL.md' : memory !== null ? memory.file : path
  const language = languageOfFile(nameForKind)
  // Preview is pure client-side rendering of the already-read text, so it is
  // available on every tab: project files, skills and memory alike.
  const previewKind = previewKindOf(nameForKind)
  const chosen = viewMode ?? localMode
  const baseMode: ViewMode = chosen ?? (previewKind === 'markdown' ? 'preview' : 'code')
  // While editing, the rendered document sits beside the text rather than replacing it.
  const mode: ViewMode = previewKind === null ? 'code' : draft !== null && baseMode === 'preview' ? 'split' : baseMode
  const chooseMode = (next: ViewMode): void => {
    setLocalMode(next)
    onViewMode?.(next)
  }

  // The editor holds LF text without a BOM; the server restores the file's own ending and BOM on save.
  const editorBase = useMemo(() => file === null ? '' : toEditorText(file.content), [file])
  const indent = useMemo(() => detectIndent(editorBase), [editorBase])
  const eol = file === null ? null : eolOf(file.content)
  const encoding = file?.editable === true ? (hasBom(file.content) ? 'UTF-8 with BOM' : 'UTF-8') : null
  const facts = useMemo(
    () => [indentLabel(indent), ...(eol !== null ? [eol] : []), ...(encoding !== null ? [encoding] : []), ...(file !== null ? [formatBytes(file.size)] : [])],
    [indent, eol, encoding, file],
  )
  const shownText = draft !== null ? draft.text : editorBase
  // The preview trails typing by a frame, so a big document never makes the editor lag.
  const previewText = useDeferredValue(draft !== null ? draft.text : file?.content ?? '')

  const separator = projectPath.includes('\\') ? '\\' : '/'
  const fullPath = skill !== null
    ? `Skill · ${skill}/SKILL.md`
    : memory !== null
      ? `Memory · ${memory.projectId !== undefined ? 'project' : 'workspace'} · ${memory.file}`
      : `${projectPath.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`
  const editable = skill === null && memory === null && file?.editable === true && file.hash !== undefined
  const readOnlyReason = file === null || file.binary || editable
    ? null
    : skill !== null ? 'Skills open read-only here'
      : memory !== null ? 'Memory opens read-only here'
        : file.truncated ? 'Larger than 1 MB, so it opens read-only'
          : 'Not valid UTF-8 text, so it opens read-only'

  const compare = comparing && disk !== null
    ? { original: disk.text, revertLabel: 'Use disk' }
    : draft !== null && review === 'changes'
      ? { original: editorBase, revertLabel: 'Revert' }
      : null
  const showCode = mode !== 'preview'
  const showPreview = previewKind !== null && mode !== 'code'
  const modeOptions: { value: ViewMode; label: string }[] = draft !== null
    ? [{ value: 'code', label: 'Code' }, { value: 'split', label: 'Split' }]
    : [{ value: 'code', label: 'Code' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }]

  // The editor's own keymap saves while it has focus. Focus often sits on a button instead (the
  // Edit/Changes switch, Cancel), and ⌘S there must still save rather than open the browser's own dialog.
  const saveFromAnywhere = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (draft === null || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return
    event.preventDefault()
    void save(draft.baseHash)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={saveFromAnywhere}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px]">
        <FileTypeIcon path={nameForKind} size={16} />
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={fullPath}>{fullPath}</span>
        {readOnlyReason !== null ? <Badge tone="gray" title={readOnlyReason}>Read-only</Badge> : null}
        {editable && draft === null && file !== null ? (
          <IconButton label="Edit file" onClick={() => onDraft({ text: editorBase, baseHash: file.hash!, dirty: false })}><Icon name="pencil" size={15} /></IconButton>
        ) : null}
        <IconButton label="Reload file" disabled={saving} onClick={reloadFromDisk}><Icon name="refresh" size={15} /></IconButton>
      </div>
      {error !== null ? (
        <div className="flex flex-col items-start gap-2 p-3">
          <ErrorNotice raw={error} />
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      ) : loading && file === null ? (
        <div className="flex items-center gap-2 p-3 text-sm text-fg-muted" role="status"><Spinner size={13} />Loading file…</div>
      ) : file !== null ? (
        <>
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3 text-xs text-fg-muted">
            <span className="font-mono">{file.binary ? 'binary' : language}{file.truncated && !file.binary ? ` · first ${Math.round(file.content.length / 1024)} KB of ${Math.round(file.size / 1024)} KB` : ''}</span>
            <span className="flex items-center gap-2">
              {!file.binary && previewKind !== null ? (
                <Segmented<ViewMode> label="View mode" size="compact" value={mode} options={modeOptions} onChange={chooseMode} />
              ) : null}
              {!file.binary ? <CopyButton text={draft?.text ?? file.content} label="Copy file contents" /> : null}
            </span>
          </div>
          {draft !== null && !file.binary ? (
            <EditBar
              dirty={draft.dirty}
              saving={saving}
              review={comparing ? null : review}
              onReview={(next) => { setComparing(false); setReview(next) }}
              onCancel={cancelEdit}
              onSave={() => void save(draft.baseHash)}
            />
          ) : null}
          {conflict !== null && draft !== null ? (
            <ConflictBanner busy={saving} comparing={comparing} onCompare={() => void toggleCompare()} onReload={reloadFromDisk} onOverwrite={() => setAsk('overwrite')} />
          ) : null}
          {saveError !== null ? <div className="shrink-0 px-3 py-2"><ErrorNotice raw={saveError} /></div> : null}
          {file.binary ? (
            <div className="min-h-0 flex-1 overflow-auto" role="region" aria-label={`Preview of ${path}`}>
              <MediaPreview workspaceId={workspaceId} projectId={projectId} path={path} layout="full" />
            </div>
          ) : (
            <div className="@container flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col @xl:flex-row">
                {showCode ? (
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {file.truncated ? <TruncationNotice /> : null}
                    <Suspense fallback={<div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-fg-muted" role="status"><Spinner size={13} />Loading editor…</div>}>
                      <CodePane
                        fileName={nameForKind}
                        value={shownText}
                        editable={draft !== null && !saving}
                        indent={indent}
                        focus={focus}
                        compare={compare}
                        ariaLabel={draft !== null ? `Edit ${path}` : `Contents of ${path}`}
                        facts={facts}
                        onChange={(text) => { if (draft !== null) onDraft({ ...draft, text, dirty: text !== editorBase || draft.baseHash !== file.hash }) }}
                        onSave={() => { if (draft !== null) void save(draft.baseHash) }}
                        onCancel={cancelEdit}
                      />
                    </Suspense>
                  </div>
                ) : null}
                {showPreview && previewKind !== null ? (
                  <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', showCode && 'border-t border-line @xl:border-l @xl:border-t-0')}>
                    <FilePreview kind={previewKind} path={nameForKind} content={previewText} truncated={file.truncated} />
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </>
      ) : null}
      {ask !== null ? (
        <ConfirmDialog
          open
          title={ASKS[ask].title}
          confirmLabel={ASKS[ask].confirm}
          tone="danger"
          onConfirm={confirmAsk}
          onDismiss={() => setAsk(null)}
          body={<p className="m-0">{ASKS[ask].body}</p>}
        />
      ) : null}
    </div>
  )
}
