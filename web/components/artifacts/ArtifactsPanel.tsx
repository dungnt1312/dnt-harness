import { useMemo } from 'react'
import type { SseEvent } from '../../lib/types.ts'
import type { FileFocus } from '../../lib/tool-facts.ts'
import { projectArtifacts, type ArtifactItem } from './artifact-projector.ts'

/**
 * Returns an opener when a recorded path resolves inside the project, else
 * null. `focus` is the window the call named, so the viewer can land on the
 * lines the call actually read instead of the top of the file.
 */
export type OpenPathResolver = (reference: string, focus?: FileFocus) => (() => void) | null

const RECOVERED_NOTE = 'Outcome unknown — the host restarted before this result was recorded.'

function ArtifactRow({ item, openPath }: { readonly item: ArtifactItem; readonly openPath?: OpenPathResolver }) {
  const open = item.kind === 'file-reference' && item.reference !== undefined ? openPath?.(item.reference) ?? null : null
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-fg-faint">{item.label}</div>
          <div className="mt-0.5 break-words font-mono text-[13px]">{item.reference ?? item.command ?? item.toolName}</div>
          {item.argumentKey !== undefined ? <div className="mt-0.5 font-mono text-xs text-fg-faint">{item.argumentKey}</div> : null}
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-fg-muted">{item.state}</span>
      </div>
      {open !== null ? <button type="button" className="mt-2 text-xs text-link hover:underline" onClick={open}>Open in workbench</button> : null}
      {item.state === 'unknown' ? <p className="m-0 mt-2 text-xs text-warn">{RECOVERED_NOTE}</p> : null}
      {item.output !== undefined ? (
        <details className="mt-2">
          <summary className="text-xs text-fg-muted">Recorded tool output</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2.5 text-xs">{item.output}</pre>
        </details>
      ) : null}
    </li>
  )
}

/**
 * Recorded artifacts. "Open in workbench" is offered only when the caller can
 * resolve the reference inside the project; it reads the current file, not a
 * snapshot from the tool call.
 */
export function ArtifactsPanel({ events, openPath }: { readonly events: readonly SseEvent[]; readonly openPath?: OpenPathResolver }) {
  const items = useMemo(() => projectArtifacts(events), [events])
  if (items.length === 0) return <p className="m-0 py-6 text-center text-sm text-fg-faint">No recorded artifacts for this conversation yet.</p>
  return <ul aria-label="Recorded artifacts" className="m-0 flex list-none flex-col gap-2 p-0">{items.map((item) => <ArtifactRow key={item.id} item={item} {...(openPath !== undefined ? { openPath } : {})} />)}</ul>
}
