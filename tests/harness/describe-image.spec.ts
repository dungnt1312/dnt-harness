import { describe, expect, it } from 'vitest'
import { describeImageTool, type VisionApiResolution } from '../../src/harness/tools/describe-image.ts'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'

const ID = 'a'.repeat(64)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function setup(resolution: VisionApiResolution = { ok: true, config: { provider: 'vision-provider', model: 'gpt-4o' } }) {
  const requests: ModelRequest[] = []
  const tool = describeImageTool({
    resolve: () => resolution,
    read: async (workspaceId, id) => {
      if (workspaceId !== 'ws' || id !== ID) throw new Error('not stored')
      return { bytes: PNG, mediaType: 'image/png' }
    },
    stream: (request) => {
      requests.push(request)
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { type: 'delta', delta: 'internal thought', thinking: true }
        yield { type: 'delta', delta: 'A dark UI ' }
        yield { type: 'delta', delta: 'with a sidebar.' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      })()
    },
  })
  return { tool, requests }
}

describe('DescribeImage tool', () => {
  it('sends the stored image to the configured vision model and returns its text', async () => {
    const { tool, requests } = setup()
    const output = JSON.parse(await tool.execute({ attachmentId: ID, question: 'What is shown?' }, { root: '/tmp', workspaceId: 'ws' })) as Record<string, unknown>
    expect(output).toEqual({ description: 'A dark UI with a sidebar.', model: 'gpt-4o', attachmentId: ID })
    expect(requests[0]).toMatchObject({ providerName: 'vision-provider', model: 'gpt-4o' })
    const user = requests[0]!.messages[1]!
    expect(Array.isArray(user.content)).toBe(true)
    expect(JSON.stringify(user.content)).toContain(PNG.toString('base64'))
    expect(JSON.stringify(user.content)).toContain('What is shown?')
    expect(requests[0]!.tools).toBeUndefined()
  })

  it('validates source, workspace, config, and empty vision output', async () => {
    const { tool } = setup()
    await expect(tool.execute({}, { root: '/tmp', workspaceId: 'ws' })).rejects.toThrow(/attachmentId/)
    await expect(tool.execute({ attachmentId: ID }, { root: '/tmp' })).rejects.toThrow(/workspace/)
    await expect(setup({ ok: false, reason: 'Image understanding is not configured.' }).tool.execute({ attachmentId: ID }, { root: '/tmp', workspaceId: 'ws' })).rejects.toThrow(/not configured/)
    const empty = describeImageTool({
      resolve: () => ({ ok: true, config: { provider: 'p', model: 'm' } }),
      read: async () => ({ bytes: PNG, mediaType: 'image/png' }),
      stream: () => (async function* (): AsyncIterable<StreamEvent> { yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } })(),
    })
    await expect(empty.execute({ attachmentId: ID }, { root: '/tmp', workspaceId: 'ws' })).rejects.toThrow(/empty description/)
  })
})
