import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import CopyButton from '../common/CopyButton.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { getSkillFile, readMemoryFile, readProjectFile, saveProjectFile, SaveConflictError, type ProjectFileView } from '../../lib/api.ts'
import { memoryTabOf, skillTabName } from '../../lib/project-paths.ts'
import { writeErrorText } from '../../lib/file-tree.ts'
import type { FileDraft, ViewerFocus } from '../../hooks/useWorkbenchFiles.ts'
import { FileEditor } from './FileEditor.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { MediaPreview } from '../common/MediaPreview.tsx'
import { escapeHtml, ensureLanguage, highlight, languageOfFile } from '../../lib/highlight.ts'

/** Above this size files render as plain escaped text to keep the viewer responsive. */
const HIGHLIGHT_LIMIT = 200_000

/** A skill's SKILL.md in the shape the viewer renders a project file. */
async function readSkillMd(workspaceId: string, projectId: string, name: string): Promise<ProjectFileView> {
  const file = await getSkillFile(workspaceId, name, 'SKILL.md', projectId)
  return { path: file.path, size: file.bytes, binary: false, truncated: false, content: file.content }
}

/** File view: path bar, language, copy, and line-numbered highlighted content; project files can be edited in place. */
export function FileViewer({ workspaceId, projectId, projectPath, path, focus = null, draft, onDraft }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly projectPath: string
  readonly path: string
  /** The window the caller opened this file at; null lands at the top. */
  readonly focus?: ViewerFocus | null
  /** The unsaved edit for this tab, owned by the caller so it survives tab switches. */
  readonly draft: FileDraft | null
  readonly onDraft: (draft: FileDraft | null) => void
}) {
  const [file, setFile] = useState<ProjectFileView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  // Edit-flow state is local: the viewer remounts per tab, only the draft survives.
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** The disk hash reported by a refused save; non-null shows the conflict banner. */
  const [conflict, setConflict] = useState<string | null>(null)
  const savingRef = useRef(false)
  // A save outlives a tab switch; its result must not touch the draft of a viewer that is gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // A skill tab reads SKILL.md from whichever layer owns the skill, which may
  // be outside the project folder.
  const skill = skillTabName(path)
  // A memory tab reads from the workspace's memory folders, also outside the project.
  const memory = memoryTabOf(path)
  const scrollRef = useRef<HTMLDivElement>(null)
  const numbersRef = useRef<HTMLPreElement>(null)
  // Measured, never assumed: the gutter shares the content's line grid, and a
  // reader's root font size may not be the one this was designed at.
  const [metrics, setMetrics] = useState<{ lineHeight: number; offset: number } | null>(null)

  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = skill !== null
        ? await readSkillMd(workspaceId, projectId, skill)
        : memory !== null
          ? await readMemoryFile(workspaceId, memory.file, memory.projectId)
          : await readProjectFile(workspaceId, projectId, path)
      if (generation.current === request) setFile(next)
    } catch (cause) {
      if (generation.current === request) setError(String(cause))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [workspaceId, projectId, path, skill, memory?.file, memory?.projectId])

  useEffect(() => { void load() }, [load])

  const clearEditState = (): void => { setSaveError(null); setConflict(null) }

  /** Writes the draft; `expectedHash` is the draft's base unless Overwrite supplies the current disk hash. */
  const save = async (expectedHash: string): Promise<void> => {
    if (draft === null || file === null || !draft.dirty || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const result = await saveProjectFile(workspaceId, projectId, path, draft.text, expectedHash)
      if (!mounted.current) return
      setFile({ ...file, content: draft.text, size: result.size, hash: result.hash })
      clearEditState()
      onDraft(null)
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

  const cancelEdit = (): void => {
    if (savingRef.current) return
    if (draft?.dirty === true && !window.confirm('Discard unsaved changes?')) return
    clearEditState()
    onDraft(null)
  }

  /** Drops the draft and re-reads the file; asks first when there is something to lose. */
  const reloadFromDisk = (): void => {
    if (savingRef.current) return
    if ((draft?.dirty === true || conflict !== null) && !window.confirm('Discard your changes and load the file from disk?')) return
    clearEditState()
    if (draft !== null) onDraft(null)
    void load()
  }

  const overwrite = (): void => {
    if (conflict === null || !window.confirm('Overwrite the file on disk with your changes?')) return
    void save(conflict)
  }

  const language = languageOfFile(skill !== null ? 'SKILL.md' : memory !== null ? memory.file : path)
  // The grammar loads after first paint: big files never wait on it, and the
  // escaped text is already correct before the highlighted pass re-renders.
  const [grammarReady, setGrammarReady] = useState(language === 'text')
  useEffect(() => {
    if (language === 'text') return
    let live = true
    void ensureLanguage(language).then((ok) => {
      if (live && ok) setGrammarReady(true)
    })
    return () => { live = false }
  }, [language])
  const html = useMemo(() => {
    if (file === null || file.binary) return ''
    if (file.content.length > HIGHLIGHT_LIMIT || !grammarReady) return escapeHtml(file.content)
    return highlight(file.content, language)
  }, [file, language, grammarReady])
  const lineCount = file === null || file.binary ? 0 : file.content.replace(/\n$/, '').split('\n').length

  useLayoutEffect(() => {
    const numbers = numbersRef.current
    if (numbers === null || lineCount === 0) return
    const style = getComputedStyle(numbers)
    const top = Number.parseFloat(style.paddingTop)
    const bottom = Number.parseFloat(style.paddingBottom)
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return
    const height = (numbers.clientHeight - top - bottom) / lineCount
    if (!Number.isFinite(height) || height <= 0) return
    setMetrics({ lineHeight: height, offset: top })
  }, [lineCount, html])

  // Landing on the lines a tool read, rather than the top of a 2000-line file.
  useEffect(() => {
    const container = scrollRef.current
    if (focus === null || container === null || metrics === null || lineCount === 0) return
    const target = Math.min(Math.max(focus.line, 1), lineCount)
    const top = metrics.offset + (target - 1) * metrics.lineHeight
    container.scrollTop = Math.max(0, top - container.clientHeight / 3)
  }, [focus?.line, focus?.seq, metrics, lineCount])

  const band = focus !== null && metrics !== null && lineCount > 0
    ? {
        top: metrics.offset + (Math.min(Math.max(focus.line, 1), lineCount) - 1) * metrics.lineHeight,
        height: Math.min(Math.max(focus.lines ?? 1, 1), Math.max(lineCount - focus.line + 1, 1)) * metrics.lineHeight,
      }
    : null
  const separator = projectPath.includes('\\') ? '\\' : '/'
  const fullPath = skill !== null
    ? `Skill · ${skill}/SKILL.md`
    : memory !== null
      ? `Memory · ${memory.projectId !== undefined ? 'project' : 'workspace'} · ${memory.file}`
      : `${projectPath.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`
  const iconPath = skill !== null ? 'SKILL.md' : memory !== null ? memory.file : path

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px]">
        <FileTypeIcon path={iconPath} size={16} />
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={fullPath}>{fullPath}</span>
        {skill === null && memory === null && file?.editable === true && file.hash !== undefined && draft === null ? (
          <IconButton label="Edit file" onClick={() => onDraft({ text: file.content, baseHash: file.hash!, dirty: false })}><Icon name="pencil" size={15} /></IconButton>
        ) : null}
        <IconButton label="Reload file" onClick={reloadFromDisk}><Icon name="refresh" size={15} /></IconButton>
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
            {!file.binary ? <CopyButton text={file.content} label="Copy file contents" className="size-7" /> : null}
          </div>
          {file.binary ? (
            <div className="min-h-0 flex-1 overflow-auto" role="region" aria-label={`Preview of ${path}`}>
              <MediaPreview workspaceId={workspaceId} projectId={projectId} path={path} layout="full" />
            </div>
          ) : draft !== null ? (
            <FileEditor
              path={path}
              text={draft.text}
              dirty={draft.dirty}
              saving={saving}
              error={saveError}
              conflict={conflict !== null}
              onChange={(text) => onDraft({ ...draft, text, dirty: text !== file.content || draft.baseHash !== file.hash })}
              onSave={() => void save(draft.baseHash)}
              onCancel={cancelEdit}
              onReload={reloadFromDisk}
              onOverwrite={overwrite}
            />
          ) : (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" role="region" aria-label={`Contents of ${path}`} tabIndex={0}>
              {file.truncated ? <p className="m-0 border-b border-line bg-warn-soft px-3 py-1.5 text-xs text-warn">File is larger than 1 MB; only the beginning is shown.</p> : null}
              <div className="relative flex min-w-max font-mono text-[12.5px] leading-5">
                {/* The lines the caller opened this file for. Both columns are
                    positioned, so the band stays behind their text. */}
                {band !== null ? <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bg-warn-soft" style={{ top: band.top, height: band.height }} /> : null}
                <pre ref={numbersRef} aria-hidden="true" className="relative m-0 select-none py-2 pl-3 pr-4 text-right text-fg-faint">
                  {Array.from({ length: lineCount }, (_, index) => index + 1).join('\n')}
                </pre>
                <pre className="relative m-0 py-2 pr-6"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
