import { parseChart } from './chart-spec.ts'
import { loadImageSource, type ImageToolOptions } from './image-tools.ts'
import type { ToolDefinition } from './types.ts'

/**
 * `SendPreview`: the agent shows the user something in the chat. It never
 * generates content; it only displays what the agent already has.
 *
 * - image: a stored attachment (`attachmentId`) or a granted file (`path`, read
 *   exactly as `Read` would be). A file is copied into the attachment store;
 *   an attachment is content-addressed, so it keeps its id.
 * - chart: a validated JSON spec the web draws as SVG. The result is the whole
 *   preview, so the log alone replays it.
 *
 * Add a kind by adding a branch here and one in the web `PreviewCard`.
 */

export const SEND_PREVIEW_TOOL = 'SendPreview'

export interface SendPreviewOptions extends Pick<ImageToolOptions, 'store' | 'read' | 'resolvePath'> {
  /** Largest image accepted. */
  readonly maxBytes?: number
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const MAX_TEXT = 200

const text = (value: unknown, label: string, max = MAX_TEXT): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`argument '${label}' must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`argument '${label}' is longer than ${max} characters`)
  return trimmed === '' ? undefined : trimmed
}

export function sendPreviewTool(options: SendPreviewOptions): ToolDefinition {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  return {
    name: SEND_PREVIEW_TOOL,
    description: [
      'Show the user a preview in the chat: an image or a chart. It displays only; it creates nothing.',
      "Give exactly one of: 'attachmentId' (a stored image: a user attachment or a GenerateImage/EditImage result), 'path' (a png/jpeg/webp/gif file inside the granted folders, e.g. a screenshot), or 'chart'.",
      "A chart is { type: 'bar'|'line', labels: string[], series: [{ name, values: number[], color? }], xLabel?, yLabel?, showValues? } with up to 8 series and 500 points; values.length must equal labels.length; each label and series name up to 200 characters.",
      "Optional: series color as hex (#rgb or #rrggbb; default palette otherwise), xLabel/yLabel axis titles (up to 60 characters), showValues to print each value (only drawn up to 40 values in total).",
      'For anything else (diagram, table), render it to an image first.',
      'The preview is shown inline automatically; after success reply briefly and do not repeat the data or tell the user any file path or id.',
    ].join(' '),
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `Optional heading, up to ${MAX_TEXT} characters.` },
        caption: { type: 'string', description: `Optional one-line note, up to ${MAX_TEXT} characters.` },
        attachmentId: { type: 'string', description: 'Stored image id.' },
        path: { type: 'string', description: 'Image file inside the granted folders (alternative to attachmentId).' },
        chart: {
          type: 'object',
          description: 'Chart data (alternative to an image).',
          properties: {
            type: { type: 'string', enum: ['bar', 'line'] },
            labels: { type: 'array', items: { type: 'string' } },
            series: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } }, color: { type: 'string', description: 'Hex colour, e.g. #3b82f6.' } },
                required: ['name', 'values'],
              },
            },
            xLabel: { type: 'string', description: 'X axis title.' },
            yLabel: { type: 'string', description: 'Y axis title.' },
            showValues: { type: 'boolean', description: 'Print each value on its bar or point.' },
          },
          required: ['type', 'labels', 'series'],
        },
      },
    },
    async execute(args, exec) {
      const title = text(args['title'], 'title')
      const caption = text(args['caption'], 'caption')
      const meta = { ...(title !== undefined ? { title } : {}), ...(caption !== undefined ? { caption } : {}) }
      const hasChart = args['chart'] !== undefined
      const hasId = typeof args['attachmentId'] === 'string' && args['attachmentId'].trim() !== ''
      const hasPath = typeof args['path'] === 'string' && args['path'].trim() !== ''
      if (Number(hasChart) + Number(hasId) + Number(hasPath) !== 1) throw new Error("give exactly one of 'attachmentId', 'path' or 'chart'")

      if (hasChart) return JSON.stringify({ kind: 'chart', chart: parseChart(args['chart']), ...meta })

      const workspaceId = exec.workspaceId
      if (workspaceId === undefined) throw new Error(`${SEND_PREVIEW_TOOL} requires a workspace-scoped execution`)
      const image = await loadImageSource({ maxBytes, options }, args, exec, workspaceId)
      const attachmentId = image.attachmentId ?? (await options.store(workspaceId, { name: image.filename, bytes: image.bytes })).id
      return JSON.stringify({ kind: 'image', attachmentId, mediaType: image.mediaType, ...meta })
    },
  }
}
