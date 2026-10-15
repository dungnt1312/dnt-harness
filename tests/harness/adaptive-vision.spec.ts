import { describe, expect, it } from 'vitest'
import { supportsNativeVision, textOnlyVisionFallback, withoutDescribeImage } from '../../src/harness/llm/adaptive-vision.ts'
import type { ToolSchema } from '../../src/harness/llm/types.ts'

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
    expect(supportsNativeVision('glm-5.3')).toBe(false)
    expect(supportsNativeVision('gpt-5.6')).toBe(true)
    expect(supportsNativeVision('unknown-future-model')).toBe(true)
    expect(supportsNativeVision('gpt-5.6', false)).toBe(false)
    expect(supportsNativeVision('glm-4.7', true)).toBe(true)
  })

  it('removes image bytes for a non-vision chat and tells the model to call DescribeImage', () => {
    const [message] = textOnlyVisionFallback([imageMessage], true)
    expect(typeof message?.content).toBe('string')
    expect(message?.content).toContain(`attachmentId=${'a'.repeat(64)}`)
    expect(message?.content).toContain('call DescribeImage')
    expect(JSON.stringify(message)).not.toContain('AAAA')
  })

  it('without a DescribeImage tool the fallback never names it and says the image cannot be viewed', () => {
    const [message] = textOnlyVisionFallback([imageMessage], false)
    expect(typeof message?.content).toBe('string')
    expect(message?.content).toContain('cannot see image pixels')
    expect(message?.content).toContain('no image-description tool is available')
    expect(message?.content).toContain('cannot view the image')
    expect(message?.content).not.toContain('DescribeImage')
    expect(JSON.stringify(message)).not.toContain('AAAA')
  })

  it('a native vision model does not need the DescribeImage schema', () => {
    expect(withoutDescribeImage([tool('Read'), tool('DescribeImage')])?.map((entry) => entry.name)).toEqual(['Read'])
    expect(withoutDescribeImage([tool('DescribeImage')])).toBeUndefined()
  })
})
