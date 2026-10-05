import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import CopyButton from '../common/CopyButton.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { readProjectFile, type ProjectFileView } from '../../lib/api.ts'
import type { ViewerFocus } from '../../hooks/useWorkbenchFiles.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { MediaPreview } from '../common/MediaPreview.tsx'
import { escapeHtml, ensureLanguage, highlight, languageOfFile } from '../../lib/highlight.ts'

/** Above this size files render as plain escaped text to keep the viewer responsive. */
const HIGHLIGHT_LIMIT = 200_000

/** Read-only file view: path bar, language, copy, and line-numbered highlighted content. */
export function FileViewer({ workspaceId, projectId, projectPath, path, focus = null }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly projectPath: string
  readonly path: string
  /** The window the caller opened this file at; null lands at the top. */
  readonly focus?: ViewerFocus | null
}) {
  const [file, setFile] = useState<ProjectFileView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
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
      const next = await readProjectFile(workspaceId, projectId, path)
      if (generation.current === request) setFile(next)
    } catch (cause) {
      if (generation.current === request) setError(String(cause))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [workspaceId, projectId, path])

  useEffect(() => { void load() }, [load])

  const language = languageOfFile(path)
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
  const fullPath = `${projectPath.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px]">
        <FileTypeIcon path={path} size={16} />
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={fullPath}>{fullPath}</span>
        <IconButton label="Reload file" onClick={() => void load()}><Icon name="refresh" size={15} /></IconButton>
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
