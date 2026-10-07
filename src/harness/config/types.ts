import type { HarnessLimits } from '../limits.ts'
import type { LimitField, LimitKey } from '../limits-config.ts'

/** Durable, versioned global configuration document (currently limits-only). */
export interface AppConfigDocument {
  readonly v: 1
  readonly limits?: Partial<HarnessLimits>
}

/**
 * Field-scoped edit as sent by clients/coordinator: set a sparse override or
 * unset it (back to inherited). Whole-batch validation belongs to the caller;
 * the store itself persists complete documents.
 */
export type LimitEdit =
  | { readonly op: 'set'; readonly key: LimitKey; readonly value: number }
  | { readonly op: 'unset'; readonly key: LimitKey }

/** Single error type across the config slice; API maps code → status later. */
export class AppConfigError extends Error {
  readonly code: 'invalid' | 'conflict' | 'locked' | 'io'
  readonly key?: LimitKey

  constructor(code: AppConfigError['code'], message: string, key?: LimitKey) {
    super(message)
    this.name = 'AppConfigError'
    this.code = code
    if (key !== undefined) this.key = key
  }
}

/**
 * Immutable effective limits captured at an operation boundary. `revision` is
 * process-local and monotonic: it starts at 0 after boot and advances only
 * when effective values change — never a durable hash.
 */
export interface LimitsSnapshot { readonly revision: number; readonly values: Readonly<HarnessLimits> }

/** Stable reader seam (`ctx.get('limits-reader')`); identity never changes across publications. */
export interface LimitsReader { read(): LimitsSnapshot }

/** Layer that supplied a field's active value, lowest to highest precedence. */
export type LimitSource = 'library' | 'host' | 'file' | 'explicit'

/**
 * Editor descriptor. `document`/`hash` are the observed disk state (both null
 * with `error` when the file is invalid); `active` is the published snapshot,
 * which a describe never changes. `inherited` holds library+host values — what
 * a field falls back to when its file override is unset. Per-field `source`
 * and `locked` describe the active layers; `fileValue` is the observed disk
 * override, `shadowed` when an explicit lock hides it. `outOfSync` means the
 * disk differs from the file layer currently active.
 */
export interface AppConfigView {
  readonly document: AppConfigDocument | null; readonly hash: string | null
  readonly active: LimitsSnapshot; readonly inherited: Readonly<HarnessLimits>
  readonly fields: readonly (LimitField & { readonly source: LimitSource; readonly locked: boolean; readonly fileValue?: number; readonly shadowed: boolean })[]
  readonly outOfSync: boolean
  /**
   * Validation error of the current disk observation, so a failed reload of a
   * still-bad file stays visible here; unreadable files reject `describe()`.
   */
  readonly error?: string
}
