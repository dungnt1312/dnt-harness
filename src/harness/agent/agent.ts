import type { Context } from '../../kernel/index.ts'
import { newExecutionId, newStepId, newTurnId, type ExecutionId, type InputId, type StepId, type TurnId } from '../../util/brand.ts'
import { resolveLimits, type HarnessLimits } from '../limits.ts'
import type { AttachmentRef } from '../attachments/store.ts'
import type { ModelRequest, ToolCall, ToolSchema } from '../llm/types.ts'
import { canonicalCall } from '../tools/names.ts'
import type { ToolResult } from '../tools/types.ts'
import type { Session } from '../session/session.ts'
import { agentScope, type AgentScope } from './scope.ts'
import type { AgentStatus, InboxItem, PreStepDecision } from './types.ts'

/** The tools surface the loop consumes; optional, structurally typed. */
interface ToolRuntime {
  schemas(): ToolSchema[]
  prepare?(call: ToolCall, options?: { signal?: AbortSignal; executionId?: ExecutionId }): Promise<{
    call: ToolCall
    execute(): Promise<ToolResult>
  }>
  execute(call: ToolCall, options?: { signal?: AbortSignal }): Promise<ToolResult>
  /** The live permission-policy revision (a value or an accessor). */
  policyRevision?: number | (() => number)
}

function revisionOf(runtime: ToolRuntime | undefined): number | undefined {
  if (runtime?.policyRevision === undefined) return undefined
  return typeof runtime.policyRevision === 'function' ? runtime.policyRevision() : runtime.policyRevision
}

/** Thrown inside a step when the user asks the loop to stop; closes the turn, not a failure. */
class StopRequested extends Error {
  constructor() {
    super('agent: stop requested')
  }
}

/** Why the abort controller fired; decides the truthful terminal reason. */
type AbortCause = 'stop' | 'inactivity'

/** Storage acknowledged nothing; the turn fails and the run halts. */
class StorageFailed extends Error {
  constructor(cause: unknown) {
    super(`durable storage failed: ${String(cause instanceof Error ? cause.message : cause)}`)
  }
}

/**
 * The default driver: one agent bound to one durable session, running the
 * turn/step flow over an inbox.
 *
 * A **step** is one model request plus the tools it calls; a **turn** is
 * zero or more steps: it opens before its first input is claimed and closes
 * once nothing is owed — tools that ran owe the model their results, so the
 * turn spends another step. Input reaches the driver through one inbox:
 * user messages wake it, injected context waits until a user message does.
 *
 * Durability: every append lands in memory immediately, and explicit
 * `session.durable()` barriers gate each checkpoint — input is acknowledged,
 * tool intent is recorded, and results are stored before the loop builds on
 * them. A barrier failure poisons the session and halts the run; nothing
 * further executes against unrecorded state.
 */
export class Agent {
  status: AgentStatus = 'idle'
  /** What the driver is currently busy with (transient, for status UIs). */
  activity: 'model' | 'tool' | null = null

  private inbox: InboxItem[] = []
  private abortController: AbortController | null = null
  private abortCause: AbortCause = 'stop'

/** The fixed workspace/project identity carried into every execution. */
  readonly identity: AgentScope

  constructor(
    private readonly ctx: Context,
    readonly session: Session,
    identity: AgentScope = { sessionId: session.id, rootSessionId: session.id },
  ) {
    this.identity = {
      ...identity,
      sessionId: session.id,
      rootSessionId: identity.rootSessionId ?? session.id,
    }
  }

  /** Whether a run is in flight; the web UI's Stop button reads this. */
  get busy(): boolean {
    return this.status !== 'idle'
  }

  /** Queue a user message; wakes the driver on the next `run()`. Ephemeral: durable acceptance is the caller's job via an `input/queued` event plus {@link enqueueAccepted}. */
  send(content: string): void {
    this.inbox.push({ kind: 'user', content })
  }

  /**
   * Adopt an already durably accepted input into the inbox. The
   * `input/queued` record exists; this only makes the driver see it. Hosts
   * call this on acceptance and after restarts to restore pending inputs —
   * restored inputs wait for the next user-triggered run, never auto-run.
   */
  enqueueAccepted(item: { content: string; inputId: InputId; attachments?: readonly AttachmentRef[] }): void {
    if (this.inbox.some((existing) => existing.kind === 'user' && existing.inputId === item.inputId)) return
    this.inbox.push({
      kind: 'user',
      content: item.content,
      inputId: item.inputId,
      ...(item.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
    })
  }

  /** User inputs waiting in the inbox (queue-depth reads for status UIs). */
  get pendingCount(): number {
    return this.inbox.filter((item) => item.kind === 'user').length
  }

  /**
   * Ask the in-flight run to stop: the abort signal reaches the provider
   * stream, approval waiters, and cancellable tools (child processes
   * included). No further tool or model request starts; already-completed
   * work stays completed. Remaining queued input stays queued — stop never
   * auto-advances it. A no-op while idle.
   */
  stop(): void {
    this.abortCause = 'stop'
    if (this.status === 'running') this.status = 'cancelling'
    this.abortController?.abort()
  }

  /**
   * Queue context that must reach the next admitted request without waking
   * the driver: it waits in the inbox until a user message arrives.
   */
  inject(content: string): void {
    this.inbox.push({ kind: 'injected', content })
  }

  /**
   * Drive turns until the inbox drains, then go idle. Every step assembles
   * its request from `session.deriveMessages()` — model-visible means
   * logged. A stopped run leaves the loop without consuming queued input.
   */
  async run(): Promise<void> {
    if (this.status !== 'idle') return
    this.status = 'running'
    this.abortCause = 'stop'
    this.abortController = new AbortController()
    let stopped = false
    try {
      // The scope lets pipeline listeners (approval routing, tool grants,
      // workspace-scoped controls) attribute work to this agent's session
      // and workspace while the turn is in flight.
      await agentScope.run(this.identity, async () => {
        // Only a user message opens a turn; injected context waits in the
        // inbox until one arrives and is claimed alongside it. A stop ends
        // the run: queued input must not auto-advance.
        while (!stopped && this.inbox.some((item) => item.kind === 'user')) {
          try {
            const closed = await this.turn()
            if (closed !== 'completed' && closed !== 'rejected' && closed !== 'empty') stopped = true
          } catch (error) {
            await this.closeOpenTurn()
            throw error
          }
        }
      })
    } finally {
      this.status = 'idle'
      this.activity = null
      this.abortController = null
    }
  }

  /**
   * Append `turn/end` for the newest still-open turn, if any: a failed step
   * must not leave the log with a dangling `turn/start`. The record is
   * flushed before returning — a terminal state the log does not hold is a
   * lie the next restart would tell differently. A poisoned session cannot
   * record anything; the original error stays the truthful outcome there.
   */
  private async closeOpenTurn(): Promise<void> {
    if (this.session.poisoned) return
    for (let i = this.session.events.length - 1; i >= 0; i--) {
      const event = this.session.events[i]
      if (event === undefined) continue
      if (event.type === 'turn/end') return
      if (event.type === 'turn/start') {
        this.session.append({ type: 'turn/end', turnId: event.turnId, reason: 'failed' })
        await this.session.durable().catch(() => {})
        return
      }
    }
  }

  /**
   * One turn. Claims the whole pending inbox (a simplification of the
   * upstream bounded claim), asks `agent/pre-step` to admit it, then spends
   * steps while tools keep owing the model their results. Returns the terminal
   * reason so `run()` knows which outcomes end the run (a stop leaves queued
   * input queued).
   */
  private async turn(): Promise<'completed' | 'cancelled' | 'failed' | 'rejected' | 'empty'> {
    const turnId = newTurnId()
    return agentScope.run({ ...this.identity, turnId }, async () => {
      this.session.append({ type: 'turn/start', turnId })
      const controller = this.abortController
      try {
      const claimed = this.inbox.splice(0, this.inbox.length)
      const contents = claimed.map((item) => item.content)
      const decision = await this.ctx.waterfall(
        'agent/pre-step',
        { contents },
        (replacement) =>
          Promise.resolve({
            kind: 'enter',
            contents: replacement?.contents ?? contents,
          } satisfies PreStepDecision),
      )

      if (decision.kind === 'reject') {
        await this.recordTurnEnd(turnId, 'rejected')
        return 'rejected'
      }
      if (decision.contents.length === 0) {
        await this.recordTurnEnd(turnId, 'empty')
        return 'empty'
      }

      let lastStep: StepId | null = null
      // A turn keeps spending steps while tools owe the model their results.
      for (let spent = 1; ; spent++) {
        let step: { stepId: StepId; toolCalls: readonly ToolCall[] }
        try {
          step = await this.step(turnId, spent === 1 ? decision.contents : [], spent === 1 ? claimed : [])
        } catch (error) {
          // A user stop is a durable result, not a failure: close the turn
          // with the `cancelled` reason and end the run.
          if (error instanceof StopRequested) {
            await this.recordTurnEnd(turnId, 'cancelled')
            return 'cancelled'
          }
          throw error
        }
        lastStep = step.stepId
        if (step.toolCalls.length === 0) break
      }

      await this.ctx.serial('agent/turn-stopping', { turnId, lastStep })
      await this.recordTurnEnd(turnId, 'completed')
      return 'completed'
    } catch (error) {
      // Classified failures append the durable reason before closing. A
      // poisoned session records nothing further — the throw is the truth.
      if (!this.session.poisoned) {
        const aborted = controller?.signal.aborted === true
        const { kind, message, reason } = error instanceof StorageFailed
          ? { kind: 'storage' as const, message: error.message, reason: 'failed' as const }
          : aborted && this.abortCause === 'inactivity'
            ? { kind: 'provider' as const, message: 'provider stream stayed inactive past the limit', reason: 'failed' as const }
            : { kind: 'internal' as const, message: String(error instanceof Error ? error.message : error), reason: 'failed' as const }
        try {
          this.session.append({ type: 'turn/error', turnId, kind, message })
          await this.session.durable()
          this.session.append({ type: 'turn/end', turnId, reason })
          // Terminal states leave the log durably: the run must not report
          // an outcome the canonical file does not hold.
          await this.session.durable()
        } catch {
          // The poisoned session wins: nothing more can be claimed durable,
          // and the failure to record it is itself the truthful outcome.
        }
      }
      // Even a poisoned session must release per-Turn holders.
        await this.ctx.parallel('agent/turn-settled', { turnId, reason: 'failed' }).catch(() => {})
        return 'failed'
      }
    })
  }

  /** Append and durably flush a turn end, then release per-Turn holders. */
  private async recordTurnEnd(turnId: TurnId, reason: 'completed' | 'rejected' | 'empty' | 'cancelled' | 'failed'): Promise<void> {
    this.session.append({ type: 'turn/end', turnId, reason })
    try {
      await this.session.durable()
    } catch (cause) {
      throw new StorageFailed(cause)
    }
    // Terminalization is durable: per-Turn resources (writer leases) go.
    await this.ctx.parallel('agent/turn-settled', { turnId, reason })
  }

  /**
   * One step: append admitted input (first step only), request from the
   * log with the registered tool schemas, stream the reply, then run every
   * requested tool and append its durable call/result pair. The model and
   * provider actually used are recorded on the answer; every durable
   * checkpoint is flushed before the loop builds on it.
   *
   * @returns the step id and the tool calls the model made.
   */
  private async step(turnId: TurnId, contents: readonly string[], claimed: readonly InboxItem[]): Promise<{ stepId: StepId; toolCalls: readonly ToolCall[] }> {
    const controller = this.abortController
    const signal = controller?.signal
    const assertLive = (): void => {
      if (signal?.aborted === true) throw this.abortError()
    }

    const stepId = newStepId()
    this.session.append({ type: 'step/start', turnId, stepId })
    for (let i = 0; i < contents.length; i++) {
      const item = claimed[i]
      this.session.append({
        type: 'user/message',
        turnId,
        content: contents[i] ?? '',
        ...(item?.inputId !== undefined ? { inputId: item.inputId } : {}),
        ...(item?.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
      })
    }
    // Durable input: acknowledged before anything asks the model for more.
    await this.flushOrHalt()

    // The tools service is optional: without it the loop still runs, and
    // tool calls fail as unknown tools.
    const tools = this.ctx.get('tools') as ToolRuntime | undefined
    const schemas = tools?.schemas() ?? []
    const projected: ModelRequest = {
      messages: this.session.deriveMessages(),
      ...(tools !== undefined && schemas.length > 0 ? { tools: schemas } : {}),
    }
    assertLive()
    // The mode-driven context builder replaces the assembly wholesale (G3:
    // there is exactly one assembly path). Everything downstream — controls
    // stamping, providers — sees the builder's output.
    const assembled = await this.ctx.waterfall(
      'agent/context',
      projected,
      (replacement) => Promise.resolve(replacement ?? projected),
    )
    const request = await this.ctx.waterfall(
      'agent/request',
      assembled,
      (replacement) => Promise.resolve(replacement ?? assembled),
    )

    let full = ''
    let calls: readonly ToolCall[] = []
    this.activity = 'model'
    try {
      const stream = this.ctx.llm.stream(request, signal !== undefined ? { signal } : {})
      // The abort check runs between stream events, and the iteration itself
      // races the abort signal: a provider that never yields (no data, hung
      // socket) is still stopped by the watchdog instead of blocking forever.
      const iterator = stream[Symbol.asyncIterator]()
      // Two silence windows. Before the first event a provider may legitimately
      // think for minutes (extended thinking whose reasoning deltas the gateway
      // never forwards), so that window is generous; once output has started,
      // silence is a stalled stream and dies fast. bump() re-arms on every event.
      let sawFirstEvent = false
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const bump = (): void => {
        if (watchdog !== undefined) clearTimeout(watchdog)
        const silenceWindow = sawFirstEvent ? this.limits().streamInactivityMs : this.limits().streamFirstEventMs
        watchdog = setTimeout(() => {
          this.abortCause = 'inactivity'
          controller?.abort()
        }, silenceWindow)
        watchdog.unref?.()
      }
      try {
        bump()
        for (;;) {
          assertLive()
          const result = await raceAbort(iterator.next(), signal, () => this.abortError())
          if (result.done === true) break
          const event = result.value
          assertLive()
          sawFirstEvent = true
          bump()
          if (event.type === 'delta') {
            // Thinking deltas are logged for UI fidelity but never join the
            // assembled assistant message — the model's answer is content only.
            if (event.thinking !== true) full += event.delta
            this.session.append({
              type: 'assistant/chunk',
              stepId,
              delta: event.delta,
              ...(event.thinking === true ? { thinking: true } : {}),
            })
          } else if (event.type === 'toolCalls') {
            calls = event.calls
          }
          // `usage` events are accounting for observers (the host taps them
          // on `llm/stream`); they carry nothing the loop acts on.
        }
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog)
        // Not awaited: a provider parked on an unresolvable await would hang
        // its generator's return() too, and the loop must stay free.
        void iterator.return?.().catch(() => {})
      }
    } finally {
      this.activity = null
    }
    // Canonical identity in the durable log: legacy lowercase names from a
    // model normalize once, here, so permission rules and results match.
    calls = calls.map((call) => canonicalCall(call))
    const provider = (request as { providerName?: string }).providerName ?? safeProviderName(this.ctx)
    this.session.append({
      type: 'assistant/message',
      stepId,
      content: full,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      ...(request.model !== undefined || provider !== undefined
        ? { controls: { ...(request.model !== undefined ? { model: request.model } : {}), ...(provider !== undefined ? { provider } : {}) } }
        : {}),
    })

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]
      if (call === undefined) continue
      const executionId = newExecutionId()
      // Stop between batch calls: the rest never started, and the log says
      // exactly that instead of leaving declared calls unanswered.
      if (signal?.aborted === true) {
        for (let j = i; j < calls.length; j++) {
          const skipped = calls[j]
          if (skipped === undefined) continue
          const skippedExecutionId = newExecutionId()
          this.session.append({ type: 'tool/call', stepId, executionId: skippedExecutionId, call: skipped })
          this.session.append({
            type: 'tool/result',
            stepId,
            executionId: skippedExecutionId,
            callId: skipped.id,
            ok: false,
            output: 'cancelled: stop requested before this call started',
          })
        }
        await this.flushOrHalt()
        throw new StopRequested()
      }
      // Prepare every gate FIRST: hooks may rewrite args and approvals bind
      // to those exact final args. Only then record the durable intent; the
      // returned execute() is the side-effect boundary.
      const prepared = tools?.prepare !== undefined
        ? await tools.prepare(call, { ...(signal !== undefined ? { signal } : {}), executionId })
        : {
            call,
            execute: async () => tools !== undefined
              ? tools.execute(call, signal !== undefined ? { signal } : {})
              : { ok: false, output: `unknown tool '${call.name}' (no tools service mounted)` },
          }
      const revision = revisionOf(tools)
      this.session.append({
        type: 'tool/call',
        stepId,
        executionId,
        call: prepared.call,
        ...(revision !== undefined ? { policyRevision: revision } : {}),
      })
      // Durable FINAL intent before side effects.
      await this.flushOrHalt()
      this.activity = 'tool'
      let result: ToolResult
      try {
        result = await prepared.execute()
      } finally {
        this.activity = null
      }
      this.session.append({
        type: 'tool/result',
        stepId,
        executionId,
        callId: prepared.call.id,
        ok: result.ok,
        output: result.output,
        ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
        ...(result.invocationId !== undefined ? { invocationId: result.invocationId } : {}),
      })
      await this.flushOrHalt()
    }

    this.session.append({ type: 'step/end', turnId, stepId })
    await this.flushOrHalt()
    return { stepId, toolCalls: calls }
  }

  /** Flush the durability barrier; a storage failure halts the run. */
  private async flushOrHalt(): Promise<void> {
    try {
      await this.session.durable()
    } catch (cause) {
      throw new StorageFailed(cause)
    }
  }

  /** The abort error matching the recorded cause. */
  private abortError(): Error {
    return this.abortCause === 'stop' ? new StopRequested() : new Error(`agent: ${this.abortCause}`)
  }

  private limits(): HarnessLimits {
    const shared = (this.ctx.get('limits') ?? {}) as Partial<HarnessLimits>
    return resolveLimits(shared)
  }
}

function safeProviderName(ctx: Context): string | undefined {
  try {
    return (ctx.get('llm') as { active?: () => { name: string } } | undefined)?.active?.().name
  } catch {
    return undefined
  }
}

/**
 * Race one iterator step against the abort signal, so a provider that never
 * yields cannot hold the loop past a stop or inactivity abort.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, makeError: () => Error): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted === true) {
      reject(makeError())
      return
    }
    const onAbort = (): void => {
      reject(makeError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
