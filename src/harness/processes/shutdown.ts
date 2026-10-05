/** Attempt every teardown stage, then surface all failures instead of leaking later resources. */
export async function runCleanup(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try { await step() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'shutdown cleanup failed')
}

/** Node timer range; larger durations must never silently become a 1ms timeout. */
export const MAX_TIMER_MS = 2_147_483_647
export function timerBudget(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : fallback
}

export async function boundedCleanup(work: () => Promise<void>, timeoutMs = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup deadline exceeded; ownership retained')), timeoutMs) })])
  } finally { clearTimeout(timer) }
}
