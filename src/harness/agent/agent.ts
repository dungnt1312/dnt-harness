import type { Context } from '../../kernel/index.ts'
import { newExecutionId, newStepId, newTurnId, type ExecutionId, type InputId, type StepId, type TurnId } from '../../util/brand.ts'
import { resolveLimits, type HarnessLimits } from '../limits.ts'
import { MAX_SQUEEZE_LEVEL } from '../context/budget.ts'
import type { AttachmentRef } from '../attachments/store.ts'
import { ProviderError, type ModelRequest, type ToolCall, type ToolSchema } from '../llm/types.ts'
import { canonicalCall } from '../tools/names.ts'
import { LogicalRequest } from '../llm/request-lifecycle.ts'
import { encodedBytes, protocolError, validateCompletion, validateToolBatch, WIRE_LIMITS } from '../llm/completion.ts'
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
  private currentStatus: AgentStatus = 'idle'

  /** Reconcile only verified transport cleanup after the driver has exited. */
  get status(): AgentStatus {
    if (this.currentStatus === 'cancelling' && this.abortController === null
      && !this.ctx.llm.sessionUncertain(this.session.id)) {
      this.currentStatus = 'idle'
    }
    return this.currentStatus
  }

  set status(value: AgentStatus) { this.currentStatus = value }
  /** What the driver is currently busy with (transient, for status UIs). */
  activity: 'model' | 'tool' | null = null

  private inbox: InboxItem[] = []
  /** Accepted inputs removed from the inbox but not yet durably settled. */
  private readonly claimedInputIds = new Set<InputId>()
  private abortController: AbortController | null = null
  /**
   * Set by {@link steer}: the in-flight run stops like a user stop, but the
   * inbox runs right after instead of staying queued. Consumed when the
   * stopped run settles.
   */
  private steerRequested = false

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

  private admissionClosed = false
  closeAdmission(): void { this.admissionClosed = true; this.stop() }

  /** Shutdown escalation: prohibit late canonical writes and drain their queued prefix. */
  async fencePersistence(): Promise<void> {
    this.session.close()
    await this.session.drain()
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
    if (this.claimedInputIds.has(item.inputId)) return
    if (this.inbox.some((existing) => existing.kind === 'user' && existing.inputId === item.inputId)) return
    this.inbox.push({
      kind: 'user',
      content: item.content,
      inputId: item.inputId,
      ...(item.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
    })
  }

  /**
   * Adopt every durably pending input, in log (acceptance) order. Accepted
   * inputs already waiting in the inbox are re-ordered to match the log, so
   * one that a failed turn handed back cannot end up behind newer input.
   * Injected context and claimed inputs are untouched.
   */
  adoptPending(pending: readonly { content: string; inputId: InputId; attachments?: readonly AttachmentRef[] }[]): void {
    const pendingIds = new Set(pending.map((item) => item.inputId))
    // Accepted inputs the log no longer lists as pending stay where they are.
    const kept = this.inbox.filter((item) => item.kind !== 'user' || item.inputId === undefined || !pendingIds.has(item.inputId))
    this.inbox = kept
    for (const item of pending) this.enqueueAccepted(item)
  }

  /** Whether a running turn has claimed this input (pre-step or later): it is no longer waiting. */
  isClaimed(inputId: InputId): boolean {
    return this.claimedInputIds.has(inputId)
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
    // The latest intent wins: a Stop after a Steer cancels the steer, so the
    // queue stays queued exactly as a plain Stop promises.
    this.steerRequested = false
    this.abortRun()
  }

  /**
   * Steer: stop the in-flight turn, then run the queued input in one new
   * turn, oldest first. The interrupted turn closes as `steered`; steering a
   * stop already in progress upgrades it. A no-op while idle — the caller
   * starts the run itself. Not durable: after a restart the input is plain
   * pending input again and never auto-runs.
   */
  steer(): void {
    if (this.status === 'idle') return
    this.steerRequested = true
    this.abortRun()
  }

  /** The shared abort of stop and steer. */
  private abortRun(): void {
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
    if (this.admissionClosed) return
    if (this.ctx.llm.sessionUncertain(this.session.id)) { this.status = 'cancelling'; return }
    if (this.status === 'cancelling' && this.abortController === null) this.status = 'idle'
    if (this.status !== 'idle') return
    this.status = 'running'
    this.abortController = new AbortController()
    let stopped = false
    let steered = false
    try {
      // The scope lets pipeline listeners (approval routing, tool grants,
      // workspace-scoped controls) attribute work to this agent's session
      // and workspace while the turn is in flight.
      await agentScope.run(this.identity, async () => {
        // Only a user message opens a turn; injected context waits in the
        // inbox until one arrives and is claimed alongside it. A stop ends
        // the run: queued input must not auto-advance.
        while (!stopped && this.inbox.some((item) => item.kind === 'user')) {
          // A stop or steer that lands between turns must not open another
          // one on the aborted controller: that turn would log the input and
          // cancel it unanswered. Leave it queued; a steer re-runs below.
          if (this.abortController?.signal.aborted === true) {
            stopped = true
            break
          }
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
      // A stop that raced a turn finishing on its own still counts as a stop:
      // input queued meanwhile stays queued (only a steer runs it).
      if (this.abortController?.signal.aborted === true) stopped = true
      // Consumed exactly once per run, even when the run throws.
      steered = this.steerRequested
      this.steerRequested = false
      this.status = this.ctx.llm.sessionUncertain(this.session.id) ? 'cancelling' : 'idle'
      this.activity = null
      this.abortController = null
    }
    // Input enqueued in the microtask gap between the loop's final check and
    // `status = 'idle'` would strand: its enqueuer saw `busy`, the loop had
    // already exited, and nobody calls run() again. This synchronous recheck
    // (same tick as the idle flip) drains it; a stopped run still does not —
    // unless the stop was a steer, whose whole point is to run the queue now.
    // A poisoned session cannot record a new turn, so a steer cannot either.
    if ((!stopped || (steered && !this.session.poisoned)) && this.inbox.some((item) => item.kind === 'user')) {
      await this.run()
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
   * One turn. Claims the whole pending inbox (this harness keeps claim simple
   * rather than bounded), asks `agent/pre-step` to admit it, then spends
   * steps while tools keep owing the model their results. Returns the terminal
   * reason so `run()` knows which outcomes end the run (a stop leaves queued
   * input queued).
   */
  private async turn(): Promise<'completed' | 'cancelled' | 'steered' | 'failed' | 'rejected' | 'empty'> {
    const turnId = newTurnId()
    return agentScope.run({ ...this.identity, turnId }, async () => {
      this.session.append({ type: 'turn/start', turnId })
      const controller = this.abortController
      // A function, not a flag: stop can land at any await, and a plain property
      // check would be narrowed by the first one.
      const stopRequested = (): boolean => controller?.signal.aborted === true
      const claimed = this.inbox.splice(0, this.inbox.length)
      try {
      for (const item of claimed) {
        if (item.kind === 'user' && item.inputId !== undefined) this.claimedInputIds.add(item.inputId)
      }
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

      // A stop or steer that landed while pre-step ran (hooks, MCP connect):
      // nothing has reached the model or the log as admitted yet. Hand the
      // claimed input back, oldest first, instead of logging it and then
      // cancelling it unanswered — a steer re-runs it, a stop leaves it queued.
      if (stopRequested()) {
        this.inbox.unshift(...claimed)
        const reason = this.stopReason()
        await this.recordTurnEnd(turnId, reason)
        return reason
      }

      if (decision.kind === 'reject') {
        this.settleClaimedInputs(claimed, 'rejected')
        this.session.append({ type: 'turn/error', turnId, kind: 'rejected', message: decision.reason ?? 'rejected by pre-step policy' })
        await this.recordTurnEnd(turnId, 'rejected')
        return 'rejected'
      }
      if (decision.contents.length === 0) {
        this.settleClaimedInputs(claimed, 'empty')
        await this.recordTurnEnd(turnId, 'empty')
        return 'empty'
      }

      let lastStep: StepId | null = null
      let nextContents: readonly string[] | undefined = decision.contents
      let nextClaimed: readonly InboxItem[] = claimed
      let nextOrigin: 'continuation' | undefined
      // A turn keeps spending steps while tools owe the model their results —
      // and while delegated work it left running still owes it a report.
      for (;;) {
        let step: { stepId: StepId; toolCalls: readonly ToolCall[] }
        try {
          step = await this.step(turnId, nextContents, nextClaimed, nextOrigin)
        } catch (error) {
          // A user stop is a durable result, not a failure: close the turn
          // with the `cancelled` (or `steered`) reason and end the run.
          if (error instanceof StopRequested) {
            await this.closeOpenStep(turnId)
            const reason = this.stopReason()
            await this.recordTurnEnd(turnId, reason)
            return reason
          }
          throw error
        }
        lastStep = step.stepId
        nextContents = undefined
        nextClaimed = []
        nextOrigin = undefined
        if (step.toolCalls.length > 0) continue
        // The model is done asking. Work it delegated and left running would be
        // cancelled by closing the turn, and everything the children did lost:
        // the host joins them and hands the reports back for one more step.
        // The reports ride a user message (the model answers to user content)
        // marked `origin: 'continuation'` so no projection reads them as
        // something the user typed.
        const continuation = await this.ctx
          .serial('agent/turn-continuation', { turnId, ...(controller?.signal !== undefined ? { signal: controller.signal } : {}) })
          .catch(() => undefined)
        if (typeof continuation !== 'string' || continuation === '' || stopRequested()) break
        nextContents = [continuation]
        nextOrigin = 'continuation'
      }

      await this.ctx.serial('agent/turn-stopping', { turnId, lastStep })
      if (stopRequested()) {
        const reason = this.stopReason()
        await this.recordTurnEnd(turnId, reason)
        return reason
      }
      await this.recordTurnEnd(turnId, 'completed')
      return 'completed'
    } catch (error) {
      // Classified failures append the durable reason before closing. A
      // poisoned session records nothing further — the throw is the truth.
      if (!this.session.poisoned) {
        const { kind, message, reason } = error instanceof StorageFailed
          ? { kind: 'storage' as const, message: error.message, reason: 'failed' as const }
          : error instanceof ProviderError
            ? { kind: 'provider' as const, message: error.message, reason: 'failed' as const }
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
      } finally {
        for (const item of claimed) {
          if (item.kind === 'user' && item.inputId !== undefined) this.claimedInputIds.delete(item.inputId)
        }
      }
    })
  }

  /** Close the newest open step when cancellation interrupts it. */
  private async closeOpenStep(turnId: TurnId): Promise<void> {
    for (let i = this.session.events.length - 1; i >= 0; i--) {
      const event = this.session.events[i]
      if (event?.type === 'step/end') return
      if (event?.type === 'step/start' && event.turnId === turnId) {
        this.session.append({ type: 'step/end', turnId, stepId: event.stepId })
        await this.flushOrHalt()
        return
      }
      if (event?.type === 'turn/start' && event.turnId === turnId) return
    }
  }

  /** Mark accepted inputs terminal even when policy admits no user message. */
  private settleClaimedInputs(claimed: readonly InboxItem[], outcome: 'rejected' | 'empty'): void {
    for (const item of claimed) {
      if (item.kind === 'user' && item.inputId !== undefined) {
        this.session.append({ type: 'input/settled', inputId: item.inputId, outcome })
      }
    }
  }

  /** Append and durably flush a turn end, then release per-Turn holders. */
  private async recordTurnEnd(turnId: TurnId, reason: 'completed' | 'rejected' | 'empty' | 'cancelled' | 'steered' | 'failed'): Promise<void> {
    this.session.append({ type: 'turn/end', turnId, reason })
    try {
      await this.session.durable()
    } catch (cause) {
      throw new StorageFailed(cause)
    }
    // Terminalization is durable: per-Turn resources (writer leases) go.
    // Observer failures are contained by parallel dispatch and can never
    // rewrite an already-durable terminal outcome.
    await this.ctx.parallel('agent/turn-settled', { turnId, reason }).catch(() => {})
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
  private async step(turnId: TurnId, contents: readonly string[] | undefined, claimed: readonly InboxItem[], origin?: 'continuation'): Promise<{ stepId: StepId; toolCalls: readonly ToolCall[] }> {
    const signal = this.abortController?.signal
    const assertLive = (): void => {
      if (signal?.aborted === true) throw this.abortError()
    }

    let stepId = newStepId()
    this.session.append({ type: 'step/start', turnId, stepId })
    const metadataByContentIndex = matchClaimedContents(contents ?? [], claimed)
    for (let index = 0; index < (contents?.length ?? 0); index++) {
      const content = contents?.[index] ?? ''
      // Middleware may insert/reorder content. Metadata follows only the exact
      // original item it belongs to; inserted context never steals an input id
      // or attachment merely because it occupies the same array position.
      const item = metadataByContentIndex.get(index)
      this.session.append({
        type: 'user/message',
        turnId,
        content,
        ...(item?.inputId !== undefined ? { inputId: item.inputId } : {}),
        ...(item?.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
        ...(origin !== undefined ? { origin } : {}),
      })
    }
    // Admission settles every accepted input even when middleware replaces its
    // text wholesale and therefore no user/message can safely carry its id.
    for (const item of claimed) {
      if (item.kind === 'user' && item.inputId !== undefined) {
        this.session.append({ type: 'input/settled', inputId: item.inputId, outcome: 'admitted' })
      }
    }
    // Durable input: acknowledged before anything asks the model for more.
    await this.flushOrHalt()

    // The tools service is optional: without it the loop still runs, and
    // tool calls fail as unknown tools.
    const tools = this.ctx.get('tools') as ToolRuntime | undefined

    // One model request. Every attempt assembles its request afresh from the log
    // (the context builder is where size is decided) and streams under its OWN
    // abort controller: a stalled stream aborts that attempt, not the whole run,
    // so it can be asked again. A run of dozens of requests — a subagent — would
    // otherwise die on the first gateway hiccup, and a provider that rejects the
    // request as too large would be sent the identical request forever.
    let full = ''
    let calls: readonly ToolCall[] = []
    let request: ModelRequest = { messages: [] }
    let squeeze = 0
    // A discarded attempt's chunks never became an assistant/message, so no
    // tool ran under this step id yet; the first mid-stream failure may still
    // be retried by abandoning the step wholesale and re-asking under a fresh
    // id. Only once per step: after the re-ask, a second failure is final.
    let discardBudget = 1
    const owner = new LogicalRequest({ firstProgressMs: this.limits().streamFirstEventMs, idleMs: this.limits().streamIdleMs, totalMs: this.limits().logicalRequestMs, retryBaseMs: this.limits().stepRetryBaseMs, maxAttempts: Math.min(4, this.limits().stepRetries + 1) })
    const cancelOwner = (): void => owner.cancel()
    signal?.addEventListener('abort', cancelOwner, { once: true })
    if (signal?.aborted) owner.cancel()
    try {
    for (;;) {
      owner.assertLive()
      assertLive()
      const schemas = tools?.schemas() ?? []
      const projected: ModelRequest = {
        assemblySignal: owner.signal,
        messages: this.session.deriveMessages(),
        ...(tools !== undefined && schemas.length > 0 ? { tools: schemas } : {}),
        ...(squeeze > 0 ? { squeeze } : {}),
      }
      // The mode-driven context builder replaces the assembly wholesale (G3:
      // there is exactly one assembly path). Everything downstream — controls
      // stamping, providers — sees the builder's output.
      const assembled = await owner.wait(this.ctx.waterfall(
        'agent/context',
        projected,
        (replacement) => { owner.assertLive(); assertLive(); return Promise.resolve(replacement ?? projected) },
      ))
      owner.assertLive(); assertLive()
      request = await owner.wait(this.ctx.waterfall(
        'agent/request',
        { ...assembled, assemblySignal: owner.signal },
        (replacement) => { owner.assertLive(); assertLive(); return Promise.resolve(replacement ?? assembled) },
      ))
      owner.assertLive(); assertLive()
      full = ''
      calls = []

      const attemptController = new AbortController()
      const relayStop = (): void => attemptController.abort()
      if (signal?.aborted === true) attemptController.abort()
      else signal?.addEventListener('abort', relayStop, { once: true })
      const attemptSignal = attemptController.signal
      let emitted = false
      let completed = false
      let outputBytes = 0
      this.activity = 'model'
      try {
        const stream = this.ctx.llm.stream(request, {
          signal: attemptSignal, requestOwner: owner,
          attribution: { sessionId: this.session.id, turnId, stepId },
          recordAttempt: async fact => {
            this.session.append({ type: fact.state === 'uncertain' ? 'execution/uncertain' : fact.state === 'reconciled' ? 'execution/reconciled' : 'model/attempt', fact })
            await this.flushOrHalt()
          },
        })
        // The abort check runs between stream events, and the iteration itself
        // races the abort signal: a provider that never yields (no data, hung
        // socket) is still stopped by the watchdog instead of blocking forever.
        const iterator = stream[Symbol.asyncIterator]()
        // Physical admission owns progress/idle timers and transport settlement.
        try {
          for (;;) {
            assertLive()
            const result = await iterator.next()
            if (result.done === true) break
            const event = result.value
            assertLive()
            if (completed) throw protocolError('malformed_protocol', 'provider emitted events after completion')
            if (event.type === 'completion') {
              validateCompletion(event)
              validateToolBatch(calls)
              completed = true
              if (calls.length > 0) emitted = true
              continue
            }
            // Accounting alone is not model progress. Tool argument fragments
            // are progress, but never become transcript entries or executable calls.
            if (event.type === 'delta') {
              if (event.delta === '') continue
              outputBytes += encodedBytes(event.delta)
              if (outputBytes > WIRE_LIMITS.outputBytes) throw protocolError('output_limit', 'provider output exceeds limit')
              // Thinking deltas are logged for UI fidelity but never join the
              // assembled assistant message — the model's answer is content only.
              if (event.thinking !== true) full += event.delta
              emitted = true
              this.session.append({
                type: 'assistant/chunk',
                stepId,
                delta: event.delta,
                ...(event.thinking === true ? { thinking: true } : {}),
              })
            } else if (event.type === 'toolCalls') {
              if (calls.length > 0) throw protocolError('invalid_tool_input', 'multiple tool batches')
              validateToolBatch(event.calls)
              if (event.calls.length > 0) emitted = true
              for (const call of event.calls) {
                outputBytes += encodedBytes(call.id) + encodedBytes(call.name) + encodedBytes(JSON.stringify(call.args))
              }
              if (outputBytes > WIRE_LIMITS.outputBytes) throw protocolError('output_limit', 'provider output exceeds limit')
              calls = event.calls
            }
            // `usage` events are accounting for observers (the host taps them
            // on `llm/stream`); they carry nothing the loop acts on.
          }
        } finally {
          // Not awaited: a provider parked on an unresolvable await would hang
          // its generator's return() too, and the loop must stay free.
          void iterator.return?.().catch(() => {})
        }
        // A stop racing with normal stream completion still owns the terminal
        // outcome and must not allow tool preparation to begin.
        assertLive()
        if (!completed) throw protocolError('incomplete_completion', 'provider iterable ended without explicit completion')
        if (full === '' && calls.length === 0) {
          throw new ProviderError('provider returned an empty response', { transient: !emitted })
        }
      } catch (caught) {
        // The attempt's own abort (a stall) reads as a provider failure; the
        // user's stop never does.
        const stopped = signal?.aborted === true
        if (stopped) throw this.abortError()
        const error = caught
        // A mid-stream failure with output already in the log used to end the
        // turn: re-asking would duplicate the streamed text. It is safe to ask
        // again anyway — the chunks never joined model history (only
        // assistant/message does) and no tool ran under this step id — so the
        // step is abandoned as consumed and a fresh one re-asks wholesale.
        // One discard per step keeps the spent transcript bounded.
        if (emitted && discardBudget > 0 && error instanceof ProviderError && error.transient && contents !== undefined) {
          discardBudget -= 1
          this.session.append({ type: 'step/abandoned', turnId, stepId, reason: error.message.slice(0, 200) })
          await this.flushOrHalt()
          stepId = newStepId()
          this.session.append({ type: 'step/start', turnId, stepId })
          // The same gateway just failed; wait like any retry would before
          // spending the fresh step, so a dead upstream gets its backoff.
          try { await owner.backoff(signal, error.retryAfterMs) } catch (error) { assertLive(); throw error }
          continue
        }
        // Only a request that produced nothing may be asked again: once a chunk
        // reached the log, a second attempt would duplicate it.
        if (!(error instanceof ProviderError) || stopped || !owner.canRetry(error, emitted)) throw error
        if (error.contextExceeded && squeeze < MAX_SQUEEZE_LEVEL) {
          squeeze += 1
          continue
        }
        if (!error.transient) throw error
        try { await owner.backoff(signal, error.retryAfterMs) } catch (error) { assertLive(); throw error }
        continue
      } finally {
        signal?.removeEventListener('abort', relayStop)
        this.activity = null
      }
      break
    }
    } catch (error) { assertLive(); throw error }
    finally { signal?.removeEventListener('abort', cancelOwner); owner.dispose() }
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
      let prepared: { call: ToolCall; execute(): Promise<ToolResult> }
      try {
        prepared = tools?.prepare !== undefined
          ? await tools.prepare(call, { ...(signal !== undefined ? { signal } : {}), executionId })
          : {
              call,
              execute: async () => tools !== undefined
                ? tools.execute(call, signal !== undefined ? { signal } : {})
                : { ok: false, output: `unknown tool '${call.name}' (no tools service mounted)` },
            }
      } catch (error) {
        this.session.append({ type: 'tool/call', stepId, executionId, call })
        this.session.append({
          type: 'tool/result',
          stepId,
          executionId,
          callId: call.id,
          ok: false,
          output: `error: tool preparation failed: ${String(error instanceof Error ? error.message : error)}`,
        })
        await this.flushOrHalt()
        continue
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
      } catch (error) {
        result = { ok: false, output: `error: tool pipeline failed: ${String(error instanceof Error ? error.message : error)}` }
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

  /** The truthful close of a user-aborted turn: a steer, or a plain stop. */
  private stopReason(): 'cancelled' | 'steered' {
    return this.steerRequested ? 'steered' : 'cancelled'
  }

  /** The error a stopped step unwinds with. */
  private abortError(): Error {
    return new StopRequested()
  }

  private limits(): HarnessLimits {
    const shared = (this.ctx.get('limits') ?? {}) as Partial<HarnessLimits>
    return resolveLimits(shared)
  }
}

/**
 * Match original inbox items to rewritten contents without letting an inserted
 * duplicate steal metadata. Unique content can move freely; duplicate content
 * is matched from the end, preserving the common prepend/append rewrite case.
 */
function matchClaimedContents(contents: readonly string[], claimed: readonly InboxItem[]): Map<number, InboxItem> {
  const matched = new Map<number, InboxItem>()
  const used = new Set<number>()
  for (let claimedIndex = claimed.length - 1; claimedIndex >= 0; claimedIndex--) {
    const item = claimed[claimedIndex]
    if (item === undefined) continue
    for (let contentIndex = contents.length - 1; contentIndex >= 0; contentIndex--) {
      if (used.has(contentIndex) || contents[contentIndex] !== item.content) continue
      used.add(contentIndex)
      matched.set(contentIndex, item)
      break
    }
  }
  return matched
}

/** Longest pause between two attempts of one transiently failing model request. */
const MAX_STEP_RETRY_DELAY_MS = 30_000

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
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
