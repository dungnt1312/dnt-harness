import type { ModelMessage, ModelRequest, ToolSchema } from './types.ts'
import { getModelInfo } from './model-catalog.ts'
import { DESCRIBE_IMAGE_TOOL } from '../tools/describe-image.ts'

/** Operator override first, then catalog; unknown preserves native vision. */
export function supportsNativeVision(model: string | undefined, override?: boolean): boolean {
  if (override !== undefined) return override
  return getModelInfo(model)?.vision !== false
}

const FALLBACK = [
  'This chat model cannot see image pixels.',
  'Before answering about an attached image, call DescribeImage with its attachmentId from the marker above and an optional focused question.',
].join(' ')

/** Remove image bytes while preserving text and an explicit tool instruction. */
export function textOnlyVisionFallback(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return messages.map((message) => {
    if (typeof message.content === 'string' || !message.content.some((part) => part.type === 'image')) return message
    const text = message.content.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text').map((part) => part.text.trim()).filter(Boolean)
    return { ...message, content: [...text, FALLBACK].join('\n\n') }
  })
}

/** A native vision model does not need the fallback tool in its schema list. */
export function withoutDescribeImage(tools: readonly ToolSchema[] | undefined): readonly ToolSchema[] | undefined {
  if (tools === undefined) return undefined
  const kept = tools.filter((tool) => tool.name !== DESCRIBE_IMAGE_TOOL)
  return kept.length === 0 ? undefined : kept
}

/** Adapt one already mode-filtered request for the selected chat model. */
export function adaptRequestVision(request: ModelRequest, nativeVision: boolean): ModelRequest {
  if (!nativeVision) return { ...request, messages: textOnlyVisionFallback(request.messages) }
  const tools = withoutDescribeImage(request.tools)
  if (tools === request.tools) return request
  const { tools: _removed, ...withoutTools } = request
  void _removed
  return tools === undefined ? withoutTools : { ...withoutTools, tools }
}
