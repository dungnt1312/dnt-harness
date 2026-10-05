import { expect, it } from 'vitest'
import { runCleanup } from '../../../src/harness/processes/shutdown.ts'
import { AgentsService, Kernel } from 'dnt-harness'
import { resolveLimits } from '../../../src/harness/limits.ts'

it('cleanup attempts all steps and preserves errors', async () => {
  const steps: string[] = []
  await expect(runCleanup([
    async () => { steps.push('flush'); throw new Error('disk') },
    async () => { steps.push('kernel') },
    async () => { steps.push('lock') },
  ])).rejects.toThrow('shutdown cleanup failed')
  expect(steps).toEqual(['flush', 'kernel', 'lock'])
})
it('agent join has a deadline and fences late persistence', async () => {
  const kernel = new Kernel()
  const service = new AgentsService(kernel.ctx)
  let fenced = false
  const fake = { busy: true, closeAdmission() {}, stop() {}, async fencePersistence() { fenced = true } }
  ;(service as unknown as { bySession: Map<string, unknown> }).bySession.set('stuck', fake)
  await expect(service.stopAll({ timeoutMs: 10 })).rejects.toThrow('shutdown join timed out')
  expect(fenced).toBe(true)
  await kernel.stop()
})
it('overflowing lifecycle timer overrides fall back to defaults', () => {
  expect(resolveLimits({ subagentBackgroundBashMaxMs: 2147483648, toolTimeoutMs: 2147483648, bashMaxWaitMs: 2147483648 })).toMatchObject({ subagentBackgroundBashMaxMs: 3600000, toolTimeoutMs: 120000, bashMaxWaitMs: 600000 })
})
it('disposeAll attempts every owner despite one disposal failure', async () => {
  const { ProcessRegistry } = await import('../../../src/harness/processes/registry.ts')
  const registry = new ProcessRegistry()
  const seen: string[] = []
  const records = (registry as unknown as { byId: Map<string, unknown> }).byId
  records.set('one', { sessionId: 'first' }); records.set('two', { sessionId: 'second' })
  registry.dispose = async id => { seen.push(id); if (id === 'first') throw new Error('stuck') }
  await expect(registry.disposeAll()).rejects.toThrow('process disposal failed')
  expect(seen).toEqual(['first', 'second'])
})
it('stalled persistence drain returns bounded unsafe-ownership outcome', async () => {
  const kernel = new Kernel(); const service = new AgentsService(kernel.ctx)
  const fake = { busy: true, closeAdmission() {}, stop() {}, fencePersistence: () => new Promise<void>(() => {}) }
  ;(service as unknown as { bySession: Map<string, unknown> }).bySession.set('stuck', fake)
  await expect(service.stopAll({ timeoutMs: 10 })).rejects.toThrow('canonical writers unresolved')
  expect(service.persistenceSafe).toBe(false)
  await kernel.stop()
})
it('bounded cleanup permits subsequent teardown when a stage stalls', async () => {
  const { boundedCleanup } = await import('../../../src/harness/processes/shutdown.ts')
  let disposed = false
  await expect(runCleanup([
    () => boundedCleanup(() => new Promise<void>(() => {}), 10),
    async () => { disposed = true },
  ])).rejects.toThrow('shutdown cleanup failed')
  expect(disposed).toBe(true)
})
