import type { Context } from 'dnt-harness'

export const name = 'disabled-fixture'

export function apply(ctx: Context): void {
  ctx.provide('shouldNotExist', true)
}
