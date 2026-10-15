import type { ModelMessage, ToolSchema } from './types.ts'
import { getModelInfo } from './model-catalog.ts'
import { DESCRIBE_IMAGE_TOOL } from '../tools/describe-image.ts'

/** Operator override first, then catalog; unknown preserves native vision. */
export function supportsNativeVision(model: string | undefined, override?: boolean): boolean {
  if (override !== undefined) return override
  return getModelInfo(model)?.vision !== false
}

const WITH_TOOL = [
  'This chat model cannot see image pixels.',
  'Before answering about an attached image, call DescribeImage with its attachmentId from the marker above and an optional focused question.',
].join(' ')

const WITHOUT_TOOL = [
  'This chat model cannot see image pixels, and no image-description tool is available in this request.',
  'If asked about the attached image, say that you cannot view the image.',
].join(' ')

/** Remove image bytes while preserving text; name the describe tool only when the request carries it. */
export function textOnlyVisionFallback(messages: readonly ModelMessage[], describeAvailable: boolean): readonly ModelMessage[] {
  const fallback = describeAvailable ? WITH_TOOL : WITHOUT_TOOL
  return messages.map((message) => {
    if (typeof message.content === 'string' || !message.content.some((part) => part.type === 'image')) return message
    const text = message.content.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text').map((part) => part.text.trim()).filter(Boolean)
    return { ...message, content: [...text, fallback].join('\n\n') }
  })
}

/** A native vision model does not need the fallback tool in its schema list. */
export function withoutDescribeImage(tools: readonly ToolSchema[] | undefined): readonly ToolSchema[] | undefined {
  if (tools === undefined) return undefined
  const kept = tools.filter((tool) => tool.name !== DESCRIBE_IMAGE_TOOL)
  return kept.length === 0 ? undefined : kept
}
