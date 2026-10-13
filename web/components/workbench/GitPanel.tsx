import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { useToast } from '../common/Toast.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import {
  fetchGitStatus,
  updateProjectGitTrust,
  type GitChange,
  type GitOperationDone,
  type GitOperationInput,
  type GitStaging,
  type GitStatusReport,
} from '../../lib/api.ts'
import { GitChangeList, withPendingStages } from './GitChangeList.tsx'
import { GitCommitArea } from './GitCommitArea.tsx'
import { GitDiffPane } from './GitDiffPane.tsx'
import { GitRemoteButton } from './GitRemoteButton.tsx'
import { GitSplit, readSplit, writeSplit, type GitSplitState } from './GitSplit.tsx'
import { failureText, useGitOperation } from './use-git-operation.tsx'
import { changeCounts, confirmationForEntries, groupChanges, primaryChangesActionStages, type GitConfirmation } from './git-panel-model.ts'
import type { WorkbenchProject } from './Workbench.tsx'

/**
 * Source control for the conversation's project: the changed files in Zed's
 * sections with their added and removed line counts, the diff of the one that
 * is open, and the staging, discard and trash actions. Every action goes
 * through one queue, so operations on the repository never overlap; a staging
 * click shows its result at once and rolls back if Git refuses.
 *
 * `pathFilter` narrows the list to the files one turn's Write/Edit calls
 * recorded (project-relative, from the TurnChangesCard's "Open in Git"). The
 * rows are still git's own status rows — every uncommitted change in those
 * files, not the turn's alone — and the banner says so. `onShowAll` clears it.
 *
 * `focusPath` opens with one row already expanded to its diff (a chat card's
 * file click); another click from chat moves the expansion, while toggling
 * rows here stays the user's own. When the focused file no longer differs
 * from HEAD, a note says so instead of an unexplained quiet list.
 */
export function GitPanel({ workspaceId, project, pathFilter, focusPath, focusNonce, onOpenFile, onShowAll, onGitTrustChange }: {
  readonly workspaceId: string
  readonly project: WorkbenchProject
  readonly pathFilter?: readonly string[]
  readonly focusPath?: string
  /** Bumped on every chat click, so clicking the same file again re-focuses it. */
  readonly focusNonce?: number
  /** Opens a changed file itself in the workbench, when a resolver is wired. */
  readonly onOpenFile?: (path: string) => void
  readonly onShowAll?: () => void
  /** Tells the owner of the project list that the trust flag changed, so a remount does not show a stale banner. */
  readonly onGitTrustChange?: (trusted: boolean) => void
}) {
  const [report, setReport] = useState<GitStatusReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // The row whose diff the pane shows; the first row until the reader picks one.
  const [selectedPath, setSelectedPath] = useState<string | null>(focusPath ?? null)
  // Bumped whenever the status moved, so the pane reads its diff again.
  const [reloadKey, setReloadKey] = useState(0)
  const [split, setSplit] = useState<GitSplitState>(() => readSplit(project.id))
  useEffect(() => { setSplit(readSplit(project.id)) }, [project.id])
  const generation = useRef(0)
  const toast = useToast()
  const git = useGitOperation(workspaceId, project.id)
  // Git runs a repository's config and hooks only for a trusted project (off unless set).
  const [trusted, setTrusted] = useState(project.gitTrusted === true)
  const [trustBusy, setTrustBusy] = useState(false)
  useEffect(() => { setTrusted(project.gitTrusted === true) }, [project.id, project.gitTrusted])
  // Optimistic staging: a clicked control shows its result before Git answers.
  const [pendingStages, setPendingStages] = useState<ReadonlyMap<string, GitStaging>>(() => new Map())
  const inflight = useRef(new Map<string, number>())
  const [running, setRunning] = useState(0)
  const [confirm, setConfirm] = useState<PendingRevert | null>(null)
  // Every Git action waits for the one before it, so the repository sees them in click order.
  const queue = useRef<Promise<void>>(Promise.resolve())

  // The focused row lands at the top of the list — a `nearest` scroll left it
  // on the bottom edge. The row may render only once the status report lands
  // and the diff only after its own fetch, so the focus stays pending until
  // the diff has settled.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const focusRowRef = useRef<HTMLButtonElement | null>(null)
  const pendingFocus = useRef(false)
  const scrollFocusToTop = useCallback(() => {
    const row = focusRowRef.current
    const box = scrollRef.current
    if (row === null || box === null) return
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - 4
  }, [])

  // A new focus from the chat card moves the selection; `null` — Review all —
  // leaves the reader's state alone. The pending flag is armed during render:
  // child effects run before this component's, and an already-shown diff
  // reports ready from its own effect in the same commit.
  const hasFocus = focusPath !== undefined && focusPath !== null && focusPath !== ''
  const focusKey = hasFocus ? `${focusPath}\u0000${focusNonce ?? 0}` : null
  const armedKey = useRef<string | null>(null)
  if (focusKey !== null && armedKey.current !== focusKey) {
    armedKey.current = focusKey
    pendingFocus.current = true
  }
  useEffect(() => {
    if (hasFocus) setSelectedPath(focusPath)
  }, [hasFocus, focusPath, focusNonce])

  useEffect(() => {
    if (pendingFocus.current) scrollFocusToTop()
  }, [focusPath, focusNonce, report, scrollFocusToTop])

  // A new identity per focus: a diff already on screen re-fires it, so a
  // repeat click on the same file settles (and clears) the focus too.
  const onFocusedDiffReady = useCallback(() => {
    if (!pendingFocus.current) return
    pendingFocus.current = false
    scrollFocusToTop()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus identity is the point
  }, [scrollFocusToTop, focusPath, focusNonce])

  const applyReport = useCallback((next: GitStatusReport) => {
    // A newer report than any status read still in flight.
    generation.current++
    setReport(next)
    setLoading(false)
    setReloadKey((key) => key + 1)
    setSelectedPath((current) => current !== null && next.changes.some((change) => change.path === current) ? current : null)
  }, [])

  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchGitStatus(workspaceId, project.id)
      if (generation.current !== request) return
      setReport(next)
      setReloadKey((key) => key + 1)
      setSelectedPath((current) => current !== null && next.changes.some((change) => change.path === current) ? current : null)
    } catch (cause) {
      if (generation.current !== request) return
      setError(String(cause))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [workspaceId, project.id])

  useEffect(() => { void load() }, [load])

  /** Run one Git operation; a failure is a toast with a View Log. Nothing is thrown. */
  const run = git.run

  /** Trust or restrict the project's Git config and hooks; the panel follows at once. */
  const changeTrust = useCallback(async (next: boolean): Promise<void> => {
    setTrustBusy(true)
    try {
      await updateProjectGitTrust(workspaceId, project.id, next)
      setTrusted(next)
      onGitTrustChange?.(next)
      // Trust changes how git reads the repository (hooks, config), so the list may differ.
      void load()
    } catch (cause) {
      toast.notify(failureText(cause), 'bad')
    } finally {
      setTrustBusy(false)
    }
  }, [workspaceId, project.id, toast, onGitTrustChange, load])

  const enqueue = useCallback((task: () => Promise<void>): void => {
    setRunning((count) => count + 1)
    queue.current = queue.current.then(task).catch(() => {}).finally(() => setRunning((count) => count - 1))
  }, [])

  /** Stage or unstage; `all` uses the dedicated stage-all / unstage-all operations. */
  const stage = useCallback((paths: readonly string[], intent: 'stage' | 'unstage', all = false): void => {
    if (paths.length === 0) return
    const target: GitStaging = intent === 'stage' ? 'staged' : 'unstaged'
    setPendingStages((previous) => {
      const next = new Map(previous)
      for (const path of paths) next.set(path, target)
      return next
    })
    for (const path of paths) inflight.current.set(path, (inflight.current.get(path) ?? 0) + 1)
    const input: GitOperationInput = all ? { type: intent === 'stage' ? 'stage-all' : 'unstage-all' } : { type: intent, paths }
    enqueue(async () => {
      const done = await run(input)
      // One commit: the answer replaces the report as the override goes away.
      for (const path of paths) inflight.current.set(path, (inflight.current.get(path) ?? 1) - 1)
      const settled = paths.filter((path) => inflight.current.get(path) === 0)
      for (const path of settled) inflight.current.delete(path)
      setPendingStages((previous) => {
        const next = new Map(previous)
        for (const path of settled) next.delete(path)
        return next
      })
      if (done?.status !== undefined) applyReport(done.status)
      else if (done?.ok === true) void load()
    })
  }, [enqueue, run, applyReport, load])

  /** Ask before discarding or trashing; `menu` names a header menu action. */
  const requestRevert = useCallback((entries: readonly GitChange[], menu?: 'tracked' | 'untracked'): void => {
    const confirmation = confirmationForEntries(entries, menu)
    if (confirmation !== null) setConfirm({ confirmation, entries })
  }, [])

  /** Tracked files are discarded, then untracked ones trashed, each as its own queued operation. */
  const confirmRevert = useCallback((entries: readonly GitChange[]): void => {
    setConfirm(null)
    const tracked = entries.filter((entry) => !entry.created).map((entry) => entry.path)
    const untracked = entries.filter((entry) => entry.created).map((entry) => entry.path)
    enqueue(async () => {
      for (const input of [
        ...(tracked.length > 0 ? [{ type: 'discard', paths: tracked } as const] : []),
        ...(untracked.length > 0 ? [{ type: 'trash', paths: untracked } as const] : []),
      ]) {
        const done = await run(input)
        if (done?.status !== undefined) applyReport(done.status)
        else if (done?.ok === true) void load()
        if (done?.ok !== true) return
      }
    })
  }, [enqueue, run, applyReport, load])

  /** A commit, uncommit or remote operation answered: its status is the new report. */
  const settleOperation = useCallback((done: GitOperationDone | undefined): void => {
    if (done?.status !== undefined) applyReport(done.status)
    else if (done?.ok === true) void load()
  }, [applyReport, load])

  const all = report?.changes ?? []
  const filtered = pathFilter !== undefined && pathFilter.length > 0 ? all.filter((change) => pathFilter.includes(change.path)) : all
  const changes = filtered
  // What the reader sees: a staging click already applied.
  const shown = withPendingStages(changes, pendingStages)
  const counts = changeCounts(shown)
  const stages = primaryChangesActionStages(shown)
  // Zed `staged_tracked_entries` (`is_staged_tracked`): "Discard Tracked Changes" acts on tracked files with something staged.
  const trackedEntries = shown.filter((change) => !change.created && change.staging !== 'unstaged')
  const untrackedEntries = shown.filter((change) => change.created)
  const filteredView = pathFilter !== undefined && pathFilter.length > 0
  // Zed `stage_all` / `unstage_all`; a turn filter keeps them to the files shown.
  const stageHeader = (intent: 'stage' | 'unstage'): void => {
    const paths = shown.filter((change) => intent === 'stage' ? change.staging !== 'staged' : change.staging !== 'unstaged').map((change) => change.path)
    stage(paths, intent, !filteredView)
  }
  // The pane shows the picked row, or the list's first one until a pick is made.
  const firstShown = groupChanges(shown).flatMap((group) => group.entries)[0]
  const current = shown.find((change) => change.path === selectedPath) ?? firstShown
  const totals = changes.reduce((sum, change) => ({
    added: sum.added + (change.added ?? 0),
    removed: sum.removed + (change.removed ?? 0),
  }), { added: 0, removed: 0 })
  // A card click aimed at a file git no longer lists: say so where the row
  // was expected, rather than leaving an unexplained quiet list.
  const focusNote = focusPath !== undefined && focusPath !== null && focusPath !== '' && !loading && report !== null && !changes.some((change) => change.path === focusPath)
    ? (
      <p className="m-0 px-2.5 py-2 text-xs text-fg-faint" role="note">
        {focusPath} no longer differs from HEAD: it was committed, or a later change put it back. The chat card still shows what the turn did.
      </p>
    )
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!trusted ? (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-muted/40 px-2.5 text-[12px]">
          <Icon name="lock" size={13} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate font-medium text-fg-muted" title="Git does not run this repository's config or hooks until you trust the folder.">Restricted Mode</span>
          <Button size="sm" variant="outline" className="h-7 px-2.5" disabled={trustBusy} onClick={() => void changeTrust(true)}>Trust</Button>
        </div>
      ) : null}
      {pathFilter !== undefined && pathFilter.length > 0 ? (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-muted/40 px-2.5 text-[12px]">
          <Icon name="squarePen" size={13} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate text-fg-muted" title="Git compares the working tree with HEAD, so a file's lines include every uncommitted change, not only this turn's.">
            This turn's files · git diff vs HEAD, all uncommitted changes
          </span>
          {onShowAll !== undefined ? (
            <button
              type="button"
              onClick={onShowAll}
              className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-link underline-offset-2 hover:bg-hover hover:underline"
            >
              Show all
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-[13px]">
        <Icon name="gitBranch" size={14} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-medium" title={report?.branch ?? project.path}>{report?.branch ?? project.name}</span>
        {changes.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
            <span className="text-fg-faint">{changes.length}</span>
            {totals.added > 0 ? <span className="text-ok">+{totals.added}</span> : null}
            {totals.removed > 0 ? <span className="text-bad">−{totals.removed}</span> : null}
          </span>
        ) : null}
        {running > 0 ? <span role="status" aria-label="Running git operation" className="shrink-0"><Spinner size={12} /></span> : null}
        {report !== null && changes.length > 0 ? (
          <div className="flex shrink-0 items-center">
            <Button size="sm" variant="outline" className="rounded-r-none border-r-0 px-2.5" onClick={() => stageHeader(stages ? 'stage' : 'unstage')}>
              {stages ? 'Stage All' : 'Unstage All'}
            </Button>
            <Menu
              label="More changes actions"
              align="end"
              triggerClassName="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-l-none rounded-r-full border border-line-strong text-fg hover:bg-hover"
              trigger={() => <Icon name="chevron" size={12} />}
            >
              {(close) => (
                <>
                  <button type="button" role="menuitem" className={menuItemClass} disabled={!counts.hasUnstaged} onClick={() => { close(); stageHeader('stage') }}>Stage All</button>
                  <button type="button" role="menuitem" className={menuItemClass} disabled={!counts.hasStaged} onClick={() => { close(); stageHeader('unstage') }}>Unstage All</button>
                  <button type="button" role="menuitem" className={menuItemClass} disabled={trackedEntries.length === 0} onClick={() => { close(); requestRevert(trackedEntries, 'tracked') }}>Discard Tracked Changes</button>
                  <button type="button" role="menuitem" className={menuItemClass} disabled={untrackedEntries.length === 0} onClick={() => { close(); requestRevert(untrackedEntries, 'untracked') }}>Trash Untracked Files</button>
                </>
              )}
            </Menu>
          </div>
        ) : null}
        {/* Not tied to the change list: a clean, trusted project can still be restricted again. */}
        {trusted ? (
          <Menu
            label="Git options"
            align="end"
            triggerClassName="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg"
            trigger={() => <Icon name="dots" size={14} />}
          >
            {(close) => (
              <button type="button" role="menuitem" className={menuItemClass} disabled={trustBusy} onClick={() => { close(); void changeTrust(false) }}>Restrict Git</button>
            )}
          </Menu>
        ) : null}
        {report !== null && changes.length > 0 ? (
          <IconButton
            label={split.collapsed ? 'Show Diff' : 'Hide Diff'}
            onClick={() => {
              const next = { ratio: split.ratio, collapsed: !split.collapsed }
              writeSplit(project.id, next)
              setSplit(next)
            }}
          >
            <Icon name="panelRight" size={14} />
          </IconButton>
        ) : null}
        <IconButton label="Refresh git status" onClick={() => void load()}><Icon name="refresh" size={14} /></IconButton>
      </div>
      <GitSplit
        projectId={project.id}
        state={split}
        onChange={setSplit}
        diff={report !== null && current !== undefined
          ? (
            <GitDiffPane
              workspaceId={workspaceId}
              projectId={project.id}
              change={current}
              reloadKey={reloadKey}
              run={run}
              enqueue={enqueue}
              onDone={settleOperation}
              onStage={(paths, intent) => stage(paths, intent)}
              onReady={onFocusedDiffReady}
              {...(onOpenFile !== undefined ? { onOpenFile: () => onOpenFile(current.path) } : {})}
            />
          )
          : null}
        list={(
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            {error !== null && report === null ? (
              <div className="flex flex-col items-start gap-2 p-3">
                <ErrorNotice raw={error} />
                <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
              </div>
            ) : loading && report === null ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-fg-muted" role="status"><Spinner size={13} />Checking git…</div>
            ) : changes.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <Icon name="check" size={20} className="text-fg-faint" />
                <p className="m-0 text-sm font-medium">No changes</p>
                <p className="m-0 max-w-xs text-[13px] text-fg-muted">
                  {report?.branch === null
                    ? 'This folder is not a git repository.'
                    : pathFilter !== undefined && pathFilter.length > 0
                      ? 'None of the files this turn wrote differ from HEAD right now: they were committed, or later changes put them back. The chat card still shows what the turn did. Show all for the whole project.'
                      : 'The working tree matches HEAD.'}
                </p>
              </div>
            ) : (
              <GitChangeList
                report={report!}
                visibleChanges={changes}
                pendingStages={pendingStages}
                onStage={(paths, intent) => stage(paths, intent)}
                onDiscard={(entries) => requestRevert(entries)}
                onTrash={(entries) => requestRevert(entries)}
                selectedPath={current?.path ?? null}
                onSelect={(path) => {
                  // The reader took over: a late diff must not yank the list back.
                  pendingFocus.current = false
                  setSelectedPath(path)
                }}
                {...(focusPath !== undefined ? { focusPath, focusRowRef } : {})}
                {...(onOpenFile !== undefined ? { onOpenFile } : {})}
              />
            )}
            {focusNote}
          </div>
        )}
      />
      {/* The whole-project view only: a turn filter shows a subset, which is not what a commit would take. */}
      {report !== null && !filteredView && (report.branch !== null || report.head !== null) ? (
        <>
          <GitCommitArea key={project.id} projectId={project.id} report={report} changes={shown} run={run} enqueue={enqueue} onDone={settleOperation} />
          <div role="group" aria-label="Branch" className="flex h-11 shrink-0 items-center gap-1.5 border-t border-line px-2.5 text-[13px]">
            <Icon name="gitBranch" size={13} className="shrink-0 text-fg-muted" />
            {report.branchInfo !== null ? (
              <>
                <span className="min-w-0 flex-1 truncate font-medium" title={report.branchInfo.name}>{report.branchInfo.name}</span>
                <GitRemoteButton key={project.id} branchInfo={report.branchInfo} run={run} onDone={settleOperation} />
              </>
            ) : (
              // Detached HEAD: there is no branch to push, so only the commit is named.
              <span className="min-w-0 flex-1 truncate font-mono text-fg-muted" title="HEAD is detached">{report.head?.sha.slice(0, 7) ?? ''}</span>
            )}
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.confirmation.title ?? ''}
        confirmLabel={confirm?.confirmation.confirmLabel ?? ''}
        {...(confirm?.confirmation.details !== undefined ? { body: <p className="m-0 whitespace-pre-line break-words">{confirm.confirmation.details}</p> } : {})}
        onDismiss={() => setConfirm(null)}
        onConfirm={() => { if (confirm !== null) confirmRevert(confirm.entries) }}
      />
      {git.dialogs}
    </div>
  )
}

interface PendingRevert {
  readonly confirmation: GitConfirmation
  readonly entries: readonly GitChange[]
}
