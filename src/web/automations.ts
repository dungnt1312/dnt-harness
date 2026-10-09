import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Cron } from 'croner'
import { isThinkingLevel, type ThinkingLevel } from '../harness/llm/model-catalog.ts'

/**
 * Automations: prompts the host runs on a schedule. Each fire opens a fresh
 * root session (see `server.ts`); this module owns the definitions, the run
 * history and the timing, with time and side effects injected so the
 * scheduler is testable on a fake clock.
 *
 * Files under `<home>/workspaces/<ws>/`: `automations.json` (definitions,
 * atomic rewrite) and `automation-runs.jsonl` (append-only run states).
 */

/** A recurring cron (host timezone) or one instant (`at`, ms epoch). */
export type AutomationSchedule =
  | { readonly cron: string }
  | { readonly at: number }

/** The parts of an automation that decide when it fires. */
export interface AutomationPlan {
  readonly schedules: readonly AutomationSchedule[]
  /** No fire after this instant (ms); null = never ends. */
  readonly endsAt: number | null
  /** Stop after this many scheduled runs; null = unlimited. */
  readonly maxRuns: number | null
  /** Scheduled runs started so far (Run now does not count). */
  readonly runCount: number
}

export interface AutomationControls {
  readonly provider: string | null
  readonly model: string | null
  readonly thinkingLevel: ThinkingLevel | null
}

export interface Automation {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly schedules: readonly AutomationSchedule[]
  readonly endsAt: number | null
  readonly maxRuns: number | null
  readonly runCount: number
  readonly projectId: string | null
  readonly modeId: string | null
  readonly controls: AutomationControls | null
  /**
   * Agent role the run delegates to (as a manual subagent spawn: the role's
   * tool ceiling, instructions and model apply). Null = the main agent.
   */
  readonly agent: string | null
  /** False when paused by the user or finished (no future runs left). */
  readonly enabled: boolean
  /** Send the result to the user when a run ends (failures and approvals always go out). */
  readonly notify: boolean
  /**
   * Where notifications go: `'push'` (Web Push) and/or channel ids. Null (rows
   * written before targets existed) means push plus every enabled channel.
   */
  readonly notifyTargets: readonly string[] | null
  /** A due time missed by more than this (host asleep or down) is recorded as missed. */
  readonly catchUpMinutes: number
  /** Last due instant already handled (fired, missed or skipped). */
  readonly lastDueAt: number
  readonly createdAt: number
  readonly updatedAt: number
}

export type AutomationInput = Pick<Automation, 'title' | 'prompt' | 'schedules' | 'endsAt' | 'maxRuns' | 'projectId' | 'modeId' | 'controls' | 'agent' | 'enabled' | 'notify' | 'notifyTargets' | 'catchUpMinutes'>

export type RunStatus = 'started' | 'done' | 'failed' | 'needs-approval' | 'missed' | 'skipped-busy'

export interface RunRecord {
  readonly v: 1
  readonly runId: string
  readonly automationId: string
  /** Scheduled instant; null for Run now. */
  readonly dueAt: number | null
  readonly at: number
  readonly status: RunStatus
  readonly sessionId?: string
  readonly error?: string
  /** Short result text for done runs (also the push body). */
  readonly summary?: string
}

export const DEFAULT_CATCH_UP_MINUTES = 120
/** Upper bound on one timer: sleep/wake and clock jumps are rechecked hourly. */
export const MAX_TIMER_MS = 60 * 60_000
const MAX_SCHEDULES = 12
const RUN_HISTORY_LIMIT = 200

export class AutomationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AutomationError'
  }
}

// ── cron helpers ─────────────────────────────────────────────

function cronOf(pattern: string): Cron {
  return new Cron(pattern, { paused: true })
}

/** Throws AutomationError(400) unless `pattern` is a valid five-field cron. */
export function validateCron(pattern: unknown): string {
  if (typeof pattern !== 'string') throw new AutomationError(400, "'cron' must be a string")
  const trimmed = pattern.trim().replace(/\s+/g, ' ')
  if (trimmed.split(' ').length !== 5) throw new AutomationError(400, `cron '${trimmed}' must have exactly five fields (minute hour day month weekday)`)
  try {
    if (cronOf(trimmed).nextRun(new Date()) === null) throw new Error('it never fires')
  } catch (error) {
    throw new AutomationError(400, `invalid cron '${trimmed}': ${error instanceof Error ? error.message : String(error)}`)
  }
  return trimmed
}

/** Plan defaults for a bare schedule list (tests, previews). */
export function planOf(schedules: readonly AutomationSchedule[], extra: Partial<Omit<AutomationPlan, 'schedules'>> = {}): AutomationPlan {
  return { schedules, endsAt: extra.endsAt ?? null, maxRuns: extra.maxRuns ?? null, runCount: extra.runCount ?? 0 }
}

/**
 * The next `count` fire instants (ms) strictly after `after`, across every
 * schedule, ascending and unique, cut at `endsAt` and at the runs left.
 */
export function nextRuns(plan: AutomationPlan, after: number, count: number): number[] {
  const left = plan.maxRuns === null ? count : Math.max(0, plan.maxRuns - plan.runCount)
  const want = Math.min(count, left)
  if (want === 0) return []
  const all = new Set<number>()
  for (const schedule of plan.schedules) {
    if ('at' in schedule) {
      if (schedule.at > after) all.add(schedule.at)
      continue
    }
    for (const date of cronOf(schedule.cron).nextRuns(want, new Date(after))) all.add(date.getTime())
  }
  return [...all]
    .filter((at) => plan.endsAt === null || at <= plan.endsAt)
    .sort((a, b) => a - b)
    .slice(0, want)
}

/** The latest fire instant in `(after, upTo]` across every schedule (and before `endsAt`), if any. */
export function latestDueBetween(plan: AutomationPlan, after: number, upTo: number): number | undefined {
  const limit = plan.endsAt === null ? upTo : Math.min(upTo, plan.endsAt)
  let latest: number | undefined
  for (const schedule of plan.schedules) {
    // croner's previous search is exclusive of the reference; +1s makes the limit inclusive.
    const previous = 'at' in schedule
      ? (schedule.at <= limit ? schedule.at : undefined)
      : cronOf(schedule.cron).previousRuns(1, new Date(limit + 1000))[0]?.getTime()
    if (previous !== undefined && previous > after && previous <= limit && (latest === undefined || previous > latest)) latest = previous
  }
  return latest
}

/** Whether the plan can still fire after `now`. */
export function hasFutureRuns(plan: AutomationPlan, now: number): boolean {
  return nextRuns(plan, now, 1).length > 0
}

/**
 * Validate one schedule entry: `{ cron }` or `{ at }`. A past `at` is allowed
 * here (a finished one-time task stays editable); create and enable refuse a
 * plan with no future runs instead.
 */
export function validateSchedule(entry: unknown): AutomationSchedule {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new AutomationError(400, "each schedule must be { cron } or { at }")
  const record = entry as Record<string, unknown>
  if (record['at'] !== undefined) {
    const at = record['at']
    if (typeof at !== 'number' || !Number.isFinite(at)) throw new AutomationError(400, "'at' must be a timestamp in milliseconds")
    return { at: Math.floor(at / 1000) * 1000 }
  }
  return { cron: validateCron(record['cron']) }
}

/** Whether two plans fire identically (order-insensitive schedules, same end conditions). */
function samePlan(a: Pick<AutomationPlan, 'schedules' | 'endsAt' | 'maxRuns'>, b: Pick<AutomationPlan, 'schedules' | 'endsAt' | 'maxRuns'>): boolean {
  const key = (plan: Pick<AutomationPlan, 'schedules'>): string => plan.schedules.map((s) => ('at' in s ? `at:${s.at}` : `cron:${s.cron}`)).sort().join('|')
  return key(a) === key(b) && a.endsAt === b.endsAt && a.maxRuns === b.maxRuns
}

// ── validation ───────────────────────────────────────────────

function parseControls(raw: unknown): AutomationControls | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AutomationError(400, "'controls' must be an object or null")
  const { provider, model, thinkingLevel } = raw as Record<string, unknown>
  if ((provider !== null && typeof provider !== 'string') || (model !== null && typeof model !== 'string') || (provider === null) !== (model === null)) {
    throw new AutomationError(400, "'controls' needs a string|null provider/model pair")
  }
  if (thinkingLevel !== null && thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
    throw new AutomationError(400, "'controls.thinkingLevel' is not a valid thinking level")
  }
  return { provider: provider as string | null, model: model as string | null, thinkingLevel: (thinkingLevel ?? null) as ThinkingLevel | null }
}

/** Validate a schedule list: 1 to {@link MAX_SCHEDULES} `{ cron }` / `{ at }` entries. */
export function parseSchedules(raw: unknown): AutomationSchedule[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AutomationError(400, "'schedules' needs at least one { cron } or { at } entry")
  if (raw.length > MAX_SCHEDULES) throw new AutomationError(400, `at most ${MAX_SCHEDULES} schedules per automation`)
  return raw.map((entry: unknown) => validateSchedule(entry))
}

/** Validate a create body (`partial` false) or a PATCH body (`partial` true). */
export function parseAutomationInput(body: Record<string, unknown>, partial: true): Partial<AutomationInput>
export function parseAutomationInput(body: Record<string, unknown>, partial: false): AutomationInput
export function parseAutomationInput(body: Record<string, unknown>, partial: boolean): Partial<AutomationInput> {
  const out: { -readonly [K in keyof AutomationInput]?: AutomationInput[K] } = {}
  const has = (key: string): boolean => body[key] !== undefined
  if (has('title') || !partial) {
    const title = body['title'] ?? 'Untitled Automation'
    if (typeof title !== 'string' || title.trim() === '') throw new AutomationError(400, "'title' must be a non-empty string")
    out.title = title.trim().slice(0, 120)
  }
  if (has('prompt') || !partial) {
    const prompt = body['prompt']
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new AutomationError(400, "'prompt' must be a non-empty string")
    out.prompt = prompt
  }
  if (has('schedules') || !partial) out.schedules = parseSchedules(body['schedules'])
  if (has('endsAt') || !partial) {
    const endsAt = body['endsAt'] ?? null
    if (endsAt !== null && (typeof endsAt !== 'number' || !Number.isFinite(endsAt))) throw new AutomationError(400, "'endsAt' must be a timestamp in milliseconds or null")
    out.endsAt = endsAt as number | null
  }
  if (has('maxRuns') || !partial) {
    const maxRuns = body['maxRuns'] ?? null
    if (maxRuns !== null && (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100_000)) {
      throw new AutomationError(400, "'maxRuns' must be a positive integer or null")
    }
    out.maxRuns = maxRuns as number | null
  }
  if (has('projectId') || !partial) {
    const projectId = body['projectId'] ?? null
    if (projectId !== null && (typeof projectId !== 'string' || projectId === '')) throw new AutomationError(400, "'projectId' must be a string or null")
    out.projectId = projectId as string | null
  }
  if (has('modeId') || !partial) {
    const modeId = body['modeId'] ?? null
    if (modeId !== null && (typeof modeId !== 'string' || modeId === '')) throw new AutomationError(400, "'modeId' must be a string or null")
    out.modeId = modeId as string | null
  }
  if (has('controls') || (!partial && body['controls'] === undefined)) out.controls = parseControls(body['controls'])
  if (has('agent') || !partial) {
    const agent = body['agent'] ?? null
    if (agent !== null && (typeof agent !== 'string' || !/^[\w.-]{1,64}$/.test(agent))) throw new AutomationError(400, "'agent' must be a role name or null")
    out.agent = agent as string | null
  }
  if (has('enabled') || !partial) {
    const enabled = body['enabled'] ?? true
    if (typeof enabled !== 'boolean') throw new AutomationError(400, "'enabled' must be a boolean")
    out.enabled = enabled
  }
  if (has('notify') || !partial) {
    const notify = body['notify'] ?? true
    if (typeof notify !== 'boolean') throw new AutomationError(400, "'notify' must be a boolean")
    out.notify = notify
  }
  if (has('notifyTargets') || !partial) {
    const raw = body['notifyTargets'] ?? null
    if (raw !== null && (!Array.isArray(raw) || raw.length > 32 || !raw.every((id) => typeof id === 'string' && id !== '' && id.length <= 80))) {
      throw new AutomationError(400, "'notifyTargets' must be a list of 'push' and channel ids, or null")
    }
    out.notifyTargets = raw === null ? null : [...new Set(raw as string[])]
  }
  if (has('catchUpMinutes') || !partial) {
    const minutes = body['catchUpMinutes'] ?? DEFAULT_CATCH_UP_MINUTES
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > 7 * 24 * 60) {
      throw new AutomationError(400, "'catchUpMinutes' must be an integer between 0 and 10080")
    }
    out.catchUpMinutes = minutes
  }
  return out
}

// ── store ────────────────────────────────────────────────────

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, content, 'utf8')
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Per-workspace definitions and run history. `dir` resolves a workspace's
 * data directory; undefined keeps everything in memory (tests, memory mode).
 */
export class AutomationStore {
  private readonly cache = new Map<string, Automation[]>()
  private readonly runs = new Map<string, RunRecord[]>()
  private writes = new Map<string, Promise<void>>()

  constructor(private readonly dir: ((workspaceId: string) => string) | undefined, private readonly now: () => number = Date.now) {}

  private file(workspaceId: string, name: string): string | undefined {
    return this.dir === undefined ? undefined : path.join(this.dir(workspaceId), name)
  }

  async list(workspaceId: string): Promise<readonly Automation[]> {
    const cached = this.cache.get(workspaceId)
    if (cached !== undefined) return cached
    let rows: Automation[] = []
    const file = this.file(workspaceId, 'automations.json')
    if (file !== undefined) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { automations?: unknown }
        if (Array.isArray(parsed.automations)) rows = parsed.automations.filter(isAutomation).map(normalizeRow)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`automations: ${file} unreadable: ${String(error)}`)
      }
    }
    this.cache.set(workspaceId, rows)
    return rows
  }

  async get(workspaceId: string, id: string): Promise<Automation> {
    const found = (await this.list(workspaceId)).find((row) => row.id === id)
    if (found === undefined) throw new AutomationError(404, 'no such automation')
    return found
  }

  async create(workspaceId: string, input: AutomationInput): Promise<Automation> {
    const at = this.now()
    // lastDueAt = now: a new automation never back-fires a due time it predates.
    const row: Automation = { id: `auto-${randomUUID()}`, ...input, runCount: 0, lastDueAt: at, createdAt: at, updatedAt: at }
    if (row.enabled && !hasFutureRuns(row, at)) throw new AutomationError(400, 'this schedule never runs: check the end date and the times')
    await this.save(workspaceId, [...await this.list(workspaceId), row])
    return row
  }

  async update(workspaceId: string, id: string, patch: Partial<AutomationInput> & { lastDueAt?: number; runCount?: number }): Promise<Automation> {
    const rows = await this.list(workspaceId)
    const index = rows.findIndex((row) => row.id === id)
    const current = rows[index]
    if (current === undefined) throw new AutomationError(404, 'no such automation')
    const touched = Object.keys(patch).some((key) => key !== 'lastDueAt' && key !== 'runCount')
    const at = this.now()
    // Re-enabling or re-timing starts from now: no catch-up for time spent disabled.
    // Saving an unchanged plan (the editor always sends it) is not a re-plan.
    const replanned = !samePlan(current, {
      schedules: patch.schedules ?? current.schedules,
      endsAt: patch.endsAt !== undefined ? patch.endsAt : current.endsAt,
      maxRuns: patch.maxRuns !== undefined ? patch.maxRuns : current.maxRuns,
    })
    const rebase = (patch.enabled === true && !current.enabled) || replanned
    const next: Automation = {
      ...current,
      ...patch,
      // A new plan counts its "N times" from zero.
      ...(replanned && patch.runCount === undefined ? { runCount: 0 } : {}),
      ...(rebase ? { lastDueAt: Math.max(current.lastDueAt, at) } : {}),
      ...(touched ? { updatedAt: at } : {}),
    }
    // Enabling a plan with nothing left to run would look on but never fire.
    if (patch.enabled === true && !hasFutureRuns(next, at)) {
      throw new AutomationError(400, 'this schedule has no future runs; change the schedule or end condition first')
    }
    const copy = [...rows]
    copy[index] = next
    await this.save(workspaceId, copy)
    return next
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const rows = await this.list(workspaceId)
    if (!rows.some((row) => row.id === id)) throw new AutomationError(404, 'no such automation')
    await this.save(workspaceId, rows.filter((row) => row.id !== id))
  }

  private async save(workspaceId: string, rows: Automation[]): Promise<void> {
    this.cache.set(workspaceId, rows)
    const file = this.file(workspaceId, 'automations.json')
    if (file === undefined) return
    const content = JSON.stringify({ v: 1, automations: rows }, null, 2)
    const write = (this.writes.get(file) ?? Promise.resolve()).catch(() => {}).then(() => writeAtomic(file, content))
    this.writes.set(file, write)
    await write
  }

  /** Append one run state (fire-and-forget safe: errors are logged). */
  async record(workspaceId: string, record: Omit<RunRecord, 'v' | 'at'> & { at?: number }): Promise<RunRecord> {
    const full: RunRecord = { v: 1, ...record, at: record.at ?? this.now() }
    const list = await this.loadRuns(workspaceId)
    list.push(full)
    const file = this.file(workspaceId, 'automation-runs.jsonl')
    if (file !== undefined) {
      const write = (this.writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, `${JSON.stringify(full)}\n`, 'utf8')
      })
      this.writes.set(file, write)
      await write.catch((error: unknown) => console.error(`automations: run record lost: ${String(error)}`))
    }
    return full
  }

  /** Session id → automation id for every run that opened a session (sidebar grouping). */
  async runSessions(workspaceId: string): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>()
    for (const record of await this.loadRuns(workspaceId)) {
      if (record.sessionId !== undefined && record.status === 'started') out.set(record.sessionId, record.automationId)
    }
    return out
  }

  /** One row per run (latest state wins), newest first. */
  async history(workspaceId: string, automationId?: string): Promise<RunRecord[]> {
    const folded = new Map<string, RunRecord>()
    for (const record of await this.loadRuns(workspaceId)) {
      if (automationId !== undefined && record.automationId !== automationId) continue
      const prior = folded.get(record.runId)
      // Keep the session id and due time a later state may omit.
      folded.set(record.runId, prior === undefined ? record : { ...prior, ...record, ...(record.sessionId === undefined && prior.sessionId !== undefined ? { sessionId: prior.sessionId } : {}) })
    }
    return [...folded.values()].sort((a, b) => (b.dueAt ?? b.at) - (a.dueAt ?? a.at) || b.at - a.at).slice(0, RUN_HISTORY_LIMIT)
  }

  private async loadRuns(workspaceId: string): Promise<RunRecord[]> {
    const cached = this.runs.get(workspaceId)
    if (cached !== undefined) return cached
    const list: RunRecord[] = []
    this.runs.set(workspaceId, list)
    const file = this.file(workspaceId, 'automation-runs.jsonl')
    if (file === undefined) return list
    try {
      await fs.access(file)
    } catch {
      return list
    }
    const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
    const loaded: RunRecord[] = []
    for await (const line of lines) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as RunRecord
        if (parsed.v === 1 && typeof parsed.runId === 'string' && typeof parsed.automationId === 'string') loaded.push(parsed)
      } catch {
        // A torn final line after a crash is skipped.
      }
    }
    list.unshift(...loaded)
    return list
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.writes.values()])
  }
}

function isAutomation(value: unknown): value is Automation {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string' && typeof row['prompt'] === 'string' && Array.isArray(row['schedules']) && typeof row['lastDueAt'] === 'number'
}

/** Fill fields added after a row was written (older files). */
function normalizeRow(row: Automation): Automation {
  const raw = row as Partial<Automation> & Automation
  return { ...row, endsAt: raw.endsAt ?? null, maxRuns: raw.maxRuns ?? null, runCount: raw.runCount ?? 0, notify: raw.notify ?? true, notifyTargets: raw.notifyTargets ?? null, agent: raw.agent ?? null }
}

// ── scheduler ────────────────────────────────────────────────

export interface SchedulerDeps {
  readonly store: AutomationStore
  readonly workspaces: () => readonly string[]
  /** Start one run; resolves false when it did not start (skipped busy, refused). */
  readonly fire: (workspaceId: string, automation: Automation, dueAt: number) => Promise<boolean>
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

/**
 * One timer aimed at the earliest due time of every enabled automation,
 * capped at {@link MAX_TIMER_MS} so a sleeping host recomputes on wake. Each
 * tick handles, per automation, only the LATEST due time since `lastDueAt`:
 * fire it if it is within the catch-up window, otherwise record it missed.
 */
export class AutomationScheduler {
  private timer: unknown
  private running: Promise<void> | undefined
  private again = false
  private stopped = false
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  start(): Promise<void> {
    this.stopped = false
    return this.poke()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
  }

  /** Re-evaluate now (after a change, or from the timer). Serialized. */
  poke(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running !== undefined) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.tick()
        } while (this.again && !this.stopped)
      } finally {
        this.running = undefined
      }
    })()
    return this.running
  }

  private async tick(): Promise<void> {
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
    const now = this.now()
    let earliest = Number.POSITIVE_INFINITY
    for (const workspaceId of this.deps.workspaces()) {
      let rows: readonly Automation[]
      try {
        rows = await this.deps.store.list(workspaceId)
      } catch (error) {
        console.error(`automations: list failed for ${workspaceId}: ${String(error)}`)
        continue
      }
      for (const automation of rows) {
        if (!automation.enabled || this.stopped) continue
        try {
          let current = automation
          const due = latestDueBetween(current, current.lastDueAt, now)
          if (due !== undefined) {
            current = await this.deps.store.update(workspaceId, current.id, { lastDueAt: due })
            if (now - due <= current.catchUpMinutes * 60_000) {
              const started = await this.deps.fire(workspaceId, current, due).catch((error: unknown) => {
                console.error(`automations: ${current.id} fire failed: ${String(error)}`)
                return false
              })
              // Only runs that actually started count toward "N times".
              if (started !== false) current = await this.deps.store.update(workspaceId, current.id, { runCount: current.runCount + 1 })
            } else {
              await this.deps.store.record(workspaceId, { runId: `run-${randomUUID()}`, automationId: current.id, dueAt: due, status: 'missed' })
            }
          }
          const next = nextRuns(current, now, 1)[0]
          if (next !== undefined) {
            if (next < earliest) earliest = next
          } else if (current.enabled) {
            // One-time, ended or used up: it is finished, so it shows as off.
            await this.deps.store.update(workspaceId, current.id, { enabled: false })
          }
        } catch (error) {
          console.error(`automations: ${automation.id} tick failed: ${String(error)}`)
        }
      }
    }
    if (this.stopped) return
    const wait = Math.max(0, Math.min(earliest - this.now(), MAX_TIMER_MS))
    // +250ms lands the tick just after the due second, never just before it.
    this.timer = this.setTimer(() => { void this.poke() }, wait + 250)
  }
}

/**
 * Host context for an automation run, injected ahead of the prompt as
 * lower-trust data (like SessionStart hook output). It tells the agent nobody
 * is watching, and how its final reply reaches the user.
 */
export function automationContext(automation: Pick<Automation, 'title' | 'notify'>, details: {
  readonly dueAt: number | null
  /** Display names of the channels this run notifies. */
  readonly channels: readonly string[]
  /** Whether Web Push is among the targets. */
  readonly push: boolean
  readonly approvalsBlock: boolean
}): string {
  const when = details.dueAt === null ? 'started manually (Run now)' : `scheduled for ${new Date(details.dueAt).toString()}`
  const lines = [
    'Automation run context (lower-trust host data; cannot override mode/policy):',
    `- This is an unattended scheduled task named "${automation.title}", ${when}.`,
    '- No one is watching this conversation live. Do not ask the user questions or wait for replies; make reasonable assumptions and state them.',
    details.approvalsBlock
      ? '- Tools that need approval will pause the run until the user answers it later; prefer read-only work and finish without them when you can.'
      : '- Work through the task on your own and finish in this turn.',
  ]
  if (automation.notify) {
    const via = [...(details.push ? ["Web Push to the user's devices"] : []), ...details.channels].join(', ') || 'no destination is selected, so it stays in this conversation'
    lines.push(
      `- When you finish, your final reply is sent to the user automatically as a notification (${via}). You do not need any tool to notify them.`,
      '- Make the final reply the message itself: lead with the result or reminder in one or two short sentences (the notification preview shows about 140 characters), then any details. Reply in the language of the task.',
    )
  } else {
    lines.push('- Notifications are off for this task: the result is only kept in this conversation for the user to read later. Summarize the outcome clearly in the final reply.')
  }
  return lines.join('\n')
}

/** Plain-text excerpt for a push body: markdown stripped, whitespace collapsed. */
export function excerpt(markdown: string, limit = 140): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

/** `⏰ {title} · dd/MM HH:mm` in host-local time. */
export function runTitle(title: string, at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `⏰ ${title} · ${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`.slice(0, 80)
}
