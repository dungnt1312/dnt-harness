import { afterEach, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { FakeScriptedLlm } from './fake-llm.ts'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

let server: WebServer | undefined
let root: string | undefined
afterEach(async () => {
  await server?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

it('emits an SSE id and replays only events after a valid Last-Event-ID', async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-resume-'))
  server = await createWebServer({ root, configFile: path.join(root, 'providers.json'), providers: [new FakeScriptedLlm(['done'])] })
  const created = await fetch(`${server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const session = await created.json() as { id: string }
  await fetch(`${server.url}/api/sessions/${session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) })
  const readFirst = async (cursor?: string) => {
    const abort = new AbortController()
    const response = await fetch(`${server!.url}/api/sessions/${session.id}/events`, { signal: abort.signal, ...(cursor !== undefined ? { headers: { 'Last-Event-ID': cursor } } : {}) })
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
    abort.abort()
    const frame = text.split('\n\n')[0]!
    const envelope = JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6))
    return { frame, envelope }
  }
  const first = await readFirst()
  expect(first.frame).toMatch(/^id: \d+\ndata: /)
  const cursor = first.envelope.events[0].seq as number
  const resumed = await readFirst(String(cursor))
  expect(resumed.envelope.kind).toBe('resume')
  expect(resumed.envelope.events.every((event: { seq: number }) => event.seq > cursor)).toBe(true)
  expect((await readFirst('99999999')).envelope.kind).toBe('snapshot')
  expect((await readFirst('invalid')).envelope.kind).toBe('snapshot')
})
