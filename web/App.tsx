import { errorSummary, modeLabel } from './lib/copy.ts'
import { Generation, composerKey, emptyComposer, acceptedDraft, validConversationScope } from './lib/interaction.ts'
import { ComposerStore, useComposerSlice } from './lib/composer-store.ts'
import { draftAttachments, draftIsEmpty, draftText, messageDraft, textDraft, type AttachmentRef, type RichDraft } from './lib/composer-draft.ts'
import { parseRoute, routePath, sessionRoute, workspaceRoute, type AppRoute } from './lib/route.ts'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import {
  answerApproval,
  createProject,
  createSessionIn,
  createWorkspace,
  deleteSessionIn,
  fetchManifest,
  fetchWorkspaceMeta,
  getSessionModel,
  getModelDefaults,
  listProjects,
  reorderProjects,
  listSessionsIn,
  listSkills,
  listWorkspaces,
  compactSession,
  renameSessionIn,
  setSessionPinnedIn,
  searchProjectFiles,
  sendMessageIn,
  uploadAttachment,
  stopSessionIn,
  setMode,
  listModes,
  setSessionModel,
  setModelDefaults,
  fetchAuthState,
  setUnauthorizedHandler,
} from './lib/api.ts'
import { PairingGate } from './components/auth/PairingGate.tsx'
import { decodeModelChoice, activeModelValue, modelOptions } from './lib/providers.ts'
import { isTurnRunning } from './lib/project.ts'
import { sameListing } from './lib/listing-equality.ts'
import { manifestRefreshKey } from './lib/manifest-refresh.ts'
import type { FileFocus } from './lib/tool-facts.ts'
import { useSessionStream } from './hooks/useSessionStream.ts'
import { useApprovalNotify } from './hooks/useApprovalNotify.ts'
import { useWorkbenchPreferences } from './hooks/useWorkbenchPreferences.ts'
import { useHotkeys } from './hooks/useHotkeys.ts'
import { useMediaQuery } from './hooks/useMediaQuery.ts'
import { useTheme } from './hooks/useTheme.ts'
import { useToast } from './components/common/Toast.tsx'
import Icon from './components/common/Icon.tsx'
import { Spinner } from './components/common/Spinner.tsx'
import { Button } from './components/ui/Button.tsx'
import { Sheet } from './components/ui/Sheet.tsx'
import { Sidebar } from './components/layout/Sidebar.tsx'
import { DocumentTitle } from './components/layout/DocumentTitle.tsx'
import { ChatHeader } from './components/layout/ChatHeader.tsx'
import { ScopeControl } from './components/layout/ScopeControl.tsx'
import { composerChipClass } from './components/composer/composer-chip.ts'
import { Workbench } from './components/workbench/Workbench.tsx'
import { TerminalDock } from './components/workbench/TerminalDock.tsx'
import { useWorkbenchFiles } from './hooks/useWorkbenchFiles.ts'
import { usePanelResize } from './hooks/usePanelResize.ts'
import { toProjectRelative } from './lib/project-paths.ts'
import { PANEL_LIMITS } from './lib/workbench-preferences.ts'
import { LazySettings } from './components/settings/LazySettings.tsx'
import { TaskStatus } from './components/chat/TaskStatus.tsx'
import { EnvironmentPanel } from './components/chat/EnvironmentPanel.tsx'
import { Transcript } from './components/chat/Transcript.tsx'
import { ApprovalBar } from './components/chat/ApprovalBar.tsx'
import { Composer } from './components/composer/Composer.tsx'
import { ModelMenu } from './components/composer/ModelMenu.tsx'
import { ContextMeter } from './components/composer/ContextMeter.tsx'
import { SessionFoldersChip } from './components/composer/SessionFoldersChip.tsx'
import { FolderPickerModal } from './components/composer/FolderPickerModal.tsx'
import ConfirmDialog from './components/common/ConfirmDialog.tsx'
import type { ContextManifestView } from './lib/api.ts'
import { builtinCommandIn, draftIsOnlyCommand, type CompletionItem } from './lib/composer-completion.ts'
import type { ModelDefaults, ProjectRow, SessionListing, SessionModel, SkillRow, WorkspaceMeta, WorkspaceRow } from './lib/types.ts'

/** The sidebar docks beside the conversation at this width; below it is a drawer. */
const SIDEBAR_DOCK_QUERY = '(min-width: 768px)'
/** The workbench docks beside the chat at this width; below it is a sheet. */
const WORKBENCH_DOCK_QUERY = '(min-width: 1280px)'

function focusComposer(): void {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus())
}

/** The composer bound to one scope's draft in the store: typing re-renders only this. */
function ScopedComposer({ store, scope, ...props }: Omit<ComponentProps<typeof Composer>, 'draft' | 'onDraft'> & {
  readonly store: ComposerStore
  readonly scope: string
}) {
  const draft = useComposerSlice(store, scope, (state) => state.draft)
  const onDraft = useCallback((next: RichDraft) => store.setDraft(scope, next), [store, scope])
  return <Composer {...props} draft={draft} onDraft={onDraft} />
}

export const sessionModelKey =(workspaceId: string, sessionId: string): string => `${workspaceId}:${sessionId}`

export type SessionModelLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly model: SessionModel }
  | { readonly status: 'error'; readonly error: string }

/** Serializes partial writes for each conversation so the server observes their intended order. */
export class SessionModelMutationQueue {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, number>()

  constructor(private readonly onPendingChange?: (key: string, count: number) => void) {}

  isPending(key: string): boolean {
    return (this.pending.get(key) ?? 0) > 0
  }

  enqueue<T>(key: string, write: () => Promise<T>): Promise<T> {
    const count = (this.pending.get(key) ?? 0) + 1
    this.pending.set(key, count)
    this.onPendingChange?.(key, count)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(write)
    this.tails.set(key, result.then(() => undefined, () => undefined))
    void result.finally(() => {
      const remaining = (this.pending.get(key) ?? 1) - 1
      if (remaining === 0) this.pending.delete(key)
      else this.pending.set(key, remaining)
      this.onPendingChange?.(key, remaining)
    }).catch(() => undefined)
    return result
  }
}

export function sessionEffectiveControls(
  current: string | null,
  defaults: ModelDefaults | null,
  state: SessionModelLoadState | undefined,
): ModelDefaults {
  if (current === null || state?.status === 'ready' && state.model.source === 'global') {
    return defaults ?? { provider: null, model: null, thinkingLevel: null }
  }
  if (state?.status !== 'ready') return { provider: null, model: null, thinkingLevel: null }
  const { provider, model, thinkingLevel } = state.model
  return { provider, model, thinkingLevel }
}

export type ModelDefaultsLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly defaults: ModelDefaults }
  | { readonly status: 'error'; readonly error: string }

/**
 * Owns global-default reads and serialized writes. Each mutation advances the
 * epoch when queued and when settled, fencing every stale GET response (even a
 * Settings refresh that began before a successful PUT).
 */
export class ModelDefaultsCoordinator {
  private tail: Promise<void> = Promise.resolve()
  private epoch = 0
  private request = 0
  private pending = 0
  private state: ModelDefaultsLoadState = { status: 'loading' }
  /** Last server-confirmed complete record; retained through transient errors. */
  private lastConfirmed: ModelDefaults | null = null

  constructor(
    private readonly onStateChange: (state: ModelDefaultsLoadState) => void,
    private readonly onPendingChange?: (pending: number) => void,
  ) {}

  isPending(): boolean {
    return this.pending > 0
  }

  refresh(read: () => Promise<ModelDefaults>): Promise<void> {
    const request = ++this.request
    const epoch = this.epoch
    this.publish({ status: 'loading' })
    return read().then(
      (defaults) => {
        if (this.request === request && this.epoch === epoch) {
          this.lastConfirmed = defaults
          this.publish({ status: 'ready', defaults })
        }
      },
      (cause: unknown) => {
        if (this.request === request && this.epoch === epoch) this.publish({ status: 'error', error: String(cause) })
      },
    )
  }

  enqueue(write: (current: ModelDefaults | null) => Promise<ModelDefaults>): Promise<ModelDefaults> {
    this.epoch += 1
    this.pending += 1
    this.onPendingChange?.(this.pending)
    // A rejected PUT is defined by the server as not published, so the most
    // recent confirmed record remains authoritative for queued dependent writes.
    const result = this.tail.catch(() => undefined).then(() => write(this.lastConfirmed))
    const published = result.then(
      (defaults) => {
        this.epoch += 1
        this.lastConfirmed = defaults
        this.publish({ status: 'ready', defaults })
        return defaults
      },
      (cause: unknown) => {
        this.epoch += 1
        this.publish({ status: 'error', error: String(cause) })
        throw cause
      },
    )
    this.tail = published.then(() => undefined, () => undefined)
    return published.finally(() => {
      this.pending -= 1
      this.onPendingChange?.(this.pending)
    })
  }

  private publish(state: ModelDefaultsLoadState): void {
    this.state = state
    this.onStateChange(state)
  }
}

/**
 * The web client: a sidebar of conversations around a stateless chat pane.
 * All chat state derives from the session event stream — the UI holds no
 * model state of its own. The active workspace is tab/navigation state:
 * switching it never touches a running Turn (execution scope is fixed
 * server-side), and the model selector writes the ACTIVE workspace's control.
 *
 * The shell mounts only once this browser is paired (or pairing is off), so
 * every load it starts runs with a live session. A session refused mid-use
 * unmounts it back to the gate; pairing again mounts it fresh.
 */
export function App() {
  const [authReady, setAuthReady] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchAuthState().then(
      (state) => { if (!cancelled) setAuthReady(!(state.required && !state.paired)) },
      () => { if (!cancelled) setAuthReady(true) },
    )
    setUnauthorizedHandler(() => setAuthReady(false))
    return () => {
      cancelled = true
      setUnauthorizedHandler(undefined)
    }
  }, [])

  if (authReady === null) return <div className="h-dvh bg-bg" aria-busy="true" />
  if (!authReady) {
    return (
      <div className="flex h-dvh items-center bg-bg text-fg">
        <DocumentTitle name={undefined} />
        <PairingGate onPaired={() => setAuthReady(true)} />
      </div>
    )
  }
  return <AppShell />
}

function AppShell() {
  const toast = useToast()
  const theme = useTheme()
  const initialRoute = useRef<AppRoute | null>(parseRoute(window.location.pathname))
  const routeRef = useRef<AppRoute | null>(initialRoute.current)
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRow[]>([])
  const [activeWs, setActiveWs] = useState<string | null>(null)
  const [sessions, setSessions] = useState<readonly SessionListing[]>([])
  const [listedWorkspace, setListedWorkspace] = useState<string | null>(null)
  const [projects, setProjects] = useState<readonly ProjectRow[]>([])
  // No-modal new-chat flow (spec: App shell): New conversation clears the
  // canvas; the composer's scope chip picks the project; the session is
  // created by the first sent message. The scope choice persists per
  // workspace in localStorage ('' = chat only).
  const [draftProject, setDraftProjectState] = useState<string | null>(null)
  // Sidebar folder state lives here so closing the sidebar — which unmounts
  // it — never forgets which folders were collapsed or expanded past five rows.
  const [folderCollapsed, setFolderCollapsed] = useState<Record<string, boolean>>({})
  const [folderExpanded, setFolderExpanded] = useState<Record<string, boolean>>({})
  const toggleFolderCollapsed = useCallback((projectId: string, collapsed: boolean) => {
    setFolderCollapsed((prev) => ({ ...prev, [projectId]: collapsed }))
  }, [])
  const expandFolder = useCallback((projectId: string, expanded: boolean) => {
    setFolderExpanded((prev) => ({ ...prev, [projectId]: expanded }))
  }, [])
  function beginConversation(): void {
    // Invalidate an in-flight first-session creation before showing a new draft.
    navigation.current.next()
    setCurrent(null)
    setFilter('')
    if (activeWs !== null) navigate(workspaceRoute(activeWs))
    if (!sidebarDocked) setSidebarOpen(false)
    focusComposer()
  }
  function newInProject(projectId: string): void {
    // This is navigation too: a late creation must not replace this new draft.
    navigation.current.next()
    setDraftProjectState(projectId)
    setCurrent(null)
    if (activeWs !== null) navigate(workspaceRoute(activeWs))
    if (!sidebarDocked) setSidebarOpen(false)
    focusComposer()
  }
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const activeWorkspace = workspaces.find((row) => row.id === activeWs) ?? null
  const documentTitle = <DocumentTitle name={activeWorkspace?.name} />

  // Draft scope: validate against registered projects; '' in storage = chat only.
  const changeDraftProject = useCallback((projectId: string | null) => {
    setDraftProjectState(projectId)
    try {
      if (activeWs !== null) window.localStorage.setItem(`mini-dsh.scope.${activeWs}`, projectId ?? '')
    } catch { /* storage may be unavailable */ }
  }, [activeWs])
  useEffect(() => {
    if (activeWs === null) return
    let stored: string | null = null
    try { stored = window.localStorage.getItem(`mini-dsh.scope.${activeWs}`) } catch { /* storage may be unavailable */ }
    setDraftProjectState(stored !== null && stored !== '' ? stored : null)
  }, [activeWs])
  const effectiveDraftProject = projects.some((project) => project.id === draftProject) ? draftProject : null
  // Folder picker (server-backed directory browser): browsers never reveal a
  // chosen folder's absolute path, so the picker navigates real directories
  // listed by the web host and registers the confirmed one as a project.
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const scopeOptions = useMemo(() => [
    { id: null, name: 'Chat only', path: 'No project folder — chat without file or shell tools' },
    ...projects.map((project) => ({ id: project.id, name: project.name, path: project.path })),
  ], [projects])

  const [current, setCurrent] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // Drafts live outside React state: the app reads only `sending`/`error`, so
  // a keystroke re-renders the composer and nothing else.
  const [composers] = useState(() => new ComposerStore())
  useEffect(() => {
    window.addEventListener('pagehide', composers.flush)
    return () => { window.removeEventListener('pagehide', composers.flush); composers.flush() }
  }, [composers])
  const setComposers = composers.set
  const updateComposer = composers.update
  const key = composerKey(activeWs, current)
  const sending = useComposerSlice(composers, key, (state) => state.sending)
  const sendError = useComposerSlice(composers, key, (state) => state.error)
  const setDraft = useCallback((draft: RichDraft) => composers.setDraft(key, draft), [composers, key])
  // Stable for the memoized transcript, which must not re-render per keystroke.
  const reuseInDraft = useCallback((text: string) => { setDraft(messageDraft(text)); focusComposer() }, [setDraft])
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null)
  const [modelDefaultsState, setModelDefaultsState] = useState<ModelDefaultsLoadState>({ status: 'loading' })
  const [pendingModelDefaultsMutations, setPendingModelDefaultsMutations] = useState(0)
  const modelDefaultsCoordinator = useRef(new ModelDefaultsCoordinator(setModelDefaultsState, setPendingModelDefaultsMutations))
  const modelDefaults = modelDefaultsState.status === 'ready' ? modelDefaultsState.defaults : null
  /** Resolved session controls, loading, and failure are distinct so `null` remains meaningful. */
  const [sessionModelStates, setSessionModelStates] = useState<ReadonlyMap<string, SessionModelLoadState>>(() => new Map())
  const sessionModelRequests = useRef(new Map<string, number>())
  const [pendingSessionModelMutations, setPendingSessionModelMutations] = useState<ReadonlyMap<string, number>>(() => new Map())
  const sessionModelQueue = useRef(new SessionModelMutationQueue((cacheKey, count) => {
    setPendingSessionModelMutations((pending) => {
      const next = new Map(pending)
      if (count === 0) next.delete(cacheKey)
      else next.set(cacheKey, count)
      return next
    })
  }))
  // Skill catalog for the composer's `/` menu. A failure just leaves the menu
  // empty — it never interrupts a conversation.
  const [skills, setSkills] = useState<readonly SkillRow[]>([])
  const [modeSelection, setModeSelection] = useState<{ modes: readonly { value: string; label: string }[]; selected: string | null }>({ modes: [], selected: null })
  const { preferences, patchPreferences } = useWorkbenchPreferences()
  const sidebarDocked = useMediaQuery(SIDEBAR_DOCK_QUERY)
  const [sidebarOpen, setSidebarOpen] = useState(() => sidebarDocked && !preferences.leftCollapsed)
  const workbenchDocked = useMediaQuery(WORKBENCH_DOCK_QUERY)
  // Docked, the workbench remembers whether it was open; as a sheet it starts closed.
  const [workbenchOpen, setWorkbenchOpen] = useState(() => workbenchDocked && !preferences.rightCollapsed)
  const [workbenchExpanded, setWorkbenchExpanded] = useState(false)
  const inspectorTab = preferences.inspectorTab
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'providers' | 'projects' | 'permissions' | 'skills' | 'memory' | 'agents' | 'mcp' | 'hooks' | 'secrets'>('providers')
  const [pendingDelete, setPendingDelete] = useState<SessionListing | null>(null)
  const [manifest, setManifest] = useState<ContextManifestView | null>(null)
  const [compactNonce, setCompactNonce] = useState(0)
  const workspaceRef = useRef(activeWs)
  workspaceRef.current = activeWs
  const currentRef = useRef(current)
  currentRef.current = current
  const sendingRef = useRef(new Set<string>())
  /** Conversations with a compaction in flight; one at a time each. */
  const compactingRef = useRef(new Set<string>())
  /**
   * Sessions created by this tab whose listing has not caught up yet. The
   * membership guards must not treat a just-created conversation as invalid:
   * `POST /sessions` returns before the refreshed listing contains it.
   */
  const createdHere = useRef(new Set<string>())
  const navigation = useRef(new Generation())
  const lists = useRef(new Generation())
  const metadata = useRef(new Generation())
  const controls = useRef(new Generation())

  useEffect(() => {
    // A docked sidebar becoming a drawer must not suddenly cover the conversation.
    setSidebarOpen(sidebarDocked ? !preferences.leftCollapsed : false)
  }, [sidebarDocked, preferences.leftCollapsed])

  const onLeftOpenChange = useCallback((open: boolean) => {
    setSidebarOpen(open)
    // Only the docked state is a remembered preference; drawers are transient.
    if (sidebarDocked) patchPreferences({ leftCollapsed: !open })
  }, [sidebarDocked, patchPreferences])

  useEffect(() => {
    setWorkbenchOpen(workbenchDocked ? !preferences.rightCollapsed : false)
    // A sheet has no "full width" mode to keep.
    if (!workbenchDocked) setWorkbenchExpanded(false)
  }, [workbenchDocked, preferences.rightCollapsed])

  const onWorkbenchOpenChange = useCallback((open: boolean) => {
    setWorkbenchOpen(open)
    if (!open) setWorkbenchExpanded(false)
    if (workbenchDocked) patchPreferences({ rightCollapsed: !open })
  }, [workbenchDocked, patchPreferences])
  const sidebarResize = usePanelResize({
    width: preferences.leftWidth,
    min: PANEL_LIMITS.left.min,
    max: PANEL_LIMITS.left.max,
    defaultWidth: PANEL_LIMITS.left.default,
    side: 'left',
    onChange: (leftWidth) => patchPreferences({ leftWidth }),
  })
  const workbenchResize = usePanelResize({
    width: preferences.rightWidth,
    min: PANEL_LIMITS.right.min,
    max: PANEL_LIMITS.right.max,
    defaultWidth: PANEL_LIMITS.right.default,
    onChange: (rightWidth) => patchPreferences({ rightWidth }),
  })
  const terminalResize = usePanelResize({
    width: preferences.terminalHeight,
    min: PANEL_LIMITS.terminal.min,
    max: PANEL_LIMITS.terminal.max,
    defaultWidth: PANEL_LIMITS.terminal.default,
    side: 'bottom',
    onChange: (terminalHeight) => patchPreferences({ terminalHeight }),
  })

  // A route-selected session becomes streamable only after the current
  // workspace listing has confirmed membership. This prevents foreign or stale
  // deep links from ever opening an SSE connection.
  const validatedCurrent = listedWorkspace === activeWs && (sessions.some((session) => session.id === current) || (current !== null && createdHere.current.has(current))) ? current : null
  const { events, items: projectedItems, approvals, stream, error: streamError, dismissApproval } = useSessionStream(activeWs, validatedCurrent)
  const notify = useApprovalNotify(approvals, activeWorkspace?.name)
  const running = useMemo(() => isTurnRunning(events), [events])
  const manifestKey = useMemo(() => manifestRefreshKey(events, compactNonce), [events, compactNonce])
  const currentSession = useMemo(() => sessions.find((session) => session.id === current) ?? null, [sessions, current])
  const currentSessionModelState = current !== null && activeWs !== null ? sessionModelStates.get(sessionModelKey(activeWs, current)) : undefined
  const currentSessionModel = currentSessionModelState?.status === 'ready' ? currentSessionModelState.model : undefined
  // A loaded conversation owns its values exactly, including deliberate nulls.
  // Drafts and legacy global conversations derive live global defaults.
  const effectiveControls = sessionEffectiveControls(current, modelDefaults, currentSessionModelState)
  const effectiveProvider = effectiveControls.provider
  const effectiveModel = effectiveControls.model
  const effectiveThinking = effectiveControls.thinkingLevel
  const modelValue = effectiveProvider !== null && effectiveProvider !== '' && effectiveModel !== null && effectiveModel !== ''
    ? `${effectiveProvider}:${effectiveModel}`
    : null
  const availableModelOptions = useMemo(() => modelOptions(meta), [meta])
  /** Per-model settings of the provider serving this conversation's next request. */
  const activeModelSettings = useMemo(() => {
    if (meta === null || effectiveProvider === null || effectiveProvider === '') return undefined
    return meta.providers.find((provider) => provider.id === effectiveProvider)?.modelSettings
  }, [meta, effectiveProvider])
  /** `provider/model` display form for the composer's model trigger. */
  const modelLabel = useMemo(() => {
    if (effectiveModel === null || effectiveModel === '') return null
    const name = meta?.providers.find((provider) => provider.id === effectiveProvider)?.name ?? effectiveProvider
    return name === null || name === '' ? effectiveModel : `${name}/${effectiveModel}`
  }, [meta, effectiveModel, effectiveProvider])
  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentSession?.projectId) ?? null,
    [projects, currentSession],
  )
  // Files browse the open conversation's project, or the draft's chosen project.
  const workbenchProject = current !== null ? currentProject : projects.find((project) => project.id === effectiveDraftProject) ?? null
  const workbenchFiles = useWorkbenchFiles(activeWs !== null && workbenchProject !== null ? `${activeWs}:${workbenchProject.id}` : null)
  const openWorkbenchFile = workbenchFiles.openFile
  const openRecordedPath = useCallback((reference: string, focus?: FileFocus): (() => void) | null => {
    if (workbenchProject === null) return null
    const relative = toProjectRelative(workbenchProject.path, reference)
    if (relative === null) return null
    return () => {
      openWorkbenchFile(relative, focus)
      patchPreferences({ inspectorTab: 'files' })
      onWorkbenchOpenChange(true)
    }
  }, [workbenchProject, openWorkbenchFile, patchPreferences, onWorkbenchOpenChange])
  /** The per-turn change card's Review all: the project's Git view. */
  const reviewTurnChanges = useCallback(() => {
    patchPreferences({ inspectorTab: 'git' })
    onWorkbenchOpenChange(true)
  }, [patchPreferences, onWorkbenchOpenChange])
  /** Environment panel rows open the matching workbench view. */
  const openEnvironmentView = useCallback((view: 'git' | 'agents') => {
    patchPreferences({ inspectorTab: view })
    onWorkbenchOpenChange(true)
  }, [patchPreferences, onWorkbenchOpenChange])
  const draftProjectName = useMemo(
    () => projects.find((project) => project.id === effectiveDraftProject)?.name,
    [projects, effectiveDraftProject],
  )
  const envModeLabel = useMemo(
    () => modeSelection.modes.find((mode) => mode.value === modeSelection.selected)?.label ?? null,
    [modeSelection],
  )
  const sessionCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const session of sessions) {
      if (session.projectId === undefined || session.projectId === null) continue
      counts[session.projectId] = (counts[session.projectId] ?? 0) + 1
    }
    return counts
  }, [sessions])

  const refreshModelDefaults = useCallback(async () => {
    await modelDefaultsCoordinator.current.refresh(getModelDefaults)
  }, [])

  useEffect(() => {
    void refreshModelDefaults()
  }, [refreshModelDefaults])

  const refreshMeta = useCallback(async () => {
    if (activeWs === null) return
    const nav = navigation.current.current()
    const request = metadata.current.next()
    try {
      const [wsMeta, modeRows] = await Promise.all([fetchWorkspaceMeta(activeWs), listModes(activeWs)])
      if (workspaceRef.current !== activeWs || !navigation.current.matches(nav) || !metadata.current.matches(request)) return
      setMeta(wsMeta)
      setModeSelection({
        modes: modeRows.modes.map((row) => ({ value: row.id, label: modeLabel(row) })),
        selected: modeRows.selected,
      })
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [activeWs, toast])

  const refreshList = useCallback(async () => {
    if (activeWs === null) return
    const nav = navigation.current.current()
    const request = lists.current.next()
    try {
      const [listing, projectRows] = await Promise.all([listSessionsIn(activeWs), listProjects(activeWs)])
      if (workspaceRef.current !== activeWs || !navigation.current.matches(nav) || !lists.current.matches(request)) return
      setSessions((previous) => sameListing(previous, listing) ? previous : listing)
      setListedWorkspace(activeWs)
      setProjects((previous) => sameListing(previous, projectRows) ? previous : projectRows)
      for (const row of listing) createdHere.current.delete(row.id)
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [activeWs, toast])

  /** Drag-to-reorder sidebar folders: apply at once, then let the server confirm. */
  const reorderProjectFolders = useCallback(async (orderedIds: readonly string[]) => {
    if (activeWs === null || workspaceRef.current !== activeWs) return
    setProjects((prev) => {
      const byId = new Map(prev.map((row) => [row.id, row]))
      const next = orderedIds.map((id) => byId.get(id)).filter((row): row is ProjectRow => row !== undefined)
      return next.length === prev.length ? next : prev
    })
    try {
      const rows = await reorderProjects(activeWs, orderedIds)
      if (workspaceRef.current !== activeWs) return
      setProjects(rows)
    } catch (cause) {
      toast.notify(String(cause))
      await refreshList()
    }
  }, [activeWs, refreshList, toast])

  const refreshWorkspaces = useCallback(async () => {
    try {
      const rows = await listWorkspaces()
      setWorkspaces((previous) => sameListing(previous, rows) ? previous : rows)
      return rows
    } catch (cause) {
      toast.notify(String(cause))
      return []
    }
  }, [toast])

  const navigate = useCallback((route: AppRoute, mode: 'push' | 'replace' = 'push') => {
    const path = routePath(route)
    if (window.location.pathname !== path) window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', path)
    routeRef.current = route
  }, [])

  const applyRoute = useCallback((route: AppRoute | null, rows: readonly WorkspaceRow[], mode: 'push' | 'replace') => {
    const fallback = rows.find((row) => row.default === true) ?? rows[0]
    const requestedWorkspaceId = route?.kind === 'root' ? null : route?.workspaceId
    const workspace = requestedWorkspaceId === null ? fallback : rows.find((row) => row.id === requestedWorkspaceId)
    if (workspace === undefined) {
      if (fallback !== undefined) {
        navigation.current.next()
        workspaceRef.current = fallback.id
        setPendingDelete(null)
        setActiveWs(fallback.id)
        navigate(workspaceRoute(fallback.id), 'replace')
      } else {
        navigation.current.next()
        workspaceRef.current = null
        setPendingDelete(null)
        setActiveWs(null)
        setCurrent(null)
        navigate({ kind: 'root' }, 'replace')
      }
      return
    }
    const sessionId = route?.kind === 'session' ? route.sessionId : null
    // Re-applying the route already in force (StrictMode's doubled mount
    // effect, a popstate to the same place) must not bump the navigation
    // token: that would discard the workspace load already in flight, and
    // with `activeWs` unchanged nothing would ever reload it.
    if (workspaceRef.current === workspace.id && currentRef.current === sessionId) {
      navigate(route?.kind === 'session' ? route : workspaceRoute(workspace.id), mode)
      return
    }
    navigation.current.next()
    workspaceRef.current = workspace.id
    currentRef.current = sessionId
    setPendingDelete(null)
    setActiveWs(workspace.id)
    setCurrent(sessionId)
    navigate(route?.kind === 'session' ? route : workspaceRoute(workspace.id), mode)
  }, [navigate])

  /** Register the picker's confirmed folder and scope the draft to it. */
  const registerFolder = useCallback(async (folderPath: string) => {
    if (activeWs === null) return
    try {
      const created = await createProject(activeWs, folderPath.split(/[\\/]/).filter(Boolean).at(-1) ?? folderPath, folderPath)
      await refreshList()
      changeDraftProject(created.id)
      toast.notify(`Project folder registered: ${created.name}`, 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [activeWs, refreshList, changeDraftProject, toast])

  useEffect(() => {
    void (async () => {
      const rows = await refreshWorkspaces()
      applyRoute(initialRoute.current, rows, 'replace')
    })()
  }, [applyRoute, refreshWorkspaces])

  useEffect(() => {
    const onPopState = (): void => {
      void (async () => {
        const rows = await refreshWorkspaces()
        applyRoute(parseRoute(window.location.pathname), rows, 'replace')
      })()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [applyRoute, refreshWorkspaces])

  // An externally removed workspace cannot remain selected in this tab.
  useEffect(() => {
    if (activeWs !== null && workspaces.length > 0 && !workspaces.some((workspace) => workspace.id === activeWs)) {
      applyRoute(routeRef.current, workspaces, 'replace')
    }
  }, [activeWs, applyRoute, workspaces])

  // Spec (Sidebar v2 behavior): a slow visible-tab poll keeps live badges
  // truthful within ≤10s, plus refresh on window focus.
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return
      void refreshList()
      void refreshWorkspaces()
    }
    const timer = window.setInterval(tick, 10_000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [refreshList, refreshWorkspaces])

  // Switching the active workspace re-scopes listings and controls. It does
  // NOT close a running Turn server-side; only this browser's selected stream changes.
  useEffect(() => {
    if (activeWs === null) return
    let cancelled = false
    const requestedSession = currentRef.current
    const nav = navigation.current.current()
    const listingToken = lists.current.next()
    const metaToken = metadata.current.next()
    setMeta(null)
    setManifest(null)
    setSessions([])
    setListedWorkspace(null)
    setProjects([])
    setModeSelection({ modes: [], selected: null })
    void (async () => {
      try {
        const [listing, projectRows, wsMeta, modeRows] = await Promise.all([
          listSessionsIn(activeWs),
          listProjects(activeWs),
          fetchWorkspaceMeta(activeWs),
          listModes(activeWs),
        ])
        if (cancelled || !navigation.current.matches(nav)) return
        if (metadata.current.matches(metaToken)) {
          setModeSelection({ modes: modeRows.modes.map((row) => ({ value: row.id, label: modeLabel(row) })), selected: modeRows.selected })
          setMeta(wsMeta)
        }
        if (!lists.current.matches(listingToken)) return
        setSessions(listing)
        // The listing that just landed belongs to the active workspace. Without
        // this the stream gate (`listedWorkspace === activeWs`) stays closed and
        // a cold load shows an empty conversation until the next 10s poll.
        setListedWorkspace(activeWs)
        setProjects(projectRows)
        for (const row of listing) createdHere.current.delete(row.id)
        if (requestedSession !== null && !listing.some((session) => session.id === requestedSession)) {
          setCurrent(null)
          navigate(workspaceRoute(activeWs), 'replace')
        }
      } catch (cause) {
        if (!cancelled && navigation.current.matches(nav)) toast.notify(String(cause))
      }
    })()
    return () => { cancelled = true }
  }, [activeWs, navigate, toast])

  // Each existing conversation receives its server-snapshotted controls once. A failed read
  // remains an explicit unavailable state until the user retries, never a workspace fallback.
  const loadSessionModel = useCallback((workspaceId: string, sessionId: string, force = false): void => {
    const cacheKey = sessionModelKey(workspaceId, sessionId)
    const existing = sessionModelStates.get(cacheKey)
    if (!force && (existing?.status === 'loading' || existing?.status === 'ready')) return
    const request = (sessionModelRequests.current.get(cacheKey) ?? 0) + 1
    sessionModelRequests.current.set(cacheKey, request)
    setSessionModelStates((states) => new Map(states).set(cacheKey, { status: 'loading' }))
    void getSessionModel(workspaceId, sessionId).then(
      (model) => {
        if (sessionModelRequests.current.get(cacheKey) !== request) return
        setSessionModelStates((states) => new Map(states).set(cacheKey, { status: 'ready', model }))
      },
      (cause: unknown) => {
        if (sessionModelRequests.current.get(cacheKey) !== request) return
        setSessionModelStates((states) => new Map(states).set(cacheKey, { status: 'error', error: String(cause) }))
      },
    )
  }, [sessionModelStates])
  useEffect(() => {
    if (activeWs !== null && current !== null) loadSessionModel(activeWs, current)
  }, [activeWs, current, loadSessionModel])

  // Skill catalog for the composer's `/` menu, per workspace.
  useEffect(() => {
    setSkills([])
    if (activeWs === null) return
    let cancelled = false
    void listSkills(activeWs)
      .then((rows) => { if (!cancelled && workspaceRef.current === activeWs) setSkills(rows) })
      .catch(() => { /* an unavailable catalog only closes the menu */ })
    return () => { cancelled = true }
  }, [activeWs])

  // Session whose manifest is currently on screen. A change means the user
  // switched conversations, which fetches at once; the same session refreshes
  // on a short delay after a turn settles.
  const manifestSession = useRef<string | null>(null)
  // Composer context meter + inspector. The previous figures stay up until
  // the selected conversation's manifest arrives, so the meter never flashes
  // empty. An in-flight turn keeps what it last showed.
  useEffect(() => {
    if (activeWs === null || current === null || running) return
    const switched = manifestSession.current !== `${activeWs}:${current}`
    manifestSession.current = `${activeWs}:${current}`
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchManifest(activeWs, current).then(
        (view) => {
          if (!cancelled && currentRef.current === current && workspaceRef.current === activeWs) setManifest(view)
        },
        () => {
          if (!cancelled && currentRef.current === current && workspaceRef.current === activeWs) setManifest(null)
        },
      )
    }, switched ? 0 : 600)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeWs, current, running, manifestKey])

  useEffect(() => {
    if (streamError === null) return
    toast.notify(streamError)
  }, [streamError, toast])

  useEffect(() => {
    if (activeWs === null || current === null || listedWorkspace !== activeWs) return
    if (sessions.some((session) => session.id === current) || createdHere.current.has(current)) return
    setCurrent(null)
    navigate(workspaceRoute(activeWs), 'replace')
  }, [activeWs, current, listedWorkspace, navigate, sessions])

  const closeSidebar = useCallback(() => onLeftOpenChange(false), [onLeftOpenChange])
  const openSession = useCallback((id: string) => {
    if (activeWs === null || id === '') return
    navigation.current.next()
    setCurrent(id)
    navigate(sessionRoute(activeWs, id))
    if (!sidebarDocked) setSidebarOpen(false)
  }, [activeWs, navigate, sidebarDocked])

  /** Runs a built-in composer command through the host: the model is never involved. */
  const runBuiltinCommand = useCallback(async (name: string): Promise<void> => {
    if (name !== 'compact') return
    if (activeWs === null || current === null) {
      toast.notify('/compact runs on an open conversation — send the first message first.')
      return
    }
    // One compaction per conversation at a time: a second pick while the
    // summarizer is running would only race the boundary check.
    if (compactingRef.current.has(current)) return
    compactingRef.current.add(current)
    try {
      const result = await compactSession(activeWs, current)
      toast.notify(`Compacted — ${result.summaryChars} chars summarized through seq ${result.coversSeq}.`, 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    } finally {
      compactingRef.current.delete(current)
    }
  }, [activeWs, current, toast])

  const send = useCallback(async () => {
    // Read at call time: the app does not re-render for draft edits.
    const composer = composers.get()[key] ?? emptyComposer
    const { draft } = composer
    // Fallback for a built-in chip that reached the draft anyway (restored
    // drafts, reuse): the chip never reaches the wire, and a mixed draft is
    // refused rather than half-sent. The live path executes on pick.
    const builtin = builtinCommandIn(draft)
    if (builtin !== null) {
      if (!draftIsOnlyCommand(draft, builtin)) {
        toast.notify(`/${builtin} runs on its own — clear the rest of the draft first.`)
        return
      }
      if (sendingRef.current.has(key)) return
      sendingRef.current.add(key)
      try {
        await runBuiltinCommand(builtin)
        updateComposer(key, (state) => acceptedDraft(state, composer.revision))
      } finally {
        sendingRef.current.delete(key)
      }
      return
    }
    if (sendingRef.current.has(key) || draftIsEmpty(draft) || modelValue === null || activeWs === null) return
    if (current === null && modelDefaultsCoordinator.current.isPending()) return
    if (current !== null && sessionModelQueue.current.isPending(sessionModelKey(activeWs, current))) return
    if (!validConversationScope(effectiveDraftProject, projects.map((project) => project.id))) return
    const workspaceId = activeWs
    const sourceKey = key
    sendingRef.current.add(sourceKey)
    updateComposer(sourceKey, (state) => ({ ...state, sending: true, error: null }))
    const revision = composer.revision
    const nav = navigation.current.current()
    const content = draftText(draft)
    const attachments = draftAttachments(draft)
    let targetKey = sourceKey
    try {
      let sessionId = current
      if (sessionId === null) {
        // Session creation is allowed to finish after navigation changes, but
        // only the operation's original navigation/workspace may select it.
        const created = await createSessionIn(workspaceId, effectiveDraftProject ?? undefined)
        sessionId = created.id
        createdHere.current.add(sessionId)
        targetKey = composerKey(workspaceId, sessionId)
        // Move the latest source state atomically. Because every composer write
        // updates the ref before scheduling React, immediate acceptance cannot
        // overtake migration, and edits made after submission retain their newer
        // revision when acceptedDraft runs on the target.
        setComposers((all) => {
          const source = all[sourceKey] ?? { ...composer, draft }
          const next = { ...all, [targetKey]: { ...source, sending: true } }
          delete next[sourceKey]
          return next
        })
        if (workspaceRef.current === workspaceId && navigation.current.matches(nav)) {
          setCurrent(sessionId)
          navigate(sessionRoute(workspaceId, sessionId))
        }
        void refreshList()
      }
      try {
        // Clear only the submitted draft after durable acceptance.
        await sendMessageIn(workspaceId, sessionId, content, globalThis.crypto.randomUUID(), attachments)
        updateComposer(targetKey, (state) => acceptedDraft(state, revision))
      } catch (cause) {
        updateComposer(targetKey, (state) => ({ ...state, error: String(cause) }))
      }
      if (workspaceRef.current === workspaceId && navigation.current.matches(nav)) void refreshList()
      void refreshWorkspaces()
    } catch (cause) {
      // Creation failed — the workspace-null composer retains its draft.
      updateComposer(sourceKey, (state) => ({ ...state, error: String(cause) }))
    } finally {
      sendingRef.current.delete(sourceKey)
      updateComposer(targetKey, (state) => ({ ...state, sending: false }))
    }
  }, [current, composers, key, modelValue, activeWs, effectiveDraftProject, navigate, projects, refreshList, refreshWorkspaces, toast, runBuiltinCommand])

  const stop = useCallback(async () => {
    if (current === null || activeWs === null) return
    try {
      await stopSessionIn(activeWs, current)
      void refreshWorkspaces()
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [current, activeWs, toast])

  // Re-send the newest user message verbatim after a failed request. Safe by
  // construction: the failure card is only reachable when the request never
  // completed, so no tool side effects can be duplicated.
  const retryLast = useCallback(async () => {
    if (sendingRef.current.has(key) || current === null || activeWs === null || running || modelValue === null) return
    if (sessionModelQueue.current.isPending(sessionModelKey(activeWs, current))) return
    const lastUser = [...projectedItems].reverse().find((item) => item.kind === 'user' && item.queued !== true)
    if (lastUser === undefined || (lastUser.kind !== 'user')) return
    sendingRef.current.add(key)
    updateComposer(key, (state) => ({ ...state, sending: true, error: null }))
    const nav = navigation.current.current()
    try {
      await sendMessageIn(activeWs, current, lastUser.content, globalThis.crypto.randomUUID())
      if (navigation.current.matches(nav)) void refreshList()
      void refreshWorkspaces()
    } catch (cause) {
      updateComposer(key, (state) => ({ ...state, error: String(cause) }))
    } finally {
      sendingRef.current.delete(key)
      updateComposer(key, (state) => ({ ...state, sending: false }))
    }
  }, [projectedItems, current, activeWs, running, modelValue, key, refreshList, toast])

  const answer = useCallback(async (approvalId: string, allow: boolean, scope: 'once' | 'session' = 'once') => {
    try {
      await answerApproval(approvalId, allow, scope)
      dismissApproval(approvalId)
      void refreshWorkspaces()
    } catch (cause) {
      throw cause
    }
  }, [toast, dismissApproval])

  const rename = useCallback(async (id: string, title: string) => {
    if (activeWs === null) return
    const nav = navigation.current.current()
    try {
      const renamed = await renameSessionIn(activeWs, id, title)
      if (!navigation.current.matches(nav)) return
      await refreshList()
      toast.notify(`Conversation renamed to "${renamed.title}"`, 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [activeWs, refreshList, toast])

  const togglePinned = useCallback(async (id: string, pinned: boolean) => {
    if (activeWs === null) return
    const nav = navigation.current.current()
    try {
      await setSessionPinnedIn(activeWs, id, pinned)
      if (!navigation.current.matches(nav)) return
      await refreshList()
      toast.notify(pinned ? 'Conversation pinned' : 'Conversation unpinned', 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [activeWs, refreshList, toast])

  /** Clipboard failures are reported: a silent copy would be a lie. */
  const copySessionId = useCallback(async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      toast.notify('Session ID copied', 'ok')
    } catch {
      toast.notify(`Could not copy. Session ID: ${id}`)
    }
  }, [toast])

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null || activeWs === null) return
    const nav = navigation.current.current()
    const request = lists.current.next()
    const id = pendingDelete.id
    setPendingDelete(null)
    try {
      await deleteSessionIn(activeWs, id)
      const listing = await listSessionsIn(activeWs)
      if (!navigation.current.matches(nav) || !lists.current.matches(request)) return
      setSessions(listing)
      if (current === id) {
        const next = listing[0]
        setCurrent(next?.id ?? null)
        navigate(next !== undefined ? sessionRoute(activeWs, next.id) : workspaceRoute(activeWs), 'replace')
      }
      toast.notify('Conversation deleted', 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [pendingDelete, current, activeWs, navigate, toast])

  const selectModel = useCallback(async (value: string) => {
    const choice = decodeModelChoice(value)
    if (choice === null || activeWs === null) return
    if (current === null) {
      try {
        await modelDefaultsCoordinator.current.enqueue((defaults) => setModelDefaults({
          provider: choice.provider,
          model: choice.model,
          thinkingLevel: defaults?.thinkingLevel ?? null,
        }))
      } catch (cause) {
        toast.notify(String(cause))
      }
      return
    }
    const workspaceId = activeWs
    const sessionId = current
    const cacheKey = sessionModelKey(workspaceId, sessionId)
    if (currentSessionModelState?.status !== 'ready') return
    try {
      const saved = await sessionModelQueue.current.enqueue(cacheKey, () => setSessionModel(workspaceId, sessionId, { provider: choice.provider, model: choice.model }))
      setSessionModelStates((states) => new Map(states).set(cacheKey, { status: 'ready', model: saved }))
    } catch (cause) {
      // Do not restore a historical snapshot: reload the server's authoritative state.
      loadSessionModel(workspaceId, sessionId, true)
      toast.notify(String(cause))
    }
  }, [activeWs, current, currentSessionModelState, loadSessionModel, toast])

  const selectMode = useCallback(async (modeId: string) => {
    if (activeWs === null) return
    const nav = navigation.current.current()
    const token = controls.current.next()
    metadata.current.next()
    try {
      await setMode(activeWs, modeId)
      if (navigation.current.matches(nav) && controls.current.matches(token)) await refreshMeta()
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [activeWs, refreshMeta, toast])

  /** Draft thinking changes global defaults; conversations edit their snapshot. */
  const selectThinking = useCallback(async (level: string | null) => {
    if (activeWs === null) return
    if (current === null) {
      try {
        await modelDefaultsCoordinator.current.enqueue((defaults) => setModelDefaults({
          provider: defaults?.provider ?? null,
          model: defaults?.model ?? null,
          thinkingLevel: level,
        }))
      } catch (cause) {
        toast.notify(String(cause))
      }
      return
    }
    const workspaceId = activeWs
    const sessionId = current
    const cacheKey = sessionModelKey(workspaceId, sessionId)
    if (currentSessionModelState?.status !== 'ready') return
    try {
      const saved = await sessionModelQueue.current.enqueue(cacheKey, () => setSessionModel(workspaceId, sessionId, { thinkingLevel: level }))
      setSessionModelStates((states) => new Map(states).set(cacheKey, { status: 'ready', model: saved }))
    } catch (cause) {
      // Do not restore a historical snapshot: reload the server's authoritative state.
      loadSessionModel(workspaceId, sessionId, true)
      toast.notify(String(cause))
    }
  }, [activeWs, current, currentSessionModelState, loadSessionModel, toast])

  const switchWorkspace = useCallback((id: string) => {
    if (id === '') return
    navigation.current.next()
    workspaceRef.current = id
    setCurrent(null)
    setPendingDelete(null)
    setActiveWs(id)
    navigate(workspaceRoute(id))
    if (!sidebarDocked) setSidebarOpen(false)
  }, [navigate, sidebarDocked])

  const addWorkspace = useCallback(async () => {
    const name = newWorkspaceName.trim()
    if (name === '') return
    const nav = navigation.current.current()
    try {
      const created = await createWorkspace(name)
      if (!navigation.current.matches(nav)) return
      setNewWorkspaceName('')
      await refreshWorkspaces()
      if (!navigation.current.matches(nav)) return
      switchWorkspace(created.id)
      toast.notify(`Created workspace "${created.name}"`, 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [newWorkspaceName, refreshWorkspaces, switchWorkspace, toast])

  const toggleTerminal = useCallback(() => {
    // Ctrl+` belongs to the chat footer. The workbench has its own Terminal
    // tab, opened from the view picker rather than this shortcut.
    patchPreferences({ terminalOpen: !preferences.terminalOpen })
  }, [preferences.terminalOpen, patchPreferences])

  useHotkeys([
    { key: 'n', mod: true, onPress: beginConversation },
    { key: 'k', mod: true, onPress: () => onLeftOpenChange(true) },
    { key: ',', mod: true, onPress: () => setSettingsOpen(true) },
    // Editors open the terminal with Ctrl+`. It must work from the composer.
    { key: '`', mod: true, allowInEditable: true, onPress: toggleTerminal },
  ])


  const openSettings = useCallback((section: typeof settingsSection = 'providers'): void => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  const openProviderSettings = useCallback(() => openSettings(), [openSettings])
  const retryLastTurn = useCallback(() => void retryLast(), [retryLast])

  const sidebar = (
    <Sidebar
      sessions={sessions}
      projects={projects}
      current={current}
      filter={filter}
      running={running}
      workspaces={workspaces}
      activeWorkspaceId={activeWs}
      newWorkspaceName={newWorkspaceName}
      onNewWorkspaceName={setNewWorkspaceName}
      onSelectWorkspace={switchWorkspace}
      onCreateWorkspace={() => void addWorkspace()}
      onWorkspacesChanged={async () => { await refreshWorkspaces() }}
      onFilter={setFilter}
      onSelect={openSession}
      onNew={beginConversation}
      onNewInProject={newInProject}
      {...(workspaces.some((workspace) => workspace.id === activeWs && workspace.archived) ? {} : { onReorderProjects: reorderProjectFolders })}
      onRename={(id, title) => void rename(id, title)}
      onDeleteRequest={setPendingDelete}
      onTogglePinned={(id, pinned) => void togglePinned(id, pinned)}
      collapsedFolders={folderCollapsed}
      onToggleFolderCollapsed={toggleFolderCollapsed}
      expandedFolders={folderExpanded}
      onExpandFolder={expandFolder}
      onOpenSettings={() => openSettings()}
      notifyEnabled={notify.enabled}
      notifyBlocked={notify.blocked}
      onToggleNotify={notify.toggle}
      theme={theme.preference}
      onTheme={theme.setPreference}
      onClose={closeSidebar}
    />
  )

  const sessionControlsPending = current !== null && activeWs !== null && (pendingSessionModelMutations.get(sessionModelKey(activeWs, current)) ?? 0) > 0
  const defaultControlsPending = current === null && pendingModelDefaultsMutations > 0
  const defaultControlsUnavailable = current === null && modelDefaultsState.status !== 'ready'
  const sessionControlsUnavailable = current !== null && currentSessionModelState?.status !== 'ready'
  const sessionControlsMessage = currentSessionModelState?.status === 'error'
    ? 'Conversation controls are unavailable. Retry loading before sending.'
    : modelDefaultsState.status === 'error'
      ? 'Global defaults are unavailable. Retry loading before sending.'
      : sessionControlsPending
        ? 'Saving conversation controls before sending…'
        : defaultControlsPending
          ? 'Saving global defaults before sending…'
          : current === null
            ? 'Loading global defaults…'
            : 'Loading conversation controls…'
  // Unavailable controls are reported (with Retry) by the composer's own status chip.
  const modelControl = sessionControlsUnavailable || defaultControlsUnavailable ? null : modelValue !== null && availableModelOptions.length > 0 ? (
    <ModelMenu
      menuLabel={current === null ? 'Default model for new conversations' : currentSessionModel?.source === 'session' ? 'Conversation model (next request)' : 'Conversation model (global default, next request)'}
      disabled={sessionControlsPending || defaultControlsPending}
      modelLabel={modelLabel ?? modelValue}
      modelValue={modelValue}
      options={availableModelOptions}
      providers={meta?.providers ?? []}
      {...(activeModelSettings !== undefined ? { modelSettings: activeModelSettings } : {})}
      onModel={(value) => void selectModel(value)}
      onManage={() => openSettings()}
    />
  ) : meta !== null ? (
    <button type="button" onClick={() => openSettings()} className={composerChipClass}>
      <span className="truncate">{modelLabel ?? 'Configure a model'}</span>
      <Icon name="chevron" size={13} />
    </button>
  ) : null

  /** `@` candidates from the conversation's project; no project, no menu. */
  const searchFiles = useCallback(async (query: string): Promise<readonly CompletionItem[]> => {
    if (activeWs === null || workbenchProject === null) return []
    const found = await searchProjectFiles(activeWs, workbenchProject.id, query, 12)
    return found.matches.map((match) => {
      const folder = match.path.slice(0, Math.max(0, match.path.length - match.name.length - 1))
      return {
        id: match.path,
        insert: match.path,
        // A mention is a chip: the path stays one object the user can remove.
        segment: { kind: 'mention', path: match.path },
        label: match.name,
        ...(folder !== '' ? { detail: folder } : {}),
      }
    })
  }, [activeWs, workbenchProject])

  /**
   * Store dropped/pasted/chosen files. A refusal (type, size) is reported per
   * file and the rest still attach, so one bad file never loses the others.
   */
  const uploadFiles = useCallback(async (files: readonly File[]): Promise<readonly AttachmentRef[]> => {
    if (activeWs === null) return []
    const stored: AttachmentRef[] = []
    for (const file of files) {
      try {
        stored.push(await uploadAttachment(activeWs, file))
      } catch (cause) {
        toast.notify(`${file.name} was not attached: ${errorSummary(String(cause))}`)
      }
    }
    return stored
  }, [activeWs, toast])

  /** ArrowUp on an empty composer edits the newest own message again. */
  const recallLast = useCallback((): string | null => {
    const lastUser = [...projectedItems].reverse().find((item) => item.kind === 'user')
    return lastUser !== undefined && lastUser.kind === 'user' ? lastUser.content : null
  }, [projectedItems])

  // The latest folder-grant revision on the stream: an approval that granted
  // a folder refreshes the chip without reopening it.
  const grantsRevision = useMemo(
    () => events.reduce((latest, event) => (event.type === 'session/grants' ? Math.max(latest, event.revision ?? 0) : latest), 0),
    [events],
  )
  const contextControl = current !== null ? (
    <>
      {activeWs !== null && currentProject !== null ? <SessionFoldersChip workspaceId={activeWs} sessionId={current} revision={grantsRevision} /> : null}
      <ContextMeter manifest={manifest} />
    </>
  ) : null

  const composerNode = (
    <ScopedComposer
      store={composers}
      scope={key}
      modelControl={modelControl}
      {...(contextControl !== null ? { contextControl } : {})}
      workspaceId={activeWs}
      sending={sending}
      connected={stream === 'open' || current === null}
      running={running}
      onSend={() => void send()}
      onCommand={(name) => void runBuiltinCommand(name)}
      onStop={() => void stop()}
      modelValue={modelValue}
      controlsUnavailable={sessionControlsUnavailable || defaultControlsUnavailable || sessionControlsPending || defaultControlsPending}
      {...(sessionControlsUnavailable || defaultControlsUnavailable || sessionControlsPending || defaultControlsPending ? { controlsUnavailableMessage: sessionControlsMessage } : {})}
      {...(currentSessionModelState?.status === 'error' && activeWs !== null && current !== null
        ? { onRetryControls: () => loadSessionModel(activeWs, current, true) }
        : modelDefaultsState.status === 'error'
          ? { onRetryControls: () => void refreshModelDefaults() }
          : {})}
      thinkingValue={effectiveThinking}
      thinkingMenuLabel={current === null ? 'Default thinking level for new conversations' : currentSessionModel?.source === 'session' ? 'Conversation thinking level (next request)' : 'Conversation thinking level (global default, next request)'}
      thinkingDisabled={sessionControlsPending || defaultControlsPending}
      {...(activeModelSettings !== undefined ? { modelSettings: activeModelSettings } : {})}
      onThinking={(level) => void selectThinking(level)}
      modes={modeSelection.modes}
      modeValue={modeSelection.selected}
      onMode={(value) => void selectMode(value)}
      {...(workbenchProject !== null ? { onSearchFiles: searchFiles } : {})}
      {...(activeWs !== null ? { onUploadFiles: uploadFiles } : {})}
      skills={skills}
      onRecallLast={recallLast}
      autoFocus={current === null}
    />
  )

  const sendErrorNotice = sendError ? (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-bad-soft p-3.5 text-sm" role="alert">
      <strong className="font-semibold text-bad">Send not confirmed. Your draft has been kept.</strong>
      <p className="m-0 text-fg-muted">Check the conversation before sending again to avoid duplicate work.</p>
      <details className="text-xs text-fg-muted">
        <summary>Error details</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{sendError}</pre>
      </details>
      <Button size="sm" variant="outline" className="self-start" onClick={() => openSettings()}>Check provider</Button>
    </div>
  ) : null

  const workbench = (
    <Workbench
      workspaceId={activeWs}
      project={workbenchProject}
      view={inspectorTab}
      onView={(view) => patchPreferences({ inspectorTab: view })}
      views={preferences.inspectorViews}
      onViews={(views) => patchPreferences({ inspectorViews: views })}
      files={workbenchFiles}
      events={events}
      expanded={workbenchExpanded}
      {...(workbenchDocked ? { onToggleExpand: () => setWorkbenchExpanded((expanded) => !expanded) } : {})}
      onClose={() => onWorkbenchOpenChange(false)}
      openPath={openRecordedPath}
      sessionId={current}
      onOpenChild={openSession}
      terminalShell={preferences.terminalShell}
      onTerminalShell={(shellId) => patchPreferences({ terminalShell: shellId })}
      context={{ meta, ...(modelDefaults !== null ? { globalDefaults: modelDefaults } : {}), ...(currentSessionModel !== undefined ? { sessionModel: currentSessionModel } : {}), ...(current !== null && currentSessionModelState?.status === 'loading' ? { sessionControlsStatus: 'loading' as const } : {}), ...(current !== null && currentSessionModelState?.status === 'error' ? { sessionControlsStatus: 'unavailable' as const } : {}), stream, sessionId: current, sessionFolder: currentProject?.path ?? null, eventCount: events.length, manifest, workspaceId: activeWs, running, modeLabel: envModeLabel, onCompacted: () => setCompactNonce((nonce) => nonce + 1), onOpenSettingsTab: (tab) => openSettings(tab) }}
    />
  )

  const terminalDock = (
    <TerminalDock
      workspaceId={activeWs}
      projectId={workbenchProject?.id ?? null}
      height={preferences.terminalHeight}
      resizeHandle={terminalResize}
      open={preferences.terminalOpen}
      onOpenChange={(terminalOpen) => patchPreferences({ terminalOpen })}
      defaultShell={preferences.terminalShell}
      onDefaultShell={(shellId) => patchPreferences({ terminalShell: shellId })}
    />
  )

  const suggestions = draftProjectName !== undefined
    ? [`Explain ${draftProjectName}`, 'Find TODOs and likely bugs', `Plan a change in ${draftProjectName}`]
    : ['Explain how to register a project and get started', 'Help me plan a feature']

  return (
    <>
      {documentTitle}
      <div className="flex h-dvh overflow-hidden bg-bg text-fg">
        {sidebarDocked && sidebarOpen ? (
          <>
            <aside className="h-full min-w-0 shrink-0" style={{ width: preferences.leftWidth }}>{sidebar}</aside>
            <div
              {...sidebarResize}
              aria-label="Resize sidebar"
              className="group relative w-px shrink-0 cursor-col-resize bg-line outline-none focus-visible:bg-link dark:bg-transparent dark:focus-visible:bg-link"
            >
              <span aria-hidden="true" className="absolute inset-y-0 -left-1.5 -right-1.5 group-hover:bg-line/60" />
            </div>
          </>
        ) : null}
        {!sidebarDocked ? <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen} side="left" label="Conversation navigation">{sidebar}</Sheet> : null}

        {/* Full-width workbench hides (but keeps mounted) the chat so drafts and scroll survive. */}
        <main className={`min-w-0 flex-1 flex-col ${workbenchDocked && workbenchOpen && workbenchExpanded ? 'hidden' : 'flex'}`}>
          <ChatHeader
            sidebarVisible={sidebarDocked && sidebarOpen}
            stream={stream}
            workbenchOpen={workbenchOpen}
            scopeControl={
              <ScopeControl
                scope={currentProject?.path ?? null}
                picker={current === null ? { value: effectiveDraftProject, options: scopeOptions, onChange: changeDraftProject, onPickFolder: () => setFolderPickerOpen(true) } : undefined}
              />
            }
            title={currentSession?.title}
            pinned={currentSession?.pinned === true}
            onOpenSidebar={() => onLeftOpenChange(true)}
            onNew={beginConversation}
            onToggleWorkbench={() => onWorkbenchOpenChange(!workbenchOpen)}
            {...(current !== null ? {
              onTogglePinned: () => void togglePinned(current, currentSession?.pinned !== true),
              onCopyId: () => void copySessionId(current),
            } : {})}
          />

          {current === null ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 sm:px-6">
              <div className="m-auto flex w-full max-w-3xl flex-col gap-5 pb-[8dvh] pt-6">
                <div className="flex flex-col items-center gap-2 text-center">
                  <h1 className="m-0 text-[28px] font-medium tracking-tight">What can I help with?</h1>
                  <p className="m-0 max-w-xl text-sm text-fg-muted">
                    {draftProjectName !== undefined
                      ? `Working in ${draftProjectName}. Pick another folder from the folder chip at the top.`
                      : 'Pick a project folder from the folder chip at the top for file and shell tools, or keep Chat only.'}
                  </p>
                </div>
                {sendErrorNotice}
                {composerNode}
                <div className="flex flex-wrap justify-center gap-2">
                  {modelValue === null ? modelDefaultsState.status === 'error'
                    ? <Button variant="primary" size="sm" onClick={() => void refreshModelDefaults()}>Retry defaults</Button>
                    : <Button variant="primary" size="sm" disabled={modelDefaultsState.status === 'loading'} onClick={() => openSettings()}>{modelDefaultsState.status === 'loading' ? 'Loading defaults…' : availableModelOptions.length === 0 ? 'Configure provider' : 'Select default model'}</Button>
                    : null}
                  {suggestions.map((suggestion) => (
                    <Button key={suggestion} variant="outline" size="sm" className="text-fg-muted" disabled={modelValue === null} onClick={() => { setDraft(textDraft(suggestion)); focusComposer() }}>
                      {suggestion}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              <EnvironmentPanel
                workspaceId={activeWs}
                sessionId={current}
                project={currentProject}
                events={events}
                connected={stream !== 'reconnecting'}
                onOpenView={openEnvironmentView}
              />
              {events.length === 0 ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-muted" role="status" aria-live="polite">
                  <Spinner size={14} />Loading conversation…
                </div>
              ) : (
                <Transcript
                  key={current}
                  conversationId={current}
                  items={projectedItems}
                  events={events}
                  {...(effectiveModel !== null && effectiveModel !== '' ? { modelLabel: effectiveModel } : {})}
                  workspaceId={activeWs}
                  project={currentProject}
                  onReviewChanges={reviewTurnChanges}
                  onReuse={reuseInDraft}
                  onOpenChild={openSession}
                  onRetry={retryLastTurn}
                  onOpenSettings={openProviderSettings}
                  openPath={openRecordedPath}
                />
              )}
              <section aria-label="Conversation composer" className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
                  <TaskStatus events={events} pending={approvals.length} sending={sending} connected={stream !== 'reconnecting'} />
                  <ApprovalBar key={key} approvals={approvals} scope={currentProject?.path ?? 'No project attached'} onAnswer={answer} />
                  {sendErrorNotice}
                  {composerNode}
                </div>
              </section>
            </>
          )}
          {terminalDock}
        </main>

        {workbenchDocked && workbenchOpen ? (
          <>
            {!workbenchExpanded ? (
              <div
                {...workbenchResize}
                aria-label="Resize workbench"
                className="group relative w-px shrink-0 cursor-col-resize bg-line outline-none focus-visible:bg-link"
              >
                <span aria-hidden="true" className="absolute inset-y-0 -left-1.5 -right-1.5 group-hover:bg-line/60" />
              </div>
            ) : null}
            <aside className="h-full min-w-0 shrink-0" style={workbenchExpanded ? { flex: '1 1 0%' } : { width: preferences.rightWidth, maxWidth: '60vw' }}>
              {workbench}
            </aside>
          </>
        ) : null}
      </div>

      {!workbenchDocked ? (
        <Sheet open={workbenchOpen} onOpenChange={onWorkbenchOpenChange} side="right" label="Workbench" className="w-[min(720px,100vw)]">
          {workbench}
        </Sheet>
      ) : null}
      <LazySettings
        initialTab={settingsSection}
        workspaceName={activeWorkspace?.name}
        projects={projects}
        onProjectsChanged={refreshList}
        sessionCounts={sessionCounts}
        open={settingsOpen}
        workspaceId={activeWs}
        providers={meta?.providers ?? []}
        activeProvider={modelDefaults?.provider ?? ''}
        activeModel={modelDefaults?.model ?? ''}
        onDismiss={() => setSettingsOpen(false)}
        onRefresh={async () => {
          await Promise.all([refreshMeta(), refreshModelDefaults()])
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete !== null ? `Delete conversation "${pendingDelete.title || 'untitled'}"?` : ''}
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onDismiss={() => setPendingDelete(null)}
      />
      <FolderPickerModal
        open={folderPickerOpen}
        onDismiss={() => setFolderPickerOpen(false)}
        onConfirm={(folderPath) => {
          setFolderPickerOpen(false)
          void registerFolder(folderPath)
        }}
      />
    </>
  )
}
