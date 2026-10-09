import type { ModelMessage, ModelRequest, StreamEvent } from '../llm/types.ts'
import type { ToolDefinition, ToolExecution } from './types.ts'
import type { StoredImage } from './image-tools.ts'

/** Read-like vision fallback for chat models that cannot receive image parts. */
export const DESCRIBE_IMAGE_TOOL = 'DescribeImage'

export interface VisionApiConfig {
  readonly provider: string
  readonly model: string
}

export type VisionApiResolution =
  | { readonly ok: true; readonly config: VisionApiConfig }
  | { readonly ok: false; readonly reason: string }

export interface DescribeImageOptions {
  readonly resolve: () => VisionApiResolution
  readonly read: (workspaceId: string, attachmentId: string) => Promise<StoredImage>
  /** Dispatch one tool-owned multimodal request through the host LLM registry. */
  readonly stream: (request: ModelRequest, exec: ToolExecution) => AsyncIterable<StreamEvent>
}

const ATTACHMENT_ID = /^[0-9a-f]{64}$/

const SYSTEM = [
  'You are a vision assistant inside a coding agent.',
  'Describe the image so a text-only model can reason about it.',
  'Cover UI layout and app screens (controls, labels, panels), visible text (transcribe faithfully), key objects, colors, and spatial relationships.',
  'Be concrete and structured, not flowery.',
  'If a specific question was asked, answer it directly after the description.',
].join(' ')

/**
 * `DescribeImage`: stored attachment + optional question → a dedicated
 * vision-capable chat model → text. It never reads arbitrary filesystem paths;
 * workspace/project images must first enter the workspace AttachmentStore.
 */
export function describeImageTool(options: DescribeImageOptions): ToolDefinition {
  return {
    name: DESCRIBE_IMAGE_TOOL,
    description: [
      'Describe or answer questions about an image using the vision-capable provider and model selected in Settings → Providers & Models → Image understanding.',
      'Use this when the current chat model cannot see image pixels and an attached or generated image must be understood.',
      'attachmentId must be the id shown in an image attachment marker or returned by GenerateImage/EditImage; this tool cannot read arbitrary workspace files.',
      'question is optional; omit it for a general description covering UI layout, visible text/OCR, objects, colors, and spatial relationships.',
      'Returns JSON with description, model, and attachmentId. This is a read-like tool and runs automatically in bundled modes.',
    ].join(' '),
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string', description: 'Stored image id from an attachment marker or a GenerateImage/EditImage result.' },
        question: { type: 'string', description: 'Optional focused question about the image; omit for a general description.' },
      },
      required: ['attachmentId'],
    },
    async execute(args, exec) {
      const attachmentId = typeof args['attachmentId'] === 'string' ? args['attachmentId'].trim() : ''
      if (!ATTACHMENT_ID.test(attachmentId)) throw new Error("argument 'attachmentId' must be a 64-character sha256 hex id")
      const question = typeof args['question'] === 'string' ? args['question'].trim() : ''
      const workspaceId = exec.workspaceId
      if (workspaceId === undefined) throw new Error(`${DESCRIBE_IMAGE_TOOL} requires a workspace-scoped execution`)
      const resolution = options.resolve()
      if (!resolution.ok) throw new Error(resolution.reason)
      const source = await options.read(workspaceId, attachmentId)
      if (!source.mediaType.startsWith('image/')) throw new Error(`attachment '${attachmentId}' is not an image`)

      const user: ModelMessage = {
        role: 'user',
        content: [
          { type: 'image', mediaType: source.mediaType, base64: source.bytes.toString('base64') },
          { type: 'text', text: question === '' ? 'Describe this image for a coding agent.' : `Question about this image: ${question}` },
        ],
      }
      const request: ModelRequest = {
        providerName: resolution.config.provider,
        model: resolution.config.model,
        messages: [{ role: 'system', content: SYSTEM }, user],
      }
      let description = ''
      for await (const event of options.stream(request, exec)) {
        if (event.type === 'delta' && event.thinking !== true) description += event.delta
      }
      description = description.trim()
      if (description === '') throw new Error('vision model returned an empty description')
      return JSON.stringify({ description, model: resolution.config.model, attachmentId })
    },
  }
}
