import type { InputId, StepId, TurnId } from '../../util/brand.ts'
import type { AttachmentRef } from '../attachments/store.ts'

/** One queued input: user messages wake the driver, injected context waits. */
export interface InboxItem {
  readonly kind: 'user' | 'injected'
  readonly content: string
  /** References accepted with the input; the log records them on the turn. */
  readonly attachments?: readonly AttachmentRef[]
  /** Set when the input was durably accepted (`input/queued`) before claiming. */
  readonly inputId?: InputId
}

/** Live agent status. `cancelling` means a stop was requested and the run is unwinding. */
export type AgentStatus = 'idle' | 'running' | 'cancelling'

/**
 * The `agent/pre-step` waterfall decision: enter with the (possibly
 * rewritten) claimed messages, or reject the claim outright. A rejected or
 * first-enter-rewritten-empty claim still closes a durable turn that spent
 * no step, so the log records the attempt.
 */
export type PreStepDecision =
  | {
      readonly kind: 'enter'
      readonly contents: readonly string[]
      /**
       * Host context to log BEFORE the contents as `origin: 'context'` user
       * messages (hook additionalContext): the model reads it, the
       * transcript shows it as context, never as something the user typed.
       */
      readonly context?: readonly string[]
    }
  | { readonly kind: 'reject'; readonly reason?: string }

declare module 'dnt-harness' {
  interface Events {
    /**
     * Around-middleware deciding what one step admits: listeners rewrite the
     * claimed messages by forwarding a replacement through `next()`, or veto
     * by returning `{ kind: 'reject' }` without calling it.
     */
    'agent/pre-step'(
      /** `signal` fires when the turn is stopped; long listeners (hooks) honor it. */
      claim: { readonly contents: readonly string[]; readonly signal?: AbortSignal },
      next: (replacement?: { readonly contents: readonly string[]; readonly context?: readonly string[] }) => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>

    /**
     * Around-middleware over the log-projected request BEFORE
     * `agent/request`: the mode-driven context builder hooks here and
     * replaces messages/tools wholesale (single assembly path). The default
     * passes the projection through unchanged.
     */
    'agent/context'(
      request: import('../llm/types.ts').ModelRequest,
      next: (replacement?: import('../llm/types.ts').ModelRequest) => Promise<import('../llm/types.ts').ModelRequest>,
    ): Promise<import('../llm/types.ts').ModelRequest>

    /**
     * Around-middleware over the model request assembled from the log:
     * listeners may replace the request downstream (e.g. prepend a system
     * message) or short-circuit. The default returns the log-projected
     * request unchanged.
     */
    'agent/request'(
      request: import('../llm/types.ts').ModelRequest,
      next: (replacement?: import('../llm/types.ts').ModelRequest) => Promise<import('../llm/types.ts').ModelRequest>,
    ): Promise<import('../llm/types.ts').ModelRequest>

    /**
     * Serial listeners run once a turn's work has settled, before `turn/end`
     * is appended. Listeners observe; continuation decisions (a tool owing
     * another request) arrive with the tool pipeline.
     */
    'agent/turn-stopping'(state: { readonly turnId: TurnId; readonly lastStep: StepId | null }): Promise<void>

    /**
     * Serial, asked when the model has stopped calling tools and the turn is
     * about to close. A listener that knows of work still owed to the model
     * (delegated children still running) waits for it and returns a message
     * carrying the outcome; the turn then spends one more step on it instead of
     * closing over — and cancelling — that work. Resolves to nothing when
     * nothing is owed. The signal fires when the user stops the run.
     */
    'agent/turn-continuation'(state: { readonly turnId: TurnId; readonly signal?: AbortSignal }): Promise<string | undefined>

    /**
     * Fired after EVERY turn terminalization (completed, rejected, empty,
     * cancelled, limit, failed) once its durable record is in. Host-level
     * per-Turn resources — the writer lease above all — release here, so a
     * cancelled or failed turn cannot hold a project folder forever.
     */
    'agent/turn-settled'(state: { readonly turnId: TurnId; readonly reason: string }): Promise<void>
  }
}
