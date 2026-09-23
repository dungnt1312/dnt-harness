/**
 * Out-of-grant file access through the web host: a path outside every
 * granted folder forces an approval (even when the tool itself is allowed),
 * carries a durable scope warning, runs once on allow, fails on deny, and —
 * answered "for this session" — grants its folder so the next call needs no
 * approval. Modes with `outOfGrant: allow` (bundled Full access and its
 * duplicates) skip the extra approval; unsafe paths and writes into a
 * read-only grant are refused without any question; a settings change in the
 * question's workspace never auto-allows it.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'mini-dsh'
import { DEFAULT_CONFIG } from '../../src/harness/guard/defaults.ts'

let base = ''
let home = ''
let primary = ''
let outside = ''
let readOnly = ''
let server: WebServer | undefined

/** `read <path>` / `write <path>` / `grep <dir>` run one tool call, then answer. */
const actor: LlmProvider = {
  name: 'actor',
  models: ['actor'],
  async *stream(request) {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
    const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
    const lastUserIndex = request.messages.lastIndexOf(lastUser!)
    const answered = request.messages.slice(lastUserIndex).some((message) => message.role === 'tool')
    // A child's brief wraps the prompt, so the command is found anywhere.
    const command = /\b(read|write|grep) (\S+)/.exec(text)
    if (!answered && command !== null) {
      const verb = command[1]
      const target = command[2] ?? ''
      const id = `c-${Math.random().toString(36).slice(2)}`
      if (verb === 'read') { yield { type: 'toolCalls', calls: [{ id, name: 'Read', args: { path: target } }] }; return }
      if (verb === 'write') { yield { type: 'toolCalls', calls: [{ id, name: 'Write', args: { path: target, content: 'written' } }] }; return }
      if (verb === 'grep') { yield { type: 'toolCalls', calls: [{ id, name: 'Grep', args: { pattern: 'secret', path: target } }] }; return }
    }
    yield { type: 'delta', delta: 'done' }
  },
}

interface Frame {
  readonly kind: string
  readonly approvalId?: string
  readonly scopeWarning?: string
  readonly proposedGrant?: string
  readonly event?: { readonly type: string; readonly ok?: boolean; readonly output?: string; readonly [key: string]: unknown }
}

/** A live SSE subscription collecting every frame. */
class Stream {
  readonly frames: Frame[] = []
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private closed = false

  constructor(response: Response) {
    this.reader = (response.body as ReadableStream<Uint8Array>).getReader()
    void this.pump()
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!this.closed) {
        const chunk = await this.reader.read()
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const data = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          if (data !== undefined) this.frames.push(JSON.parse(data.slice('data: '.length)) as Frame)
        }
      }
    } catch {
      // closed
    }
  }

  async wait(predicate: (frame: Frame) => boolean, what: string, from = 0): Promise<Frame> {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const found = this.frames.slice(from).find(predicate)
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  close(): void {
    this.closed = true
    this.reader.cancel().catch(() => {})
  }
}

const streams: Stream[] = []

function send(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function idOf(response: Response): Promise<string> {
  return String(((await response.json()) as { id: string }).id)
}

interface Fixture {
  readonly url: string
  readonly wsId: string
  readonly sessionId: string
  readonly stream: Stream
  say(text: string): Promise<void>
  toolResult(from: number): Promise<Frame>
}

async function fixture(options: { yolo?: boolean } = {}): Promise<Fixture> {
  server = await createWebServer({ home, providers: [actor], configFile: path.join(home, 'providers.json'), ...(options.yolo === true ? { yolo: true } : {}) })
  const url = server.url
  const wsId = ((await (await fetch(`${url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const projectId = await idOf(await send('POST', `${url}/api/workspaces/${wsId}/projects`, { name: 'Main', path: primary }))
  const sessionId = await idOf(await send('POST', `${url}/api/workspaces/${wsId}/sessions`, { projectId }))
  const stream = new Stream(await fetch(`${url}/api/workspaces/${wsId}/sessions/${sessionId}/events`))
  streams.push(stream)
  await stream.wait((frame) => frame.kind === 'snapshot', 'snapshot')
  return {
    url, wsId, sessionId, stream,
    async say(text) {
      await send('POST', `${url}/api/workspaces/${wsId}/sessions/${sessionId}/messages`, { content: text })
    },
    toolResult: (from) => stream.wait((frame) => frame.kind === 'session' && frame.event?.type === 'tool/result', 'tool result', from),
  }
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-oog-')))
  home = path.join(base, 'home')
  primary = path.join(base, 'primary')
  outside = path.join(base, 'outside')
  readOnly = path.join(base, 'readonly')
  for (const dir of [home, primary, outside, readOnly]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(outside, 'a.txt'), 'secret a\n', 'utf8')
  await fs.writeFile(path.join(outside, 'b.txt'), 'secret b\n', 'utf8')
})

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close()
  await server?.close().catch(() => {})
  server = undefined
  await fs.rm(base, { recursive: true, force: true })
})

describe('out-of-grant approvals', () => {
  it('an allowed tool still asks outside the grants; allow runs once and records the warning', async () => {
    const f = await fixture()
    const target = path.join(outside, 'a.txt')
    const mark = f.stream.frames.length
    await f.say(`read ${target}`)
    const question = await f.stream.wait((frame) => frame.kind === 'approval', 'approval', mark)
    expect(question.scopeWarning).toBe(`Outside granted folders: ${target} (read)`)
    expect(question.proposedGrant).toBe(outside)
    const request = await f.stream.wait((frame) => frame.event?.type === 'approval/request', 'approval/request event', mark)
    expect(request.event?.['scopeWarning']).toBe(question.scopeWarning)
    expect((await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: true })).status).toBe(200)
    const result = await f.toolResult(mark)
    expect(result.event?.ok).toBe(true)
    expect(result.event?.output).toContain('secret a')

    // Once only: the next read in the same folder asks again.
    const again = f.stream.frames.length
    await f.say(`read ${path.join(outside, 'b.txt')}`)
    await f.stream.wait((frame) => frame.kind === 'approval', 'second approval', again)
  }, 20_000)

  it('deny fails the call without reading', async () => {
    const f = await fixture()
    const mark = f.stream.frames.length
    await f.say(`read ${path.join(outside, 'a.txt')}`)
    const question = await f.stream.wait((frame) => frame.kind === 'approval', 'approval', mark)
    await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: false })
    const result = await f.toolResult(mark)
    expect(result.event?.ok).toBe(false)
    expect(result.event?.output).not.toContain('secret')
  }, 20_000)

  it('"allow for this session" grants the folder so the next call runs without a question', async () => {
    const f = await fixture()
    const mark = f.stream.frames.length
    await f.say(`read ${path.join(outside, 'a.txt')}`)
    const question = await f.stream.wait((frame) => frame.kind === 'approval', 'approval', mark)
    expect((await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: true, scope: 'session' })).status).toBe(200)
    expect((await f.toolResult(mark)).event?.ok).toBe(true)
    const grants = (await (await fetch(`${f.url}/api/workspaces/${f.wsId}/sessions/${f.sessionId}/grants`)).json()) as { roots: unknown[] }
    expect(grants.roots).toEqual([{ path: outside, access: 'read' }])
    // The durable grant names the approval that created it.
    const recorded = f.stream.frames.find((frame) => frame.event?.type === 'session/grants')
    expect(recorded?.event?.['approvalId']).toBe(question.approvalId)

    const next = f.stream.frames.length
    await f.say(`read ${path.join(outside, 'b.txt')}`)
    const result = await f.toolResult(next)
    expect(result.event?.output).toContain('secret b')
    expect(f.stream.frames.slice(next).some((frame) => frame.kind === 'approval')).toBe(false)
  }, 20_000)

  it('a session answer is refused when the folder is not grantable', async () => {
    const f = await fixture()
    const mark = f.stream.frames.length
    await fs.writeFile(path.join(base, 'top.txt'), 'secret top\n', 'utf8')
    // The parent folder of this file contains the app home: never grantable.
    await f.say(`read ${path.join(base, 'top.txt')}`)
    const question = await f.stream.wait((frame) => frame.kind === 'approval', 'approval', mark)
    expect(question.proposedGrant).toBeUndefined()
    expect((await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: true, scope: 'session' })).status).toBe(400)
    await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: false })
  }, 20_000)

  it('Full access and its duplicates run out-of-grant paths without a question', async () => {
    const f = await fixture()
    expect((await send('PUT', `${f.url}/api/workspaces/${f.wsId}/mode`, { modeId: 'full-access' })).status).toBe(200)
    let mark = f.stream.frames.length
    await f.say(`read ${path.join(outside, 'a.txt')}`)
    expect((await f.toolResult(mark)).event?.output).toContain('secret a')
    expect(f.stream.frames.slice(mark).some((frame) => frame.kind === 'approval')).toBe(false)

    expect((await send('POST', `${f.url}/api/workspaces/${f.wsId}/modes/full-access/duplicate`, { newId: 'full-copy' })).status).toBeLessThan(300)
    expect((await send('PUT', `${f.url}/api/workspaces/${f.wsId}/mode`, { modeId: 'full-copy' })).status).toBe(200)
    mark = f.stream.frames.length
    await f.say(`read ${path.join(outside, 'b.txt')}`)
    expect((await f.toolResult(mark)).event?.output).toContain('secret b')
    expect(f.stream.frames.slice(mark).some((frame) => frame.kind === 'approval')).toBe(false)
  }, 20_000)

  it('--yolo runs out-of-grant paths without a question', async () => {
    const f = await fixture({ yolo: true })
    const mark = f.stream.frames.length
    await f.say(`read ${path.join(outside, 'a.txt')}`)
    expect((await f.toolResult(mark)).event?.output).toContain('secret a')
  }, 20_000)

  it('network paths and writes into a read-only grant are refused without a question', async () => {
    const f = await fixture()
    await send('PUT', `${f.url}/api/workspaces/${f.wsId}/sessions/${f.sessionId}/grants`, { expectedRevision: 0, roots: [{ path: readOnly, access: 'read' }] })
    let mark = f.stream.frames.length
    await f.say('read \\\\attacker.example\\share\\x.txt')
    let result = await f.toolResult(mark)
    expect(result.event?.output).toMatch(/network \(UNC\) and device paths/)

    mark = f.stream.frames.length
    await f.say(`write ${path.join(readOnly, 'x.txt')}`)
    // Write asks in this mode for its own reason; the refusal must come first.
    result = await f.toolResult(mark)
    expect(result.event?.output).toMatch(/read-only granted folder/)
    expect(f.stream.frames.slice(mark).some((frame) => frame.kind === 'approval')).toBe(false)
  }, 20_000)

  it('a child agent\'s question offers no session answer', async () => {
    const f = await fixture()
    const mark = f.stream.frames.length
    const spawned = await send('POST', `${f.url}/api/workspaces/${f.wsId}/agents/explorer`, {
      rootSessionId: f.sessionId,
      task: { prompt: `read ${path.join(outside, 'a.txt')}` },
    })
    expect(spawned.status).toBe(202)
    const question = await f.stream.wait((frame) => frame.kind === 'approval', 'child approval', mark)
    expect(question.scopeWarning).toContain(path.join(outside, 'a.txt'))
    expect(question.proposedGrant).toBeUndefined()
    expect((await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: true, scope: 'session' })).status).toBe(400)
    await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: false })
  }, 20_000)

  it('a grant revoked while the call waits for approval no longer authorizes it', async () => {
    const f = await fixture()
    const grantsUrl = `${f.url}/api/workspaces/${f.wsId}/sessions/${f.sessionId}/grants`
    await send('PUT', grantsUrl, { expectedRevision: 0, roots: [{ path: outside, access: 'write' }] })
    const mark = f.stream.frames.length
    // Write asks in this mode on its own; the grant is removed before answering.
    await f.say(`write ${path.join(outside, 'new.txt')}`)
    const question = await f.stream.wait((frame) => frame.kind === 'approval', 'write approval', mark)
    expect(question.scopeWarning).toBeUndefined()
    await send('PUT', grantsUrl, { expectedRevision: 1, roots: [] })
    await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: true })
    const result = await f.toolResult(mark)
    expect(result.event?.ok).toBe(false)
    await expect(fs.readFile(path.join(outside, 'new.txt'), 'utf8')).rejects.toThrow()
  }, 20_000)

  it('a settings save in the question\'s workspace never auto-allows it', async () => {
    const f = await fixture()
    // The DEFAULT workspace runs Full access; the question lives in another
    // workspace, so an ambient-scope fallback would wrongly exempt it.
    expect((await send('PUT', `${f.url}/api/workspaces/${f.wsId}/mode`, { modeId: 'full-access' })).status).toBe(200)
    const other = await idOf(await send('POST', `${f.url}/api/workspaces`, { name: 'Other' }))
    const otherProject = await idOf(await send('POST', `${f.url}/api/workspaces/${other}/projects`, { name: 'Main', path: primary }))
    const otherSession = await idOf(await send('POST', `${f.url}/api/workspaces/${other}/sessions`, { projectId: otherProject }))
    const stream = new Stream(await fetch(`${f.url}/api/workspaces/${other}/sessions/${otherSession}/events`))
    streams.push(stream)
    await stream.wait((frame) => frame.kind === 'snapshot', 'snapshot')
    await send('POST', `${f.url}/api/workspaces/${other}/sessions/${otherSession}/messages`, { content: `read ${path.join(outside, 'a.txt')}` })
    const question = await stream.wait((frame) => frame.kind === 'approval', 'approval')
    const guard = (await (await fetch(`${f.url}/api/guard/dangerous-commands?workspaceId=${other}`)).json()) as { hash: string }
    expect((await send('PUT', `${f.url}/api/guard/dangerous-commands`, { workspaceId: other, config: DEFAULT_CONFIG, expectedHash: guard.hash })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(stream.frames.some((frame) => frame.event?.type === 'tool/result')).toBe(false)
    await send('POST', `${f.url}/api/approvals/${question.approvalId}`, { allow: false })
  }, 20_000)
})
