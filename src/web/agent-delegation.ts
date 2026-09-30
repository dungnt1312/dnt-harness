/**
 * Model-driven delegation: the `Agent` tool and the model resolution behind it.
 *
 * The tool is deliberately ASYNC — `spawn` returns a handle at once and
 * `wait` blocks on several children — because one step's tool calls run
 * sequentially. A blocking spawn would therefore serialize delegation and
 * the executor's parallel capacity would never be used.
 *
 * Which model a child runs on follows one fixed order: the spawn request,
 * then the role definition, then the parent conversation's own pair. The
 * result is stamped into the child's log at spawn, so a child never silently
 * inherits a later global default and a role may name a model that lives on
 * a different provider than the parent's.
 */
import type { SessionId, WorkspaceId, ProjectId } from '../util/brand.ts'
import type { Session } from '../harness/session/session.ts'
import type { SessionEvent } from '../harness/session/events.ts'
import { agentScope } from '../harness/agent/scope.ts'
import { bundledDefinition, BUNDLED_AGENT_ROLES, type AgentDefinitionService } from '../harness/agents/definition-service.ts'
import { MAX_ACTIVE_PER_ROOT, type ChildExecutor, type ChildModel, type TaskPacket } from '../harness/agents/executor.ts'
import type { GrantedRoot, ToolDefinition } from '../harness/tools/types.ts'

/** Most parent-conversation text an `inherit: 'brief'` child receives. */
export const MAX_INHERITED_CHARS = 12_000

/**
 * The bounded parent projection behind `inherit: 'brief'`: recent user and
 * assistant MESSAGES only — never tool calls, tool results, assistant
 * messages that accompany tool use, or a compaction summary. Newest content
 * is kept up to `maxChars`, then returned in chronological order. Pure, so
 * both spawn surfaces call it synchronously at the moment of spawn.
 */
export function projectInheritedMessages(events: readonly SessionEvent[], maxChars = MAX_INHERITED_CHARS): string {
  const kept: string[] = []
  let used = 0
  for (let i = events.length - 1; i >= 0 && used < maxChars; i--) {
    const event = events[i]
    let line: string | undefined
    if (event?.type === 'user/message' && event.content.trim() !== '') line = `User: ${event.content.trim()}`
    else if (event?.type === 'assistant/message' && (event.toolCalls === undefined || event.toolCalls.length === 0) && event.content.trim() !== '') {
      line = `Assistant: ${event.content.trim()}`
    }
    if (line === undefined) continue
    const separatorChars = kept.length > 0 ? 2 : 0
    const room = maxChars - used - separatorChars
    const text = truncateInheritedLine(line, room)
    // There is not enough space to retain the source label and truncation
    // marker, so omit this and every older message rather than returning a
    // misleading unlabelled fragment.
    if (text === undefined) break
    kept.push(text)
    used += separatorChars + text.length
  }
  return kept.reverse().join('\n\n')
}

/** Retain a recognisable source label when a message crosses the context cap. */
function truncateInheritedLine(line: string, maxChars: number): string | undefined {
  if (line.length <= maxChars) return line
  const labelEnd = line.indexOf(': ')
  const marker = `${line.slice(0, labelEnd)}: [truncated] `
  if (labelEnd < 0 || marker.length > maxChars) return undefined
  return marker + line.slice(-(maxChars - marker.length))
}

/** A parent conversation's effective selection, as the host resolves it. */
export interface ParentModel {
  readonly provider: string | null | undefined
  readonly model: string | null | undefined
  readonly thinkingLevel?: string | null | undefined
}

export interface ChildModelDeps {
  readonly parent: ParentModel
  /** Usable provider ids. */
  readonly providers: readonly string[]
  /** Models one provider advertises; empty means it accepts any name. */
  readonly modelsOf: (provider: string) => readonly string[]
  /** Host validation; its message already lists what the provider offers. */
  readonly validate: (provider: string, model: string) => void
}

/** How many `provider:model` ids an error message may enumerate. */
const MAX_LISTED = 30

export class ChildModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChildModelError'
  }
}

/**
 * Resolve the pair to stamp, or `undefined` when nothing is known and the
 * host's own defaults should stand.
 *
 * `reference` accepts `provider:model` (the web client's encoding, split on
 * the first colon) or a bare model name, which resolves to the parent's
 * provider when that provider offers it, otherwise to the single provider
 * that does. An ambiguous bare name is an error naming the candidates, never
 * a silent pick.
 */
export function resolveChildModel(
  reference: string | undefined,
  definitionModel: string | undefined,
  deps: ChildModelDeps,
): ChildModel | undefined {
  const thinkingLevel = deps.parent.thinkingLevel
  const inherited = withThinking(deps.parent, thinkingLevel)
  const requested = (reference ?? definitionModel ?? '').trim()
  if (requested === '') return inherited

  const boundary = requested.indexOf(':')
  if (boundary > 0 && boundary < requested.length - 1) {
    const provider = requested.slice(0, boundary)
    const model = requested.slice(boundary + 1)
    deps.validate(provider, model)
    return { provider, model, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) }
  }

  const parentProvider = typeof deps.parent.provider === 'string' && deps.parent.provider !== '' ? deps.parent.provider : undefined
  if (parentProvider !== undefined && deps.modelsOf(parentProvider).includes(requested)) {
    deps.validate(parentProvider, requested)
    return { provider: parentProvider, model: requested, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) }
  }
  const candidates = deps.providers.filter((provider) => deps.modelsOf(provider).includes(requested))
  if (candidates.length > 1) {
    throw new ChildModelError(
      `model '${requested}' exists on several providers (${candidates.join(', ')}); name it as 'provider:model'`,
    )
  }
  const chosen = candidates[0]
    // A provider that advertises no catalog accepts any name, so the parent's
    // provider stays the fallback rather than a guess across the others.
    ?? (parentProvider !== undefined && deps.modelsOf(parentProvider).length === 0 ? parentProvider : undefined)
  if (chosen === undefined) {
    throw new ChildModelError(`unknown model '${requested}'; available: ${availableModels(deps).join(', ') || 'none'}`)
  }
  deps.validate(chosen, requested)
  return { provider: chosen, model: requested, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) }
}

/** Every usable `provider:model` id, bounded for messages and descriptions. */
export function availableModels(deps: Pick<ChildModelDeps, 'providers' | 'modelsOf'>, limit = MAX_LISTED): string[] {
  const ids: string[] = []
  for (const provider of deps.providers) {
    for (const model of deps.modelsOf(provider)) {
      if (ids.length >= limit) return ids
      ids.push(`${provider}:${model}`)
    }
  }
  return ids
}

function withThinking(parent: ParentModel, thinkingLevel: string | null | undefined): ChildModel | undefined {
  if (typeof parent.provider !== 'string' || parent.provider === '') return undefined
  if (typeof parent.model !== 'string' || parent.model === '') return undefined
  return { provider: parent.provider, model: parent.model, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) }
}

// ── the Agent tool ───────────────────────────────────────────

/** Longest a single `wait` may block, mirroring the HTTP lifecycle route. */
const MAX_WAIT_MS = 120_000
const DEFAULT_WAIT_MS = 30_000
/** How long a role listing may serve the tool description before a refresh. */
const ROLE_CACHE_MS = 5_000

export interface DelegationDeps {
  readonly definitions: AgentDefinitionService
  readonly executor: Pick<ChildExecutor, 'spawn' | 'childrenOfRoot' | 'wait' | 'cancel' | 'reconcile' | 'activeOfRoot' | 'runningChildrenOfRoot'>
  /** The executing session, root or child. */
  readonly session: (sessionId: SessionId) => Promise<Session | undefined>
  readonly childModelFor: (
    parent: Session,
    workspaceId: WorkspaceId,
    requested?: string,
    definitionModel?: string,
  ) => ChildModel | undefined
  /** Usable provider ids and their advertised models, for the live catalog. */
  readonly providers: () => readonly string[]
  readonly modelsOf: (provider: string) => readonly string[]
  /** The parent's effective additional folders, snapshotted into the child at spawn. */
  readonly grantsOf?: (parentSessionId: SessionId) => readonly GrantedRoot[]
}

/**
 * The `Agent` tool: bounded one-level delegation the model drives itself.
 * Authority comes from the ambient scope alone — a tool argument can never
 * choose a different workspace, session, or parent.
 */
export function agentTool(deps: DelegationDeps): ToolDefinition {
  // The description must be assembled synchronously, so role listings are
  // cached per workspace and refreshed in the background. Every workspace
  // starts from the bundled roles, which are static, so the description is
  // never empty — and one workspace's custom roles never leak into another's.
  const BUNDLED_ROLES = BUNDLED_AGENT_ROLES.map((name) => {
    const definition = bundledDefinition(name)
    return { name: definition.name, description: definition.description }
  })
  const roleCache = new Map<WorkspaceId, { roles: readonly { readonly name: string; readonly description: string }[]; refreshedAt: number }>()

  const rolesFor = (workspaceId: WorkspaceId): readonly { readonly name: string; readonly description: string }[] => {
    const now = Date.now()
    // Lazy TTL eviction keeps the long-lived closure bounded.
    for (const [id, entry] of roleCache) {
      if (id !== workspaceId && now - entry.refreshedAt >= ROLE_CACHE_MS) roleCache.delete(id)
    }
    const cached = roleCache.get(workspaceId)
    if (cached !== undefined && now - cached.refreshedAt < ROLE_CACHE_MS) return cached.roles
    const entry = { roles: cached?.roles ?? BUNDLED_ROLES, refreshedAt: now }
    roleCache.set(workspaceId, entry)
    void deps.definitions.list(workspaceId)
      .then((rows) => { entry.roles = rows.map((row) => ({ name: row.definition.name, description: row.definition.description })) })
      .catch(() => { /* keep the previous listing; `catalog` reports the truth */ })
    return entry.roles
  }

  const describe = (): string => {
    const scope = agentScope.getStore()
    const roles = scope?.workspaceId !== undefined ? rolesFor(scope.workspaceId) : BUNDLED_ROLES
    const models = availableModels({ providers: deps.providers(), modelsOf: deps.modelsOf })
    const total = deps.providers().reduce((sum, provider) => sum + deps.modelsOf(provider).length, 0)
    return [
      'Delegate a bounded task to a child agent and collect its result.',
      'spawn returns immediately, so several children run at the same time; wait blocks until they settle.',
      'One level only: a child can never delegate further.',
      'Wait for the children before you finish your turn — children still running when the turn closes are cancelled.',
      'Delegate when the work is separable and its result compresses — a search across many files, a review, a verification run. Do not delegate what you can do in two tool calls, and do not delegate work whose context you would have to retype.',
      'Write the prompt as you would brief a colleague who cannot see this conversation: name the files and the facts it needs, and say what the answer must contain. The child\'s final message is all you get back.',
      'Children share the project filesystem with their root. Coordinate edits to the same files and re-read before writing; unrelated conversations never own or block this project.',
      `Roles: ${roles.map((role) => `${role.name} (${role.description})`).join('; ') || 'none'}.`,
      `Models as provider:model — ${models.join(', ') || 'none'}${total > models.length ? `, +${total - models.length} more, use action:"catalog"` : ''}.`,
      'Omit model to inherit this conversation\'s model; grantTools only narrows the role, never widens it.',
    ].join(' ')
  }

  return {
    name: 'Agent',
    description: describe(),
    requiresRoot: false,
    schema: () => ({ description: describe(), parameters: PARAMETERS }),
    parameters: PARAMETERS,
    async execute(args) {
      const scope = agentScope.getStore()
      if (scope?.workspaceId === undefined) throw new Error('Agent requires a workspace-scoped execution')
      if (scope.childOf !== undefined) throw new Error('one-level delegation: a child agent cannot delegate')
      const workspaceId = scope.workspaceId
      const parent = await deps.session(scope.sessionId)
      if (parent === undefined) throw new Error('Agent could not resolve the calling conversation')
      const action = typeof args['action'] === 'string' ? args['action'] : 'spawn'

      switch (action) {
        case 'spawn': return spawn(deps, args, scope.sessionId, workspaceId, scope.projectId, parent)
        case 'list': return JSON.stringify({ children: await deps.executor.childrenOfRoot(scope.sessionId, workspaceId) })
        case 'wait': return wait(deps, args, scope.sessionId, workspaceId)
        case 'cancel': return cancel(deps, args, scope.sessionId, workspaceId)
        case 'reconcile': return reconcile(deps, args, scope.sessionId, workspaceId)
        case 'catalog': return catalog(deps, workspaceId)
        default:
          throw new Error(`unknown action '${action}'; use spawn, wait, cancel, reconcile or catalog`)
      }
    },
  }
}

const PARAMETERS: ToolDefinition['parameters'] = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'spawn | wait | list | cancel | reconcile | catalog (default spawn)' },
    definition: { type: 'string', description: 'spawn: the role name, from the catalog' },
    prompt: { type: 'string', description: 'spawn: the brief, in prose — what to do, the files and facts it needs, and what the answer must contain' },
    requiredResult: { type: 'string', description: 'spawn: the shape of the answer you need back' },
    inherit: { type: 'string', description: `spawn: "none" (default) or "brief" — also hand the child up to ${MAX_INHERITED_CHARS} chars of this conversation's recent messages (no tool output); costs context, so prefer naming what it needs in the prompt` },
    objective: { type: 'string', description: 'spawn: alternative structured form — what the child must accomplish (use prompt instead)' },
    constraints: { type: 'array', items: { type: 'string' }, description: 'spawn: limits the child must respect' },
    references: { type: 'array', items: { type: 'string' }, description: 'spawn: files or facts the child should start from' },
    grantTools: { type: 'array', items: { type: 'string' }, description: 'spawn: narrows the role\'s tools; never widens them' },
    model: { type: 'string', description: 'spawn: provider:model (or a bare model name); omit to inherit this conversation\'s' },
    childIds: { type: 'array', items: { type: 'string' }, description: 'wait/cancel: child session ids; wait defaults to every running child' },
    timeoutMs: { type: 'number', description: `wait: how long to block, capped at ${MAX_WAIT_MS}` },
  },
  required: [],
}

async function spawn(
  deps: DelegationDeps,
  args: Record<string, unknown>,
  parentSessionId: SessionId,
  workspaceId: WorkspaceId,
  projectId: ProjectId | undefined,
  parent: Session,
): Promise<string> {
  // Shape only: whether the brief is usable is the executor's single call
  // (SpawnError 'packet'), shared with the HTTP route.
  const name = typeof args['definition'] === 'string' ? args['definition'].trim() : ''
  if (name === '') throw new Error("'definition' must name a role; use action:\"catalog\" to list them")
  const inherit = args['inherit'] ?? 'none'
  if (inherit !== 'none' && inherit !== 'brief') throw new Error("'inherit' must be \"none\" or \"brief\"")
  // Captured synchronously before any await: a message the parent appends
  // while the role and model resolve can never leak into the snapshot.
  const inheritedContext = inherit === 'brief' ? projectInheritedMessages(parent.events) : undefined

  const resolved = await deps.definitions.resolve(workspaceId, name).catch(async (error: unknown) => {
    const rows = await deps.definitions.list(workspaceId).catch(() => [])
    throw new Error(`${String(error instanceof Error ? error.message : error)}; available roles: ${rows.map((row) => row.definition.name).join(', ') || 'none'}`)
  })
  const packet: TaskPacket = {
    ...(typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {}),
    ...(typeof args['objective'] === 'string' ? { objective: args['objective'] } : {}),
    constraints: stringList(args['constraints']),
    references: stringList(args['references']),
    requiredResult: typeof args['requiredResult'] === 'string' && args['requiredResult'].trim() !== ''
      ? args['requiredResult'].trim()
      : 'bounded summary with file references',
  }
  const both = (packet.prompt?.trim() ?? '') !== '' && (packet.objective?.trim() ?? '') !== ''
  const grantTools = Array.isArray(args['grantTools']) ? stringList(args['grantTools']) : undefined
  const model = deps.childModelFor(
    parent,
    workspaceId,
    typeof args['model'] === 'string' ? args['model'] : undefined,
    resolved.definition.model,
  )
  const turnId = agentScope.getStore()?.turnId
  if (turnId === undefined) throw new Error('Agent spawn requires the calling root\'s active Turn')
  const handle = await deps.executor.spawn({
    workspaceId,
    ...(projectId !== undefined ? { projectId } : {}),
    parentSessionId,
    parentTurnId: turnId,
    definition: resolved.definition,
    packet,
    ...(grantTools !== undefined ? { grantTools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(inheritedContext !== undefined ? { inherit: 'brief' as const, inheritedContext } : {}),
    ...(deps.grantsOf !== undefined ? { grants: deps.grantsOf(parentSessionId) } : {}),
  })
  // A grant that asked for something the role lacks is reported, never
  // silently dropped: the model would otherwise plan around a missing tool.
  const dropped = grantTools?.filter((tool) => !resolved.definition.tools.includes(tool)) ?? []
  const notes = [
    ...(dropped.length > 0 ? [`role '${handle.definitionName}' does not expose ${dropped.join(', ')}`] : []),
    ...(both ? ["both 'prompt' and 'objective' were given; the prompt is the brief"] : []),
  ]
  return JSON.stringify({
    childSessionId: handle.childSessionId,
    definition: handle.definitionName,
    ...(handle.model !== undefined ? { model: handle.model } : {}),
    status: handle.status,
    // Active children of THIS conversation; the host-wide ceiling is not shown.
    active: `${deps.executor.activeOfRoot(parentSessionId)}/${MAX_ACTIVE_PER_ROOT}`,
    ...(inheritedContext !== undefined ? { inheritedChars: inheritedContext.length } : {}),
    ...(dropped.length > 0 ? { droppedGrants: dropped } : {}),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    next: 'call Agent with action:"wait" before finishing this turn',
  })
}

async function wait(
  deps: DelegationDeps,
  args: Record<string, unknown>,
  parentSessionId: SessionId,
  workspaceId: WorkspaceId,
): Promise<string> {
  const requested = stringList(args['childIds'])
  const ids = requested.length > 0
    ? await ownedChildIds(deps, requested, parentSessionId)
    : deps.executor.runningChildrenOfRoot(parentSessionId)
  if (ids.length === 0) return JSON.stringify({ children: [], note: 'no children are running for this conversation' })

  const raw = Number(args['timeoutMs'])
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_WAIT_MS) : DEFAULT_WAIT_MS
  const handles = await deps.executor.wait(workspaceId, ids, { timeoutMs })
  const running = handles.filter((child) => child.status === 'running')
  return JSON.stringify({
    children: handles,
    ...(running.length > 0
      ? {
          note: running.some((child) => child.awaitingApproval === true)
            ? 'a child is waiting for the user to answer an approval; wait again or cancel it'
            : 'still running after the timeout; call wait again',
        }
      : {}),
  })
}

async function reconcile(
  deps: DelegationDeps,
  args: Record<string, unknown>,
  parentSessionId: SessionId,
  workspaceId: WorkspaceId,
): Promise<string> {
  const requested = stringList(args['childIds'])
  if (requested.length === 0) throw new Error("'childIds' must name at least one child to reconcile")
  const handles = []
  for (const id of await ownedChildIds(deps, requested, parentSessionId)) {
    const handle = await deps.executor.reconcile(workspaceId, id)
    if (handle !== undefined) handles.push(handle)
  }
  return JSON.stringify({ children: handles })
}

async function cancel(
  deps: DelegationDeps,
  args: Record<string, unknown>,
  parentSessionId: SessionId,
  workspaceId: WorkspaceId,
): Promise<string> {
  const requested = stringList(args['childIds'])
  if (requested.length === 0) throw new Error("'childIds' must name at least one child to cancel")
  const handles = []
  for (const id of await ownedChildIds(deps, requested, parentSessionId)) {
    const handle = await deps.executor.cancel(workspaceId, id)
    if (handle !== undefined) handles.push(handle)
  }
  return JSON.stringify({ children: handles })
}

/** Explicit lifecycle ids must belong to the calling root, not merely its workspace. */
async function ownedChildIds(deps: DelegationDeps, ids: readonly string[], parentSessionId: SessionId): Promise<SessionId[]> {
  const owned: SessionId[] = []
  for (const id of ids) {
    const child = await deps.session(id as SessionId)
    if (childParentSessionId(child) === parentSessionId) owned.push(id as SessionId)
  }
  return owned
}

function childParentSessionId(session: Session | undefined): SessionId | undefined {
  if (session === undefined) return undefined
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event?.type === 'session/child-meta') return event.parentSessionId as SessionId
  }
  return undefined
}

async function catalog(deps: DelegationDeps, workspaceId: WorkspaceId): Promise<string> {
  const rows = await deps.definitions.list(workspaceId)
  return JSON.stringify({
    roles: rows.map((row) => ({
      name: row.definition.name,
      description: row.definition.description,
      tools: row.definition.tools,
      ...(row.definition.model !== undefined ? { model: row.definition.model } : {}),
    })),
    models: availableModels({ providers: deps.providers(), modelsOf: deps.modelsOf }, Number.MAX_SAFE_INTEGER),
  })
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map(String).filter((entry) => entry.trim() !== '') : []
}
