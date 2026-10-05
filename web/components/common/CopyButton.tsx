import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.tsx'
import { IconButton } from '../ui/IconButton.tsx'

/** Clipboard failures leave the source available for manual selection. */
export default function CopyButton({ text, getText, label, className }: {
  readonly text?: string
  /** Lazily assemble large payloads only when the reader actually copies. */
  readonly getText?: () => string
  readonly label?: string
  readonly className?: string
}) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const copy = async (): Promise<void> => {
    setFailed(false)
    try {
      await navigator.clipboard.writeText(getText?.() ?? text ?? '')
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
      setFailed(true)
    }
  }
  return (
    <>
      <IconButton label={copied ? 'Copied to clipboard' : (label ?? 'Copy to clipboard')} className={className ?? ''} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </IconButton>
      {failed
        ? (
          // Out of flow: a failed copy must not push the panel it sits on.
          <span role="status" className="pointer-events-none absolute right-1 top-full z-10 mt-1 rounded-sm bg-bg px-2 py-1 text-xs text-bad shadow-pop">
            Could not copy. Select the text and copy it manually.
          </span>
        )
        : null}
    </>
  )
}
