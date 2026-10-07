import { DEFAULT_LIMITS, isValidLimit, type HarnessLimits } from '../limits.ts'
import { LIMIT_FIELDS, type LimitKey } from '../limits-config.ts'
import type { AppConfigStore, ConfigRead } from './store.ts'
import {
  AppConfigError,
  type AppConfigDocument,
  type AppConfigView,
  type LimitEdit,
  type LimitSource,
  type LimitsReader,
  type LimitsSnapshot,
} from './types.ts'

export interface AppConfigServiceOptions {
  /** Host profile defaults layered above the library defaults and below the file. */
  readonly hostDefaults?: Partial<HarnessLimits>
  /** Embedding/test overrides: valid entries win over the file and lock their field. */
  readonly explicit?: Partial<HarnessLimits>
  /** Called after a committed publication that changed effective values. */
  readonly onPublished?: (snapshot: LimitsSnapshot) => void
  /** Receives anything `onPublished` throws; a committed update is never undone. */
  readonly onNotificationError?: (error: unknown) => void
}

type Limits = Partial<Record<LimitKey, number>>
type Observation = Exclude<ConfigRead, { kind: 'invalid' }>

const LIMIT_KEYS: readonly LimitKey[] = LIMIT_FIELDS.map(field => field.key)
const KNOWN_KEYS = new Set<string>(LIMIT_KEYS)

/**
 * Sparse, detached, frozen copy keeping only valid entries. Programmatic
 * layers (host, explicit) fall through on invalid values — never filled with
 * defaults, so an absent or invalid key cannot shadow a lower layer.
 */
function validEntries(partial: Partial<HarnessLimits> | undefined): Readonly<Limits> {
  const out: Limits = {}
  if (partial !== null && typeof partial === 'object') {
    for (const key of LIMIT_KEYS) if (isValidLimit(key, partial[key])) out[key] = partial[key]
  }
  return Object.freeze(out)
}

function freezeDocument(document: AppConfigDocument): AppConfigDocument {
  return document.limits === undefined
    ? Object.freeze({ v: 1 as const })
    : Object.freeze({ v: 1 as const, limits: Object.freeze({ ...document.limits }) })
}

function sameValues(a: Readonly<HarnessLimits>, b: Readonly<HarnessLimits>): boolean {
  return LIMIT_KEYS.every(key => Object.is(a[key], b[key]))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

/**
 * Strict runtime validation of an untrusted edit batch: every entry must be a
 * plain `{op,key[,value]}` with a known key, a valid value for `set`, and at
 * most one edit per key. Any failure rejects the whole batch.
 */
function validateEdits(edits: unknown): readonly LimitEdit[] {
  if (!Array.isArray(edits)) throw new AppConfigError('invalid', 'edits must be an array')
  const seen = new Set<string>()
  for (const edit of edits as unknown[]) {
    if (!isPlainObject(edit)) throw new AppConfigError('invalid', 'each edit must be a plain object')
    const { op, key } = edit
    if (typeof key !== 'string' || !KNOWN_KEYS.has(key)) throw new AppConfigError('invalid', `unknown limit key: ${String(key)}`)
    const limitKey = key as LimitKey
    if (seen.has(key)) throw new AppConfigError('invalid', `duplicate edit for limit ${key}`, limitKey)
    seen.add(key)
    const allowed = op === 'set' ? ['op', 'key', 'value'] : op === 'unset' ? ['op', 'key'] : undefined
    if (allowed === undefined) throw new AppConfigError('invalid', `unknown edit op: ${String(op)}`, limitKey)
    for (const field of Object.keys(edit)) {
      if (!allowed.includes(field)) throw new AppConfigError('invalid', `unexpected edit field '${field}' for ${key}`, limitKey)
    }
    if (op === 'set' && !isValidLimit(limitKey, edit['value'])) {
      throw new AppConfigError('invalid', `invalid value for limit ${key}`, limitKey)
    }
  }
  return edits as readonly LimitEdit[]
}

/**
 * Stable coordinator for the global limits configuration. Composes
 * library → host → file → explicit layers into one immutable snapshot and
 * publishes it through a single serialized path shared by boot, edit and
 * reload, so an older reload can never overwrite a newer publication.
 * Snapshots are swapped synchronously only after durable state is
 * committed; the revision advances only when effective values change.
 * `describe` observes the disk without activating anything.
 */
export class AppConfigService implements LimitsReader {
  private readonly store: AppConfigStore
  private readonly options: AppConfigServiceOptions
  /** Library + host values: what a field without a file override inherits. */
  private readonly inherited: Readonly<HarnessLimits>
  private readonly hostKeys: ReadonlySet<LimitKey>
  private readonly explicit: Readonly<Limits>
  private tail: Promise<unknown> = Promise.resolve()
  private snapshot: LimitsSnapshot | undefined
  /** File layer and its hash currently composed into the active snapshot. */
  private activeFile: Readonly<Limits> = Object.freeze({})
  private activeHash = ''

  constructor(store: AppConfigStore, options: AppConfigServiceOptions = {}) {
    this.store = store
    this.options = options
    const host = validEntries(options.hostDefaults)
    this.hostKeys = new Set(Object.keys(host) as LimitKey[])
    this.inherited = Object.freeze({ ...DEFAULT_LIMITS, ...host })
    this.explicit = validEntries(options.explicit)
  }

  /** Load the file and publish revision 0; an invalid or unreadable file refuses boot. */
  boot(): Promise<void> {
    return this.serialize(async () => {
      if (this.snapshot !== undefined) throw new Error('app-config service already booted')
      const observed = this.requireValid(await this.store.read())
      this.activeFile = Object.freeze({ ...observed.document.limits })
      this.activeHash = observed.hash
      this.snapshot = Object.freeze({ revision: 0, values: this.compose(this.activeFile) })
    })
  }

  read(): LimitsSnapshot {
    if (this.snapshot === undefined) throw new Error('app-config service is not booted')
    return this.snapshot
  }

  /** Observe the disk for an editor; never activates. Unreadable files reject with `io`. */
  async describe(): Promise<AppConfigView> {
    this.read()
    return this.view(await this.store.read())
  }

  /**
   * Apply a validated set/unset batch to the canonical disk document, persist
   * it under `expectedHash`, then activate the complete saved candidate —
   * including any valid manual edits the caller observed via `describe`.
   */
  edit(edits: readonly LimitEdit[], expectedHash: string): Promise<AppConfigView> {
    return this.serialize(async () => {
      this.read()
      const batch = validateEdits(edits)
      if (typeof expectedHash !== 'string') throw new AppConfigError('invalid', 'expectedHash must be a string')
      for (const edit of batch) {
        if (edit.key in this.explicit) {
          throw new AppConfigError('locked', `limit ${edit.key} is locked by an explicit override`, edit.key)
        }
      }
      const current = this.requireValid(await this.store.read())
      const limits: Limits = { ...current.document.limits }
      for (const edit of batch) {
        if (edit.op === 'set') limits[edit.key] = edit.value
        else delete limits[edit.key]
      }
      const candidate: AppConfigDocument = Object.keys(limits).length > 0 ? { v: 1, limits } : { v: 1 }
      const saved = await this.store.save(candidate, expectedHash)
      const observed: Observation = { kind: 'valid', document: saved.document, hash: saved.hash }
      this.activate(observed)
      return this.view(observed)
    })
  }

  /** Re-read the file and publish it; invalid files reject and keep the last good snapshot. */
  reload(): Promise<AppConfigView> {
    return this.serialize(async () => {
      this.read()
      const observed = this.requireValid(await this.store.read())
      this.activate(observed)
      return this.view(observed)
    })
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run)
    this.tail = next.catch(() => {})
    return next
  }

  private requireValid(read: ConfigRead): Observation {
    if (read.kind === 'invalid') throw new AppConfigError('invalid', read.error)
    return read
  }

  private compose(file: Readonly<Limits>): Readonly<HarnessLimits> {
    return Object.freeze({ ...this.inherited, ...file, ...this.explicit })
  }

  /** Synchronous, non-throwing swap; notification failures are contained. */
  private activate(observed: Observation): void {
    const file = Object.freeze({ ...observed.document.limits })
    const values = this.compose(file)
    const previous = this.read()
    this.activeFile = file
    this.activeHash = observed.hash
    if (sameValues(previous.values, values)) return
    const snapshot: LimitsSnapshot = Object.freeze({ revision: previous.revision + 1, values })
    this.snapshot = snapshot
    try {
      this.options.onPublished?.(snapshot)
    } catch (error) {
      try {
        this.options.onNotificationError?.(error)
      } catch {
        // The handler is the last reporting channel; the publication is already committed.
      }
    }
  }

  private sourceOf(key: LimitKey): LimitSource {
    if (key in this.explicit) return 'explicit'
    if (key in this.activeFile) return 'file'
    return this.hostKeys.has(key) ? 'host' : 'library'
  }

  private view(read: ConfigRead): AppConfigView {
    const valid = read.kind === 'invalid' ? undefined : read
    const diskLimits: Readonly<Limits> = valid?.document.limits ?? {}
    const fields = LIMIT_FIELDS.map(field => {
      const locked = field.key in this.explicit
      const fileValue = diskLimits[field.key]
      return Object.freeze({
        ...field,
        source: this.sourceOf(field.key),
        locked,
        ...(fileValue === undefined ? {} : { fileValue }),
        shadowed: locked && fileValue !== undefined,
      })
    })
    return Object.freeze({
      document: valid ? freezeDocument(valid.document) : null,
      hash: valid ? valid.hash : null,
      active: this.read(),
      inherited: this.inherited,
      fields: Object.freeze(fields),
      outOfSync: valid ? valid.hash !== this.activeHash : true,
      ...(read.kind === 'invalid' ? { error: read.error } : {}),
    })
  }
}
