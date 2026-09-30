/**
 * Crash-durable MCP execution evidence. This is not an immutable audit log:
 * a person who can write the data home can edit the file. It does survive a
 * process crash between intent and terminal record.
 *
 * The session event log stays a separate authority. Do not read this file
 * through the session validator.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolOutcome } from '../tools/types.ts'

export const JOURNAL_SCHEMA = 1
export const JOURNAL_DIGEST = 'sha256'

export class JournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalError'
  }
}

export interface DispatchIntent {
  readonly kind: 'dispatch_intent'
  readonly invocationId: string
  readonly workspaceId: string
  readonly server: string
  readonly tool: string
  readonly argsHash: string
  readonly generation: number
  readonly epoch: number
  readonly configRevision: number
  readonly secretRevision: number
  readonly policyRevision?: number
}

export interface TerminalRecord {
  readonly kind: 'terminal'
  readonly invocationId: string
  readonly outcome: ToolOutcome
  readonly outputHash: string
  readonly detail: string
}

interface Stored extends Record<string, unknown> {
  readonly v: number
  readonly seq: number
  readonly at: number
  readonly digest: string
}

export class McpExecutionJournal {
  private chain: Promise<void> = Promise.resolve()
  private poisoned: string | undefined
  private seq = 0
  private readonly terminals = new Map<string, { readonly outcome: ToolOutcome; readonly detail: string }>()
  private readonly openIntents = new Set<string>()
  /** Immutable-intent fingerprint per invocation id, open or terminal. */
  private readonly intentKeys = new Map<string, string>()
  /** Ids reserved in this process, including ones whose intent write is still in flight. */
  private readonly reserved = new Set<string>()
  /** Terminal records written by this process; only these still carry their full result. */
  private readonly liveTerminals = new Set<string>()

  constructor(
    private readonly filePath: string,
    private readonly assertOwner: () => Promise<void> = async () => undefined,
  ) {}

  get faulted(): boolean {
    return this.poisoned !== undefined
  }

  /** Load committed lines. A torn final line is dropped. A bad middle line throws. */
  async open(): Promise<{ readonly unresolved: readonly string[] }> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { unresolved: [] }
      throw error
    }
    let torn = false
    if (raw.length > 0 && !raw.endsWith('\n')) {
      const cut = raw.lastIndexOf('\n')
      raw = cut === -1 ? '' : raw.slice(0, cut + 1)
      torn = true
    }
    const lines = raw.split('\n').filter((line) => line !== '')
    let expected = 1
    for (const line of lines) {
      let parsed: Stored
      try {
        parsed = JSON.parse(line) as Stored
      } catch {
        this.poisoned = 'execution journal has a corrupt record before the end of the file'
        throw new JournalError(this.poisoned)
      }
      if (parsed.v !== JOURNAL_SCHEMA || parsed.seq !== expected) {
        this.poisoned = 'execution journal sequence does not match'
        throw new JournalError(this.poisoned)
      }
      if (parsed.digest !== digestOf(parsed)) {
        this.poisoned = 'execution journal digest does not match'
        throw new JournalError(this.poisoned)
      }
      this.seq = parsed.seq
      expected += 1
      this.remember(parsed)
    }
    if (torn) await fs.writeFile(this.filePath, raw)
    return { unresolved: [...this.openIntents] }
  }

  hasTerminal(invocationId: string): { readonly outcome: ToolOutcome; readonly detail: string } | undefined {
    return this.terminals.get(invocationId)
  }

  /** Whether this process wrote the terminal record (so the caller still holds the full result). */
  terminalWrittenHere(invocationId: string): boolean {
    return this.liveTerminals.has(invocationId)
  }

  /**
   * Claim one invocation id for dispatch. Synchronous: the check and the
   * claim happen with no await between them, so two concurrent callers can
   * never both own the same id. `integrity` means the id is already bound to a
   * different immutable intent; `terminal` / `in-flight` mean an identical
   * intent already exists and must not be sent again.
   */
  reserve(intent: Omit<DispatchIntent, 'kind'>): 'owner' | 'in-flight' | 'terminal' | 'integrity' {
    const key = intentKey(intent)
    const known = this.intentKeys.get(intent.invocationId)
    if (known !== undefined && known !== key) return 'integrity'
    if (this.terminals.has(intent.invocationId)) return 'terminal'
    if (this.reserved.has(intent.invocationId) || this.openIntents.has(intent.invocationId)) return 'in-flight'
    this.reserved.add(intent.invocationId)
    this.intentKeys.set(intent.invocationId, key)
    return 'owner'
  }

  async appendIntent(intent: DispatchIntent): Promise<void> {
    const key = intentKey(intent)
    const known = this.intentKeys.get(intent.invocationId)
    if (known !== undefined && known !== key) {
      throw new JournalError(`execution '${intent.invocationId}' is already bound to a different intent`)
    }
    await this.append(intent)
    this.intentKeys.set(intent.invocationId, key)
    this.openIntents.add(intent.invocationId)
  }

  async appendTerminal(record: TerminalRecord): Promise<void> {
    await this.append(record)
    this.openIntents.delete(record.invocationId)
    this.reserved.delete(record.invocationId)
    this.liveTerminals.add(record.invocationId)
    this.terminals.set(record.invocationId, { outcome: record.outcome, detail: record.detail })
  }

  /** Drop an in-process claim whose intent was never written (nothing was sent). */
  release(invocationId: string): void {
    if (!this.openIntents.has(invocationId) && !this.terminals.has(invocationId)) {
      this.reserved.delete(invocationId)
      this.intentKeys.delete(invocationId)
    }
  }

  /** Close unresolved intents as indeterminate. Does not dispatch them. */
  async terminalizeUnresolved(): Promise<readonly string[]> {
    const pending = [...this.openIntents]
    for (const invocationId of pending) {
      await this.appendTerminal({
        kind: 'terminal',
        invocationId,
        outcome: 'indeterminate',
        outputHash: digestText('unresolved'),
        detail: 'recovered without a terminal record; the call was not repeated',
      })
    }
    return pending
  }

  private remember(record: Stored): void {
    const kind = record['kind']
    const invocationId = record['invocationId']
    if (typeof invocationId !== 'string') return
    if (kind === 'dispatch_intent') {
      this.openIntents.add(invocationId)
      this.intentKeys.set(invocationId, intentKey(record as unknown as Omit<DispatchIntent, 'kind'>))
    }
    if (kind === 'terminal') {
      this.openIntents.delete(invocationId)
      const outcome = record['outcome']
      if (outcome === 'success' || outcome === 'error' || outcome === 'indeterminate' || outcome === 'audit_fault') {
        this.terminals.set(invocationId, { outcome, detail: typeof record['detail'] === 'string' ? record['detail'] : '' })
      }
    }
  }

  private async append(body: DispatchIntent | TerminalRecord): Promise<void> {
    if (this.poisoned !== undefined) throw new JournalError(this.poisoned)
    const run = this.chain.then(async () => {
      await this.assertOwner()
      const seq = this.seq + 1
      const unsigned = { v: JOURNAL_SCHEMA, seq, at: Date.now(), ...body }
      const stamped: Stored = { ...unsigned, digest: digestText(stable(unsigned)) }
      const handle = await fs.open(this.filePath, 'a')
      try {
        await handle.appendFile(`${JSON.stringify(stamped)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.seq = seq
    })
    this.chain = run.then(() => undefined, () => undefined)
    try {
      await run
    } catch (error) {
      this.poisoned = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
}

/**
 * The immutable part of an intent: what would be sent, to whom, under which
 * configuration. Epoch and generation are host-lifecycle fencing, not intent,
 * so a legitimate reopen under a new epoch still matches.
 */
function intentKey(intent: Omit<DispatchIntent, 'kind'>): string {
  return stable({
    workspaceId: intent.workspaceId,
    server: intent.server,
    tool: intent.tool,
    argsHash: intent.argsHash,
    configRevision: intent.configRevision,
    secretRevision: intent.secretRevision,
  })
}

export function digestText(value: string): string {
  return createHash(JOURNAL_DIGEST).update(value).digest('hex')
}

function digestOf(record: Stored): string {
  const { digest: _ignored, ...rest } = record
  void _ignored
  return digestText(stable(rest))
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}
