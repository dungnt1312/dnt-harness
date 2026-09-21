import { lazy, Suspense, useMemo, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { ArtifactsPanel, type OpenPathResolver } from '../artifacts/ArtifactsPanel.tsx'
import { ContextPanel, type ContextPanelProps } from '../layout/ContextPanel.tsx'
import { AgentRunsPanel } from './AgentRunsPanel.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { FileViewer } from './FileViewer.tsx'
import { baseName } from '../../lib/project-paths.ts'
import { fileStyle } from '../../lib/file-icons.ts'
import { cn } from '../../lib/cn.ts'
import type { WorkbenchFiles } from '../../hooks/useWorkbenchFiles.ts'
import { ANCHOR_VIEW, clampInspectorTab, normalizeInspectorViews, type WorkbenchViewName } from '../../lib/workbench-preferences.ts'
import type { SseEvent } from '../../lib/types.ts'

// One source for the view names: the stored preference and this component
// must not be able to drift apart.
export type WorkbenchView = WorkbenchViewName

const VIEW_META: Readonly<Record<WorkbenchView, { readonly icon: 'folder' | 'info' | 'layers' | 'gitBranch' | 'terminal'; readonly label: string }>> = {
  files: { icon: 'folder', label: 'Files' },
  context: { icon: 'info', label: 'Context' },
  artifacts: { icon: 'layers', label: 'Artifacts' },
  agents: { icon: 'gitBranch', label: 'Agents' },
  terminal: { icon: 'terminal', label: 'Terminal' },
}

/** Picker order; the strip itself keeps the order the operator opened views in. */
const VIEW_ORDER = Object.keys(VIEW_META) as readonly WorkbenchView[]

// xterm is ~250KB: it must not sit in the entry bundle for the readers who
// never open a terminal.
const TerminalPanel = lazy(async () => import('./TerminalPanel.tsx'))

export interface WorkbenchProject {
  readonly id: string
  readonly name: string
  readonly path: string
}

const tabClass = 'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-fg-muted transition-colors hover:bg-hover hover:text-fg'

function ViewTab({ view, active, onClick, onClose }: {
  readonly view: WorkbenchView
  readonly active: boolean
  readonly onClick: () => void
  /** Absent for the anchor view, which cannot be closed. */
  readonly onClose?: () => void
}) {
  const { icon, label } = VIEW_META[view]
  if (onClose === undefined) {
    return (
      <button type="button" aria-pressed={active} onClick={onClick} className={cn(tabClass, active && 'bg-muted text-fg')}>
        <Icon name={icon} size={15} />
        {label}
      </button>
    )
  }
  return (
    <span className={cn('group flex h-8 shrink-0 items-center rounded-lg', active ? 'bg-muted' : 'hover:bg-hover')}>
      <button type="button" aria-pressed={active} onClick={onClick} className={cn('flex h-full items-center gap-1.5 pl-2.5 pr-1 text-[13px]', active ? 'text-fg' : 'text-fg-muted hover:text-fg')}>
        <Icon name={icon} size={15} />
        {label}
      </button>
      <button type="button" aria-label={`Close ${label}`} title="Close" onClick={onClose} className="mr-1 flex size-5 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg">
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}

/**
 * The workbench: the Files anchor plus whichever of Context / Artifacts /
 * Agents / Terminal the operator has opened from the picker, and one closable
 * tab per opened file. Views are opened on demand rather than all shown at
 * once, because a nav holding every view leaves no room for file tabs.
 *
 * File bodies come from the project browsing endpoints rather than tool output.
 * Terminal is the deliberate interactive exception: a user-driven shell,
 * separate from the agent loop and from the session log.
 */
export function Workbench({ workspaceId, project, view, onView, views, onViews, files, context, events, expanded, onToggleExpand, onClose, openPath, sessionId = null, onOpenChild, onOpenAgentSettings, terminalShell = null, onTerminalShell }: {
  readonly workspaceId: string | null
  /** The project whose files are browsable; null for chat-only conversations. */
  readonly project: WorkbenchProject | null
  readonly view: WorkbenchView
  readonly onView: (view: WorkbenchView) => void
  /**
   * Opened view tabs in strip order; normalized here, so a stale list is safe.
   * The selected view is clamped to this list, never folded back into it: a
   * close must be able to remove the tab it just closed.
   */
  readonly views: readonly WorkbenchView[]
  readonly onViews: (views: readonly WorkbenchView[]) => void
  readonly files: WorkbenchFiles
  readonly context: ContextPanelProps
  readonly events: readonly SseEvent[]
  readonly expanded: boolean
  readonly onToggleExpand?: () => void
  readonly onClose: () => void
  readonly openPath?: OpenPathResolver
  /** Root conversation the Agents view delegates from; null when none is open. */
  readonly sessionId?: string | null
  readonly onOpenChild?: (childSessionId: string) => void
  readonly onOpenAgentSettings?: () => void
  /** Shell the Terminal view opens by itself; null defers to the host's order. */
  readonly terminalShell?: string | null
  readonly onTerminalShell?: (shellId: string | null) => void
}) {
  const showFile = files.activeFile !== null && project !== null && workspaceId !== null
  // One pass: the strip decides, and the selection follows it. Deriving the
  // active view here (rather than asserting `view` into the strip) is what
  // makes a single close click work — see closeView below.
  const openViews = useMemo(() => normalizeInspectorViews(views), [views])
  const activeView = clampInspectorTab(view, openViews)
  const closedViews = VIEW_ORDER.filter((candidate) => !openViews.includes(candidate))

  const selectView = (next: WorkbenchView): void => {
    files.showFixedView()
    // Selecting a view that is not open yet opens it. Doing it here, in one
    // click, keeps the strip and the selection from having to be repaired
    // by whichever patch happens to land second.
    if (!openViews.includes(next)) onViews([...openViews, next])
    onView(next)
  }

  /**
   * Closing a tab reveals its right neighbour, else its left one. The strip
   * is written first and the selection only follows it, and both are patches
   * on one preference object: nothing re-adds the tab being removed, so the
   * first click is the one that takes effect.
   */
  const closeView = (target: WorkbenchView): void => {
    if (target === ANCHOR_VIEW) return
    const index = openViews.indexOf(target)
    const remaining = openViews.filter((candidate) => candidate !== target)
    onViews(remaining)
    if (activeView === target) onView(remaining[Math.min(index, remaining.length - 1)] ?? ANCHOR_VIEW)
  }

  let body: ReactNode
  if (showFile) {
    body = <FileViewer key={`${project.id}:${files.activeFile}`} workspaceId={workspaceId} projectId={project.id} projectPath={project.path} path={files.activeFile!} />
  } else if (activeView === 'files') {
    body = project !== null && workspaceId !== null
      ? <FileBrowser key={project.id} workspaceId={workspaceId} project={project} folder={files.folder} activeFile={files.activeFile} onFolder={files.setFolder} onOpenFile={files.openFile} />
      : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <Icon name="folder" size={22} className="text-fg-faint" />
            <p className="m-0 text-sm font-medium">No project folder for this conversation</p>
            <p className="m-0 max-w-xs text-[13px] text-fg-muted">Start a conversation in a project to browse its files here. Context and Artifacts remain available.</p>
          </div>
        )
  } else if (activeView === 'context') {
    body = <div className="min-h-0 flex-1 overflow-y-auto p-4"><ContextPanel {...context} /></div>
  } else if (activeView === 'terminal') {
    body = (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">Loading terminal…</div>}>
        <TerminalPanel
          workspaceId={workspaceId}
          projectId={project?.id ?? null}
          defaultShell={terminalShell ?? null}
          {...(onTerminalShell !== undefined ? { onDefaultShell: onTerminalShell } : {})}
        />
      </Suspense>
    )
  } else if (activeView === 'agents') {
    body = (
      <AgentRunsPanel
        workspaceId={workspaceId}
        rootSessionId={sessionId}
        {...(onOpenChild !== undefined ? { onOpenChild } : {})}
        {...(onOpenAgentSettings !== undefined ? { onOpenSettings: onOpenAgentSettings } : {})}
      />
    )
  } else {
    body = <div className="min-h-0 flex-1 overflow-y-auto p-4"><ArtifactsPanel events={events} {...(openPath !== undefined ? { openPath } : {})} /></div>
  }

  return (
    <section aria-label="Workbench" className="flex h-full min-h-0 w-full flex-col bg-bg text-fg">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="toolbar" aria-label="Workbench views">
          {openViews.map((openView) => (
            <ViewTab
              key={openView}
              view={openView}
              active={!showFile && activeView === openView}
              onClick={() => selectView(openView)}
              {...(openView === ANCHOR_VIEW ? {} : { onClose: () => closeView(openView) })}
            />
          ))}
          {closedViews.length > 0 ? (
            <Menu
              label="Open a view"
              triggerClassName="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              trigger={() => <Icon name="plus" size={15} />}
            >
              {(close) => closedViews.map((closedView) => (
                <button
                  key={closedView}
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => { close(); selectView(closedView) }}
                >
                  <Icon name={VIEW_META[closedView].icon} size={15} />
                  {VIEW_META[closedView].label}
                </button>
              ))}
            </Menu>
          ) : null}
          {files.openFiles.length > 0 ? <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" /> : null}
            {files.openFiles.map((path) => {
              const active = files.activeFile === path
              const icon = fileStyle(path)
              return (
                <span key={path} className={cn('group flex h-8 shrink-0 items-center rounded-lg', active ? 'bg-muted' : 'hover:bg-hover')}>
                  <button type="button" aria-pressed={active} title={path} onClick={() => files.openFile(path)} className={cn('flex h-full items-center gap-1.5 pl-2.5 pr-1 text-[13px]', active ? 'text-fg' : 'text-fg-muted hover:text-fg')}>
                    <Icon name={icon.name} size={14} className={icon.className} />
                  <span className="max-w-[10rem] truncate">{baseName(path)}</span>
                </button>
                <button type="button" aria-label={`Close ${path}`} title="Close" onClick={() => files.closeFile(path)} className="mr-1 flex size-5 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg">
                  <Icon name="close" size={12} />
                </button>
              </span>
            )
          })}
        </div>
        {onToggleExpand !== undefined ? (
          <IconButton label={expanded ? 'Exit full width' : 'Expand workbench'} onClick={onToggleExpand}>
            <Icon name={expanded ? 'minimize' : 'maximize'} size={16} />
          </IconButton>
        ) : null}
        <IconButton label="Hide workbench" onClick={onClose}><Icon name="close" size={17} /></IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </section>
  )
}
