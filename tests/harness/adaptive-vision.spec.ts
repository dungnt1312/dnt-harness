import { describe, expect, it } from 'vitest'
import { adaptRequestVision, supportsNativeVision, textOnlyVisionFallback } from '../../src/harness/llm/adaptive-vision.ts'
import type { ModelRequest, ToolSchema } from '../../src/harness/llm/types.ts'

const imageMessage = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: 'look\n\n[image attachment "screen.png" attachmentId=' + 'a'.repeat(64) + ']' },
    { type: 'image' as const, mediaType: 'image/png', base64: 'AAAA', name: 'screen.png' },
  ],
}
const tool = (name: string): ToolSchema => ({ name, description: name, parameters: { type: 'object', properties: {} } })

describe('adaptive vision', () => {
  it('uses operator override first and treats unknown models as native vision', () => {
    expect(supportsNativeVision('glm-4.7')).toBe(false)
    expect(supportsNativeVision('gpt-5.6')).toBe(true)
    expect(supportsNativeVision('unknown-future-model')).toBe(true)
    expect(supportsNativeVision('gpt-5.6', false)).toBe(false)
    expect(supportsNativeVision('glm-4.7', true)).toBe(true)
  })

  it('removes image bytes for a non-vision chat and tells the model to call DescribeImage', () => {
    const [message] = textOnlyVisionFallback([imageMessage])
    expect(typeof message?.content).toBe('string')
    expect(message?.content).toContain(`attachmentId=${'a'.repeat(64)}`)
    expect(message?.content).toContain('call DescribeImage')
    expect(JSON.stringify(message)).not.toContain('AAAA')
  })

  it('keeps image parts but removes DescribeImage for a native vision model', () => {
    const request: ModelRequest = { messages: [imageMessage], tools: [tool('Read'), tool('DescribeImage')] }
    const adapted = adaptRequestVision(request, true)
    expect(adapted.messages).toEqual([imageMessage])
    expect(adapted.tools?.map((entry) => entry.name)).toEqual(['Read'])
  })

  it('keeps DescribeImage and text-only messages for a non-vision model', () => {
    const request: ModelRequest = { messages: [imageMessage], tools: [tool('Read'), tool('DescribeImage')] }
    const adapted = adaptRequestVision(request, false)
    expect(adapted.tools?.map((entry) => entry.name)).toEqual(['Read', 'DescribeImage'])
    expect(typeof adapted.messages[0]?.content).toBe('string')
  })
})
