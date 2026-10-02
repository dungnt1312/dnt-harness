import type { Context } from 'dnt-harness'

export const name = 'hello-fixture'

export function apply(ctx: Context): void {
  ctx.provide('helloValue', 'hello from fixture')
}
