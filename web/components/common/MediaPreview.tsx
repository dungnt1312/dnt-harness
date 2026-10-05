import { useState } from 'react'
import { mediaKindOf, projectMediaUrl } from '../../lib/api.ts'
import { ImageLightbox } from '../chat/ImageLightbox.tsx'
import { cn } from '../../lib/cn.ts'

/**
 * In-place preview of a file the browser renders itself: an image with
 * click-to-zoom, or a playable audio/video. The bytes stream from the
 * project's media route, which sniffs the real type before serving; the file
 * name only decides whether a preview is attempted. A binary the browser
 * cannot render falls back to the plain "no preview" note the diff rows
 * showed before.
 */
export function MediaPreview({ workspaceId, projectId, path, layout = 'inline' }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly path: string
  /** `inline` fits an expanded diff row; `full` fills the file viewer pane. */
  readonly layout?: 'inline' | 'full'
}) {
  const kind = mediaKindOf(path)
  const [zoomed, setZoomed] = useState(false)
  const [failed, setFailed] = useState(false)
  if (kind === null) {
    return <p className="m-0 px-1 py-1.5 text-[12px] text-fg-muted" role="note">Binary file — no preview for this format.</p>
  }
  if (failed) {
    return <p className="m-0 px-1 py-1.5 text-[12px] text-fg-muted" role="note">Could not load the media preview — the file may have moved or the format may not be playable.</p>
  }
  const url = projectMediaUrl(workspaceId, projectId, path)
  if (kind === 'image') {
    return (
      <figure className="m-0 inline-flex max-w-full p-2">
        <button
          type="button"
          aria-label={`Zoom ${path}`}
          onClick={() => setZoomed(true)}
          className="m-0 block cursor-zoom-in border-0 bg-none p-0"
        >
          <img
            src={url}
            alt={path}
            onError={() => setFailed(true)}
            className={cn('rounded-md border border-line bg-muted object-contain', layout === 'inline' ? 'max-h-48' : 'max-h-[70vh] max-w-full')}
          />
        </button>
        <ImageLightbox src={zoomed ? url : null} alt={path} onDismiss={() => setZoomed(false)} />
      </figure>
    )
  }
  if (kind === 'video') {
    return (
      <div className={cn('p-2', layout === 'full' && 'mx-auto max-w-xl')}>
        <video
          src={url}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          className="w-full rounded-md border border-line bg-black"
        />
      </div>
    )
  }
  return (
    <div className={cn('p-2', layout === 'full' && 'mx-auto max-w-xl')}>
      <audio src={url} controls preload="metadata" onError={() => setFailed(true)} className="w-full" />
    </div>
  )
}
