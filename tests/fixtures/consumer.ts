import type { Context } from 'dnt-harness'
import type { GreeterService } from './greeter.ts'

declare module 'dnt-harness' {
  interface Context {
    greeter: GreeterService
  }
}

export const name = 'consumer-fixture'

export const inject = ['greeter']

export function apply(ctx: Context): void {
  ctx.provide('consumerSaw', ctx.greeter.greet('world'))
}
