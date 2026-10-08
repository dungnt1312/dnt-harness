import { lazy, memo, Suspense, useMemo, useState, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import type { OpenPathResolver } from '../../lib/project-paths.ts'
import { ContextPanel, type ContextPanelProps } from '../layout/ContextPanel.tsx'
import { AgentRunsPanel } from './AgentRunsPanel.tsx'
import { TrajectoryPanel } from './TrajectoryPanel.tsx'
import { FilesWorkspace } from './FilesWorkspace.tsx'
import { GitPanel } from './GitPanel.tsx'
import { ProcessPanel } from './ProcessPanel.tsx'

const TerminalPanel = lazy(async () => import('./TerminalPanel.tsx'))
import { baseName } from '../../lib/project-paths.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { cn } from '../../lib/cn.ts'
import type { WorkbenchFiles } from '../../hooks/useWorkbenchFiles.ts'
import { ANCHOR_VIEW, clampInspectorTab, normalizeInspectorViews, type WorkbenchViewName } from '../../lib/workbench-preferences.ts'
import type { SseEvent } from '../../lib/types.ts'

// One source for the view names: the stored preference and this component
// must not be able to drift apart.
export type WorkbenchView = WorkbenchViewName

const VIEW_META: Readonly<Record<WorkbenchView, { readonly icon: 'folder' | 'info' | 'gitBranch' | 'clock' | 'terminal'; readonly label: string }>> = {
  files: { icon: 'folder', label: 'Files' },
  git: { icon: 'gitBranch', label: 'Git' },
  context: { icon: 'info', label: 'Context' },
  agents: { icon: 'gitBranch', label: 'Subagents' },
  trajectory: { icon: 'clock', label: 'Trajectory' },
  terminal: { icon: 'terminal', label: 'Terminal' },
  process: { icon: 'terminal', label: 'Processes' },
}

/** Picker order; the strip itself keeps the order the operator opened views in. */
const VIEW_ORDER = Object.keys(VIEW_META) as readonly WorkbenchView[]

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
 * The workbench: the Files anchor plus whichever of Context / Trajectory /
 * Subagents the operator has opened from the picker, and one closable tab per
 * opened file. Views are opened on demand rather than all shown at once,
 * because a nav holding every view leaves no room for file tabs.
 *
 * File bodies come from the project browsing endpoints rather than tool output.
 * Terminal is a view tab like the others (Ctrl+` opens it). The chat column
 * has a separate footer terminal; this panel does not own that one.
 *
 * Memoized with a custom comparator: the shell re-renders every streaming
 * frame, and this panel only consumes the log through the Trajectory and
 * Subagents views. The log props are compared by identity for everything
 * else, and treated as "changed" only when one of those two views is open —
 * a frames-long stream of chunks never re-renders Files, Git, Context or the
 * tab strip. (`events`/`agentEvents` are new arrays per frame by design; the
 * views that read them re-render on their own `useMemo` deps instead.)
 */
export const Workbench = memo(function Workbench({ workspaceId, project, agentsProjectId = null, view, onView, views, onViews, files, context, events, agentEvents, expanded, onToggleExpand, onClose, openPath, sessionId = null, agentsSessionId = null, onOpenChild, terminalShell = null, onTerminalShell, bindingReady = true, gitPathFilter = null, gitFocusPath = null, onClearGitFilter, processFocus = null }: {
  readonly workspaceId: string | null
  /** The project whose files are browsable; null for chat-only conversations. */
  readonly project: WorkbenchProject | null
  /** Project binding of the root delegation session, not necessarily the viewed child. */
  readonly agentsProjectId?: string | null
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
  /** The conversation open in the chat column; the Process view's scope. */
  readonly sessionId?: string | null
  /**
   * The conversation whose delegation the Subagents view lists — the root
   * while a subagent is open (a child has no children of its own); falls back
   * to `sessionId`.
   */
  readonly agentsSessionId?: string | null
  readonly onOpenChild?: (childSessionId: string) => void
  /**
   * The delegation source conversation's log, when it is not the viewed one
   * (a second stream keeps the root's log alive while a child is open). The
   * Subagents view derives row briefs and its refresh signal from it.
   */
  readonly agentEvents?: readonly SseEvent[]
  /** Shell the Terminal tab opens without being asked. */
  readonly terminalShell?: string | null
  readonly onTerminalShell?: (shellId: string | null) => void
  /**
   * Whether the conversation binding behind `project` is final. False while
   * the session list loads (a restored Terminal tab would otherwise auto-open
   * its shell before the project is known, landing it in the host's default
   * folder instead of the conversation's project).
   */
  readonly bindingReady?: boolean
  /** The background process the Environment panel focused, if any. */
  readonly processFocus?: string | null
  /**
   * Project-relative paths the Git view narrows to while reviewing one turn's
   * recorded writes; null shows every change. Set by a card's Review all.
   */
  readonly gitPathFilter?: readonly string[] | null
  /** The Git view row a card's file click opened, pre-expanded to its diff. */
  readonly gitFocusPath?: { readonly path: string; readonly nonce: number } | null
  /** Clears the turn filter (the banner's Show all). */
  readonly onClearGitFilter?: () => void
}) {
  // The file tree defaults off on touch: a 380px sheet gives it ~130px, too
  // narrow to browse and too narrow to leave for the file the reader opened.
  const [treeVisible, setTreeVisible] = useState(() => typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: coarse)').matches)
  const [treeFraction, setTreeFraction] = useState(0.34)
  // One pass: the strip decides, and the selection follows it. Deriving the
  // active view here (rather than asserting `view` into the strip) is what
  // makes a single close click work — see closeView below.
  const openViews = useMemo(() => normalizeInspectorViews(views), [views])
  const activeView = clampInspectorTab(view, openViews)
  const closedViews = VIEW_ORDER.filter((candidate) => !openViews.includes(candidate))
  // Delegation lands in the root's own log, whether the user or the model
  // started it: the Subagents view refreshes off that traffic and reads each
  // child's brief from it. While a child is open that log is the parent's,
  // streamed separately from the viewed conversation's own events.
  const delegation = useMemo(() => {
    let count = 0
    const briefs = new Map<string, string>()
    for (const event of agentEvents ?? events) {
      if (event.type !== 'agent/child-spawn' && event.type !== 'agent/child-result') continue
      count += 1
      const brief = event.brief ?? event.objective
      if (event.type === 'agent/child-spawn' && event.childSessionId !== undefined && brief !== undefined) briefs.set(event.childSessionId, brief)
    }
    return { count, briefs }
  }, [agentEvents, events])

  const selectView = (next: WorkbenchView): void => {
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

  let body: ReactNode = null
  if (activeView === 'files') {
    body = project !== null && workspaceId !== null ? (
      <FilesWorkspace key={project.id} workspaceId={workspaceId} project={project} files={files} treeVisible={treeVisible} treeFraction={treeFraction} onTreeFraction={setTreeFraction} />
    ) : (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="folder" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">No project folder for this conversation</p>
        <p className="m-0 max-w-xs text-[13px] text-fg-muted">Start a conversation in a project to browse its files here. Context and Trajectory remain available.</p>
      </div>
    )
  } else if (activeView === 'context') {
    body = <div className="min-h-0 flex-1 overflow-y-auto p-4"><ContextPanel {...context} /></div>
  } else if (activeView === 'trajectory') {
    body = <TrajectoryPanel events={events} workspaceId={workspaceId} sessionId={sessionId} {...(openPath !== undefined ? { openPath } : {})} />
  } else if (activeView === 'git') {
    body = project !== null && workspaceId !== null
      ? <GitPanel
          key={project.id}
          workspaceId={workspaceId}
          project={project}
          {...(gitPathFilter !== null && gitPathFilter.length > 0 ? { pathFilter: gitPathFilter } : {})}
          {...(gitFocusPath !== null ? { focusPath: gitFocusPath.path, focusNonce: gitFocusPath.nonce } : {})}
          {...(openPath !== undefined ? { onOpenFile: (path: string) => { openPath(`${project.path}/${path}`)?.() } } : {})}
          {...(onClearGitFilter !== undefined ? { onShowAll: onClearGitFilter } : {})}
        />
      : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Icon name="gitBranch" size={22} className="text-fg-faint" />
          <p className="m-0 text-sm font-medium">No project folder for this conversation</p>
          <p className="m-0 max-w-xs text-[13px] text-fg-muted">Start a conversation in a project to see its git changes here.</p>
        </div>
      )
  } else if (activeView === 'agents') {
    body = (
      <AgentRunsPanel
        workspaceId={workspaceId}
        rootSessionId={agentsSessionId ?? sessionId}
        rootProjectId={agentsProjectId}
        briefs={delegation.briefs}
        refreshSignal={delegation.count}
        {...(onOpenChild !== undefined ? { onOpenChild } : {})}
      />
    )
  } else if (activeView === 'terminal') {
    body = (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">Loading terminal…</div>}>
        <TerminalPanel
          key={project?.id ?? 'workspace'}
          workspaceId={workspaceId}
          projectId={project?.id ?? null}
          defaultShell={terminalShell}
          onDefaultShell={onTerminalShell ?? (() => undefined)}
          bindingReady={bindingReady}
        />
      </Suspense>
    )
  } else if (activeView === 'process') {
    body = sessionId !== null && workspaceId !== null
      ? <ProcessPanel workspaceId={workspaceId} sessionId={sessionId} processId={processFocus ?? null} />
      : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Icon name="terminal" size={22} className="text-fg-faint" />
          <p className="m-0 text-sm font-medium">No conversation open</p>
          <p className="m-0 max-w-xs text-[13px] text-fg-muted">Background processes belong to a conversation; open one to see them here.</p>
        </div>
      )
  }

  return (
    <section aria-label="Workbench" className="flex h-full min-h-0 w-full flex-col bg-bg text-fg">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="toolbar" aria-label="Workbench views">
          {openViews.map((openView) => (
            <ViewTab
              key={openView}
              view={openView}
              active={activeView === openView}
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
        </div>
        {activeView === 'files' && project !== null ? (
          <IconButton label={treeVisible ? 'Hide file tree' : 'Show file tree'} aria-pressed={treeVisible} onClick={() => setTreeVisible((visible) => !visible)}>
            <Icon name="folder" size={16} />
          </IconButton>
        ) : null}
        {onToggleExpand !== undefined ? (
          <IconButton label={expanded ? 'Exit full width' : 'Expand workbench'} onClick={onToggleExpand}>
            <Icon name={expanded ? 'minimize' : 'maximize'} size={16} />
          </IconButton>
        ) : null}
        <IconButton label="Hide workbench" onClick={onClose}><Icon name="close" size={17} /></IconButton>
      </div>
      {activeView === 'files' && files.openFiles.length > 0 ? (
        <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-bg" role="group" aria-label="Open files">
          {files.openFiles.map((path) => {
            const active = files.activeFile === path
            return (
              <span key={path} className={cn('group relative flex h-full shrink-0 items-center border-r border-line', active ? 'bg-bg' : 'bg-muted/40 hover:bg-hover')}>
                <button type="button" aria-pressed={active} title={path} onClick={() => files.openFile(path)} className={cn('flex h-full items-center gap-1.5 pl-3 pr-1 text-[13px]', active ? 'text-fg' : 'text-fg-muted hover:text-fg')}>
                  <FileTypeIcon path={path} size={14} />
                  <span className="max-w-[12rem] truncate">{baseName(path)}</span>
                </button>
                <button type="button" aria-label={`Close ${path}`} title="Close" onClick={() => files.closeFile(path)} className={cn('mr-1 flex size-5 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg [@media(pointer:coarse)]:size-7', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100')}>
                  <Icon name="close" size={12} />
                </button>
                {active ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-link" /> : null}
              </span>
            )
          })}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </section>
  )
}, (previous, next) => {
  // Log props (events, agentEvents, context.eventCount) arrive fresh each
  // streamed frame; only the views that read the log re-render for them.
  const logReads = next.view === 'trajectory' || next.view === 'agents'
  if (logReads && (previous.events !== next.events || previous.agentEvents !== next.agentEvents)) return false
  return previous.workspaceId === next.workspaceId
    && previous.project === next.project
    && previous.agentsProjectId === next.agentsProjectId
    && previous.view === next.view
    && previous.views === next.views
    && previous.files === next.files
    && previous.context === next.context
    && previous.expanded === next.expanded
    && previous.onToggleExpand === next.onToggleExpand
    && previous.onClose === next.onClose
    && previous.openPath === next.openPath
    && previous.sessionId === next.sessionId
    && previous.agentsSessionId === next.agentsSessionId
    && previous.onOpenChild === next.onOpenChild
    && previous.terminalShell === next.terminalShell
    && previous.onTerminalShell === next.onTerminalShell
    && previous.bindingReady === next.bindingReady
    && previous.processFocus === next.processFocus
    && previous.gitPathFilter === next.gitPathFilter
    && previous.gitFocusPath === next.gitFocusPath
    && previous.onClearGitFilter === next.onClearGitFilter
})
