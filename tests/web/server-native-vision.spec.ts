/** Native vision keeps image parts and omits the DescribeImage fallback tool. */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type ModelRequest, type StreamEvent, type WebServer } from 'dnt-harness'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('native')])
let home = ''
let server: WebServer

afterAll(async () => { await server?.close().catch(() => {}); if (home !== '') await fs.rm(home, { recursive: true, force: true }) })

describe('native vision web flow', () => {
  it('keeps the image in the chat request and removes DescribeImage from tools', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-native-vision-'))
    const requests: ModelRequest[] = []
    const provider: LlmProvider = {
      name: 'vision-chat', models: ['gpt-5.6'],
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(request)
        yield { type: 'delta', delta: 'I can see it.' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    server = await createWebServer({ home, providers: [provider], activeModel: { provider: 'vision-chat', model: 'gpt-5.6' }, configFile: path.join(home, 'providers.json') })
    const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
    const upload = await fetch(`${server.url}/api/workspaces/${wsId}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'screen.png' }, body: new Uint8Array(PNG) })
    const ref = await upload.json()
    const { id } = await (await fetch(`${server.url}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    await fetch(`${server.url}/api/workspaces/${wsId}/sessions/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'look', attachments: [ref] }) })
    await expect.poll(() => requests.length, { timeout: 5_000 }).toBe(1)
    expect(Array.isArray(requests[0]!.messages.find((message) => message.role === 'user')?.content)).toBe(true)
    expect(JSON.stringify(requests[0]!.messages)).toContain(PNG.toString('base64'))
    expect(requests[0]!.tools?.some((tool) => tool.name === 'DescribeImage')).toBe(false)
  })
})
