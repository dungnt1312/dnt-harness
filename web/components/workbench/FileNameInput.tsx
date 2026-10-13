import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { TextInput } from '../ui/TextInput.tsx'

/**
 * Inline name editor for an explorer row. Enter submits, Escape and blur
 * cancel without submitting, so a stray click never creates or renames
 * anything. `onSubmit` resolves null on success or the error to show.
 */
export function FileNameInput({ initial, label, selectStem, onSubmit, onCancel }: {
  readonly initial: string
  readonly label: string
  /** Select the name without its extension (rename of a file). */
  readonly selectStem: boolean
  readonly onSubmit: (name: string) => Promise<string | null>
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = ref.current
    if (input === null) return
    input.focus()
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length)
  }, [initial, selectStem])

  const submit = async (): Promise<void> => {
    if (pending.current) return
    if (value.trim() === '') { onCancel(); return }
    pending.current = true
    setBusy(true)
    setError(null)
    const problem = await onSubmit(value)
    pending.current = false
    if (problem === null) return
    setBusy(false)
    setError(problem)
  }

  // Focus only works once the input is re-enabled, so wait for the render.
  useEffect(() => {
    if (!busy && error !== null) ref.current?.focus()
  }, [busy, error])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') { event.preventDefault(); void submit() }
    else if (event.key === 'Escape') { event.preventDefault(); onCancel() }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
      <TextInput
        ref={ref}
        className="h-7 px-2 text-[13px]"
        aria-label={label}
        value={value}
        disabled={busy}
        invalid={error !== null}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { if (!pending.current) onCancel() }}
      />
      {error !== null ? <p role="alert" className="m-0 text-xs text-bad">{error}</p> : null}
    </div>
  )
}
