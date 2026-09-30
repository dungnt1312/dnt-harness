import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { DEFAULT_BASE_SYSTEM, DEFAULT_CHILD_SYSTEM } from '../context/builder.ts'

/**
 * The workspace-authored replacements for the harness's fixed system prompts.
 * A blank/missing field means "use the default" — an override never merges,
 * it replaces wholesale (the builder trims and falls back the same way).
 */
export interface SystemPromptsConfig {
  readonly v: 1
  /** Replaces the base system prompt for ROOT conversations. */
  readonly base?: string
  /** Replaces the subagent preamble for CHILD requests. */
  readonly child?: string
}

/** One workspace's effective prompts plus the config hash for conflict detection. */
export interface SystemPromptsSnapshot {
  readonly base: { readonly text: string; readonly overridden: boolean }
  readonly child: { readonly text: string; readonly overridden: boolean }
  readonly hash: string
  readonly warning?: string
}

/** Upper bound per prompt: a system prompt is a ceiling on context, not a document store. */
export const MAX_PROMPT_CHARS = 20_000

const EMPTY_CONFIG: SystemPromptsConfig = { v: 1 }

type ReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'valid'; readonly config: SystemPromptsConfig; readonly hash: string }
  | { readonly kind: 'corrupt'; readonly warning: string }

/**
 * Per-workspace store for the system prompt overrides, one JSON file per
 * workspace: `<home>/workspaces/<ws>/system-prompts.json`. Writes are atomic
 * and serialized per workspace; `expectedHash` gives compare-and-swap
 * semantics so two editors cannot silently overwrite each other. Read models
 * resolve the defaults, so callers never branch on "is this overridden?".
 */
export class SystemPromptsStore {
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private readonly home: string) {}

  private workspaceFile(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'system-prompts.json')
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.mutationTails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }
  }

  /** The effective prompts for one workspace: overrides resolved against defaults. */
  async load(workspaceId: string): Promise<SystemPromptsSnapshot> {
    const result = await this.readFile(this.workspaceFile(workspaceId))
    if (result.kind === 'valid') return snapshotOf(result.config, result.hash)
    if (result.kind === 'corrupt') return { ...snapshotOf(EMPTY_CONFIG, hashConfig(EMPTY_CONFIG)), warning: result.warning }
    return snapshotOf(EMPTY_CONFIG, hashConfig(EMPTY_CONFIG))
  }

  /**
   * Save one workspace's overrides. Omitting a field (or saving it blank)
   * clears that override back to the default; present non-blank strings
   * replace wholesale.
   */
  async save(
    workspaceId: string,
    input: { readonly base?: string; readonly child?: string },
    expectedHash?: string,
  ): Promise<SystemPromptsSnapshot> {
    const config = validateInput(input)
    return this.withLock(workspaceId, async () => {
      if (expectedHash !== undefined) {
        const current = await this.effectiveHash(workspaceId)
        if (current !== expectedHash) {
          throw new Error(`conflict: system-prompts.json changed externally; expected ${expectedHash} but found ${current}`)
        }
      }
      const file = this.workspaceFile(workspaceId)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await replaceFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`)
      return snapshotOf(config, hashConfig(config))
    })
  }

  private async effectiveHash(workspaceId: string): Promise<string> {
    const result = await this.readFile(this.workspaceFile(workspaceId))
    if (result.kind === 'valid') return result.hash
    return hashConfig(EMPTY_CONFIG)
  }

  private async readFile(filePath: string): Promise<ReadResult> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      throw error
    }
    try {
      const config = parseConfig(JSON.parse(raw))
      return { kind: 'valid', config, hash: hashConfig(config) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'corrupt', warning: `system-prompts.json is corrupt/invalid (${detail}); using defaults` }
    }
  }
}

function snapshotOf(config: SystemPromptsConfig, hash: string): SystemPromptsSnapshot {
  const base = config.base?.trim() ?? ''
  const child = config.child?.trim() ?? ''
  return {
    base: { text: base !== '' ? config.base!.trim() : DEFAULT_BASE_SYSTEM, overridden: base !== '' },
    child: { text: child !== '' ? config.child!.trim() : DEFAULT_CHILD_SYSTEM, overridden: child !== '' },
    hash,
  }
}

function hashConfig(config: SystemPromptsConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

function parseConfig(parsed: unknown): SystemPromptsConfig {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid config: not an object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj['v'] !== 1) throw new Error(`invalid config: v must be 1, got ${String(obj['v'])}`)
  for (const key of Object.keys(obj)) {
    if (key !== 'v' && key !== 'base' && key !== 'child') {
      throw new Error(`invalid config: unknown top-level key '${key}'`)
    }
  }
  for (const key of ['base', 'child'] as const) {
    const value = obj[key]
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`invalid config: '${key}' must be a non-empty string when present`)
    }
    if (typeof value === 'string' && value.length > MAX_PROMPT_CHARS) {
      throw new Error(`invalid config: '${key}' exceeds ${MAX_PROMPT_CHARS} chars`)
    }
  }
  return {
    v: 1,
    ...(typeof obj['base'] === 'string' ? { base: obj['base'] } : {}),
    ...(typeof obj['child'] === 'string' ? { child: obj['child'] } : {}),
  }
}

function validateInput(input: { readonly base?: string; readonly child?: string }): SystemPromptsConfig {
  if (input === null || typeof input !== 'object') throw new Error('invalid config: must be an object')
  for (const key of ['base', 'child'] as const) {
    const value = input[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`invalid config: '${key}' must be a string`)
    }
    if (typeof value === 'string' && value.length > MAX_PROMPT_CHARS) {
      throw new Error(`invalid config: '${key}' exceeds ${MAX_PROMPT_CHARS} chars`)
    }
  }
  // Blank means "back to the default", so it is normalized away on save.
  const base = input.base?.trim() ?? ''
  const child = input.child?.trim() ?? ''
  return {
    v: 1,
    ...(base !== '' ? { base: input.base! } : {}),
    ...(child !== '' ? { child: input.child! } : {}),
  }
}
