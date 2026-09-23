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
import { agentScope } from '../harness/agent/scope.ts'
import type { AgentDefinitionService } from '../harness/agents/definition-service.ts'
import type { ChildExecutor, ChildModel, TaskPacket } from '../harness/agents/executor.ts'
import type { ToolDefinition } from '../harness/tools/types.ts'

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
  readonly executor: ChildExecutor
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
}

/**
 * The `Agent` tool: bounded one-level delegation the model drives itself.
 * Authority comes from the ambient scope alone — a tool argument can never
 * choose a different workspace, session, or parent.
 */
export function agentTool(deps: DelegationDeps): ToolDefinition {
  // The description must be assembled synchronously, so the role listing is
  // cached and refreshed in the background. It starts with the bundled roles,
  // which are static, so the description is never empty.
  let roles: readonly { readonly name: string; readonly description: string }[] = [
    { name: 'explorer', description: 'read-only investigation' },
    { name: 'worker', description: 'bounded task with file tools' },
  ]
  let rolesFor: string | undefined
  let refreshedAt = 0

  const refreshRoles = (workspaceId: WorkspaceId): void => {
    if (rolesFor === workspaceId && Date.now() - refreshedAt < ROLE_CACHE_MS) return
    rolesFor = workspaceId
    refreshedAt = Date.now()
    void deps.definitions.list(workspaceId)
      .then((rows) => { roles = rows.map((row) => ({ name: row.definition.name, description: row.definition.description })) })
      .catch(() => { /* keep the previous listing; `catalog` reports the truth */ })
  }

  const describe = (): string => {
    const scope = agentScope.getStore()
    if (scope?.workspaceId !== undefined) refreshRoles(scope.workspaceId)
    const models = availableModels({ providers: deps.providers(), modelsOf: deps.modelsOf })
    const total = deps.providers().reduce((sum, provider) => sum + deps.modelsOf(provider).length, 0)
    return [
      'Delegate a bounded task to a child agent and collect its result.',
      'spawn returns immediately, so several children run at the same time; wait blocks until they settle.',
      'One level only: a child can never delegate further.',
      'Wait for the children before you finish your turn — children still running when the turn closes are cancelled.',
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
        case 'list': return JSON.stringify({ children: deps.executor.childrenOfRoot(scope.sessionId, workspaceId) })
        case 'wait': return wait(deps, args, scope.sessionId, workspaceId)
        case 'cancel': return cancel(deps, args, workspaceId)
        case 'catalog': return catalog(deps, workspaceId)
        default:
          throw new Error(`unknown action '${action}'; use spawn, wait, list, cancel or catalog`)
      }
    },
  }
}

const PARAMETERS: ToolDefinition['parameters'] = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'spawn | wait | list | cancel | catalog (default spawn)' },
    definition: { type: 'string', description: 'spawn: the role name, from the catalog' },
    objective: { type: 'string', description: 'spawn: what the child must accomplish' },
    constraints: { type: 'array', items: { type: 'string' }, description: 'spawn: limits the child must respect' },
    references: { type: 'array', items: { type: 'string' }, description: 'spawn: files or facts the child should start from' },
    requiredResult: { type: 'string', description: 'spawn: the shape of the answer you need back' },
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
  const objective = typeof args['objective'] === 'string' ? args['objective'].trim() : ''
  if (objective === '') throw new Error("'objective' must be a non-empty string")
  const name = typeof args['definition'] === 'string' ? args['definition'].trim() : ''
  if (name === '') throw new Error("'definition' must name a role; use action:\"catalog\" to list them")

  const resolved = await deps.definitions.resolve(workspaceId, name).catch(async (error: unknown) => {
    const rows = await deps.definitions.list(workspaceId).catch(() => [])
    throw new Error(`${String(error instanceof Error ? error.message : error)}; available roles: ${rows.map((row) => row.definition.name).join(', ') || 'none'}`)
  })
  const packet: TaskPacket = {
    objective,
    constraints: stringList(args['constraints']),
    references: stringList(args['references']),
    requiredResult: typeof args['requiredResult'] === 'string' && args['requiredResult'].trim() !== ''
      ? args['requiredResult'].trim()
      : 'bounded summary with file references',
  }
  const grantTools = Array.isArray(args['grantTools']) ? stringList(args['grantTools']) : undefined
  const model = deps.childModelFor(
    parent,
    workspaceId,
    typeof args['model'] === 'string' ? args['model'] : undefined,
    resolved.definition.model,
  )
  const lastTurn = [...parent.events].reverse().find((event) => event.type === 'turn/start')
  const handle = await deps.executor.spawn({
    workspaceId,
    ...(projectId !== undefined ? { projectId } : {}),
    parentSessionId,
    parentTurnId: lastTurn !== undefined && lastTurn.type === 'turn/start' ? String(lastTurn.turnId) : 'ad-hoc',
    definition: resolved.definition,
    packet,
    ...(grantTools !== undefined ? { grantTools } : {}),
    ...(model !== undefined ? { model } : {}),
  })
  // A grant that asked for something the role lacks is reported, never
  // silently dropped: the model would otherwise plan around a missing tool.
  const dropped = grantTools?.filter((tool) => !resolved.definition.tools.includes(tool)) ?? []
  const active = deps.executor.childrenOfRoot(parentSessionId, workspaceId).filter((child) => child.status === 'running').length
  return JSON.stringify({
    childSessionId: handle.childSessionId,
    definition: handle.definitionName,
    ...(handle.model !== undefined ? { model: handle.model } : {}),
    status: handle.status,
    active: `${active}/3`,
    ...(dropped.length > 0 ? { droppedGrants: dropped, note: `role '${handle.definitionName}' does not expose ${dropped.join(', ')}` } : {}),
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
    ? requested
    : deps.executor.childrenOfRoot(parentSessionId, workspaceId)
        .filter((child) => child.status === 'running')
        .map((child) => child.childSessionId as string)
  if (ids.length === 0) return JSON.stringify({ children: [], note: 'no children are running for this conversation' })

  const raw = Number(args['timeoutMs'])
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_WAIT_MS) : DEFAULT_WAIT_MS
  const handles = await deps.executor.wait(workspaceId, ids as SessionId[], { timeoutMs })
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

async function cancel(deps: DelegationDeps, args: Record<string, unknown>, workspaceId: WorkspaceId): Promise<string> {
  const ids = stringList(args['childIds'])
  if (ids.length === 0) throw new Error("'childIds' must name at least one child to cancel")
  const handles = []
  for (const id of ids) {
    const handle = await deps.executor.cancel(workspaceId, id as SessionId)
    if (handle !== undefined) handles.push(handle)
  }
  return JSON.stringify({ children: handles })
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
