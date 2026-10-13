import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerGitAskpass, gitOperation, HttpError, updateProjectGitTrust, type GitAskpassFrame } from './api.ts'

const encoder = new TextEncoder()

/** A response whose body arrives in the given byte chunks, one `read()` each. */
function streamOf(chunks: readonly Uint8Array[], status = 200): Response {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index++]
      if (next === undefined) controller.close()
      else controller.enqueue(next)
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } })
}

/** The bytes split at the given offsets, so frames and even UTF-8 characters straddle chunks. */
function splitAt(text: string, ...offsets: number[]): Uint8Array[] {
  const bytes = encoder.encode(text)
  const cuts = [0, ...offsets, bytes.length]
  return cuts.slice(0, -1).map((start, i) => bytes.slice(start, cuts[i + 1]))
}

const ASKPASS = { type: 'askpass', promptId: 'p1', operation: 'push', prompt: "Password for 'https://x':" }
const DONE = { type: 'done', ok: true, stdout: 'ok é', stderr: '' }
const NDJSON = `${JSON.stringify(ASKPASS)}\n${JSON.stringify(DONE)}\n`

interface Call { readonly url: string; readonly init: RequestInit }

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gitOperation NDJSON client', () => {
  it('posts the body without the route type and resolves with the done frame', async () => {
    const calls = stubFetch(() => streamOf([encoder.encode(`${JSON.stringify(DONE)}\n`)]))
    const done = await gitOperation('w 1', 'p1', { type: 'commit', message: 'msg', amend: true }, async () => ({ cancel: true }))
    expect(done).toEqual(DONE)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/workspaces/w%201/projects/p1/git/commit')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ message: 'msg', amend: true })
  })

  it('reconstructs lines and characters split across arbitrary chunk boundaries', async () => {
    const text = `${JSON.stringify(DONE)}\n`
    // Offsets inside the first frame, inside the two-byte "é", and just before the newline.
    const accent = encoder.encode(text.slice(0, text.indexOf('é'))).length
    stubFetch(() => streamOf(splitAt(text, 3, 17, accent + 1, text.length - 2)))
    expect(await gitOperation('w', 'p', { type: 'stage-all' }, async () => ({ cancel: true }))).toEqual(DONE)
  })

  it('handles several frames in one chunk and a final frame without a newline', async () => {
    const answers: string[] = []
    const calls = stubFetch(({ url }) => {
      if (url.includes('/git/askpass/')) return new Response('{"answered":true}', { status: 200 })
      return streamOf([encoder.encode(`${JSON.stringify(ASKPASS)}\n${JSON.stringify(DONE)}`)])
    })
    const done = await gitOperation('w', 'p', { type: 'push', remote: 'origin', branch: 'main' }, async (prompt) => {
      answers.push(prompt.promptId)
      return { password: 'pw' }
    })
    expect(done).toEqual(DONE)
    expect(answers).toEqual(['p1'])
    await vi.waitFor(() => expect(calls).toHaveLength(2))
  })

  it('hands each askpass frame to onAskpass as it arrives and posts the password', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const seen: GitAskpassFrame[] = []
    const calls = stubFetch(({ url }) => {
      if (url.includes('/git/askpass/')) return new Response('{"answered":true}', { status: 200 })
      const bytes = encoder.encode(NDJSON)
      const first = encoder.encode(`${JSON.stringify(ASKPASS)}\n`).length
      let sent = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 0) {
            sent = 1
            controller.enqueue(bytes.slice(0, first))
            return
          }
          // The prompt must be answered before git (and so the stream) can go on.
          await gate
          controller.enqueue(bytes.slice(first))
          controller.close()
        },
      }), { status: 200 })
    })
    const pending = gitOperation('w', 'p', { type: 'push', remote: 'origin', branch: 'main' }, async (prompt) => {
      seen.push(prompt)
      return { password: 's3cret' }
    })
    await vi.waitFor(() => expect(calls.some((call) => call.url.endsWith('/git/askpass/p1'))).toBe(true))
    expect(seen).toEqual([ASKPASS])
    const answer = calls.find((call) => call.url.endsWith('/git/askpass/p1'))!
    expect(answer.init.method).toBe('POST')
    expect(JSON.parse(answer.init.body as string)).toEqual({ password: 's3cret' })
    release()
    expect(await pending).toEqual(DONE)
  })

  /** A server that raises one prompt and only finishes (with `last`) once the prompt has been answered. */
  function stubPromptServer(last: object): Call[] {
    let answered!: () => void
    const gate = new Promise<void>((resolve) => { answered = resolve })
    return stubFetch(({ url }) => {
      if (url.includes('/git/askpass/')) {
        answered()
        return new Response('{"answered":true}', { status: 200 })
      }
      let step = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (step++ === 0) {
            controller.enqueue(encoder.encode(`${JSON.stringify(ASKPASS)}\n`))
            return
          }
          await gate
          controller.enqueue(encoder.encode(`${JSON.stringify(last)}\n`))
          controller.close()
        },
      }), { status: 200 })
    })
  }

  it('posts { cancel: true } when the prompt is cancelled', async () => {
    const calls = stubPromptServer({ type: 'done', ok: false, stdout: '', stderr: '', cancelled: true })
    const done = await gitOperation('w', 'p', { type: 'fetch', remote: 'origin' }, async () => ({ cancel: true }))
    expect(done.cancelled).toBe(true)
    const answer = calls.find((call) => call.url.endsWith('/git/askpass/p1'))!
    expect(JSON.parse(answer.init.body as string)).toEqual({ cancel: true })
  })

  it('a rejected onAskpass is a cancel', async () => {
    const calls = stubPromptServer({ type: 'done', ok: false, stdout: '', stderr: '', cancelled: true })
    await gitOperation('w', 'p', { type: 'pull', remote: 'origin' }, async () => { throw new Error('dialog closed') })
    const answer = calls.find((call) => call.url.endsWith('/git/askpass/p1'))!
    expect(JSON.parse(answer.init.body as string)).toEqual({ cancel: true })
  })

  it('aborts the request when the answer cannot be delivered', async () => {
    let aborted = false
    stubFetch(({ url, init }) => {
      if (url.includes('/git/askpass/')) return new Response('{"error":"no such prompt"}', { status: 404 })
      init.signal?.addEventListener('abort', () => { aborted = true })
      let step = 0
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (step++ === 0) {
            controller.enqueue(encoder.encode(`${JSON.stringify(ASKPASS)}\n`))
            return undefined
          }
          return new Promise<void>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        },
      }), { status: 200 })
    })
    await expect(gitOperation('w', 'p', { type: 'push', remote: 'o', branch: 'b' }, async () => ({ password: 'x' }))).rejects.toBeInstanceOf(HttpError)
    expect(aborted).toBe(true)
  })

  it('accepts a done frame without status and keeps query results', async () => {
    stubFetch(() => streamOf([encoder.encode('{"type":"done","ok":true,"stdout":"","stderr":"","remotes":["origin"]}\n')]))
    const done = await gitOperation('w', 'p', { type: 'remotes', branch: 'main' }, async () => ({ cancel: true }))
    expect(done.status).toBeUndefined()
    expect(done.remotes).toEqual(['origin'])
  })

  it('throws HttpError for an error before the stream starts', async () => {
    stubFetch(() => new Response('{"error":"paths must be an array of strings"}', { status: 400 }))
    const error = await gitOperation('w', 'p', { type: 'stage', paths: [] }, async () => ({ cancel: true })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).body).toContain('paths must be')
  })

  it.each([401, 404])('throws HttpError for HTTP %i', async (status) => {
    stubFetch(() => new Response('{"error":"nope"}', { status }))
    const error = await gitOperation('w', 'p', { type: 'push', remote: 'o', branch: 'b' }, async () => ({ cancel: true })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(status)
  })

  it('rejects when the stream ends without a done frame', async () => {
    stubFetch(({ url }) => url.includes('/git/askpass/')
      ? new Response('{"answered":true}', { status: 200 })
      : streamOf([encoder.encode(`${JSON.stringify(ASKPASS)}\n`)]))
    await expect(gitOperation('w', 'p', { type: 'pull', remote: 'o' }, async () => ({ cancel: true }))).rejects.toThrow('ended without a result')
  })

  it('rejects on a malformed frame', async () => {
    stubFetch(() => streamOf([encoder.encode('not json\n')]))
    await expect(gitOperation('w', 'p', { type: 'stage-all' }, async () => ({ cancel: true }))).rejects.toThrow('malformed frame')
  })
})

describe('answerGitAskpass and updateProjectGitTrust', () => {
  it('posts the answer to the prompt route', async () => {
    const calls = stubFetch(() => new Response('{"answered":true}', { status: 200 }))
    await answerGitAskpass('w', 'p', 'a/b', { password: 'x' })
    expect(calls[0]!.url).toBe('/api/workspaces/w/projects/p/git/askpass/a%2Fb')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ password: 'x' })
  })

  it('throws HttpError for an unknown prompt', async () => {
    stubFetch(() => new Response('{"error":"no such prompt"}', { status: 404 }))
    await expect(answerGitAskpass('w', 'p', 'gone', { cancel: true })).rejects.toBeInstanceOf(HttpError)
  })

  it('PATCHes gitTrusted on the project', async () => {
    const calls = stubFetch(() => new Response('{"id":"p","name":"P","workspaceId":"w","path":"/x","createdAt":1,"gitTrusted":true}', { status: 200 }))
    const row = await updateProjectGitTrust('w', 'p', true)
    expect(calls[0]!.url).toBe('/api/workspaces/w/projects/p')
    expect(calls[0]!.init.method).toBe('PATCH')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ gitTrusted: true })
    expect(row.gitTrusted).toBe(true)
  })
})
