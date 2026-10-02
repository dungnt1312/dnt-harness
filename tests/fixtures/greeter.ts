import { Service, type Context } from 'dnt-harness'

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string): string {
    return `Hello, ${who}!`
  }
}

export const name = 'greeter-fixture'

export function apply(ctx: Context): void {
  ctx.plugin(GreeterService)
}
