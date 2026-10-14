import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Segmented } from '../ui/Segmented.tsx'

/** The strip shown only while a file is being edited: state on the left, the way out on the right. */
export function EditBar({ dirty, saving, review, onReview, onCancel, onSave }: {
  readonly dirty: boolean
  readonly saving: boolean
  /** Whether the editor shows the edit against the text it started from. */
  readonly review: 'edit' | 'changes' | null
  readonly onReview: (next: 'edit' | 'changes') => void
  readonly onCancel: () => void
  readonly onSave: () => void
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
      <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
        <span>Editing</span>
        {dirty ? <Badge tone="amber">Unsaved</Badge> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Segmented<'edit' | 'changes'>
          label="Editor view"
          size="compact"
          value={review}
          disabled={saving}
          options={[{ value: 'edit', label: 'Edit' }, { value: 'changes', label: 'Changes' }]}
          onChange={onReview}
        />
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  )
}

/** The file moved on disk under the editor: compare, take the disk version, or keep going and overwrite. */
export function ConflictBanner({ comparing, busy, onCompare, onReload, onOverwrite }: {
  readonly comparing: boolean
  readonly busy: boolean
  readonly onCompare: () => void
  readonly onReload: () => void
  readonly onOverwrite: () => void
}) {
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-warn-soft px-3 py-2 text-[13px] text-warn">
      <span className="min-w-0">This file changed on disk since you opened it.</span>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onCompare}>{comparing ? 'Hide comparison' : 'Compare'}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>Reload</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onOverwrite}>Overwrite</Button>
      </div>
    </div>
  )
}
