/**
 * The path-scope guard in the tool pipeline: it runs AFTER every prepended
 * rewrite listener (hooks), so it classifies the final path; it refuses
 * unsafe and read-only targets before authorization; and its match is
 * dropped once authorization settles, so it neither leaks nor authorizes a
 * later call.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kernel, ToolsService, fsTools, type ToolCall } from 'mini-dsh'
import { attachPathScopeGuard } from '../../src/web/path-scope-guard.ts'

let root = ''
let outside = ''

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-scope-guard-')))
  outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-scope-guard-out-')))
  await fs.writeFile(path.join(outside, 'x.txt'), 'outside', 'utf8')
  await fs.writeFile(path.join(root, 'in.txt'), 'inside', 'utf8')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

function boot(): { kernel: Kernel; guard: ReturnType<typeof attachPathScopeGuard> } {
  const kernel = new Kernel()
  kernel.ctx.plugin(ToolsService)
  for (const tool of fsTools()) kernel.ctx.tools.register(tool)
  kernel.ctx.tools.setRootResolver(() => ({ root }))
  const guard = attachPathScopeGuard(kernel.ctx, { exempt: () => false, proposeGrant: async () => undefined })
  kernel.ctx.tools.setApprovedPathResolver(async (call, allowed) => {
    const match = guard.take(undefined, call, allowed)
    return match === undefined ? undefined : [{ path: match.path, intent: match.intent }]
  })
  return { kernel, guard }
}

const read = (target: string): ToolCall => ({ id: 'call-1', name: 'Read', args: { path: target } })

describe('path-scope guard', () => {
  it('classifies the path a prepended rewrite hook produced, not the original', async () => {
    const { kernel, guard } = boot()
    let seen: ToolCall | undefined
    // Registered AFTER the guard but prepended — like the PreToolUse hooks.
    kernel.ctx.on('tools/rewrite', async (payload, next) => {
      const rewritten = { ...payload.call, args: { path: path.join(outside, 'x.txt') } }
      seen = rewritten
      // Forwarding only the call must still classify against the grant.
      return next({ call: rewritten })
    }, true)
    let matched: unknown
    kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      matched = guard.get(undefined, payload.call)
      return next()
    })
    const prepared = await kernel.ctx.tools.prepare(read('in.txt'))
    expect(seen).toBeDefined()
    expect(matched).toMatchObject({ path: path.join(outside, 'x.txt'), intent: 'read' })
    // No approval layer here: the allowed call reads the approved path once.
    expect((await prepared.execute()).output).toBe('outside')
    expect(guard.get(undefined, prepared.call)).toBeUndefined()
  })

  it('refuses unsafe targets before authorization and drops matches on deny', async () => {
    const { kernel, guard } = boot()
    const unc = await (await kernel.ctx.tools.prepare(read('\\\\host\\share\\x'))).execute()
    expect(unc.output).toMatch(/denied: .*network \(UNC\) and device paths/)

    kernel.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'test policy' }))
    const call = read(path.join(outside, 'x.txt'))
    const denied = await (await kernel.ctx.tools.prepare(call)).execute()
    expect(denied.output).toBe('denied: test policy')
    expect(guard.get(undefined, call)).toBeUndefined()
  })
})
