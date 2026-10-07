import type { HarnessLimits } from '../limits.ts'
import type { LimitKey } from '../limits-config.ts'

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
