import type { AttachmentRef } from './composer-draft.ts'
import type { AgentDefinitionRow, ChildRow, Envelope, HooksConfigRow, McpServerRow, MemoryEntryRow, Meta, ModelDefaults, ProjectRow, ProviderInput, ProviderSummary, SecretRow, SessionListing, SessionModel, SkillRow, TerminalFrame, TerminalListing, TerminalRow, WorkspaceMeta, WorkspaceRow } from './types.ts'

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as T
}

export function listSessions(): Promise<SessionListing[]> {
  return fetch('/api/sessions').then((r) => json<SessionListing[]>(r))
}

export function createSession(folder?: string): Promise<{ id: string; folder?: string }> {
  return fetch('/api/sessions', {
    method: 'POST',
    ...(folder !== undefined ? {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder }),
    } : {}),
  }).then((r) => json<{ id: string; folder?: string }>(r))
}

export function deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).then((r) =>
    json<{ deleted: boolean }>(r),
  )
}

export function renameSession(sessionId: string, title: string): Promise<{ id: string; title: string }> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((r) => json<{ id: string; title: string }>(r))
}

/** Set this session's workspace; an empty path resets it to server default. */
export function setSessionFolder(sessionId: string, path: string): Promise<{ folder: string | null }> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/folder`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then((r) => json<{ folder: string | null }>(r))
}

export function stopSession(sessionId: string): Promise<{ stopped: boolean }> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' }).then((r) =>
    json<{ stopped: boolean }>(r),
  )
}

/** Send one message. Pass a stable `clientRequestId` so transport retries deduplicate server-side. */
export function sendMessage(sessionId: string, content: string, clientRequestId?: string): Promise<{ inputId: string; queued: boolean; duplicate?: boolean }> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, ...(clientRequestId !== undefined ? { clientRequestId } : {}) }),
  }).then((r) => json<{ inputId: string; queued: boolean; duplicate?: boolean }>(r))
}

export function answerApproval(approvalId: string, allow: boolean): Promise<void> {
  return fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allow }),
  }).then((r) => json<{ answered: boolean }>(r)).then(() => undefined)
}

/** Server-side metadata: active pair, default folder, safe provider list. */
export function fetchMeta(): Promise<Meta> {
  return fetch('/api/meta').then((r) => json<Meta>(r))
}

/** Select an exact provider/model pair. Omit provider only for legacy callers. */
export function setModel(model: string, provider?: string): Promise<Meta> {
  return fetch('/api/model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...(provider !== undefined ? { provider } : {}) }),
  }).then((r) => json<{ model: string }>(r)).then(() => fetchMeta())
}

/** Switch the default workspace inherited by sessions without their own path. */
export function setFolder(path: string): Promise<Meta> {
  return fetch('/api/folder', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then((r) => json<{ folder: string }>(r)).then(() => fetchMeta())
}

export function listProviders(): Promise<ProviderSummary[]> {
  return fetch('/api/providers').then((r) => json<ProviderSummary[]>(r))
}

export function createProvider(input: Required<Pick<ProviderInput, 'name' | 'baseUrl' | 'apiKey'>> & ProviderInput): Promise<ProviderSummary> {
  return fetch('/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ProviderSummary>(r))
}

export function updateProvider(id: string, input: ProviderInput): Promise<ProviderSummary> {
  return fetch(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ProviderSummary>(r))
}

export function deleteProvider(id: string): Promise<{ deleted: boolean }> {
  return fetch(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<{ deleted: boolean }>(r))
}

export function syncProvider(id: string): Promise<{ ok: boolean; models: string[] }> {
  return fetch(`/api/providers/${encodeURIComponent(id)}/sync`, { method: 'POST' }).then((r) =>
    json<{ ok: boolean; models: string[] }>(r),
  )
}

export function testProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  return fetch(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }).then((r) => json<{ ok: boolean; error?: string }>(r))
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
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
  return wire(source, onEnvelope, onState)
}

/** Workspace-scoped subscription (G2): the session's owning workspace is part of the address. */
export function subscribeEventsIn(
  workspaceId: string,
  sessionId: string,
  onEnvelope: (envelope: Envelope) => void,
  onState?: (state: StreamState) => void,
): () => void {
  const source = new EventSource(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/events`)
  return wire(source, onEnvelope, onState)
}

function wire(
  source: EventSource,
  onEnvelope: (envelope: Envelope) => void,
  onState?: (state: StreamState) => void,
): () => void {
  source.onopen = () => onState?.('open')
  source.onerror = () => {
    onState?.(source.readyState === EventSource.CONNECTING ? 'reconnecting' : 'connecting')
  }
  source.onmessage = (message: MessageEvent<string>) => {
    onEnvelope(JSON.parse(message.data) as Envelope)
  }
  return () => {
    source.close()
  }
}


// ── G2: workspaces & projects ───────────────────────────────────────────────

export function listWorkspaces(): Promise<WorkspaceRow[]> {
  return fetch('/api/workspaces').then((r) => json<WorkspaceRow[]>(r))
}

export function createWorkspace(name: string): Promise<WorkspaceRow> {
  return fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<WorkspaceRow>(r))
}

/** Rename a workspace (PATCH name). */
export function renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<WorkspaceRow>(r))
}

/** Archive (true) or restore (false); refused while sessions run (409). */
export function setWorkspaceArchived(workspaceId: string, archived: boolean): Promise<WorkspaceRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  }).then((r) => json<WorkspaceRow>(r))
}

/** Delete an empty workspace; non-empty workspaces answer 409. */
export function deleteWorkspace(workspaceId: string): Promise<{ readonly deleted: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: boolean }>(r),
  )
}

export function listProjects(workspaceId: string): Promise<ProjectRow[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`).then((r) => json<ProjectRow[]>(r))
}

export function createProject(workspaceId: string, name: string, path: string): Promise<ProjectRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, path }),
  }).then((r) => json<ProjectRow>(r))
}

/** Persist a sidebar folder order; answers the reordered rows. */
export function reorderProjects(workspaceId: string, order: readonly string[]): Promise<ProjectRow[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/order`, {
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
  return fetch(`/api/fs/dirs${query}`).then((r) => json<FolderListing>(r))
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
}

const projectBase = (workspaceId: string, projectId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`

export function listProjectFiles(workspaceId: string, projectId: string, path: string): Promise<ProjectListing> {
  return fetch(`${projectBase(workspaceId, projectId)}/files?path=${encodeURIComponent(path)}`).then((r) => json<ProjectListing>(r))
}

export function readProjectFile(workspaceId: string, projectId: string, path: string): Promise<ProjectFileView> {
  return fetch(`${projectBase(workspaceId, projectId)}/file?path=${encodeURIComponent(path)}`).then((r) => json<ProjectFileView>(r))
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

/** Bounded file-name search under a project root (composer mentions). */
export function searchProjectFiles(workspaceId: string, projectId: string, query: string, limit?: number): Promise<ProjectSearchResult> {
  const cap = limit !== undefined ? `&limit=${limit}` : ''
  return fetch(`${projectBase(workspaceId, projectId)}/search?q=${encodeURIComponent(query)}${cap}`).then((r) => json<ProjectSearchResult>(r))
}

/** Per-workspace controls + project list. */
export function fetchWorkspaceMeta(workspaceId: string): Promise<WorkspaceMeta> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/meta`).then((r) => json<WorkspaceMeta>(r))
}

/** Read one conversation's controls; legacy `source: 'global'` follows live global defaults. */
export function getSessionModel(workspaceId: string, sessionId: string): Promise<SessionModel> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/model`).then((r) => json<SessionModel>(r))
}

/** Update a conversation's model controls; null deliberately clears a control. */
export function setSessionModel(
  workspaceId: string,
  sessionId: string,
  update: Partial<Pick<SessionModel, 'provider' | 'model' | 'thinkingLevel'>>,
): Promise<SessionModel> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<SessionModel>(r))
}

/** Read the global defaults used by drafts and new conversations. */
export function getModelDefaults(): Promise<ModelDefaults> {
  return fetch('/api/model-defaults').then((r) => json<ModelDefaults>(r))
}

/** Update global defaults. A complete provider/model pair or both null is required by the server. */
export function setModelDefaults(update: ModelDefaults): Promise<ModelDefaults> {
  return fetch('/api/model-defaults', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  }).then((r) => json<ModelDefaults>(r))
}

/** @deprecated Global defaults are no longer workspace-scoped. Use `setModelDefaults`. */
export function setWorkspaceModel(workspaceId: string, model: string, provider?: string): Promise<unknown> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...(provider !== undefined ? { provider } : {}) }),
  }).then((r) => json<unknown>(r))
}

/** @deprecated Global defaults are no longer workspace-scoped. Use `setModelDefaults`. */
export function setWorkspaceThinking(workspaceId: string, level: string | null): Promise<{ thinkingLevel: string | null }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/thinking`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level }),
  }).then((r) => json<{ thinkingLevel: string | null }>(r))
}

export function listSessionsIn(workspaceId: string): Promise<SessionListing[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`).then((r) => json<SessionListing[]>(r))
}

export function createSessionIn(workspaceId: string, projectId?: string): Promise<{ id: string; projectId?: string }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(projectId !== undefined && projectId !== '' ? { projectId } : {}),
  }).then((r) => json<{ id: string; projectId?: string }>(r))
}

export function deleteSessionIn(workspaceId: string, sessionId: string): Promise<{ deleted: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  }).then((r) => json<{ deleted: boolean }>(r))
}

export function renameSessionIn(workspaceId: string, sessionId: string, title: string): Promise<{ id: string; title: string }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((r) => json<{ id: string; title: string }>(r))
}

export function stopSessionIn(workspaceId: string, sessionId: string): Promise<{ stopped: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  }).then((r) => json<{ stopped: boolean }>(r))
}

/** Store one composer attachment; the reply is what a message carries. */
export function uploadAttachment(workspaceId: string, file: File): Promise<AttachmentRef> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': file.type !== '' ? file.type : 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  }).then((r) => json<AttachmentRef>(r))
}

/** The URL that serves a stored attachment's bytes (previews, transcript). */
export function attachmentUrl(workspaceId: string, id: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(id)}`
}

export function sendMessageIn(workspaceId: string, sessionId: string, content: string, clientRequestId?: string, attachments?: readonly AttachmentRef[]): Promise<{ inputId: string; queued: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      ...(clientRequestId !== undefined ? { clientRequestId } : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    }),
  }).then((r) => json<{ inputId: string; queued: boolean }>(r))
}

// ── G3: modes + manifest ────────────────────────────────────────────────────

/** Live permission control: the map replaces the workspace policy wholesale. */
export function setPolicy(workspaceId: string, policy: Record<string, string>): Promise<{ readonly policy: Record<string, string> }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(policy),
  }).then((r) => json<{ readonly policy: Record<string, string> }>(r))
}

export interface ModeRow {
  readonly id: string
  readonly name: string
  readonly source: 'bundled' | 'workspace'
}

export interface ModeSelection {
  readonly modes: readonly ModeRow[]
  readonly selected: string
  readonly revision: number
}

export function listModes(workspaceId: string): Promise<ModeSelection> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mode`).then((r) => json<ModeSelection>(r))
}

/** Live mode control: applies at the next tool gate and next request. */
export function setMode(workspaceId: string, modeId: string): Promise<{ modeId: string; revision: number }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mode`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modeId }),
  }).then((r) => json<{ modeId: string; revision: number }>(r))
}

export interface ContextManifestView {
  readonly modeId: string
  readonly modeRevision: number
  readonly model?: string
  readonly provider?: string
  readonly budget: { readonly availableTokens: number; readonly usedTokens: number; readonly estimated: boolean }
  readonly history: {
    readonly setting: string
    readonly includedTurns: number
    readonly omittedTurns: number
    readonly includedSeqRange?: readonly [number, number]
    readonly omittedSeqRange?: readonly [number, number]
    readonly checkpointHash?: string
  }
  readonly sources: {
    readonly instructionsHash?: string
    readonly skills: readonly string[]
    readonly memory: readonly string[]
    readonly toolNames: readonly string[]
    readonly toolSchemas: number
  }
  readonly omissions: readonly string[]
}

/** `null` means the valid no-request-yet state (HTTP 204), not an error. */
export function fetchManifest(workspaceId: string, sessionId: string): Promise<ContextManifestView | null> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/manifest`).then((r) => {
    if (r.status === 204) return null
    return json<ContextManifestView>(r)
  })
}

/** Manual compaction: older turns become an immutable checkpoint. */
export function compactSession(workspaceId: string, sessionId: string): Promise<{ readonly coversSeq: number; readonly summaryChars: number }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/compact`, { method: 'POST' }).then((r) =>
    json<{ readonly coversSeq: number; readonly summaryChars: number }>(r),
  )
}

// ── G3 skills ───────────────────────────────────────────────────────────────

export function listSkills(workspaceId: string): Promise<SkillRow[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`).then((r) => json<SkillRow[]>(r))
}

/** One skill's raw SKILL.md + hash (the settings editor's load). */
export function getSkill(workspaceId: string, name: string): Promise<SkillRow & { readonly instructions: string }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}`).then((r) =>
    json<SkillRow & { readonly instructions: string }>(r),
  )
}

/** Save raw SKILL.md content; pass the row's hash to reject drifted writes. */
export function saveSkill(workspaceId: string, name: string, content: string, expectedHash?: string): Promise<{ readonly name: string; readonly hash: string }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, ...(expectedHash !== undefined ? { expectedHash } : {}) }),
  }).then((r) => json<{ readonly name: string; readonly hash: string }>(r))
}

export function deleteSkill(workspaceId: string, name: string): Promise<{ readonly deleted: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: boolean }>(r),
  )
}

// ── G3 memory ───────────────────────────────────────────────────────────────

export function searchMemory(workspaceId: string, query: string): Promise<MemoryEntryRow[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory?q=${encodeURIComponent(query)}`).then((r) => json<MemoryEntryRow[]>(r))
}

export function readMemory(workspaceId: string, id: string): Promise<MemoryEntryRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(id)}`).then((r) => json<MemoryEntryRow>(r))
}

export function createMemory(workspaceId: string, input: { readonly id: string; readonly title: string; readonly body: string; readonly pinned?: boolean }): Promise<MemoryEntryRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, ...(input.pinned === true ? { pinned: true } : {}) }),
  }).then((r) => json<MemoryEntryRow>(r))
}

export function updateMemory(
  workspaceId: string,
  id: string,
  input: { readonly expectedHash: string; readonly title?: string; readonly body?: string; readonly pinned?: boolean },
): Promise<MemoryEntryRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(id)}`, {
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

export function deleteMemory(workspaceId: string, id: string): Promise<{ readonly forgotten: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly forgotten: boolean }>(r),
  )
}

// ── G4: agents & delegation ─────────────────────────────────────────────────

export function fetchAgentDefinition(workspaceId: string, name: string): Promise<AgentDefinitionRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(name)}`).then((r) => json<AgentDefinitionRow>(r))
}

export interface SpawnTaskInput {
  readonly objective: string
  readonly constraints: readonly string[]
  readonly references: readonly string[]
  readonly requiredResult: string
}

export function spawnChild(
  workspaceId: string,
  name: string,
  rootSessionId: string,
  task: SpawnTaskInput,
  grantTools?: readonly string[],
): Promise<ChildRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rootSessionId,
      task,
      ...(grantTools !== undefined && grantTools.length > 0 ? { grantTools } : {}),
    }),
  }).then((r) => json<ChildRow>(r))
}

export function listChildren(workspaceId: string, rootSessionId: string): Promise<ChildRow[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/children?root=${encodeURIComponent(rootSessionId)}`).then((r) =>
    json<ChildRow[]>(r),
  )
}

export function waitChild(workspaceId: string, childSessionId: string, waitMs = 5_000): Promise<ChildRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/children/${encodeURIComponent(childSessionId)}?waitMs=${waitMs}`).then((r) =>
    json<ChildRow>(r),
  )
}

export function cancelChild(workspaceId: string, childSessionId: string): Promise<ChildRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/children/${encodeURIComponent(childSessionId)}/cancel`, { method: 'POST' }).then((r) =>
    json<ChildRow>(r),
  )
}

export interface ImportAgentInput {
  readonly content: string
  readonly dialect: 'claude' | 'codex'
  readonly sourceVersion?: string
}

export interface ImportResult {
  readonly imported: readonly string[]
  readonly blocked?: readonly string[]
  readonly warnings?: readonly string[]
  readonly active?: boolean
  readonly spawned?: boolean
  readonly reconnected?: readonly string[]
}

export function importAgentDefinition(workspaceId: string, name: string, input: ImportAgentInput): Promise<ImportResult> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(name)}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ImportResult>(r))
}

// ── G5: MCP, hooks, secrets ─────────────────────────────────────────────────

export function listMcpServers(workspaceId: string): Promise<McpServerRow[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp`).then((r) => json<McpServerRow[]>(r))
}

export function upsertMcpServer(workspaceId: string, name: string, config: Record<string, unknown>): Promise<{ readonly saved: string; readonly enabled: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...config, name }),
  }).then((r) => json<{ readonly saved: string; readonly enabled: boolean }>(r))
}

/** Stored config of one server, including fields the settings form does not show. */
export function getMcpServer(workspaceId: string, name: string): Promise<Record<string, unknown>> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}`).then((r) => json<Record<string, unknown>>(r))
}

export function deleteMcpServer(workspaceId: string, name: string): Promise<{ readonly deleted: string }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: string }>(r),
  )
}

export function setMcpServerAction(workspaceId: string, name: string, action: 'enable' | 'disable' | 'reconnect'): Promise<{ readonly status: string }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/${action}`, { method: 'POST' }).then((r) =>
    json<{ readonly status: string }>(r),
  )
}

export function importMcpServers(workspaceId: string, input: ImportAgentInput): Promise<ImportResult> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<ImportResult>(r))
}

export function fetchHooks(workspaceId: string): Promise<HooksConfigRow> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/hooks`).then((r) => json<HooksConfigRow>(r))
}

export function saveHooks(workspaceId: string, config: HooksConfigRow): Promise<{ readonly saved: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/hooks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  }).then((r) => json<{ readonly saved: boolean }>(r))
}

/** Masked key names only — values never leave the server. */
export function listSecrets(workspaceId: string): Promise<SecretRow[]> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/secrets`).then((r) => json<SecretRow[]>(r))
}

export function setSecret(workspaceId: string, key: string, value: string): Promise<{ readonly rotated: string; readonly reconnected?: readonly string[] }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/secrets/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  }).then((r) => json<{ readonly rotated: string; readonly reconnected?: readonly string[] }>(r))
}

export function deleteSecret(workspaceId: string, key: string): Promise<{ readonly deleted: string }> {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }).then((r) =>
    json<{ readonly deleted: string }>(r),
  )
}

/** Workspace management only. Removing registration never deletes the folder. */
export function renameProject(workspaceId: string, projectId: string, name: string): Promise<ProjectRow> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/projects/' + encodeURIComponent(projectId), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }).then(r => json<ProjectRow>(r))
}
/** Retarget a project's folder; refused while its sessions are running (409). */
export function setProjectPath(workspaceId: string, projectId: string, path: string): Promise<ProjectRow> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/projects/' + encodeURIComponent(projectId), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
  }).then(r => json<ProjectRow>(r))
}
export function removeProject(workspaceId: string, projectId: string): Promise<{ deleted: boolean }> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/projects/' + encodeURIComponent(projectId), { method: 'DELETE' }).then(r => json<{ deleted: boolean }>(r))
}

export function listAgentDefinitions(workspaceId: string): Promise<AgentDefinitionRow[]> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/agents').then(r => json<AgentDefinitionRow[]>(r))
}
export function deleteAgentDefinition(workspaceId: string, name: string): Promise<{ deleted: boolean }> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/agents/' + encodeURIComponent(name), { method: 'DELETE' }).then(r => json<{ deleted: boolean }>(r))
}

// ── Workbench terminals ─────────────────────────────────────────────────────
// A user-driven shell, not an agent tool: these routes carry no approval and
// write nothing to the session log. Payloads are base64 because PTY traffic is
// a byte stream.

export function listTerminals(workspaceId: string): Promise<TerminalListing> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals').then(r => json<TerminalListing>(r))
}

export function createTerminal(workspaceId: string, input: { shellId?: string; projectId?: string; cols: number; rows: number }): Promise<TerminalRow> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(r => json<TerminalRow>(r))
}

export function killTerminal(workspaceId: string, terminalId: string): Promise<{ killed: boolean }> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/' + encodeURIComponent(terminalId), { method: 'DELETE' }).then(r => json<{ killed: boolean }>(r))
}

export function writeTerminal(workspaceId: string, terminalId: string, data: string): Promise<unknown> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/' + encodeURIComponent(terminalId) + '/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: toBase64(data) }),
  }).then(r => json<unknown>(r))
}

export function resizeTerminal(workspaceId: string, terminalId: string, cols: number, rows: number): Promise<TerminalRow> {
  return fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/' + encodeURIComponent(terminalId) + '/resize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  }).then(r => json<TerminalRow>(r))
}

/** One stream per workspace carries every terminal in it (see the server note on connection limits). */
export function subscribeTerminals(
  workspaceId: string,
  onFrame: (frame: TerminalFrame) => void,
  onState?: (state: StreamState) => void,
): () => void {
  const source = new EventSource('/api/workspaces/' + encodeURIComponent(workspaceId) + '/terminals/events')
  source.onopen = () => onState?.('open')
  source.onerror = () => {
    onState?.(source.readyState === EventSource.CONNECTING ? 'reconnecting' : 'connecting')
  }
  source.onmessage = (message: MessageEvent<string>) => {
    onFrame(JSON.parse(message.data) as TerminalFrame)
  }
  return () => {
    source.close()
  }
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
