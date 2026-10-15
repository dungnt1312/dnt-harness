import { estimateContentTokens, estimateTokens, schemaCost } from '../harness/context/budget.ts'
import { MAX_COMPACTION_SUMMARY_CHARS } from '../harness/context/compaction.ts'
import type { EffectiveCompactionSnapshot, SnapshotIdentity } from '../harness/context/compaction-snapshot.ts'
import { validateCompletion } from '../harness/llm/completion.ts'
import { DRAFT_TOO_LONG, MAX_DRAFT_CHARS, condenseDraft } from './compaction-condense.ts'
import type { ModelMessage, ModelRequest, StreamEvent, StreamOptions, TokenUsage } from '../harness/llm/types.ts'

/**
 * Structured compaction summary: the snapshot's exact request prefix, the
 * final answer, and ONE appended instruction. A single settled stop with
 * bounded text is the only success. There is no fallback to folding the raw
 * transcript here — a failure stays a failure and the caller decides.
 */

/** Marks the appended instruction so hosts and tests can tell a summary call from a turn. */
export const COMPACTION_HANDOFF_MARKER = '[compaction-handoff]'

const HANDOFF_INSTRUCTION = [
  COMPACTION_HANDOFF_MARKER,
  'Stop the task and write a handoff summary of everything above. This summary REPLACES the covered conversation in a fresh context window. Do not call any tools: respond with text only.',
  '',
  'Write for yourself, resuming without the user reviewing this. Keep, in this priority:',
  '1. The user\'s intent, constraints and permission scope — restrictions they set, quoted exactly. Their words are only what they typed, not tool results or system text.',
  '2. Decisions made, approaches tried or ruled out, and why.',
  '3. Current work: files and identifiers, uncommitted state, the latest verified outcomes and unresolved errors. Do not state as done what was only claimed.',
  '4. Pending tasks and the next step, tied to the user\'s most recent request in their words. Omit a next step if the last task was concluded.',
  '5. Details that would be hard to reconstruct, kept exactly: names, numbers, paths, commands, identifiers.',
  '',
  'Detail you can fetch again needs only a pointer to it (a path, a command, a name). Be dense, no filler, in the language of the conversation.',
  `Keep the summary within ${MAX_COMPACTION_SUMMARY_CHARS} characters. Output only the summary text.`,
].join('\n')

export type SummaryPath = 'exact' | 'reconstructed'

/** A summary computed from a snapshot, not yet adopted: it is not a checkpoint. */
export interface PreparedSummary {
  readonly snapshotId: string
  readonly cutoff: number
  readonly summary: string
  readonly sourceDigest: string
  readonly identity: SnapshotIdentity
  readonly seedHash?: string
  readonly generationMs: number
  readonly path: SummaryPath
  /** Usage of the attempt that produced the summary, when the provider reported it. */
  readonly usage?: TokenUsage
}

export interface GenerateOptions {
  readonly stream: (request: ModelRequest, options?: StreamOptions) => AsyncIterable<StreamEvent>
  /** Parent cancellation (Stop, delete, shutdown). */
  readonly signal: AbortSignal
  /** One wall-clock deadline for the WHOLE operation, re-ask included. */
  readonly deadlineAt: number
  readonly maxOutputTokens: number
  /** Called once per attempt with the usage the provider actually reported. */
  readonly recordUsage: (usage: TokenUsage) => void
  readonly path: SummaryPath
}

function requestFor(snapshot: EffectiveCompactionSnapshot, instruction: string, maxOutputTokens: number): ModelRequest {
  const messages: ModelMessage[] = [...snapshot.request.messages, snapshot.finalAnswer, { role: 'user', content: instruction }]
  return {
    ...(snapshot.request.model !== undefined ? { model: snapshot.request.model } : {}),
    ...(snapshot.request.providerName !== undefined ? { providerName: snapshot.request.providerName } : {}),
    ...(snapshot.request.thinkingLevel !== undefined ? { thinkingLevel: snapshot.request.thinkingLevel } : {}),
    messages,
    ...(snapshot.request.tools !== undefined ? { tools: snapshot.request.tools } : {}),
    maxOutputTokens,
  }
}

interface Attempt {
  /** Trimmed answer text; empty when the model was cut off by its output limit. */
  readonly text: string
  readonly finish: 'stop' | 'length'
  readonly usage?: TokenUsage
}

/**
 * One attempt: exactly one settled completion, no tools, text up to `cap`
 * (beyond it the attempt throws `overflow`). A `length` finish is returned, not
 * thrown, when `allowLength`. Reported usage is recorded even on failure.
 */
async function runAttempt(stream: GenerateOptions['stream'], request: ModelRequest, signal: AbortSignal, record: (usage: TokenUsage) => void, cap: number, overflow: string, allowLength: boolean): Promise<Attempt> {
  let text = ''
  let finish: 'stop' | 'length' = 'stop'
  let completions = 0
  let usage: TokenUsage | undefined
  try {
    for await (const event of stream(request, { signal })) {
      signal.throwIfAborted()
      if (completions > 0 && event.type !== 'usage') throw new Error('compaction output after completion')
      if (event.type === 'usage') {
        usage = event.usage
      } else if (event.type === 'completion') {
        completions++
        if (completions > 1) throw new Error('compaction duplicate completion')
        validateCompletion(event, { allowLength })
        if (event.finishReason === 'length' && allowLength) finish = 'length'
        else if (event.finishReason !== 'stop') throw new Error('compaction requires stop completion')
      } else if (event.type === 'toolCalls' || event.type === 'toolCallProgress') {
        throw new Error('compaction tool output rejected')
      } else if (event.type === 'delta' && event.thinking !== true) {
        if (text.length + event.delta.length > cap) throw new Error(overflow)
        text += event.delta
      }
    }
    signal.throwIfAborted()
    if (completions !== 1) throw new Error('compaction missing completion')
  } finally {
    if (usage !== undefined) record(usage)
  }
  if (finish === 'length') return { text: '', finish, ...(usage !== undefined ? { usage } : {}) }
  if (text.trim() === '') throw new Error('compaction summarizer returned an empty summary')
  return { text: text.trim(), finish, ...(usage !== undefined ? { usage } : {}) }
}

export async function generateCompaction(snapshot: EffectiveCompactionSnapshot, options: GenerateOptions): Promise<PreparedSummary> {
  const startedAt = Date.now()
  const remaining = options.deadlineAt - startedAt
  if (remaining <= 0) throw new Error('compaction deadline already passed')
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('compaction deadline exceeded')), remaining)
  const signal = AbortSignal.any([options.signal, deadline.signal])
  try {
    // A complete draft up to MAX_DRAFT_CHARS is accepted; a longer one is condensed below.
    let attempt = await runAttempt(options.stream, requestFor(snapshot, HANDOFF_INSTRUCTION, options.maxOutputTokens), signal, options.recordUsage, MAX_DRAFT_CHARS, DRAFT_TOO_LONG, true)
    if (attempt.finish === 'length') {
      // One re-ask, same prefix, explicit hard limit. A second cut-off is final.
      const retryInstruction = `${HANDOFF_INSTRUCTION}\n\nHARD CONSTRAINT: your previous answer was cut off by the output limit. Rewrite it in at most ${MAX_COMPACTION_SUMMARY_CHARS} characters. Drop detail in this order: completed work older than the earliest still-relevant item, then verbose command-output descriptions. Never drop the user's constraints, the current task, latest verified outcomes, or pending work.`
      // Read like the first draft: a complete answer over 24 000 is condensed below, not refused.
      attempt = await runAttempt(options.stream, requestFor(snapshot, retryInstruction, options.maxOutputTokens), signal, options.recordUsage, MAX_DRAFT_CHARS, DRAFT_TOO_LONG, false)
    }
    const { request } = snapshot
    const summary = attempt.text.length <= MAX_COMPACTION_SUMMARY_CHARS
      ? attempt.text
      : await condenseDraft(attempt.text, {
        stream: options.stream,
        pair: request.providerName !== undefined && request.model !== undefined ? { providerName: request.providerName, model: request.model } : undefined,
        signal,
        recordUsage: options.recordUsage,
      })
    return {
      snapshotId: snapshot.id,
      cutoff: snapshot.cutoff,
      summary,
      sourceDigest: snapshot.sourceDigest,
      identity: snapshot.identity,
      ...(snapshot.seedHash !== undefined ? { seedHash: snapshot.seedHash } : {}),
      generationMs: Date.now() - startedAt,
      path: options.path,
      ...(attempt.usage !== undefined ? { usage: attempt.usage } : {}),
    }
  } catch (error) {
    // Report the cause the caller can act on: a deadline reads as a deadline.
    if (deadline.signal.aborted && !options.signal.aborted) throw new Error('compaction deadline exceeded', { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Safety margin on the part of a request no provider has measured. */
const UNMEASURED_MARGIN = 1.2

export interface TokenEstimate {
  readonly tokens: number
  readonly basis: 'reported' | 'estimated'
}

const charsToTokens = (chars: number): number => Math.ceil(chars / 3)

function messageChars(message: ModelMessage): number {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  return content.length + (message.toolCalls !== undefined ? JSON.stringify(message.toolCalls).length : 0)
}

/**
 * Tokens a summary request for this snapshot will send. A provider-reported
 * input size of the snapshot's own request is the baseline (it includes system
 * and tool schemas); only what is added after it — the final answer and the
 * instruction — is estimated, with a 20% margin. Without a report the whole
 * request is estimated conservatively. Always labelled, never a verified count.
 */
export function estimateSnapshotTokens(snapshot: EffectiveCompactionSnapshot, path: SummaryPath = 'exact'): TokenEstimate {
  const added = charsToTokens(messageChars(snapshot.finalAnswer) + HANDOFF_INSTRUCTION.length)
  if (snapshot.inputEvidence !== undefined) {
    return { tokens: snapshot.inputEvidence.inputTokens + Math.ceil(added * UNMEASURED_MARGIN), basis: 'reported' }
  }
  if (path === 'reconstructed') {
    // The context builder just sized this very request with its own estimator and fitted it to
    // the budget; a margin on top would refuse what the builder itself accepted.
    const history = [...snapshot.request.messages, snapshot.finalAnswer]
      .reduce((total, message) => total + estimateContentTokens(message.content) + (message.toolCalls !== undefined ? estimateTokens(JSON.stringify(message.toolCalls)) : 0), 0)
    return { tokens: history + schemaCost(snapshot.request.tools ?? []) + estimateTokens(HANDOFF_INSTRUCTION), basis: 'estimated' }
  }
  const prefix = snapshot.request.messages.reduce((total, message) => total + messageChars(message), 0) + JSON.stringify(snapshot.request.tools ?? []).length
  return { tokens: Math.ceil((charsToTokens(prefix) + added) * UNMEASURED_MARGIN), basis: 'estimated' }
}

/** Refuse a summary request that cannot leave room for its own answer. An unknown window is left to the provider. */
export function assertFitsWindow(snapshot: EffectiveCompactionSnapshot, limits: { readonly contextWindowTokens?: number; readonly outputTokens: number }, path: SummaryPath = 'exact'): void {
  if (limits.contextWindowTokens === undefined) return
  const estimate = estimateSnapshotTokens(snapshot, path)
  if (estimate.tokens + limits.outputTokens > limits.contextWindowTokens) {
    throw new Error(`compaction-input-too-large: ~${estimate.tokens} input tokens (${estimate.basis}) plus ${limits.outputTokens} output exceed the ${limits.contextWindowTokens}-token window`)
  }
}
