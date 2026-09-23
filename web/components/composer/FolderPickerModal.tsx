import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listDirs, type FolderListing } from '../../lib/api.ts'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Modal } from '../ui/Modal.tsx'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'

function splitPathSegments(absPath: string): { label: string; path: string }[] {
  const normalized = absPath.replace(/\\/g, '/')
  const isWindowsDrive = /^[A-Za-z]:(\/|$)/.test(normalized)
  if (isWindowsDrive) {
    const drive = normalized.slice(0, 2)
    const rest = normalized.slice(2).split('/').filter(Boolean)
    const segments: { label: string; path: string }[] = [{ label: drive, path: `${drive}\\` }]
    let acc = `${drive}\\`
    for (const part of rest) {
      acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`
      segments.push({ label: part, path: acc })
    }
    return segments
  }
  if (normalized.startsWith('/')) {
    const parts = normalized.split('/').filter(Boolean)
    const segments: { label: string; path: string }[] = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc += `/${part}`
      segments.push({ label: part, path: acc })
    }
    return segments
  }
  return [{ label: absPath, path: absPath }]
}

function looksLikeAbsolutePath(input: string): boolean {
  const value = input.trim()
  if (value === '') return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  if (value.startsWith('/')) return true
  if (value.startsWith('~')) return true
  return false
}

/**
 * Server-backed folder picker (spec: no-modal new-chat flow). A browser never
 * reveals a chosen folder's absolute path, so the picker navigates real
 * machine directories listed by `/api/fs/dirs` — click a row to descend, Up
 * to climb, and the primary action registers the folder shown in the path
 * bar. A single input both filters the current listing and accepts an
 * absolute path (Enter/Go navigates when it looks like a path).
 */
export function FolderPickerModal({
  open,
  onDismiss,
  onConfirm,
}: {
  readonly open: boolean
  readonly onDismiss: () => void
  readonly onConfirm: (path: string) => void
}) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async (target?: string) => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await listDirs(target)
      if (generation.current !== request) return
      setListing(next)
      setQuery('')
    } catch (cause) {
      if (generation.current !== request) return
      setError(String(cause))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const step = (offset: number, from: HTMLButtonElement): void => {
    const rows = [...(from.closest('.folder-picker-list')?.querySelectorAll<HTMLButtonElement>('.folder-picker-row') ?? [])]
    const index = rows.indexOf(from)
    rows[Math.max(0, Math.min(rows.length - 1, (index === -1 ? 0 : index) + offset))]?.focus()
  }

  const filteredDirs = useMemo(() => {
    if (listing === null) return []
    let dirs = listing.dirs
    if (!showHidden) dirs = dirs.filter((dir) => !dir.name.startsWith('.'))
    const trimmed = query.trim()
    if (trimmed !== '' && !looksLikeAbsolutePath(trimmed)) {
      const lower = trimmed.toLowerCase()
      dirs = dirs.filter((dir) => dir.name.toLowerCase().includes(lower) || dir.path.toLowerCase().includes(lower))
    }
    return dirs
  }, [listing, query, showHidden])

  const hiddenCount = useMemo(() => {
    if (listing === null || showHidden) return 0
    return listing.dirs.filter((dir) => dir.name.startsWith('.')).length
  }, [listing, showHidden])

  const breadcrumb = useMemo(() => {
    if (listing === null) return []
    return splitPathSegments(listing.path)
  }, [listing])

  const handleGo = useCallback(() => {
    const target = query.trim()
    if (target === '' || !looksLikeAbsolutePath(target)) return
    void load(target)
  }, [query, load])

  const isPathQuery = looksLikeAbsolutePath(query.trim())

  return (
    <Modal
      open={open}
      onDismiss={onDismiss}
      label="Choose a project folder"
      width="md"
      bodyClassName="flex flex-col gap-3 p-0"
      header={
        <>
          <span className="flex min-w-0 flex-col">
            <strong className="text-base font-semibold">Choose a project folder</strong>
            <small className="text-xs text-fg-faint">The folder registers as a project; the conversation is created by your first message.</small>
          </span>
          <IconButton label="Close folder picker" size="md" onClick={onDismiss}><Icon name="close" size={18} /></IconButton>
        </>
      }
    >
      {/* Breadcrumb — click a segment to jump, Up to go parent */}
      <div className="flex items-center gap-2 px-5 pt-4">
        <IconButton
          label={listing?.parent ? `Go to parent folder ${listing.parent}` : 'Go to parent folder'}
          variant="outline"
          disabled={listing?.parent === null || listing === null}
          onClick={() => { if (listing?.parent !== null && listing !== null) void load(listing.parent) }}
        >
          <Icon name="arrowUp" size={16} />
        </IconButton>
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto truncate rounded-lg bg-muted px-2 py-1.5 text-xs scrollbar-thin" aria-label="Breadcrumb">
          {listing === null ? (
            <span className="font-mono text-fg-muted">{loading ? 'Loading…' : '—'}</span>
          ) : (
            breadcrumb.map((segment, index) => (
              <span key={segment.path} className="flex shrink-0 items-center gap-0.5">
                {index > 0 ? <span className="px-0.5 text-fg-faint">/</span> : null}
                <button
                  type="button"
                  className="max-w-[14ch] truncate rounded px-1 py-0.5 font-mono hover:bg-hover focus-visible:bg-hover"
                  title={segment.path}
                  onClick={() => void load(segment.path)}
                >
                  {segment.label}
                </button>
              </span>
            ))
          )}
        </nav>
      </div>

      {/* Single input: type to filter, paste a path + Enter/Go to navigate */}
      <div className="flex items-center gap-2 px-5">
        <div className="relative flex-1">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
          <input
            className="filter-input w-full !pl-8 !pr-8"
            value={query}
            placeholder="Type to filter, or paste a path and press Enter"
            aria-label="Filter or go to path"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); if (isPathQuery) handleGo() }
              else if (event.key === 'Escape') setQuery('')
            }}
          />
          {query !== '' ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-fg-faint hover:bg-hover hover:text-fg"
              aria-label="Clear"
              onClick={() => setQuery('')}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
        {isPathQuery ? (
          <Button size="sm" variant="outline" onClick={handleGo}>Go</Button>
        ) : null}
        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs hover:bg-hover">
          <input
            type="checkbox"
            className="size-3.5 accent-[--accent]"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          Hidden
        </label>
      </div>

      <div className="folder-picker-list mx-5 h-[min(320px,45dvh)] overflow-y-auto rounded-xl border border-line p-1" role="listbox" aria-label="Folders">
        {error !== null ? (
          <div className="flex flex-col items-start gap-2 p-3 text-sm text-bad" role="alert">
            <span className="flex items-center gap-2"><Icon name="alertTriangle" size={15} />{error}</span>
            <Button size="sm" variant="outline" onClick={() => void load(listing?.path)}>Retry</Button>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 p-3 text-sm text-fg-muted"><Spinner size={13} />Loading…</div>
        ) : (listing?.dirs.length ?? 0) === 0 ? (
          <div className="p-3 text-sm text-fg-muted">No subfolders here.</div>
        ) : filteredDirs.length === 0 ? (
          <div className="p-3 text-sm text-fg-muted">
            No matches for “{query.trim()}”.
            {hiddenCount > 0 ? ` ${hiddenCount} hidden folders are hidden — toggle “Hidden” to show.` : null}
          </div>
        ) : (
          <>
            {hiddenCount > 0 && query.trim() === '' ? (
              <div className="px-2.5 pb-1 pt-1 text-[11px] text-fg-faint">{hiddenCount} hidden folders hidden — toggle “Hidden” to show.</div>
            ) : null}
            {filteredDirs.map((dir) => (
              <div role="option" aria-selected={false} key={dir.path}>
                <button
                  type="button"
                  className="folder-picker-row flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover"
                  onClick={() => void load(dir.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') { event.preventDefault(); step(1, event.currentTarget) }
                    else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1, event.currentTarget) }
                  }}
                >
                  <Icon name="folder" size={15} className="text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate">{dir.name}</span>
                  <Icon name="chevronRight" size={14} className="text-fg-faint" />
                </button>
              </div>
            ))}
          </>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" onClick={onDismiss}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={listing === null || loading || error !== null} onClick={() => { if (listing !== null) onConfirm(listing.path) }}>
          Choose this folder
        </Button>
      </footer>
    </Modal>
  )
}
