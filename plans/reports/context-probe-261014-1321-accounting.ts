import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWebServer, type LlmProvider, type WebServer } from '../../src/index.ts'
import { contextFill } from '../../web/lib/format.ts'

// Isolated diagnostic: no real provider, no production data, no source modifications.
async function scenario(large: boolean) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-context-audit-'))
  let server: WebServer | undefined
  let chatCalls = 0
  const provider: LlmProvider = {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      const summary = request.messages.some((m) => typeof m.content === 'string' && m.content.includes('Primary Request and Intent'))
      if (summary) {
        yield { type: 'delta', delta: 'CHECKPOINT SUMMARY TEXT' }
      } else {
        chatCalls++
        yield { type: 'delta', delta: large && chatCalls === 1 ? 'x'.repeat(1_100_000) : 'hello' }
        yield { type: 'usage', usage: { inputTokens: 100_000, cachedInputTokens: 50_000, outputTokens: 1 } }
        yield { type: 'usage', usage: { inputTokens: 120_000, cachedInputTokens: 110_000, outputTokens: 2 } }
      }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
  const boot = async () => {
    server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), limits: { automaticCompactionPressure: 0.85 } })
    return server
  }
  try {
    await boot()
    const wsId = (await (await fetch(`${server!.url}/api/workspaces`)).json())[0].id
    const base = () => `${server!.url}/api/workspaces/${wsId}`
    const { id } = await (await fetch(`${base()}/sessions`, { method: 'POST' })).json()
    const endpoint = () => `${base()}/sessions/${id}`
    const manifest = async () => (await fetch(`${endpoint()}/manifest`)).json()
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    const log = async (): Promise<any[]> => (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const send = async (content: string, expectedTurns: number) => {
      await fetch(`${endpoint()}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
      const deadline = Date.now() + 10_000
      for (;;) {
        const events = await log().catch(() => [])
        const sessions = await (await fetch(`${base()}/sessions`)).json()
        if (events.filter((e) => e.type === 'turn/end').length >= expectedTurns && sessions.find((s: any) => s.id === id)?.status === 'idle') return
        if (Date.now() > deadline) throw new Error('turn did not settle')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    await send('first', 1)
    const before = await manifest()
    const durable = (await log()).findLast((e) => e.type === 'context/manifest').manifest
    assert.equal(contextFill(before).used, 120_000)
    assert.equal(durable.usage, undefined)
    if (!large) {
      assert.equal(before.usage.cacheableInputTokens, 220_000)
      assert.equal(before.usage.cachedInputTokens, 160_000)
      await server!.close(); server = undefined
      await boot()
      const restarted = await manifest()
      assert.equal(restarted.usage, undefined)
      assert.equal(contextFill(restarted).used, before.budget.usedTokens)
      console.log(JSON.stringify({ scenario: 'usage-restart', live: contextFill(before), durable: contextFill(durable), afterRestart: contextFill(restarted), liveCacheRate: 160_000 / 220_000, expectedLastReportCacheRate: 110_000 / 120_000 }, null, 2))
      await send('second', 2)
    } else {
      await send('second', 2)
    }
    // Large scenario automatically compacts; small scenario uses the manual route.
    let compact: any
    if (!large) {
      const response = await fetch(`${endpoint()}/compact`, { method: 'POST' })
      assert.equal(response.status, 200)
      compact = await response.json()
    } else {
      compact = (await log()).findLast((e) => e.type === 'compaction/end' && !e.error)
      assert.ok(compact, 'pre-trim pressure should automatically compact')
    }
    const afterCompact = await manifest()
    const partsTotal = Object.values(afterCompact.breakdown).reduce((sum: number, value) => sum + Number(value), 0)
    const lastDurable = (await log()).findLast((e) => e.type === 'context/manifest').manifest
    console.log(JSON.stringify({ scenario: large ? 'trimmed-compaction' : 'reported-compaction', tokensBefore: compact.tokensBefore, tokensAfter: compact.tokensAfter, meterAfterCompact: afterCompact.budget.usedTokens, breakdownSum: partsTotal, preTrimTokens: lastDurable.budget.preTrimTokens, assembledTokens: lastDurable.budget.usedTokens, wholeWindow: lastDurable.budget.contextLimitTokens }, null, 2))
    assert.notEqual(partsTotal, afterCompact.budget.usedTokens)
    await server!.close(); server = undefined
    await boot()
    const afterCompactRestart = await manifest()
    assert.equal(afterCompactRestart.budget.usedTokens, lastDurable.budget.usedTokens)
    await send('continue', 3)
    const next = await manifest()
    console.log(JSON.stringify({ scenario: large ? 'trimmed-next-request' : 'next-request', compactEstimate: afterCompact.budget.usedTokens, restartedEstimate: afterCompactRestart.budget.usedTokens, nextAssembledEstimate: next.budget.usedTokens, nextReported: next.usage.last.inputTokens }, null, 2))
    if (large) assert.equal(afterCompact.budget.usedTokens, 0)
  } finally {
    await server?.close()
    await fs.rm(home, { recursive: true, force: true })
  }
}
await scenario(false)
await scenario(true)
