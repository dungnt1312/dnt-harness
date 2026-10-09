/** End-to-end adaptive vision: text-only chat delegates pixels to DescribeImage. */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { FakeOpenAiServer } from './fake-llm.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('screen')])
const ID = createHash('sha256').update(PNG).digest('hex')
let home = ''
let server: WebServer
let chat: FakeOpenAiServer
let vision: FakeOpenAiServer
let wsId = ''

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-adaptive-vision-'))
  chat = new FakeOpenAiServer([
    { toolCalls: [{ name: 'DescribeImage', args: { attachmentId: ID, question: 'What is shown?' } }] },
    'The screenshot shows a Settings page.',
  ])
  vision = new FakeOpenAiServer(['A dark Settings screen with a sidebar and provider controls.'])
  await chat.start(); await vision.start()
  const configFile = path.join(home, 'providers.json')
  await fs.writeFile(configFile, JSON.stringify({
    version: 2,
    defaults: { provider: 'chat', model: 'glm-4.7', thinkingLevel: null },
    providers: [
      { id: 'chat', name: 'Chat', baseUrl: chat.url, apiKey: '', models: ['glm-4.7'], enabled: true, modelSettings: { 'glm-4.7': { vision: false } } },
      { id: 'vision', name: 'Vision', baseUrl: vision.url, apiKey: '', models: ['gpt-4o'], enabled: true, modelSettings: { 'gpt-4o': { vision: true } } },
    ],
    aliases: [], aliasGeneration: 0,
  }))
  await fs.writeFile(path.join(home, 'image-understanding.json'), JSON.stringify({ provider: 'vision', model: 'gpt-4o' }))
  server = await createWebServer({ home, configFile, yolo: true })
  wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
})

afterAll(async () => {
  await server?.close().catch(() => {})
  await chat?.stop(); await vision?.stop()
  await fs.rm(home, { recursive: true, force: true })
})

describe('adaptive vision web flow', () => {
  it('serves and validates Image understanding settings', async () => {
    const get = await fetch(`${server.url}/api/image-understanding`)
    expect(await get.json()).toEqual({ provider: 'vision', model: 'gpt-4o' })
    expect((await fetch(`${server.url}/api/image-understanding`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'missing', model: 'm' }) })).status).toBe(400)
    const off = await fetch(`${server.url}/api/image-understanding`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: null, model: null }) })
    expect(await off.json()).toEqual({ provider: null, model: null })
    // Restore for the tool-flow test.
    expect((await fetch(`${server.url}/api/image-understanding`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'vision', model: 'gpt-4o' }) })).status).toBe(200)
  })

  it('removes image_url from text-only chat and sends pixels only to DescribeImage vision model', async () => {
    const upload = await fetch(`${server.url}/api/workspaces/${wsId}/attachments`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('screen.png') }, body: new Uint8Array(PNG),
    })
    expect(upload.status).toBe(201)
    const ref = await upload.json() as { id: string; name: string; mediaType: string; bytes: number }
    expect(ref.id).toBe(ID)
    const created = await fetch(`${server.url}/api/workspaces/${wsId}/sessions`, { method: 'POST' })
    const { id } = await created.json() as { id: string }
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/sessions/${id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'What is this?', attachments: [ref] }),
    })).status).toBe(202)

    const log = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await expect.poll(async () => (await fs.readFile(log, 'utf8').catch(() => '')).includes('"type":"turn/end"'), { timeout: 8_000 }).toBe(true)

    const chatBodies = chat.seenRequests.filter((request) => request.url.endsWith('/chat/completions')).map((request) => request.body)
    const first = JSON.stringify(chatBodies[0])
    expect(first).not.toContain('image_url')
    expect(first).not.toContain(PNG.toString('base64'))
    expect(first).toContain(`attachmentId=${ID}`)
    expect(first).toContain('call DescribeImage')
    expect(((chatBodies[0]?.['tools'] ?? []) as { function?: { name?: string } }[]).some((tool) => tool.function?.name === 'DescribeImage')).toBe(true)

    const visionBody = vision.seenRequests.find((request) => request.url.endsWith('/chat/completions'))?.body
    expect(visionBody?.['model']).toBe('gpt-4o')
    expect(JSON.stringify(visionBody)).toContain('image_url')
    expect(JSON.stringify(visionBody)).toContain(PNG.toString('base64'))
    expect(visionBody?.['tools']).toBeUndefined()

    const rows = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; output?: string })
    const result = rows.find((row) => row.type === 'tool/result')
    expect(result?.output).toContain('A dark Settings screen')
  })
})
