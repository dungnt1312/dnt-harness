import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import Icon from '../common/Icon.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { FileViewer } from './FileViewer.tsx'
import { cn } from '../../lib/cn.ts'
import type { WorkbenchFiles } from '../../hooks/useWorkbenchFiles.ts'
import type { WorkbenchProject } from './Workbench.tsx'

const TREE_LIMITS = { min: 0.18, max: 0.6, default: 0.34 } as const

/** File viewer on the left and a collapsible, resizable tree on the right. */
export function FilesWorkspace({ workspaceId, project, files, treeVisible, treeFraction, onTreeFraction }: {
  readonly workspaceId: string
  readonly project: WorkbenchProject
  readonly files: WorkbenchFiles
  readonly treeVisible: boolean
  readonly treeFraction: number
  readonly onTreeFraction: (value: number) => void
}) {
  const fraction = useRef(treeFraction)
  const treeRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startX: number; startFraction: number; width: number; userSelect: string } | null>(null)
  useEffect(() => () => {
    if (drag.current !== null) document.body.style.userSelect = drag.current.userSelect
  }, [])
  const setWidth = (value: number): void => {
    fraction.current = Math.round(Math.min(TREE_LIMITS.max, Math.max(TREE_LIMITS.min, value)) * 1000) / 1000
    if (treeRef.current !== null) treeRef.current.style.width = `${fraction.current * 100}%`
    handleRef.current?.setAttribute('aria-valuenow', String(Math.round(fraction.current * 100)))
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return
    document.body.style.userSelect = drag.current.userSelect
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onTreeFraction(fraction.current)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.08 : 0.02
    const next = event.key === 'ArrowLeft' ? fraction.current + step
      : event.key === 'ArrowRight' ? fraction.current - step
        : event.key === 'Home' ? TREE_LIMITS.max
          : event.key === 'End' ? TREE_LIMITS.min : null
    if (next === null) return
    event.preventDefault()
    setWidth(next)
    onTreeFraction(fraction.current)
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {files.activeFile !== null
          ? <FileViewer key={`${project.id}:${files.activeFile}`} workspaceId={workspaceId} projectId={project.id} projectPath={project.path} path={files.activeFile} focus={files.focus} />
          : <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"><Icon name="fileText" size={22} className="text-fg-faint" /><p className="m-0 text-sm text-fg-muted">Open a file from the tree.</p></div>}
      </div>
      <div
        ref={handleRef}
        role="separator"
        tabIndex={treeVisible ? 0 : -1}
        aria-label="Resize file tree"
        aria-orientation="vertical"
        aria-valuemin={18}
        aria-valuemax={60}
        aria-valuenow={Math.round(treeFraction * 100)}
        onPointerDown={(event) => {
          if (event.button !== 0 || !treeVisible) return
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { startX: event.clientX, startFraction: fraction.current, width: event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0, userSelect: document.body.style.userSelect }
          document.body.style.userSelect = 'none'
        }}
        onPointerMove={(event) => {
          if (drag.current === null || drag.current.width === 0) return
          setWidth(drag.current.startFraction + (drag.current.startX - event.clientX) / drag.current.width)
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => { setWidth(TREE_LIMITS.default); onTreeFraction(fraction.current) }}
        className={cn('group relative w-px shrink-0 touch-none cursor-col-resize bg-line outline-none focus-visible:bg-link', !treeVisible && 'hidden')}
      >
        <span aria-hidden="true" className="absolute inset-y-0 -left-3 -right-3 group-hover:bg-line/60" />
      </div>
      <div ref={treeRef} className={cn('min-h-0 min-w-0 shrink-0 flex-col', treeVisible ? 'flex' : 'hidden')} style={{ width: `${treeFraction * 100}%` }}>
        <FileBrowser key={project.id} workspaceId={workspaceId} project={project} activeFile={files.activeFile} onOpenFile={files.openFile} />
      </div>
    </div>
  )
}
