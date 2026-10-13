import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Button } from '../ui/Button.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'

/** Tab-indented files get a tab; everything else gets two spaces. */
export function indentUnit(text: string): '\t' | '  ' {
  return /^\t/m.test(text) ? '\t' : '  '
}

export function FileEditor({ path, text, dirty, saving, error, conflict, onChange, onSave, onCancel, onReload, onOverwrite }: {
  readonly path: string
  readonly text: string
  readonly dirty: boolean
  readonly saving: boolean
  readonly error: string | null
  /** Shown above the editor when the file changed on disk. */
  readonly conflict: boolean
  readonly onChange: (text: string) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly onReload: () => void
  readonly onOverwrite: () => void
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { areaRef.current?.focus() }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const area = e.currentTarget
      const { selectionStart: start, selectionEnd: end, value } = area
      const unit = indentUnit(text)
      const caret = start + unit.length
      onChange(value.slice(0, start) + unit + value.slice(end))
      requestAnimationFrame(() => area.setSelectionRange(caret, caret))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span>Editing</span>
          {dirty && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">Unsaved</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
      {conflict && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-2 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <span>This file changed on disk since you opened it.</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onReload}>Reload</Button>
            <Button size="sm" variant="outline" onClick={onOverwrite}>Overwrite</Button>
          </div>
        </div>
      )}
      {error !== null && <div className="shrink-0 px-3 py-2"><ErrorNotice raw={error} /></div>}
      <textarea
        ref={areaRef}
        aria-label={`Edit ${path}`}
        className="min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-[12.5px] leading-5 outline-none"
        value={text}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        wrap="off"
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
