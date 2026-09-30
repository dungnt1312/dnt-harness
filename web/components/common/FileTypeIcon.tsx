import { useEffect, useState } from 'react'
import { fileStyle, folderStyle, materialIconSrc } from '../../lib/file-icons.ts'

const FALLBACK_FILE = materialIconSrc('document')
const FALLBACK_FOLDER = materialIconSrc('folder')

/**
 * A Material Icon Theme glyph for a file or folder. The SVGs are precolored,
 * so nothing here tints them. A missing asset falls back to the plain
 * document or folder icon rather than showing a broken image.
 */
export function FileTypeIcon({ path, kind = 'file', open = false, size = 16, className }: {
  readonly path: string
  readonly kind?: 'file' | 'folder'
  readonly open?: boolean
  readonly size?: number
  readonly className?: string
}) {
  const icon = kind === 'folder' ? folderStyle(path, open) : fileStyle(path)
  const fallback = kind === 'folder' ? FALLBACK_FOLDER : FALLBACK_FILE
  const [src, setSrc] = useState(icon.src)

  useEffect(() => { setSrc(icon.src) }, [icon.src])

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      aria-hidden="true"
      className={className === undefined ? 'shrink-0' : `shrink-0 ${className}`}
      onError={() => { if (src !== fallback) setSrc(fallback) }}
    />
  )
}
