import { lazy, Suspense, type ReactNode } from 'react'

const TerminalPanel = lazy(async () => import('./TerminalPanel.tsx'))

/**
 * The chat column's terminal footer. Hidden until Ctrl+` shows it, so a
 * closed terminal leaves the conversation flush with the bottom of the
 * window. The shell tabs are the only chrome; the close button lives on
 * that strip. The workbench has its own Terminal tab.
 */
export function TerminalDock({ workspaceId, projectId, height, resizeHandle, open, onOpenChange, defaultShell, onDefaultShell, bindingReady = true }: {
  readonly workspaceId: string | null
  readonly projectId: string | null
  /** Height in px while the dock is open. Closed renders nothing. */
  readonly height: number
  /** Props from usePanelResize with side: 'bottom'; spread onto the separator. */
  readonly resizeHandle: Record<string, unknown>
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly defaultShell: string | null
  readonly onDefaultShell: (shellId: string | null) => void
  /** Passed to the panel; holds its auto-open until the project binding is final. */
  readonly bindingReady?: boolean
}) {
  let body: ReactNode = null
  if (open) {
    body = (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">Loading terminal…</div>}>
        <TerminalPanel
          key={projectId ?? 'workspace'}
          workspaceId={workspaceId}
          projectId={projectId}
          defaultShell={defaultShell}
          onDefaultShell={onDefaultShell}
          onHide={() => onOpenChange(false)}
          bindingReady={bindingReady}
        />
      </Suspense>
    )
  }

  // A closed footer leaves no bar. Ctrl+` is the way back in.
  if (!open) return null

  return (
    <section aria-label="Terminal" className="flex shrink-0 flex-col bg-bg">
      <div
        {...resizeHandle}
        aria-label="Resize terminal"
        // The handle is the footer's only top rule: one hairline, with the
        // grab area hanging off it, so the tab strip below stays centred.
        className="relative z-10 h-px shrink-0 cursor-row-resize bg-line outline-none transition-colors before:absolute before:inset-x-0 before:-top-1.5 before:bottom-0 before:content-[''] hover:bg-link focus-visible:bg-link"
      />
      <div className="flex min-h-0 flex-col overflow-hidden bg-bg" style={{ height }}>
        {body}
      </div>
    </section>
  )
}
