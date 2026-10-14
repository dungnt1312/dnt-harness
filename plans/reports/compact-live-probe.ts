import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Kernel, Session, OpenAiCompletionsProvider } from '../../src/index.ts'
import { LlmService } from '../../src/harness/llm/service.ts'
import { LogicalRequest } from '../../src/harness/llm/request-lifecycle.ts'
import { FileSessionStore } from '../../src/harness/storage/file-session-store.ts'
import { CheckpointStore, compactSession, recoverCanonicalCheckpoint, projectForSummary } from '../../src/harness/context/compaction.ts'
import { createCompactionSummarizer } from '../../src/web/llm-summarizer.ts'
import { loadProviderStore, maxOutputTokenOverrides } from '../../src/web/provider-store.ts'
import { buildContext } from '../../src/harness/context/builder.ts'
import { DEFAULT_BUDGET } from '../../src/harness/context/budget.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import type { ModelRequest, StreamOptions } from '../../src/harness/llm/types.ts'

// Opt-in diagnostic, never a test-suite implicit provider call. All writers are
// under a new temporary root. Source home and provider configuration are read-only.
assert.equal(process.env['COMPACT_LIVE_APPROVED'], '1', 'explicit opt-in required')
const source = path.join(os.homedir(), '.dnt-harness/data/workspaces/ws-mur65pzr745ftn/sessions/session-mv5ffu5ceex0a5/events.jsonl')
const cutoff = 25891
const original = await fs.readFile(source)
const events = original.toString('utf8').trim().split('\n').map(line => JSON.parse(line) as SessionEvent).filter(e => e.seq <= cutoff)
const model = 'claude-sonnet-5-5'
const configured = loadProviderStore(path.join(os.homedir(), '.dnt-harness/providers.json'))
const selected = events.findLast(e => e.type === 'session/model') as any
const entry = configured.providers.find(p => p.id === selected?.provider && p.enabled)
  ?? configured.providers.find(p => p.enabled && p.models.includes(model))
assert(entry, 'configured provider for selected model not found')
const resume = process.env['COMPACT_RESUME_ROOT']
const root = resume ?? await fs.mkdtemp(path.join(os.tmpdir(), 'compact-live-acceptance-'))
await fs.chmod(root, 0o700)
const id = 'session-acceptancecopy' as any
const store = new FileSessionStore({ dir: root })
await store.init()
if (resume === undefined) await store.replace(id, events)
const kernel = new Kernel()
kernel.ctx.plugin(LlmService)
kernel.ctx.llm.register(new OpenAiCompletionsProvider({ name: entry.id, apiKey: entry.apiKey, baseUrl: entry.baseUrl, models: entry.models, maxRetries: 0, maxOutputTokens: maxOutputTokenOverrides(entry) }))
const session = new Session(kernel.ctx, { id, store })
session.adoptHistory((await store.read(id)).events)
const checkpoints = new CheckpointStore(path.join(root, 'checkpoints'))
const seed = recoverCanonicalCheckpoint(session.committedEvents)
assert(seed, 'canonical seed required')
const text = projectForSummary(events, cutoff, undefined, seed.coversSeq)
const attempts: any[] = []
let chunk = 0
let reopened: FileSessionStore | undefined
const report: any = { root, model, provider: entry.id, cutoff, seedCutoff: seed.coversSeq, sourceChars: text.length, startedAt: Date.now(), attempts }
const persist = async () => fs.writeFile(path.join(root, resume === undefined ? 'metrics.json' : 'continuation-metrics.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ root, model, provider: entry.id, cutoff, seedCutoff: seed.coversSeq, sourceChars: text.length }))
const stream = (request: ModelRequest, options?: StreamOptions) => (async function* () {
  const input = request.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
  const reask = input.includes('HARD CONSTRAINT:')
  if (!reask) chunk++
  const row: any = { request: attempts.length + 1, chunk, reask, inputChars: input.length, maxOutputTokens: request.maxOutputTokens ?? null, startedAt: Date.now(), textChars: 0, thinkingChars: 0 }
  attempts.push(row)
  const owner = new LogicalRequest({ totalMs: 600_000, maxAttempts: 1 })
  try {
    for await (const event of kernel.ctx.llm.stream(request, { ...options, requestOwner: owner })) {
      if (event.type === 'delta') { if (event.thinking) row.thinkingChars += event.delta.length; else row.textChars += event.delta.length }
      if (event.type === 'usage') row.usage = event.usage
      if (event.type === 'completion') row.finish = event.finishReason
      yield event
    }
  } catch (error) { row.error = error instanceof Error ? error.message : 'request failed'; throw error }
  finally { owner.dispose(); row.durationMs = Date.now() - row.startedAt; await persist(); console.log(JSON.stringify(row)) }
})()
try {
  const summary = createCompactionSummarizer(stream, { providerName: entry.id, model })
  const checkpoint = resume === undefined
    ? await compactSession(session, checkpoints, summary, { trigger: 'manual', model, seed, signal: AbortSignal.timeout(1_800_000) })
    : seed
  report.compactionPassed = true
  report.summaryChars = checkpoint.summary.length
  await fs.writeFile(path.join(root, 'summary.txt'), checkpoint.summary, { mode: 0o600 })
  assert.equal(checkpoint.coversSeq, cutoff)
  assert(checkpoint.summary.length > 0 && checkpoint.summary.length <= 24_000)
  await session.durable()
  // Restart read from disk, not the in-memory checkpoint or sidecar cache.
  await store.close()
  reopened = new FileSessionStore({ dir: root })
  const recoveredEvents = (await reopened.read(id)).events
  const recovered = recoverCanonicalCheckpoint(recoveredEvents)
  assert.equal(recovered?.summary, checkpoint.summary)
  assert.equal(recovered?.coversSeq, cutoff)
  report.restartVerified = true
  const follow = new Session(kernel.ctx, { id, store: reopened })
  follow.adoptHistory(recoveredEvents)
  follow.append({ type: 'turn/start', turnId: 'continuation-probe' as any })
  follow.append({ type: 'user/message', turnId: 'continuation-probe' as any, content: 'Chỉ trả lời từ context, không dùng tool. Trong tối đa 1200 từ, liệt kê ràng buộc của người dùng, việc còn dở, lỗi chưa giải quyết và kết quả đã kiểm chứng. Không đoán hoặc coi việc chưa làm là hoàn tất.' })
  await follow.durable()
  const mode: any = { definition: { id: 'acceptance', name: 'Acceptance', instructions: '', sources: { history: 'compact', workspaceInstructions: false, skills: 'off', memoryPinned: false, memoryRetrieval: false }, toolExposure: [], permissionDefaults: {} }, source: 'workspace' }
  const assembled = buildContext({ events: follow.committedEvents, mode, modeRevision: 1, model, providerName: entry.id, schemas: [], activeSkills: [], pinnedMemory: [], budget: DEFAULT_BUDGET, compaction: recovered! })
  assert(assembled.messages.some(m => typeof m.content === 'string' && m.content.includes(checkpoint.summary)))
  let continuation = ''
  const owner = new LogicalRequest({ totalMs: 300_000, maxAttempts: 1 })
  try {
    for await (const e of kernel.ctx.llm.stream({ messages: assembled.messages, model, providerName: entry.id, maxOutputTokens: 12000 }, { requestOwner: owner })) {
      if (e.type === 'delta' && !e.thinking) continuation += e.delta
      if (e.type === 'usage') report.continuationUsage = e.usage
      if (e.type === 'completion') { report.continuationFinish = e.finishReason; assert.equal(e.finishReason, 'stop') }
    }
  } finally { owner.dispose() }
  await fs.writeFile(path.join(root, 'continuation.txt'), continuation, { mode: 0o600 })
  await fs.writeFile(path.join(root, 'summary.txt'), checkpoint.summary, { mode: 0o600 })
  await reopened.close()
  report.outcome = 'compacted'; report.summaryChars = checkpoint.summary.length; report.restartVerified = true; report.continuationChars = continuation.length
} catch (error) { report.outcome = 'failed'; report.error = error instanceof Error ? error.message : 'failed' }
finally {
  await store.close().catch(() => {})
  await reopened?.close().catch(() => {})
  await checkpoints.close()
  report.durationMs = Date.now() - report.startedAt
  // The live log may legitimately grow during the run. Verify its original byte prefix only.
  const live = await fs.readFile(source)
  assert(live.subarray(0, original.length).equals(original), 'live source prefix was changed')
  report.livePrefixUnchanged = true
  await persist()
  console.log(JSON.stringify({ outcome: report.outcome, error: report.error, durationMs: report.durationMs, root }))
}
