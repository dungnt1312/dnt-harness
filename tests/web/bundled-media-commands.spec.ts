/**
 * The bundled /image and /video slash commands, end to end through the web
 * host: they appear in the `/` catalog, expand around what the user typed, run
 * the paid tool without a second approval (their `allowed-tools`), and any
 * other layer can override them by name.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, withoutSentStamp, type LlmProvider, type ModelRequest, type StreamEvent, type WebServer } from 'dnt-harness'

const BUNDLED = path.resolve(import.meta.dirname, '../../commands')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('cmd-image')])
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from('cmd-video')])

let home = ''
let server: WebServer
let api: Server
let apiUrl = ''
let wsId = ''
const requests: ModelRequest[] = []
const imageCalls: string[] = []
/** What the scripted model does on its next request: call this tool, or answer. */
let script: { readonly tool?: { readonly name: string; readonly args: Record<string, unknown> } } = {}

const provider: LlmProvider = {
  name: 'scripted',
  models: ['scripted'],
  async *stream(request): AsyncIterable<StreamEvent> {
    requests.push(request)
    const lastIsToolResult = request.messages.at(-1)?.role === 'tool'
    if (script.tool !== undefined && !lastIsToolResult) {
      yield { type: 'toolCalls', calls: [{ id: `call-${requests.length}`, name: script.tool.name, args: script.tool.args }] }
      yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
      return
    }
    yield { type: 'delta', delta: 'Done.' }
    yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
  },
}

const json = (pathname: string, method: string, body?: unknown): Promise<Response> =>
  fetch(`${server.url}${pathname}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

type Event = { type: string; [key: string]: unknown }
async function events(sessionId: string): Promise<Event[]> {
  const raw = await fs.readFile(path.join(home, 'workspaces', wsId, 'sessions', sessionId, 'events.jsonl'), 'utf8').catch(() => '')
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Event)
}
async function run(content: string, modeId = 'ask-before-changes'): Promise<Event[]> {
  const { id } = (await (await json(`/api/workspaces/${wsId}/sessions`, 'POST', {})).json()) as { id: string }
  expect((await json(`/api/workspaces/${wsId}/sessions/${id}/mode`, 'PUT', { modeId })).status).toBe(200)
  expect((await json(`/api/workspaces/${wsId}/sessions/${id}/messages`, 'POST', { content })).status).toBe(202)
  let latest: Event[] = []
  await expect.poll(async () => { latest = await events(id); return latest.some((event) => event.type === 'turn/end' || event.type === 'turn/error' || event.type === 'approval/request') }, { timeout: 15_000 }).toBe(true)
  return latest
}
const userTexts = (request: ModelRequest | undefined): string[] =>
  (request?.messages ?? []).filter((message) => message.role === 'user').map((message) => withoutSentStamp(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-media-cmd-'))
  api = createServer((req, res) => {
    const url = req.url ?? ''
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST' && url === '/v1/images/generations') {
        imageCalls.push(url)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      } else if (req.method === 'POST' && url === '/v1/videos') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ request_id: 'r1' }))
      } else if (req.method === 'GET' && url === '/v1/videos/r1') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'done', video: { url: `http://127.0.0.1:${(api.address() as AddressInfo).port}/cdn.mp4`, duration: 2 } }))
      } else if (req.method === 'GET' && url === '/cdn.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' }).end(MP4)
      } else res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`

  server = await createWebServer({
    home,
    providers: [provider],
    activeModel: { provider: 'scripted', model: 'scripted' },
    configFile: path.join(home, 'providers.json'),
    bundledCommandsDir: BUNDLED,
  })
  wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const created = (await (await json('/api/providers', 'POST', { name: 'Media', baseUrl: apiUrl, apiKey: 'k', models: [] })).json()) as { id: string }
  expect((await json('/api/image-generation', 'PUT', { provider: created.id, model: 'img' })).status).toBe(200)
  expect((await json('/api/video-generation', 'PUT', { provider: created.id, model: 'vid' })).status).toBe(200)
})

afterAll(async () => {
  await server?.close().catch(() => {})
  await new Promise<void>((resolve) => api?.close(() => resolve()))
  await fs.rm(home, { recursive: true, force: true })
})

describe('bundled /image and /video commands', () => {
  it('are listed in the / catalog as bundled commands with a hint', async () => {
    const listed = (await (await fetch(`${server.url}/api/workspaces/${wsId}/commands`)).json()) as { commands: { name: string; source: string; description: string; argumentHint?: string; allowedTools?: string[]; disableModelInvocation?: true }[] }
    const image = listed.commands.find((row) => row.name === 'image')
    const video = listed.commands.find((row) => row.name === 'video')
    expect(image).toMatchObject({ source: 'bundled', argumentHint: '<describe the image>', allowedTools: ['GenerateImage'], disableModelInvocation: true })
    expect(video).toMatchObject({ source: 'bundled', argumentHint: '<describe the video>', allowedTools: ['GenerateVideo'], disableModelInvocation: true })
    expect(image?.description).toMatch(/image/i)
  })

  it('/image expands around the typed description and runs GenerateImage without a second approval', async () => {
    requests.length = 0
    script = { tool: { name: 'GenerateImage', args: { prompt: 'a red fox in snow' } } }
    const log = await run('/image a red fox in snow')

    expect(log.some((event) => event.type === 'approval/request')).toBe(false)
    expect(log.filter((event) => event.type === 'user/message').map((event) => [event['content'], event['origin']])).toEqual([
      ['/image a red fox in snow', undefined],
      [expect.stringContaining('a red fox in snow'), 'command'],
    ])
    expect(userTexts(requests[0])[1]).toMatch(/Call the GenerateImage tool/)
    expect(userTexts(requests[0])[1]).toContain('a red fox in snow')
    const result = log.find((event) => event.type === 'tool/result')
    expect(result?.['ok']).toBe(true)
    expect(JSON.parse(String(result?.['output'])).attachmentId).toMatch(/^[0-9a-f]{64}$/)
    expect(imageCalls).toHaveLength(1)
  })

  it('/video expands and runs GenerateVideo without a second approval', async () => {
    requests.length = 0
    script = { tool: { name: 'GenerateVideo', args: { prompt: 'waves at dusk', seconds: '2' } } }
    const log = await run('/video waves at dusk')

    expect(log.some((event) => event.type === 'approval/request')).toBe(false)
    expect(userTexts(requests[0])[1]).toMatch(/Call the GenerateVideo tool/)
    expect(userTexts(requests[0])[1]).toContain('waves at dusk')
    const result = log.find((event) => event.type === 'tool/result')
    expect(result?.['ok']).toBe(true)
    expect(JSON.parse(String(result?.['output'])).videoId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the grant is only for the command: a model-initiated call still asks', async () => {
    script = { tool: { name: 'GenerateImage', args: { prompt: 'no command here' } } }
    const log = await run('please draw something')
    expect(log.some((event) => event.type === 'approval/request')).toBe(true)
  })

  it('an empty /image still expands, and tells the model to ask instead of calling the tool', async () => {
    requests.length = 0
    script = {}
    await run('/image')
    expect(userTexts(requests[0])[1]).toMatch(/If the description above is empty, do not call the tool/)
  })

  it('does not reach a mode that does not expose the tool', async () => {
    requests.length = 0
    script = {}
    await run('/image a cat', 'plan')
    expect(requests[0]?.tools?.some((tool) => tool.name === 'GenerateImage') ?? false).toBe(false)
  })

  it('a workspace command of the same name overrides the bundled one', async () => {
    await fs.mkdir(path.join(home, 'workspaces', wsId, 'commands'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'commands', 'image.md'), '---\ndescription: Mine\n---\nCUSTOM IMAGE: $ARGUMENTS')
    const listed = (await (await fetch(`${server.url}/api/workspaces/${wsId}/commands`)).json()) as { commands: { name: string; source: string }[] }
    expect(listed.commands.find((row) => row.name === 'image')?.source).toBe('workspace')
    requests.length = 0
    script = {}
    await run('/image a fox')
    expect(userTexts(requests[0])[1]).toBe('CUSTOM IMAGE: a fox')
    await fs.rm(path.join(home, 'workspaces', wsId, 'commands', 'image.md'))
  })

  it('stays unavailable to the model through the Skill tool', async () => {
    const catalog = (await (await fetch(`${server.url}/api/workspaces/${wsId}/commands`)).json()) as { commands: { name: string; disableModelInvocation?: true }[] }
    expect(catalog.commands.filter((row) => row.name === 'image' || row.name === 'video').every((row) => row.disableModelInvocation === true)).toBe(true)
  })
})
