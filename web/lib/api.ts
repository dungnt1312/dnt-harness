import type { AttachmentRef } from './composer-draft.ts'
import type { AdditionalDirectory, AgentDefinitionRow, ChildRow, CommandRow, ContextManifestView, Envelope, FolderGrant, HooksConfigRow, HooksSectionRow, SessionGrantsView, McpServerRow, MemoryEntryRow, Meta, ModeCatalogRow, ModeFileRow, ModelAliasInput, ModelAliasRow, ModelDefaults, ProjectRow, ProviderInput, ProviderSummary, SecretRow, SessionListing, SessionModel, ResourceSourcesDoc, SkillFileRow, SkillRow, SkillRuleRow, TerminalFrame, TerminalListing, TerminalRow, UsageDailyResponse, UserQuestionAnswer, WorkspaceMeta, WorkspaceRow, WorkspaceSourcesRow } from './types.ts'

const CSRF_HEADER = 'x-dnt-harness-csrf'
let csrfToken: string | undefined

/** Remember the CSRF token returned by pairing. Cookie mutations send it back. */
export function setCsrfToken(token: string | undefined): void {
  csrfToken = token
}

/**
 * Whether this browser is paired. A paired session also returns its CSRF
 * token, so a reloaded page can mutate again. A disabled control plane
 * reports ready.
 */
export async function fetchAuthState(): Promise<{ required: boolean; paired: boolean }> {
  const state = await apiFetch('/api/auth/state').then((response) => json<{ required: boolean; paired: boolean; csrf?: string }>(response))
  if (state.csrf !== undefined) setCsrfToken(state.csrf)
  return { required: state.required, paired: state.paired }
}

let onUnauthorized: (() => void) | undefined

/** Called whenever a request is refused for lack of a live session (expired, revoked, restarted host). */
export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  onUnauthorized = handler
}

/**
 * The only REST entry point. Credentials stay same-origin; unsafe methods
 * carry the CSRF header. A 401 means the browser needs to pair again, so the
 * app is told to show the pairing gate instead of a bare HTTP error.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== 'GET' && method !== 'HEAD' && csrfToken !== undefined) headers.set(CSRF_HEADER, csrfToken)
  const response = await fetch(input, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 401 && !input.startsWith('/api/auth/')) {
    csrfToken = undefined
    onUnauthorized?.()
  }
  return response
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}: ${body}`)
    this.name = 'HttpError'
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new HttpError(response.status, await response.text())
  }
  return (await response.json()) as T
}

export function listSessions(): Promise<SessionListing[]> {
  return apiFetch('/api/sessions').then((r) => json<SessionListing[]>(r))
}

export function createSession(folder?: string): Promise<{ id: string; folder?: string }> {
  return apiFetch('/api/sessions', {
    method: 'POST',
    ...(folder !== undefined ? {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder }),
    } : {}),
  }).then((r) => json<{ id: string; folder?: string }>(r))
}

export function deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).then((r) =>
    json<{ deleted: boolean }>(r),
  )
}

export function renameSession(sessionId: string, title: string): Promise<{ id: string; title: string }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((r) => json<{ id: string; title: string }>(r))
}

/** Set this session's workspace; an empty path resets it to server default. */
export function setSessionFolder(sessionId: string, path: string): Promise<{ folder: string | null }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/folder`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then((r) => json<{ folder: string | null }>(r))
}

export function stopSession(sessionId: string): Promise<{ stopped: boolean }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' }).then((r) =>
    json<{ stopped: boolean }>(r),
  )
}

/** Send one message. Pass a stable `clientRequestId` so transport retries deduplicate server-side. */
export function sendMessage(sessionId: string, content: string, clientRequestId?: string): Promise<{ inputId: string; queued: boolean; duplicate?: boolean }> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, ...(clientRequestId !== undefined ? { clientRequestId } : {}) }),
  }).then((r) => json<{ inputId: string; queued: boolean; duplicate?: boolean }>(r))
}

/**
 * Answer one approval. `scope: 'session'` (out-of-grant questions only) also
 * grants the question's proposed folder to the conversation once allowed.
 */
export function answerApproval(approvalId: string, allow: boolean, scope: 'once' | 'session' = 'once'): Promise<void> {
  return apiFetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allow, ...(scope === 'session' ? { scope } : {}) }),
  }).then((r) => json<{ answered: boolean }>(r)).then(() => undefined)
}

/** Answer (or decline) one AskUserQuestion; `answers` align with its questions. */
export function answerQuestion(questionId: string, reply: { readonly answers: readonly UserQuestionAnswer[] } | { readonly decline: true }): Promise<void> {
  return apiFetch(`/api/questions/${encodeURIComponent(questionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reply),
  }).then((r) => json<{ answered: boolean }>(r)).then(() => undefined)
}

/** Server-side metadata: active pair, default folder, safe provider list. */
export function fetchMeta(): Promise<Meta> {
  return apiFetch('/api/meta').then((r) => json<Meta>(r))
}

/** Select an exact provider/model pair. Omit provider only for legacy callers. */
export function setModel(model: string, provider?: string): Promise<Meta> {
  return apiFetch('/api/model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...(provider !== undefined ? { provider } : {}) }),
  }).then((r) => json<{ model: string }>(r)).then(() => fetchMeta())
}

/** Switch the default workspace inherited by sessions without their own path. */
export function setFolder(path: string): Promise<Meta> {
  return apiFetch('/api/folder', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then((r) => json<{ folder: string }>(r)).then(() => fetchMeta())
}

export function listProviders(): Promise<ProviderSummary[]> {
  return apiFetch('/api/providers').then((r) => json<ProviderSummary[]>(r))
}

export function listModelAliases(): Promise<ModelAliasRow[]> {
  return apiFetch('/api/model-aliases').then((r) => json<ModelAliasRow[]>(r))
}

export function createModelAlias(input: ModelAliasInput): Promise<ModelAliasRow> {
  return apiFetch('/api/model-aliases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then((r) => json<ModelAliasRow>(r))
}

export function updateModelAlias(name: string, input: Partial<ModelAliasInput> & { readonly expectedRevision: number }): Promise<ModelAliasRow> {
  return apiFetch(`/api/model-aliases/${encodeURIComponent(name)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then((r) => json<ModelAliasRow>(r))
}

export function deleteModelAlias(name: string, expectedRevision: number): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/model-aliases/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision }) }).then((r) => json<{ deleted: boolean }>(r))
}

/** Settings → Usage: daily token rows across every workspace. */
export function fetchUsage(): Promise<UsageDailyResponse> {
  return apiFetch('/api/usage').then((r) => json<UsageDailyResponse>(r))
}

// ── automations + web push ─────────────────────────────────────

export interface AutomationControls {
  readonly provider: string | null
  readonly model: string | null
  readonly thinkingLevel: string | null
}

export interface AutomationInput {
  readonly title: string
  readonly prompt: string
  /** Recurring cron (host time) or one instant. */
  readonly schedules: readonly ({ readonly cron: string } | { readonly at: number })[]
  /** No runs after this instant; null = never ends. */
  readonly endsAt: number | null
  /** Stop after this many scheduled runs; null = unlimited. */
  readonly maxRuns: number | null
  readonly projectId: string | null
  readonly modeId: string | null
  readonly controls: AutomationControls | null
  /** Agent role the run delegates to (as a subagent); null = the main agent. */
  readonly agent: string | null
  readonly enabled: boolean
  /** Send the result to the user when a run ends. */
  readonly notify: boolean
  /** `'push'` and/or channel ids; null = push plus every enabled channel. */
  readonly notifyTargets: readonly string[] | null
  readonly catchUpMinutes?: number
}

export interface AutomationRow extends AutomationInput {
  readonly id: string
  readonly catchUpMinutes: number
  /** Scheduled runs started under the current plan. */
  readonly runCount: number
  readonly createdAt: number
  readonly updatedAt: number
  /** Next fire instants (ms), empty when disabled. */
  readonly nextRuns: readonly number[]
  /** No runs left under this plan (one-time done, end date passed, run count used up). */
  readonly finished: boolean
}

export type AutomationRunStatus = 'started' | 'done' | 'failed' | 'needs-approval' | 'missed' | 'skipped-busy'

export interface AutomationRun {
  readonly runId: string
  readonly automationId: string
  readonly dueAt: number | null
  readonly at: number
  readonly status: AutomationRunStatus
  readonly sessionId?: string
  readonly error?: string
  readonly summary?: string
}

const automationsPath = (workspaceId: string, id?: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/automations${id !== undefined ? `/${encodeURIComponent(id)}` : ''}`

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export function listAutomations(workspaceId: string): Promise<readonly AutomationRow[]> {
  return apiFetch(automationsPath(workspaceId)).then((r) => json<readonly AutomationRow[]>(r))
}

export function createAutomation(workspaceId: string, input: AutomationInput): Promise<AutomationRow> {
  return apiFetch(automationsPath(workspaceId), jsonInit('POST', input)).then((r) => json<AutomationRow>(r))
}

export function updateAutomation(workspaceId: string, id: string, patch: Partial<AutomationInput>): Promise<AutomationRow> {
  return apiFetch(automationsPath(workspaceId, id), jsonInit('PATCH', patch)).then((r) => json<AutomationRow>(r))
}

export async function deleteAutomation(workspaceId: string, id: string): Promise<void> {
  await apiFetch(automationsPath(workspaceId, id), { method: 'DELETE' }).then((r) => json<unknown>(r))
}

export function runAutomationNow(workspaceId: string, id: string): Promise<{ readonly runId: string; readonly sessionId?: string; readonly skipped?: true }> {
  return apiFetch(`${automationsPath(workspaceId, id)}/run`, { method: 'POST' }).then((r) => json<{ runId: string; sessionId?: string; skipped?: true }>(r))
}

export function listAutomationRuns(workspaceId: string, id: string): Promise<readonly AutomationRun[]> {
  return apiFetch(`${automationsPath(workspaceId, id)}/runs`).then((r) => json<readonly AutomationRun[]>(r))
}

/** Next fire times for an unsaved plan; rejects with the server's validation error. */
export function previewSchedules(plan: Pick<AutomationInput, 'schedules' | 'endsAt' | 'maxRuns'>): Promise<{ readonly next: readonly number[] }> {
  return apiFetch('/api/automations/preview', jsonInit('POST', plan)).then((r) => json<{ next: readonly number[] }>(r))
}

export interface PushDevice {
  readonly id: string
  readonly label: string
  readonly createdAt: number
  readonly endpoint: string
}

export function getPushKey(): Promise<string> {
  return apiFetch('/api/push/key').then((r) => json<{ publicKey: string }>(r)).then((body) => body.publicKey)
}

export function listPushDevices(): Promise<readonly PushDevice[]> {
  return apiFetch('/api/push/subscriptions').then((r) => json<readonly PushDevice[]>(r))
}

export function registerPushDevice(subscription: PushSubscriptionJSON, label: string): Promise<PushDevice> {
  return apiFetch('/api/push/subscriptions', jsonInit('POST', { subscription, label })).then((r) => json<PushDevice>(r))
}

export async function removePushDevice(id: string): Promise<void> {
  await apiFetch(`/api/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<unknown>(r))
}

export function sendTestPush(): Promise<{ readonly sent: number; readonly removed: number; readonly failed: number }> {
  return apiFetch('/api/push/test', { method: 'POST' }).then((r) => json<{ sent: number; removed: number; failed: number }>(r))
}

export type ChannelKind = 'telegram' | 'teams' | 'discord'

/** A notification channel as the host shows it; secrets never come back. */
export interface NotifyChannel {
  readonly id: string
  readonly kind: ChannelKind
  readonly name: string
  readonly enabled: boolean
  readonly summary: string
  /** Teams: who each message @mentions. */
  readonly mentions?: readonly string[]
  readonly createdAt: number
}

export interface ChannelConfigInput {
  readonly botToken?: string
  readonly chatId?: string
  readonly webhookUrl?: string
  /** Teams: comma-separated emails (an empty string clears them). */
  readonly mentions?: string
}

export function listChannels(): Promise<readonly NotifyChannel[]> {
  return apiFetch('/api/notify/channels').then((r) => json<readonly NotifyChannel[]>(r))
}

export function createChannel(input: { readonly kind: ChannelKind; readonly name: string; readonly config: ChannelConfigInput }): Promise<NotifyChannel> {
  return apiFetch('/api/notify/channels', jsonInit('POST', input)).then((r) => json<NotifyChannel>(r))
}

export function updateChannel(id: string, patch: { readonly name?: string; readonly enabled?: boolean; readonly config?: ChannelConfigInput }): Promise<NotifyChannel> {
  return apiFetch(`/api/notify/channels/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)).then((r) => json<NotifyChannel>(r))
}

export async function deleteChannel(id: string): Promise<void> {
  await apiFetch(`/api/notify/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<unknown>(r))
}

export async function testChannel(id: string): Promise<void> {
  await apiFetch(`/api/notify/channels/${encodeURIComponent(id)}/test`, { method: 'POST' }).then((r) => json<unknown>(r))
}

export function createProvider(input: Required<Pick<ProviderInput, 'name' | 'baseUrl' | 'apiKey'>> & ProviderInput): Promise<ProviderSummary> {
  return apiFetch('/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ProviderSummary>(r))
}

export function updateProvider(id: string, input: ProviderInput): Promise<ProviderSummary> {
  return apiFetch(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ProviderSummary>(r))
}

export function deleteProvider(id: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<{ deleted: boolean }>(r))
}

/**
 * What the endpoint offers right now. A probe: nothing is stored, so the
 * caller chooses what to keep and saves it like any other edit.
 */
export function fetchProviderModels(id: string): Promise<{ ok: boolean; models: string[] }> {
  return apiFetch(`/api/providers/${encodeURIComponent(id)}/models`).then((r) => json<{ ok: boolean; models: string[] }>(r))
}

/** Replace the stored model list with the endpoint's, server-side (REST clients). */
export function syncProvider(id: string): Promise<{ ok: boolean; models: string[] }> {
  return apiFetch(`/api/providers/${encodeURIComponent(id)}/sync`, { method: 'POST' }).then((r) =>
    json<{ ok: boolean; models: string[] }>(r),
  )
}

/** Ping one model of a provider. Omit `model` to use the provider's first. */
export function testProvider(id: string, model?: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(`/api/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    ...(model !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) } : {}),
  }).then((r) => json<{ ok: boolean; error?: string }>(r))
}

/** Live connection state of one session's event stream. */
export type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting'

/**
 * Subscribe to one session's event stream. `onState` reports the EventSource
 * lifecycle (initial connect, open, and the automatic reconnect on drop).
 * Returns a disposer closing the source; the browser reconnects on its own
 * until then.
 */
export function subscribeEvents(
  sessionId: string,
  onEnvelope: (envelope: Envelope) => void,
  onState?: (state: StreamState) => void,
): () => void {
  return wire((cursor) => `/api/sessions/${encodeURIComponent(sessionId)}/events${cursorSuffix(cursor)}`, onEnvelope, onState)
}

function cursorSuffix(cursor: number | undefined): string {
  return cursor !== undefined && Number.isSafeInteger(cursor) && cursor >= 0 ? `?cursor=${cursor}` : ''
}

/**
 * Hidden at least this long, the old socket is presumed dead: mobile OSes
 * suspend a backgrounded page within seconds, and the server's 25 s ping is an
 * SSE comment the page cannot observe. A needless swap costs one small resume.
 */
const RESUME_RECONNECT_MS = 3_000

/** Workspace-scoped subscription (G2): the session's owning workspace is part of the address. */
export function subscribeEventsIn(
  workspaceId: string,
  sessionId: string,
  onEnvelope: (envelope: Envelope, cursor?: number) => void,
  onState?: (state: StreamState) => void,
  cursor?: number,
): () => void {
  return wire((at) => `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/events${cursorSuffix(at)}`, onEnvelope, onState, cursor)
}

/**
 * Mobile browsers freeze a backgrounded page and leave its socket dead or
 * half-open; the native retry then waits for a TCP timeout or its own delay,
 * which is slower than a reload. Returning to the page (or regaining network)
 * after a long hide, or with the source not open, swaps in a fresh source that
 * resumes from the last seen frame id, the same path a cached navigation uses.
 */
function wire(
  urlAt: (cursor: number | undefined) => string,
  onEnvelope: (envelope: Envelope, cursor?: number) => void,
  onState?: (state: StreamState) => void,
  initialCursor?: number,
): () => void {
  let lastCursor = initialCursor
  return resilientSource(() => urlAt(lastCursor), (message) => {
    const cursor = /^\d+$/.test(message.lastEventId ?? '') ? Number(message.lastEventId) : undefined
    const safe = cursor !== undefined && Number.isSafeInteger(cursor) ? cursor : undefined
    if (safe !== undefined) lastCursor = safe
    onEnvelope(JSON.parse(message.data) as Envelope, safe)
  }, onState)
}

/** An EventSource that is swapped for a fresh one on return from a long hide or on a network return (see {@link wire}). */
function resilientSource(
  url: () => string,
  onMessage: (message: MessageEvent<string>) => void,
  onState?: (state: StreamState) => void,
): () => void {
  let hiddenAt = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? Date.now() : undefined
  let source: EventSource
  const open = (): void => {
    const current = new EventSource(url())
    source = current
    current.onopen = () => onState?.('open')
    current.onerror = () => {
      onState?.(current.readyState === EventSource.CONNECTING ? 'reconnecting' : 'connecting')
    }
    current.onmessage = onMessage
  }
  const reconnect = (): void => {
    source.close()
    onState?.('reconnecting')
    open()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') { hiddenAt ??= Date.now(); return }
    const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt
    hiddenAt = undefined
    if (away >= RESUME_RECONNECT_MS || source.readyState !== EventSource.OPEN) reconnect()
  }
  // Network came back: the socket from before the drop is dead even if it still reports OPEN.
  const onOnline = (): void => reconnect()
  open()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
  return () => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
    source.close()
  }
}


// ── G2: workspaces & projects ───────────────────────────────────────────────

export function listWorkspaces(): Promise<WorkspaceRow[]> {
  return apiFetch('/api/workspaces').then((r) => json<WorkspaceRow[]>(r))
}

export function createWorkspace(name: string): Promise<WorkspaceRow> {
  return apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<WorkspaceRow>(r))
}

/** Rename a workspace (PATCH name). */
export function renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<WorkspaceRow>(r))
}

/** Archive (true) or restore (false); refused while sessions run (409). */
export function setWorkspaceArchived(workspaceId: string, archived: boolean): Promise<WorkspaceRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  }).then((r) => json<WorkspaceRow>(r))
}

/** Delete an empty workspace; a non-empty one answers 409 `workspace-not-empty` unless `force` removes its sessions and projects too. */
export function deleteWorkspace(workspaceId: string, force = false): Promise<{ readonly deleted: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}${force ? '?force=true' : ''}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: boolean }>(r),
  )
}

export function listProjects(workspaceId: string): Promise<ProjectRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`).then((r) => json<ProjectRow[]>(r))
}

export function createProject(workspaceId: string, name: string, path: string): Promise<ProjectRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, path }),
  }).then((r) => json<ProjectRow>(r))
}

/** Persist a sidebar folder order; answers the reordered rows. */
export function reorderProjects(workspaceId: string, order: readonly string[]): Promise<ProjectRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/order`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order }),
  }).then((r) => json<ProjectRow[]>(r))
}

/** One level of the folder picker: child directories of `path` (home when empty). */
export interface FolderListing {
  readonly path: string
  readonly parent: string | null
  readonly dirs: readonly { readonly name: string; readonly path: string }[]
}

export function listDirs(path?: string): Promise<FolderListing> {
  const query = path !== undefined && path !== '' ? `?path=${encodeURIComponent(path)}` : ''
  return apiFetch(`/api/fs/dirs${query}`).then((r) => json<FolderListing>(r))
}

/** One entry of a read-only project listing; `path` is root-relative with `/`. */
export interface ProjectEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'dir' | 'file'
  readonly size?: number
}

export interface ProjectListing {
  readonly path: string
  readonly entries: readonly ProjectEntry[]
}

export interface ProjectFileView {
  readonly path: string
  readonly size: number
  readonly binary: boolean
  readonly truncated: boolean
  readonly content: string
  /** Project files only: the viewer may edit and save this file. */
  readonly editable?: boolean
  /** Project files only: sha256 of the stored bytes, sent back on save. */
  readonly hash?: string
}

const projectBase = (workspaceId: string, projectId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`

export function listProjectFiles(workspaceId: string, projectId: string, path: string): Promise<ProjectListing> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/files?path=${encodeURIComponent(path)}`).then((r) => json<ProjectListing>(r))
}

export function readProjectFile(workspaceId: string, projectId: string, path: string): Promise<ProjectFileView> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/file?path=${encodeURIComponent(path)}`).then((r) => json<ProjectFileView>(r))
}

/** Explorer writes; the server never overwrites (409) and refuses the root and `.git` (400). */
export function createProjectEntry(workspaceId: string, projectId: string, path: string, kind: 'file' | 'dir'): Promise<ProjectEntry> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, kind }),
  }).then((r) => json<ProjectEntry>(r))
}

/** Rename in the same folder; resolves with the entry's new root-relative path. */
export function renameProjectEntry(workspaceId: string, projectId: string, path: string, name: string): Promise<{ path: string; kind: 'file' | 'dir' }> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/files`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
  }).then((r) => json<{ path: string; kind: 'file' | 'dir' }>(r))
}

/** Permanent delete; a folder goes with everything inside it. */
export function deleteProjectEntry(workspaceId: string, projectId: string, path: string): Promise<{ deleted: true; path: string }> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    .then((r) => json<{ deleted: true; path: string }>(r))
}

/** The file changed on disk since it was opened; `currentHash` is what is there now. */
export class SaveConflictError extends Error {
  constructor(readonly currentHash: string) {
    super('The file changed on disk since it was opened.')
    this.name = 'SaveConflictError'
  }
}

/** Save the viewer's text; refuses (SaveConflictError) when the file no longer hashes to `expectedHash`. */
export async function saveProjectFile(workspaceId: string, projectId: string, path: string, content: string, expectedHash: string): Promise<{ path: string; size: number; hash: string }> {
  const response = await apiFetch(`${projectBase(workspaceId, projectId)}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, expectedHash }),
  })
  if (response.status === 409) {
    // Clone so a 409 without a hash still reaches json() as an HttpError with its body.
    const body = (await response.clone().json().catch(() => ({}))) as { currentHash?: unknown }
    if (typeof body.currentHash === 'string') throw new SaveConflictError(body.currentHash)
  }
  return json<{ path: string; size: number; hash: string }>(response)
}

/** One raw file from a memory folder (the project tier with `projectId`, else the workspace tier). */
export function readMemoryFile(workspaceId: string, path: string, projectId?: string): Promise<ProjectFileView> {
  const project = projectId !== undefined ? `&projectId=${encodeURIComponent(projectId)}` : ''
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory-file?path=${encodeURIComponent(path)}${project}`).then((r) => json<ProjectFileView>(r))
}

/** The URL that streams one project file as image/audio/video media. */
export function projectMediaUrl(workspaceId: string, projectId: string, path: string): string {
  return `${projectBase(workspaceId, projectId)}/media?path=${encodeURIComponent(path)}`
}

/** Media kinds the browser renders itself, decided by the file name alone. */
export type MediaKind = 'image' | 'audio' | 'video'

const MEDIA_BY_EXTENSION: Readonly<Record<string, MediaKind>> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image', heic: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio', weba: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', ogv: 'video',
}

/** The preview kind a path qualifies for, or null when it is not media. */
export function mediaKindOf(path: string): MediaKind | null {
  return MEDIA_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? null
}

/** One `@` mention candidate: a file name and its root-relative path. */
export interface ProjectMatch {
  readonly name: string
  readonly path: string
  readonly score: number
}

export interface ProjectSearchResult {
  readonly query: string
  readonly matches: readonly ProjectMatch[]
  /** The walk hit its budget, so more files may match than are listed. */
  readonly truncated: boolean
}

export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict'

/** Zed `StageStatus`. */
export type GitStaging = 'staged' | 'unstaged' | 'partial'

/** One changed path from `git status` (mirrors `src/web/project-git.ts`). */
export interface GitChange {
  readonly path: string
  readonly previousPath?: string
  readonly status: GitChangeStatus
  /** Raw index (X) column of the porcelain code; `' '` when unmodified, `'?'` when untracked. */
  readonly indexStatus: string
  /** Raw worktree (Y) column of the porcelain code. */
  readonly worktreeStatus: string
  /** Zed `FileStatus::is_created`: added to the index or the worktree, or untracked. */
  readonly created: boolean
  readonly deleted: boolean
  /** Unmerged. */
  readonly conflicted: boolean
  readonly staging: GitStaging
  readonly added?: number
  readonly removed?: number
}

/** How the current branch relates to its upstream (Zed `UpstreamTracking`). */
export type GitUpstreamTrack =
  | { readonly kind: 'tracked'; readonly ahead: number; readonly behind: number }
  | { readonly kind: 'gone' }
  | { readonly kind: 'none' }

export interface GitBranchInfo {
  readonly name: string
  readonly upstream?: { readonly remote: string; readonly branch: string }
  readonly upstreamTrack: GitUpstreamTrack
}

/** The latest commit on HEAD. */
export interface GitHead {
  readonly sha: string
  readonly subject: string
  /** The full commit message (subject and body), for Amend and Uncommit. */
  readonly message: string
  /** False for a root commit: there is nothing to uncommit to. */
  readonly hasParent: boolean
}

export interface GitStatusReport {
  readonly branch: string | null
  /** Current branch with its upstream; `null` when detached or not a repository. */
  readonly branchInfo: GitBranchInfo | null
  /** Latest commit; `null` when there is none. */
  readonly head: GitHead | null
  readonly changes: readonly GitChange[]
  readonly truncated: boolean
  /** Commits ahead of the upstream, when the branch tracks one. */
  readonly ahead?: number
  /** Commits behind the upstream, when the branch tracks one. */
  readonly behind?: number
  /** A merge, cherry-pick, rebase, revert or apply is in progress. */
  readonly mergeHeads?: boolean
  /** `MERGE_MSG` (comment lines stripped), the suggested commit message while merging. */
  readonly mergeMessage?: string
}

export interface GitDiffLine {
  readonly kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'
  readonly text: string
}

/** Zed `secondary_status` of one displayed hunk. */
export type GitHunkStatus = 'staged' | 'unstaged' | 'partial'

/** The identity of one displayed hunk; the server refuses a stale one. */
export interface GitHunkRef {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly fingerprint: string
}

export interface GitHunk extends GitHunkRef {
  readonly status: GitHunkStatus
}

/** One conflict region of a conflicted file (Zed `conflict_set.rs`). */
export interface GitConflict {
  readonly index: number
  readonly startLine: number
  readonly endLine: number
  readonly ours: string
  readonly theirs: string
  readonly oursName: string
  readonly theirsName: string
  readonly fingerprint: string
}

export interface GitDiffReport {
  readonly path: string
  readonly lines: readonly GitDiffLine[]
  readonly truncated: boolean
  readonly binary: boolean
  /** The displayed hunks; empty when hunk controls are not offered for this file. */
  readonly hunks?: readonly GitHunk[]
  /** Conflict regions of a conflicted file. */
  readonly conflicts?: readonly GitConflict[]
}

/** One branch from `for-each-ref` (Zed `Branch`). `name` is short: `main`, `origin/main`. */
export interface GitBranch {
  readonly name: string
  readonly remote: boolean
  readonly current: boolean
  readonly upstream?: string
  readonly unixTime?: number
  readonly subject?: string
}

/** Read-only git status for a project. An empty `changes` is a clean tree or no repository. */
export function fetchGitStatus(workspaceId: string, projectId: string): Promise<GitStatusReport> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/git`).then((r) => json<GitStatusReport>(r))
}

/** One background-process row from the host registry. */
export interface SessionProcessSnapshot {
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly status: 'running' | 'exited' | 'killed' | 'failed' | 'interrupted'
  readonly startedAt: number
  readonly exitCode: number | null
  readonly durationMs: number
  readonly truncated: boolean
}

/** Live registry snapshot for one session — reconciliation, not hydration. */
export function listSessionProcesses(workspaceId: string, sessionId: string): Promise<readonly SessionProcessSnapshot[]> {
  return apiFetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/processes`).then((r) => json<readonly SessionProcessSnapshot[]>(r))
}

/** One process plus its captured output, for the workbench detail view. */
export interface SessionProcessDetail extends SessionProcessSnapshot {
  readonly output: string
  readonly outputTruncated: boolean
}

/** Detail of one background process; 404 once the host no longer knows it. */
export function getSessionProcess(workspaceId: string, sessionId: string, processId: string): Promise<SessionProcessDetail> {
  return apiFetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/processes/${processId}`).then((r) => json<SessionProcessDetail>(r))
}

/** Operator stop of one background process; 409 when it already ended. */
export function stopSessionProcess(workspaceId: string, sessionId: string, processId: string): Promise<{ stopped: boolean; processId: string }> {
  return apiFetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/processes/${processId}/stop`, { method: 'POST' }).then((r) => json<{ stopped: boolean; processId: string }>(r))
}

/** Read-only unified diff of one root-relative path against HEAD. */
export function fetchGitDiff(workspaceId: string, projectId: string, path: string): Promise<GitDiffReport> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/git?path=${encodeURIComponent(path)}`).then((r) => json<GitDiffReport>(r))
}

/** The body of `POST …/git/:op`; `type` is the route's `:op`. Mirrors `parseGitOperation` in `src/web/server.ts`. */
export type GitOperationInput =
  | { readonly type: 'stage' | 'unstage' | 'discard' | 'trash'; readonly paths: readonly string[] }
  | { readonly type: 'stage-all' | 'unstage-all' | 'uncommit' | 'fetch-all' }
  | { readonly type: 'commit'; readonly message: string; readonly amend?: boolean; readonly signoff?: boolean; readonly noVerify?: boolean; readonly tracked?: boolean }
  | { readonly type: 'fetch'; readonly remote: string }
  | { readonly type: 'pull'; readonly remote: string; readonly branch?: string; readonly rebase?: boolean }
  | { readonly type: 'push'; readonly remote: string; readonly branch: string; readonly upstreamBranch?: string; readonly setUpstream?: boolean; readonly force?: boolean }
  /** Query: the remotes of a branch (`push` asks for the push remote; `all` lists every remote, as Push To and Fetch From do); answered in `done.remotes`. */
  | { readonly type: 'remotes'; readonly branch: string; readonly push?: boolean; readonly all?: boolean }
  /** Query: the remote refs containing HEAD; answered in `done.pushedTo`. */
  | { readonly type: 'pushed-to' }
  /** Query: local and remote branches; answered in `done.branches`, `done.defaultBranch` and `done.error`. */
  | { readonly type: 'branches' }
  | { readonly type: 'switch-branch'; readonly name: string }
  | { readonly type: 'create-branch'; readonly name: string; readonly base?: string }
  | { readonly type: 'delete-branch'; readonly name: string; readonly remote?: boolean; readonly force?: boolean }
  | { readonly type: 'stage-hunk' | 'unstage-hunk' | 'restore-hunk'; readonly path: string; readonly hunk: GitHunkRef }
  | { readonly type: 'resolve-conflict'; readonly path: string; readonly index: number; readonly fingerprint: string; readonly choice: 'ours' | 'theirs' | 'both' }
  | { readonly type: 'ignore'; readonly paths: readonly string[] }

/** A credential prompt Git raised while the operation runs. */
export interface GitAskpassFrame {
  readonly type: 'askpass'
  readonly promptId: string
  readonly operation: string
  readonly prompt: string
}

/** The last frame of an operation. `status` can be absent (a failure before Git could report it). */
export interface GitOperationDone {
  readonly type: 'done'
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly status?: GitStatusReport
  /** The user cancelled a prompt, so Git was stopped. */
  readonly cancelled?: boolean
  readonly remotes?: readonly string[]
  readonly pushedTo?: readonly string[]
  /** The `branches` query's answer. */
  readonly branches?: readonly GitBranch[]
  /** The repository's default branch, when one resolves (Zed `default_branch`). */
  readonly defaultBranch?: string
  /** Why the branch list is partial (Zed `branch_list_error`). */
  readonly error?: string
}

export type GitOperationFrame = GitAskpassFrame | GitOperationDone

/** The answer to a prompt: the password, or a cancel that stops Git. */
export type GitAskpassAnswer = { readonly password: string } | { readonly cancel: true }

/** Answer one prompt of a running operation (`POST …/git/askpass/:promptId`). The password is not echoed back. */
export function answerGitAskpass(workspaceId: string, projectId: string, promptId: string, answer: GitAskpassAnswer): Promise<void> {
  return apiFetch(`${projectBase(workspaceId, projectId)}/git/askpass/${encodeURIComponent(promptId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer),
  }).then((r) => json<{ readonly answered: boolean }>(r)).then(() => undefined)
}

/** Trust (or stop trusting) a project's repository config and hooks for Git. */
export function updateProjectGitTrust(workspaceId: string, projectId: string, gitTrusted: boolean): Promise<ProjectRow> {
  return apiFetch(projectBase(workspaceId, projectId), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gitTrusted }),
  }).then((r) => json<ProjectRow>(r))
}

function parseGitFrame(line: string): GitOperationFrame {
  let frame: unknown
  try {
    frame = JSON.parse(line)
  } catch {
    throw new Error('Git operation stream carried a malformed frame')
  }
  const type = (frame as { readonly type?: unknown } | null)?.type
  if (type !== 'askpass' && type !== 'done') throw new Error('Git operation stream carried an unknown frame')
  return frame as GitOperationFrame
}

/** How long the stream is still read after an answer could not be delivered, before the request is aborted. */
const GIT_ANSWER_GRACE_MS = 1_500

/**
 * Run one Git operation (`POST …/git/:op`). The response is NDJSON read as it
 * arrives: each `askpass` frame goes to `onAskpass` straight away, and what it
 * resolves to is posted back (a rejection cancels the prompt); the promise
 * resolves with the `done` frame. The `signal` handed to `onAskpass` aborts when
 * the stream finishes or fails, so a prompt dialog can close itself. A request
 * refused before the stream starts is an `HttpError`. If the answer cannot be
 * delivered, the stream is still read: a `done` frame that arrives resolves the
 * promise (the operation ended on its own); if none arrives within
 * `GIT_ANSWER_GRACE_MS`, the request is aborted, which cancels Git on the
 * server, and the promise rejects with the delivery error.
 */
export async function gitOperation(
  workspaceId: string,
  projectId: string,
  input: GitOperationInput,
  onAskpass: (prompt: GitAskpassFrame, signal: AbortSignal) => Promise<GitAskpassAnswer>,
): Promise<GitOperationDone> {
  const { type, ...body } = input
  const abort = new AbortController()
  const streamEnded = new AbortController()
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const response = await apiFetch(`${projectBase(workspaceId, projectId)}/git/${type}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal,
  })
  if (!response.ok) throw new HttpError(response.status, await response.text())
  if (response.body === null) throw new Error('Git operation answered without a stream')

  let failure: unknown
  let finished = false
  const answer = (prompt: GitAskpassFrame): void => {
    void (async () => {
      let reply: GitAskpassAnswer
      try {
        reply = await onAskpass(prompt, streamEnded.signal)
      } catch {
        reply = { cancel: true }
      }
      if (finished) return
      await answerGitAskpass(workspaceId, projectId, prompt.promptId, reply)
    })().catch((error: unknown) => {
      if (finished) return
      failure = error
      // Git may still end by itself (the prompt was already cancelled there):
      // keep reading for a short while before giving up on the operation.
      graceTimer ??= setTimeout(() => { if (!finished) abort.abort() }, GIT_ANSWER_GRACE_MS)
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const take = (line: string): GitOperationDone | undefined => {
    if (line.trim() === '') return undefined
    const frame = parseGitFrame(line)
    if (frame.type === 'done') return frame
    answer(frame)
    return undefined
  }
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        throw failure ?? error
      }
      if (chunk.done) break
      pending += decoder.decode(chunk.value, { stream: true })
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const done = take(line)
        if (done !== undefined) return done
      }
    }
    pending += decoder.decode()
    const done = take(pending)
    if (done !== undefined) return done
    throw failure ?? new Error('Git operation ended without a result')
  } finally {
    finished = true
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    streamEnded.abort()
    reader.cancel().catch(() => {})
  }
}

/**
 * Stream a generated commit message (`POST …/git/commit-message`, NDJSON):
 * `onText` gets each delta as it arrives. Rejects with the server's own words
 * (no model configured, a provider error) and when the stream ends without a
 * `done`. Aborting `signal` cancels the model request on the server.
 */
export async function streamCommitMessage(
  workspaceId: string,
  projectId: string,
  subject: string | undefined,
  onText: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await apiFetch(`${projectBase(workspaceId, projectId)}/git/commit-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subject !== undefined && subject !== '' ? { subject } : {}),
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    let message = text
    try {
      const parsed = (JSON.parse(text) as { readonly error?: unknown }).error
      if (typeof parsed === 'string' && parsed !== '') message = parsed
    } catch { /* not JSON: the body is the message */ }
    throw new HttpError(response.status, message)
  }
  if (response.body === null) throw new Error('Commit message answered without a stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const take = (line: string): boolean => {
    if (line.trim() === '') return false
    const frame = JSON.parse(line) as { readonly type?: string; readonly text?: string; readonly ok?: boolean; readonly error?: string }
    if (frame.type === 'delta' && typeof frame.text === 'string') onText(frame.text)
    if (frame.type === 'done') {
      if (frame.ok !== true) throw new Error(frame.error ?? 'Commit message generation failed')
      return true
    }
    return false
  }
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      pending += decoder.decode(chunk.value, { stream: true })
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (take(line)) return
      }
    }
    pending += decoder.decode()
    if (take(pending)) return
    throw new Error('Commit message ended without a result')
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** Settings → Providers & Models → Git: the commit-message model (empty uses the `fast` alias). */
export type CommitMessageSettings = ImageGenerationSettings

export function getCommitMessageSettings(): Promise<CommitMessageSettings> {
  return apiFetch('/api/commit-message').then((r) => json<CommitMessageSettings>(r))
}

export function setCommitMessageSettings(update: CommitMessageSettings): Promise<CommitMessageSettings> {
  return apiFetch('/api/commit-message', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<CommitMessageSettings>(r))
}

/** Bounded file-name search under a project root (composer mentions). */
export function searchProjectFiles(workspaceId: string, projectId: string, query: string, limit?: number): Promise<ProjectSearchResult> {
  const cap = limit !== undefined ? `&limit=${limit}` : ''
  return apiFetch(`${projectBase(workspaceId, projectId)}/search?q=${encodeURIComponent(query)}${cap}`).then((r) => json<ProjectSearchResult>(r))
}

/** Per-workspace controls + project list. */
export function fetchWorkspaceMeta(workspaceId: string): Promise<WorkspaceMeta> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/meta`).then((r) => json<WorkspaceMeta>(r))
}

/** Read one conversation's controls; legacy `source: 'global'` follows live global defaults. */
export function getSessionModel(workspaceId: string, sessionId: string): Promise<SessionModel> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/model`).then((r) => json<SessionModel>(r))
}

/** Update a conversation's model controls; null deliberately clears a control. */
export function setSessionModel(
  workspaceId: string,
  sessionId: string,
  update: Partial<Pick<SessionModel, 'provider' | 'model' | 'thinkingLevel' | 'alias'>>,
): Promise<SessionModel> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<SessionModel>(r))
}

/** Read the global defaults used by drafts and new conversations. */
export function getModelDefaults(): Promise<ModelDefaults> {
  return apiFetch('/api/model-defaults').then((r) => json<ModelDefaults>(r))
}

/** Update global defaults. A complete provider/model pair or both null is required by the server. */
export function setModelDefaults(update: ModelDefaults): Promise<ModelDefaults> {
  return apiFetch('/api/model-defaults', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<ModelDefaults>(r))
}

/** @deprecated Global defaults are no longer workspace-scoped. Use `setModelDefaults`. */
export function setWorkspaceModel(workspaceId: string, model: string, provider?: string): Promise<unknown> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...(provider !== undefined ? { provider } : {}) }),
  }).then((r) => json<unknown>(r))
}

/** @deprecated Global defaults are no longer workspace-scoped. Use `setModelDefaults`. */
export function setWorkspaceThinking(workspaceId: string, level: string | null): Promise<{ thinkingLevel: string | null }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/thinking`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level }),
  }).then((r) => json<{ thinkingLevel: string | null }>(r))
}

export function listSessionsIn(workspaceId: string): Promise<SessionListing[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`).then((r) => json<SessionListing[]>(r))
}

export function createSessionIn(workspaceId: string, projectId?: string, controls?: ModelDefaults): Promise<{ id: string; projectId?: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(projectId !== undefined && projectId !== '' ? { projectId } : {}),
      ...(controls !== undefined ? { controls } : {}),
    }),
  }).then((r) => json<{ id: string; projectId?: string }>(r))
}

export function deleteSessionIn(workspaceId: string, sessionId: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  }).then((r) => json<{ deleted: boolean }>(r))
}

export function renameSessionIn(workspaceId: string, sessionId: string, title: string): Promise<{ id: string; title: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((r) => json<{ id: string; title: string }>(r))
}

/** Pin or unpin a conversation; the server records it in the session's own log. */
export function setSessionPinnedIn(workspaceId: string, sessionId: string, pinned: boolean): Promise<{ id: string; pinned: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  }).then((r) => json<{ id: string; pinned: boolean }>(r))
}

export function stopSessionIn(workspaceId: string, sessionId: string): Promise<{ stopped: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  }).then((r) => json<{ stopped: boolean }>(r))
}

/** Store one composer attachment; the reply is what a message carries. */
export function uploadAttachment(workspaceId: string, file: File): Promise<AttachmentRef> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': file.type !== '' ? file.type : 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  }).then((r) => json<AttachmentRef>(r))
}

/** Settings → Providers & Models → Image generation: the provider/model the GenerateImage tool calls. */
export interface ImageGenerationSettings {
  readonly provider: string | null
  readonly model: string | null
}

export function getImageGenerationSettings(): Promise<ImageGenerationSettings> {
  return apiFetch('/api/image-generation').then((r) => json<ImageGenerationSettings>(r))
}

export function setImageGenerationSettings(update: ImageGenerationSettings): Promise<ImageGenerationSettings> {
  return apiFetch('/api/image-generation', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<ImageGenerationSettings>(r))
}

/** Settings → Providers & Models → Image understanding: the DescribeImage model. */
export type ImageUnderstandingSettings = ImageGenerationSettings

export function getImageUnderstandingSettings(): Promise<ImageUnderstandingSettings> {
  return apiFetch('/api/image-understanding').then((r) => json<ImageUnderstandingSettings>(r))
}

export function setImageUnderstandingSettings(update: ImageUnderstandingSettings): Promise<ImageUnderstandingSettings> {
  return apiFetch('/api/image-understanding', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<ImageUnderstandingSettings>(r))
}

/** Settings → Providers & Models → Speech-to-text: the dictation model (OpenAI-compatible /audio/transcriptions). */
export type SpeechToTextSettings = ImageGenerationSettings

export function getSpeechToTextSettings(): Promise<SpeechToTextSettings> {
  return apiFetch('/api/speech-to-text').then((r) => json<SpeechToTextSettings>(r))
}

export function setSpeechToTextSettings(update: SpeechToTextSettings): Promise<SpeechToTextSettings> {
  return apiFetch('/api/speech-to-text', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<SpeechToTextSettings>(r))
}

/** Dictate one audio blob to text; the server proxies the configured provider. */
export async function transcribeSpeech(blob: Blob, language?: string): Promise<string> {
  const query = language !== undefined && language !== '' ? `?language=${encodeURIComponent(language)}` : ''
  const response = await apiFetch(`/api/speech-to-text/transcribe${query}`, {
    method: 'POST',
    headers: { 'content-type': blob.type !== '' ? blob.type : 'application/octet-stream' },
    body: blob,
  })
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `transcription failed (${response.status})`)
  return ((await response.json()) as { text: string }).text
}

/** Settings → Providers & Models → Videos: the provider/model the GenerateVideo tool calls. */
export type VideoGenerationSettings = ImageGenerationSettings

export function getVideoGenerationSettings(): Promise<VideoGenerationSettings> {
  return apiFetch('/api/video-generation').then((r) => json<VideoGenerationSettings>(r))
}

export function setVideoGenerationSettings(update: VideoGenerationSettings): Promise<VideoGenerationSettings> {
  return apiFetch('/api/video-generation', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<VideoGenerationSettings>(r))
}

/** The URL that streams a generated video (Range-capable, so players can seek). */
export function videoUrl(workspaceId: string, id: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/videos/${encodeURIComponent(id)}`
}

/** The URL that serves a stored attachment's bytes (previews, transcript). */
export function attachmentUrl(workspaceId: string, id: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(id)}`
}

/** How a message reaches a running session: wait for the turn, or stop it and run now. */
export type Delivery = 'queue' | 'steer'

export function sendMessageIn(workspaceId: string, sessionId: string, content: string, clientRequestId?: string, attachments?: readonly AttachmentRef[], delivery: Delivery = 'queue'): Promise<{ inputId: string; queued?: boolean; duplicate?: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      ...(clientRequestId !== undefined ? { clientRequestId } : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(delivery === 'steer' ? { delivery } : {}),
    }),
  }).then((r) => json<{ inputId: string; queued?: boolean; duplicate?: boolean }>(r))
}

/** "Send now": stop the running turn and run every queued input in one new turn. */
export function steerSessionIn(workspaceId: string, sessionId: string): Promise<{ steered: boolean; pending: number }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: 'POST',
  }).then((r) => json<{ steered: boolean; pending: number }>(r))
}

/** Edit a queued input while it still waits (409 once a turn claimed it). An `attachments` array (empty included) replaces the queued files; omitted keeps them. */
export function reviseQueuedInputIn(workspaceId: string, sessionId: string, inputId: string, content: string, attachments?: readonly AttachmentRef[]): Promise<{ inputId: string; revised: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/inputs/${encodeURIComponent(inputId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      ...(attachments !== undefined ? { attachments } : {}),
    }),
  }).then((r) => json<{ inputId: string; revised: boolean }>(r))
}

/** Delete a queued input before it runs (409 once a turn claimed it). */
export function withdrawQueuedInputIn(workspaceId: string, sessionId: string, inputId: string): Promise<{ inputId: string; withdrawn: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/inputs/${encodeURIComponent(inputId)}`, {
    method: 'DELETE',
  }).then((r) => json<{ inputId: string; withdrawn: boolean }>(r))
}

// ── G3: modes + manifest ────────────────────────────────────────────────────

export interface ModeRow {
  readonly id: string
  readonly name: string
  /** One-line summary shown under the name in the picker. */
  readonly description?: string
  readonly source: 'bundled' | 'workspace'
}

export interface ModeSelection {
  readonly modes: readonly ModeRow[]
  readonly selected: string
  readonly revision: number
}

export function listModes(workspaceId: string): Promise<ModeSelection> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mode`).then((r) => json<ModeSelection>(r))
}

/** Live mode control: applies at the next tool gate and next request. */
export function setMode(workspaceId: string, modeId: string): Promise<{ modeId: string; revision: number }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mode`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modeId }),
  }).then((r) => json<{ modeId: string; revision: number }>(r))
}

export interface SessionModeSelection {
  readonly modeId: string
  readonly name: string
  readonly revision: number
  /** `'workspace-default'` follows the workspace selection; `'session'` is this conversation's own. */
  readonly source: 'session' | 'workspace-default'
}

/** Read one conversation's own mode; a conversation without one reports the workspace default. */
export function getSessionMode(workspaceId: string, sessionId: string): Promise<SessionModeSelection> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/mode`).then((r) => json<SessionModeSelection>(r))
}

/** Update one conversation's mode: live for its next tool gate and request, mid-turn included. */
export function setSessionMode(workspaceId: string, sessionId: string, modeId: string): Promise<SessionModeSelection> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/mode`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modeId }),
  }).then((r) => json<SessionModeSelection>(r))
}

// ── Mode authoring (Settings). The selection control above stays separate. ──

/** The catalog with what each mode grants, so a list needs no read per row. */
export function listModeFiles(workspaceId: string): Promise<ModeCatalogRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/modes`).then((r) => json<ModeCatalogRow[]>(r))
}

/** Raw Markdown + hash, so the editor never saves blind. */
export function getModeFile(workspaceId: string, modeId: string): Promise<ModeFileRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/modes/${encodeURIComponent(modeId)}`)
    .then((r) => json<ModeFileRow>(r))
}

export function saveModeFile(workspaceId: string, modeId: string, content: string, expectedHash?: string): Promise<{ readonly id: string; readonly name: string; readonly hash: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/modes/${encodeURIComponent(modeId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, ...(expectedHash !== undefined ? { expectedHash } : {}) }),
  }).then((r) => json<{ readonly id: string; readonly name: string; readonly hash: string }>(r))
}

/** Customizing a bundled mode: the server copies it into the workspace. */
export function duplicateModeFile(workspaceId: string, modeId: string, newId: string): Promise<{ readonly id: string; readonly name: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/modes/${encodeURIComponent(modeId)}/duplicate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newId }),
  }).then((r) => json<{ readonly id: string; readonly name: string }>(r))
}

export function deleteModeFile(workspaceId: string, modeId: string): Promise<{ readonly deleted: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/modes/${encodeURIComponent(modeId)}`, { method: 'DELETE' })
    .then((r) => json<{ readonly deleted: boolean }>(r))
}

/** Show or hide one mode in this workspace's composer picker. */
export function setModeEnabled(workspaceId: string, modeId: string, enabled: boolean): Promise<{ readonly id: string; readonly enabled: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/modes/${encodeURIComponent(modeId)}/enabled`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then((r) => json<{ readonly id: string; readonly enabled: boolean }>(r))
}

export type { ContextBreakdownView, ContextManifestView, ContextUsageView } from './types.ts'

/** `null` means the valid no-request-yet state (HTTP 204), not an error. */
export function fetchManifest(workspaceId: string, sessionId: string): Promise<ContextManifestView | null> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/manifest`).then((r) => {
    if (r.status === 204) return null
    return json<ContextManifestView>(r)
  })
}

/** One raw context block by content hash; `null` = never recorded (legacy log). */
export function fetchContextBody(workspaceId: string, sessionId: string, hash: string): Promise<{ kind: string; name?: string; hash: string; chars: number; body: string } | null> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/context/${encodeURIComponent(hash)}`).then((r) => {
    if (r.status === 404) return null
    return json<{ kind: string; name?: string; hash: string; chars: number; body: string }>(r)
  })
}

export interface CompactResult {
  readonly coversSeq: number
  readonly summaryChars: number
  /** Context tokens before/after; absent when the run was not measured. */
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  /** How the summary was produced: `exact` and `reconstructed` are one request; `recovery` folds the whole transcript. */
  readonly path?: 'exact' | 'reconstructed' | 'recovery' | 'legacy'
}

/** Stop, a delete or a shutdown ended the compaction. Not a failure: nothing was written. */
export class CompactionCancelled extends Error {
  constructor() {
    super('Compaction was cancelled.')
    this.name = 'CompactionCancelled'
  }
}

/**
 * Manual compaction: older turns become an immutable checkpoint. Always an empty POST;
 * the server picks how to summarize and never asks the user to choose.
 */
export async function compactSession(workspaceId: string, sessionId: string): Promise<CompactResult> {
  const response = await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/compact`, { method: 'POST' })
  if (response.status === 409) {
    const text = await response.text()
    let parsed: { cancelled?: unknown } = {}
    try { parsed = JSON.parse(text) as typeof parsed } catch { /* plain-text refusal */ }
    if (parsed.cancelled === true) throw new CompactionCancelled()
    throw new HttpError(409, text)
  }
  return json<CompactResult>(response)
}

// ── G3 skills ───────────────────────────────────────────────────────────────

// ── Claude Code plugins ─────────────────────────────────────────────────────

export type PluginScope = 'workspace' | 'project' | 'local' | 'user'

export interface PluginRowView {
  readonly id: string
  readonly name: string
  readonly marketplace: string
  readonly description?: string
  readonly version?: string
  readonly installed: boolean
  readonly installedScopes: readonly PluginScope[]
  readonly enabled?: { readonly value: boolean; readonly scope: PluginScope }
  readonly active: boolean
  readonly components?: { readonly commands: number; readonly skills: number; readonly agents: number; readonly hooks: boolean; readonly mcpServers: readonly string[] }
  readonly notes?: readonly string[]
  readonly error?: string
}

export interface MarketplaceView {
  readonly name: string
  readonly source: { readonly source: string; readonly repo?: string; readonly url?: string; readonly path?: string }
  readonly lastUpdated: string
  readonly document?: { readonly name: string; readonly description?: string; readonly owner?: string; readonly plugins: readonly { readonly name: string; readonly description?: string; readonly version?: string; readonly category?: string; readonly author?: string; readonly homepage?: string }[] }
  readonly error?: string
}

const pluginQuery = (projectId?: string): string => (projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : '')

export function listPlugins(workspaceId: string, projectId?: string): Promise<{ readonly plugins: readonly PluginRowView[]; readonly suggestedMarketplaces: Readonly<Record<string, unknown>> }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/plugins${pluginQuery(projectId)}`).then((r) => json<{ plugins: PluginRowView[]; suggestedMarketplaces: Record<string, unknown> }>(r))
}

export function pluginAction(workspaceId: string, pluginId: string, action: 'install' | 'enable' | 'disable' | 'uninstall' | 'update', scope: PluginScope, projectId?: string): Promise<{ readonly plugins: readonly PluginRowView[]; readonly notes?: readonly string[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/${action}${pluginQuery(projectId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope }),
  }).then((r) => json<{ plugins: PluginRowView[]; notes?: string[] }>(r))
}

export interface PluginItemView { readonly name: string; readonly description?: string }

/** What a plugin contains (GET …/plugins/:id); not-installed plugins are staged on the server to read it. */
export interface PluginDetailsView {
  readonly id: string
  readonly name: string
  readonly marketplace: string
  readonly description?: string
  readonly version?: string
  readonly author?: string
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly category?: string
  readonly keywords?: readonly string[]
  readonly source: { readonly kind: string; readonly location: string }
  readonly commands: readonly PluginItemView[]
  readonly skills: readonly PluginItemView[]
  readonly agents: readonly PluginItemView[]
  readonly hooks: readonly string[]
  readonly mcpServers: readonly { readonly name: string; readonly type: string }[]
  readonly notes: readonly string[]
}

export function pluginDetails(workspaceId: string, pluginId: string, projectId?: string): Promise<PluginDetailsView> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}${pluginQuery(projectId)}`).then((r) => json<PluginDetailsView>(r))
}

export function listMarketplaces(): Promise<{ readonly marketplaces: readonly MarketplaceView[] }> {
  return apiFetch('/api/plugins/marketplaces').then((r) => json<{ marketplaces: MarketplaceView[] }>(r))
}

export function addMarketplace(source: string): Promise<{ readonly name: string; readonly plugins: number }> {
  return apiFetch('/api/plugins/marketplaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) })
    .then((r) => json<{ name: string; plugins: number }>(r))
}

export function updateMarketplace(name: string): Promise<{ readonly name: string; readonly plugins: number }> {
  return apiFetch(`/api/plugins/marketplaces/${encodeURIComponent(name)}/update`, { method: 'POST' }).then((r) => json<{ name: string; plugins: number }>(r))
}

export function removeMarketplace(name: string): Promise<{ readonly removed: boolean }> {
  return apiFetch(`/api/plugins/marketplaces/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => json<{ removed: boolean }>(r))
}

/** Claude Code custom slash commands across the user/plugin/workspace/project layers. */
export function listCommands(workspaceId: string, projectId?: string): Promise<{ readonly commands: readonly CommandRow[]; readonly errors: readonly { path: string; message: string }[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/commands${projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)
    .then((r) => json<{ commands: CommandRow[]; errors: { path: string; message: string }[] }>(r))
}

export function listSkills(workspaceId: string, projectId?: string): Promise<SkillRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills${projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) => json<SkillRow[]>(r))
}

/** One skill's raw SKILL.md + hash (the settings editor's load). */
export function getSkill(workspaceId: string, name: string, projectId?: string): Promise<SkillRow & { readonly instructions: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}${projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) =>
    json<SkillRow & { readonly instructions: string }>(r),
  )
}

/** The workspace's skill source rules (defaults materialized). */
export function getSkillSources(workspaceId: string): Promise<{ readonly rules: readonly SkillRuleRow[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/sources`).then((r) => json<{ readonly rules: readonly SkillRuleRow[] }>(r))
}

/** Files inside one skill's owning layer folder (recursive, SKILL.md first). */
export function getSkillFiles(workspaceId: string, name: string, projectId?: string): Promise<{ readonly files: readonly SkillFileRow[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}/files${projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) =>
    json<{ readonly files: readonly SkillFileRow[] }>(r),
  )
}

/** One file's utf8 content from the skill's folder (containment-checked). */
export function getSkillFile(workspaceId: string, name: string, filePath: string, projectId?: string): Promise<SkillFileRow & { readonly content: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(filePath)}${projectId !== undefined ? `&projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) =>
    json<SkillFileRow & { readonly content: string }>(r),
  )
}

/** The workspace's folder-layer policy for skills, agents, hooks and commands. */
export function getWorkspaceSources(workspaceId: string): Promise<WorkspaceSourcesRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources`).then((r) => json<WorkspaceSourcesRow>(r))
}

/** Replace the whole document; a stale `expectedHash` is refused with 409. */
export function putWorkspaceSources(workspaceId: string, doc: ResourceSourcesDoc, expectedHash: string): Promise<WorkspaceSourcesRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc, expectedHash }),
  }).then((r) => json<WorkspaceSourcesRow>(r))
}

/** Replace the skill source rules (validated server-side, last-write-wins). */
export function putSkillSources(workspaceId: string, rules: readonly SkillRuleRow[]): Promise<{ readonly rules: readonly SkillRuleRow[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/sources`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules }),
  }).then((r) => json<{ readonly rules: readonly SkillRuleRow[] }>(r))
}

/** Save raw SKILL.md content; pass the row's hash to reject drifted writes.
 *  `warnings` explains when the saved copy is disabled or shadowed elsewhere. */
export function saveSkill(workspaceId: string, name: string, content: string, expectedHash?: string): Promise<{ readonly name: string; readonly hash: string; readonly warnings?: readonly string[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, ...(expectedHash !== undefined ? { expectedHash } : {}) }),
  }).then((r) => json<{ readonly name: string; readonly hash: string; readonly warnings?: readonly string[] }>(r))
}

export function deleteSkill(workspaceId: string, name: string): Promise<{ readonly deleted: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: boolean }>(r),
  )
}

/** Hide or unhide a skill from this workspace's discovery surfaces. */
export function setSkillHidden(workspaceId: string, name: string, hidden: boolean): Promise<{ readonly name: string; readonly hidden: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}/hidden`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hidden }),
  }).then((r) => json<{ readonly name: string; readonly hidden: boolean }>(r))
}

// ── G3 memory ───────────────────────────────────────────────────────────────

/** `?projectId=` selects the project tier; null/undefined is the workspace tier. */
function memoryScopeQuery(projectId: string | null | undefined, lead: '?' | '&'): string {
  return projectId === null || projectId === undefined || projectId === '' ? '' : `${lead}projectId=${encodeURIComponent(projectId)}`
}

export function searchMemory(workspaceId: string, query: string, projectId?: string | null): Promise<MemoryEntryRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory?q=${encodeURIComponent(query)}${memoryScopeQuery(projectId, '&')}`).then((r) => json<MemoryEntryRow[]>(r))
}

export function readMemory(workspaceId: string, id: string, projectId?: string | null): Promise<MemoryEntryRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(id)}${memoryScopeQuery(projectId, '?')}`).then((r) => json<MemoryEntryRow>(r))
}

export function createMemory(workspaceId: string, input: { readonly id: string; readonly title: string; readonly body: string; readonly pinned?: boolean }, projectId?: string | null): Promise<MemoryEntryRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory${memoryScopeQuery(projectId, '?')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, ...(input.pinned === true ? { pinned: true } : {}) }),
  }).then((r) => json<MemoryEntryRow>(r))
}

export function updateMemory(
  workspaceId: string,
  id: string,
  input: { readonly expectedHash: string; readonly title?: string; readonly body?: string; readonly pinned?: boolean },
  projectId?: string | null,
): Promise<MemoryEntryRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(id)}${memoryScopeQuery(projectId, '?')}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedHash: input.expectedHash,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    }),
  }).then((r) => json<MemoryEntryRow>(r))
}

export function deleteMemory(workspaceId: string, id: string, projectId?: string | null): Promise<{ readonly forgotten: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(id)}${memoryScopeQuery(projectId, '?')}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly forgotten: boolean }>(r),
  )
}

// ── G4: agents & delegation ─────────────────────────────────────────────────

export function fetchAgentDefinition(workspaceId: string, name: string): Promise<AgentDefinitionRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(name)}`).then((r) => json<AgentDefinitionRow>(r))
}

/**
 * A child's brief: prose `prompt` (primary) or the structured four-field
 * form. The host requires one of `prompt`/`objective` to be non-empty.
 */
export interface SpawnTaskInput {
  readonly prompt?: string
  readonly objective?: string
  readonly constraints?: readonly string[]
  readonly references?: readonly string[]
  readonly requiredResult?: string
}

export function spawnChild(
  workspaceId: string,
  name: string,
  rootSessionId: string,
  task: SpawnTaskInput,
  grantTools?: readonly string[],
  /** Plain model alias, `provider:model`, or bare model; omitted inherits the conversation's pair. */
  model?: string,
  /** `'brief'` hands the child a bounded slice of the conversation; default off. */
  inherit?: 'none' | 'brief',
): Promise<ChildRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rootSessionId,
      task,
      ...(grantTools !== undefined && grantTools.length > 0 ? { grantTools } : {}),
      ...(model !== undefined && model !== '' ? { model } : {}),
      ...(inherit === 'brief' ? { inherit } : {}),
    }),
  }).then((r) => json<ChildRow>(r))
}

export function listChildren(workspaceId: string, rootSessionId: string): Promise<ChildRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/children?root=${encodeURIComponent(rootSessionId)}`).then((r) =>
    json<ChildRow[]>(r),
  )
}

export function waitChild(workspaceId: string, rootSessionId: string, childSessionId: string, waitMs = 5_000): Promise<ChildRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(rootSessionId)}/children/${encodeURIComponent(childSessionId)}?waitMs=${waitMs}`).then((r) =>
    json<ChildRow>(r),
  )
}

export function cancelChild(workspaceId: string, rootSessionId: string, childSessionId: string): Promise<ChildRow> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(rootSessionId)}/children/${encodeURIComponent(childSessionId)}/cancel`, { method: 'POST' }).then((r) =>
    json<ChildRow>(r),
  )
}

/** Re-read one retained child lifecycle against canonical parent storage. */
export function reconcileChild(workspaceId: string, rootSessionId: string, childSessionId: string): Promise<ChildRow | null> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(rootSessionId)}/children/${encodeURIComponent(childSessionId)}/reconcile`, { method: 'POST' })
    .then((r) => json<ChildRow | { readonly reconciled: true; readonly child: null }>(r))
    .then((body) => 'childSessionId' in body ? body : null)
}

export interface ImportAgentInput {
  /** A Claude Code subagent file (YAML frontmatter + body), saved verbatim. */
  readonly content: string
  /** `codex` converts a pinned Codex spec; `dnt-harness` is an alias of `claude`. */
  readonly dialect: 'claude' | 'codex' | 'dnt-harness'
  readonly sourceVersion?: string
  /** Hash the raw editor read; a file changed since then is rejected (409). */
  readonly expectedHash?: string
}

export interface ImportResult {
  /** The saved role (agent saves). */
  readonly definition?: AgentDefinitionRow
  readonly imported: readonly string[]
  readonly blocked?: readonly string[]
  readonly warnings?: readonly string[]
  readonly active?: boolean
  readonly spawned?: boolean
  readonly reconnected?: readonly string[]
}

export function importAgentDefinition(workspaceId: string, name: string, input: ImportAgentInput): Promise<ImportResult> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(name)}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ImportResult>(r))
}

/** Copy a ~/.claude or bundled role into this workspace, same name, file verbatim. */
export function cloneAgentToWorkspace(workspaceId: string, name: string): Promise<{ readonly definition: AgentDefinitionRow }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(name)}/clone`, { method: 'POST' })
    .then((r) => json<{ readonly definition: AgentDefinitionRow }>(r))
}

/** The exact text of a workspace role file, with the hash a save must match. */
export function readAgentFile(workspaceId: string, file: string): Promise<{ readonly content: string; readonly hash: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(file)}/file`)
    .then((r) => json<{ readonly content: string; readonly hash: string }>(r))
}

// ── G5: MCP, hooks, secrets ─────────────────────────────────────────────────

export function listMcpServers(workspaceId: string): Promise<McpServerRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp`).then((r) => json<McpServerRow[]>(r))
}

export function upsertMcpServer(workspaceId: string, name: string, config: Record<string, unknown>): Promise<{ readonly saved: string; readonly enabled: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...config, name }),
  }).then((r) => json<{ readonly saved: string; readonly enabled: boolean }>(r))
}

/** Stored config of one server, including fields the settings form does not show. */
export function getMcpServer(workspaceId: string, name: string): Promise<Record<string, unknown>> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}`).then((r) => json<Record<string, unknown>>(r))
}

export function deleteMcpServer(workspaceId: string, name: string): Promise<{ readonly deleted: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: string }>(r),
  )
}

export function setMcpServerAction(workspaceId: string, name: string, action: 'enable' | 'disable' | 'reconnect' | 'test'): Promise<{ readonly status?: string; readonly tested?: boolean; readonly tools?: readonly string[]; readonly enabled?: boolean; readonly published?: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/${action}`, { method: 'POST' }).then((r) =>
    json<{ readonly status: string }>(r),
  )
}

/** Why Connect could not start; `client_required` means the user must enter an OAuth app. */
export type McpOAuthErrorCode = 'discovery_failed' | 'client_required' | 'registration_failed'

export class McpOAuthError extends Error {
  constructor(readonly code: McpOAuthErrorCode | undefined, message: string) {
    super(message)
    this.name = 'McpOAuthError'
  }
}

async function oauthCall<T>(workspaceId: string, name: string, action: 'begin' | 'complete' | 'revoke', body: unknown): Promise<T> {
  const response = await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/oauth/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text()
    let parsed: { code?: McpOAuthErrorCode; error?: string } = {}
    try { parsed = JSON.parse(text) as typeof parsed } catch { /* plain-text error */ }
    throw new McpOAuthError(parsed.code, parsed.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

/** Discover, register if needed, and get the provider's sign-in URL. `scopes` adds scopes on Reconnect. */
export function beginMcpOAuth(workspaceId: string, name: string, scopes: readonly string[] = []): Promise<{ readonly authorizationUrl: string; readonly state: string; readonly redirectMode: McpOAuthRedirectMode }> {
  return oauthCall(workspaceId, name, 'begin', scopes.length > 0 ? { scopes } : {})
}

/**
 * How the provider returns the browser:
 * `loopback` / `origin`: to this app, and the sign-in finishes on its own;
 * `paste`: to an address on the person's machine that this tab cannot reach,
 * so they paste that address back.
 */
export type McpOAuthRedirectMode = 'loopback' | 'origin' | 'paste'

/** Finish with the pending `state`, or with the address the browser ended on after sign-in. */
export function completeMcpOAuth(workspaceId: string, name: string, proof: string | { readonly callbackUrl: string }): Promise<{ readonly connected: true; readonly status?: string }> {
  return oauthCall(workspaceId, name, 'complete', typeof proof === 'string' ? { state: proof } : { callbackUrl: proof.callbackUrl })
}

export function revokeMcpOAuth(workspaceId: string, name: string): Promise<{ readonly local: 'revoked'; readonly remote: 'succeeded' | 'failed' | 'unavailable' }> {
  return oauthCall(workspaceId, name, 'revoke', {})
}

export function importMcpServers(workspaceId: string, input: ImportAgentInput): Promise<ImportResult> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ImportResult>(r))
}

/** Switch one configured hook (any layer) on or off for this workspace. */
export function setHookActive(workspaceId: string, hookId: string, active: boolean): Promise<{ readonly id: string; readonly active: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/hooks/${encodeURIComponent(hookId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ active }),
  }).then((r) => json<{ readonly id: string; readonly active: boolean }>(r))
}

/** The workspace layer (`<ws>/settings.json`) plus every Claude Code layer that applies. */
export function fetchHooks(workspaceId: string, projectId?: string | null): Promise<HooksConfigRow> {
  const query = projectId !== undefined && projectId !== null ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/hooks${query}`).then((r) => json<HooksConfigRow>(r))
}

/** Replace the workspace layer's `hooks` section (Claude Code format); other settings keys are kept. */
export function saveHooks(workspaceId: string, hooks: HooksSectionRow, disableAllHooks?: boolean): Promise<{ readonly saved: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/hooks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hooks, ...(disableAllHooks !== undefined ? { disableAllHooks } : {}) }),
  }).then((r) => json<{ readonly saved: boolean }>(r))
}

/** Masked key names only — values never leave the server. */
export function listSecrets(workspaceId: string): Promise<SecretRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/secrets`).then((r) => json<SecretRow[]>(r))
}

export function setSecret(workspaceId: string, key: string, value: string): Promise<{ readonly rotated: string; readonly reconnected?: readonly string[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/secrets/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  }).then((r) => json<{ readonly rotated: string; readonly reconnected?: readonly string[] }>(r))
}

export function deleteSecret(workspaceId: string, key: string): Promise<{ readonly deleted: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: string }>(r),
  )
}

/** Workspace management only. Removing registration never deletes the folder. */
export function renameProject(workspaceId: string, projectId: string, name: string): Promise<ProjectRow> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/projects/' + encodeURIComponent(projectId), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }).then(r => json<ProjectRow>(r))
}
/** Retarget a project's folder; refused while its sessions are running (409). */
export function setProjectPath(workspaceId: string, projectId: string, path: string): Promise<ProjectRow> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/projects/' + encodeURIComponent(projectId), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
  }).then(r => json<ProjectRow>(r))
}
/** Replace the extra folders a project grants its conversations (validated server-side). */
export function setProjectFolders(workspaceId: string, projectId: string, additionalDirectories: readonly AdditionalDirectory[]): Promise<ProjectRow> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/projects/' + encodeURIComponent(projectId), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ additionalDirectories }),
  }).then(r => json<ProjectRow>(r))
}
function sessionGrantsUrl(workspaceId: string, sessionId: string): string {
  return '/api/workspaces/' + encodeURIComponent(workspaceId) + '/sessions/' + encodeURIComponent(sessionId) + '/grants'
}
/** A conversation's own folder grants plus the effective (project + session) view. */
export function getSessionGrants(workspaceId: string, sessionId: string): Promise<SessionGrantsView> {
  return apiFetch(sessionGrantsUrl(workspaceId, sessionId)).then(r => json<SessionGrantsView>(r))
}
/** Replace a conversation's folder grants; 409 when `expectedRevision` is stale. */
export function setSessionGrants(workspaceId: string, sessionId: string, expectedRevision: number, roots: readonly FolderGrant[]): Promise<SessionGrantsView> {
  return apiFetch(sessionGrantsUrl(workspaceId, sessionId), {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision, roots }),
  }).then(r => json<SessionGrantsView>(r))
}
export function removeProject(workspaceId: string, projectId: string): Promise<{ deleted: boolean }> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/projects/' + encodeURIComponent(projectId), { method: 'DELETE' }).then(r => json<{ deleted: boolean }>(r))
}

/** Every effective subagent (bundled, ~/.claude/agents, workspace, and the project's .claude/agents when given). */
export function listAgentDefinitions(workspaceId: string, projectId?: string | null): Promise<AgentDefinitionRow[]> {
  const query = projectId !== undefined && projectId !== null ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/agents' + query).then(r => json<AgentDefinitionRow[]>(r))
}
export function deleteAgentDefinition(workspaceId: string, name: string): Promise<{ deleted: boolean }> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/agents/' + encodeURIComponent(name), { method: 'DELETE' }).then(r => json<{ deleted: boolean }>(r))
}

// ── Workbench terminals ─────────────────────────────────────────────────────
// A user-driven shell, not an agent tool: these routes carry no approval and
// write nothing to the session log. Payloads are base64 because PTY traffic is
// a byte stream.

export function listTerminals(workspaceId: string): Promise<TerminalListing> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals').then(r => json<TerminalListing>(r))
}

export function createTerminal(workspaceId: string, input: { shellId?: string; projectId?: string; cols: number; rows: number }): Promise<TerminalRow> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(r => json<TerminalRow>(r))
}

export function killTerminal(workspaceId: string, terminalId: string): Promise<{ killed: boolean }> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/' + encodeURIComponent(terminalId), { method: 'DELETE' }).then(r => json<{ killed: boolean }>(r))
}

export function writeTerminal(workspaceId: string, terminalId: string, data: string): Promise<unknown> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/' + encodeURIComponent(terminalId) + '/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: toBase64(data) }),
  }).then(r => json<unknown>(r))
}

export function resizeTerminal(workspaceId: string, terminalId: string, cols: number, rows: number): Promise<TerminalRow> {
  return apiFetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/' + encodeURIComponent(terminalId) + '/resize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  }).then(r => json<TerminalRow>(r))
}

/**
 * One stream per workspace carries every terminal in it (see the server note on
 * connection limits). Every (re)connect opens with a full snapshot, which the
 * panel treats as the truth, so a swapped source needs no cursor.
 */
export function subscribeTerminals(
  workspaceId: string,
  onFrame: (frame: TerminalFrame) => void,
  onState?: (state: StreamState) => void,
): () => void {
  const url = '/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/events'
  return resilientSource(() => url, (message) => onFrame(JSON.parse(message.data) as TerminalFrame), onState)
}

// ── Dangerous command guard ───────────────────────────────────────────────

export type GuardAction = 'deny' | 'ask' | 'off'
export type CustomRuleAction = 'deny' | 'ask' | 'allow'
export interface CustomRule {
  readonly id: string
  readonly pattern: string
  readonly isRegex: boolean
  readonly action: CustomRuleAction
  readonly description?: string
}
export interface DangerousCommandsConfig {
  readonly v: 1
  readonly presets: Record<string, GuardAction>
  readonly customRules: readonly CustomRule[]
  /** Per-preset allowed path prefixes (e.g. `tmp`, `.worktrees`). */
  readonly exceptions?: Partial<Record<string, readonly string[]>>
}
export interface GuardConfigResponse {
  readonly config: DangerousCommandsConfig
  readonly hash: string
  readonly warning?: string
}

export function getGuardConfig(workspaceId: string): Promise<GuardConfigResponse> {
  return apiFetch(`/api/guard/dangerous-commands?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => json<GuardConfigResponse>(r))
}

export function putGuardConfig(workspaceId: string, config: DangerousCommandsConfig, expectedHash?: string): Promise<GuardConfigResponse> {
  return apiFetch('/api/guard/dangerous-commands', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, config, ...(expectedHash !== undefined ? { expectedHash } : {}) }),
  }).then((r) => json<GuardConfigResponse>(r))
}

export function getGlobalGuardConfig(): Promise<GuardConfigResponse> {
  return apiFetch('/api/guard/dangerous-commands/global').then((r) => json<GuardConfigResponse>(r))
}

export function putGlobalGuardConfig(config: DangerousCommandsConfig, expectedHash?: string): Promise<GuardConfigResponse> {
  return apiFetch('/api/guard/dangerous-commands/global', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config, ...(expectedHash !== undefined ? { expectedHash } : {}) }),
  }).then((r) => json<GuardConfigResponse>(r))
}

// ── System prompt overrides (Settings → System Prompts) ──────────────────

export interface PromptOverrideView {
  /** The effective text: the override when set, the harness default otherwise. */
  readonly text: string
  readonly overridden: boolean
}
export interface SystemPromptsResponse {
  readonly base: PromptOverrideView
  readonly child: PromptOverrideView
  readonly defaults: { readonly base: string; readonly child: string }
  readonly hash: string
  readonly warning?: string
}

export function getSystemPrompts(workspaceId: string): Promise<SystemPromptsResponse> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/system-prompts`).then((r) => json<SystemPromptsResponse>(r))
}

/** Blank string clears the override (back to the default). */
export function putSystemPrompts(
  workspaceId: string,
  prompts: { readonly base: string; readonly child: string },
  expectedHash?: string,
): Promise<SystemPromptsResponse> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/system-prompts`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...prompts, ...(expectedHash !== undefined ? { expectedHash } : {}) }),
  }).then((r) => json<SystemPromptsResponse>(r))
}

/** UTF-8 safe base64 in both directions; btoa/atob alone mangle non-Latin-1 output. */
export function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(value: string): string {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}
