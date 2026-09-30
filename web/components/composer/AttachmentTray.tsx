import Icon from '../common/Icon.tsx'
import { attachmentUrl } from '../../lib/api.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { formatBytes } from '../../lib/format.ts'
import type { AttachmentRef } from '../../lib/composer-draft.ts'

export function AttachmentTray({ attachments, workspaceId, onRemove, onInsertText, canInsertText }: {
  readonly attachments: readonly AttachmentRef[]
  readonly workspaceId: string | null
  readonly onRemove: (attachment: AttachmentRef) => void
  /** Available for locally-created text paste attachments. */
  readonly onInsertText?: (attachment: AttachmentRef) => void
  /** Limits recovery controls to attachments with retained local source text. */
  readonly canInsertText?: (attachment: AttachmentRef) => boolean
}) {
  if (attachments.length === 0) return null
  return (
    <section aria-label={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`} className="min-w-0 px-5 pt-3">
      <p className="sr-only" role="status">{attachments.length} attachment{attachments.length === 1 ? '' : 's'} attached</p>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Attached files">
        {attachments.map((attachment) => {
          const image = attachment.mediaType.startsWith('image/') && workspaceId !== null
          return (
            <li key={attachment.id} className="group flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-line bg-hover p-1.5 text-[13px]">
              {image ? <img className="size-12 shrink-0 rounded-lg object-cover" src={attachmentUrl(workspaceId, attachment.id)} alt={`Image attachment: ${attachment.name}`} /> : <FileTypeIcon path={attachment.name} size={20} />}
              <span className="min-w-0"><span className="block truncate">{attachment.name}</span><span className="block text-xs text-fg-faint">{formatBytes(attachment.bytes)}</span></span>
              {onInsertText !== undefined && canInsertText?.(attachment) === true ? <button type="button" className="shrink-0 rounded px-1 text-link hover:underline focus-visible:outline focus-visible:outline-2" onClick={() => onInsertText(attachment)}>Insert back</button> : null}
              <button type="button" className="shrink-0 rounded p-1 text-fg-faint hover:text-fg focus-visible:outline focus-visible:outline-2" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment)}><Icon name="close" size={14} /></button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
