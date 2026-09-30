import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import Icon from '../common/Icon.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import {
  createTerminal,
  fromBase64,
  killTerminal,
  listTerminals,
  resizeTerminal,
  subscribeTerminals,
  writeTerminal,
} from '../../lib/api.ts'
import type { ShellRow, TerminalRow } from '../../lib/types.ts'

/** Keystrokes are batched per frame: one POST per character would be ~80 req/s while typing. */
const INPUT_FLUSH_MS = 16
/** Dragging the panel divider fires a resize per pointer move; only the settled size matters. */
const RESIZE_DEBOUNCE_MS = 100

const NEW_TERMINAL_CLASS = 'flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40'

/** Read a CSS custom property from the shell, so the terminal follows the app theme. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

function themeFromTokens(): Record<string, string> {
  return {
    background: token('--bg', '#1a1714'),
    foreground: token('--fg', '#efe9e3'),
    cursor: token('--accent', '#c96442'),
    cursorAccent: token('--bg', '#1a1714'),
    selectionBackground: token('--muted', '#3a332d'),
  }
}

interface Attached {
  readonly term: Terminal
  readonly fit: FitAddon
  readonly host: HTMLDivElement
  pendingInput: string
  inputTimer: ReturnType<typeof setTimeout> | undefined
  resizeTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether `onData` may reach the PTY. False while replaying scrollback:
   * xterm parses writes asynchronously and answers device queries it finds,
   * and those answers must not be typed into the live shell.
   */
  acceptInput: boolean
}

/**
 * The Workbench terminal: a tab strip over real xterm instances, fed by the
 * workspace's multiplexed stream.
 *
 * Instances are kept alive and merely hidden when another tab is selected —
 * disposing one would throw away scrollback and cursor state that the server
 * has no obligation to resend.
 */
export function TerminalPanel({ workspaceId, projectId, defaultShell, onDefaultShell, onHide }: {
  readonly workspaceId: string | null
  readonly projectId: string | null
  /** Preferred shell id; `null` defers to the host's own order. */
  readonly defaultShell?: string | null
  readonly onDefaultShell?: (shellId: string | null) => void
  /**
   * Hides the whole panel without killing shells. The chat footer uses it;
   * the workbench tab does not, because closing that tab is the tab's own X.
   */
  readonly onHide?: () => void
}) {
  const [rows, setRows] = useState<readonly TerminalRow[]>([])
  // The view shows one project's shells. A terminal with no project only
  // appears while no project is open.
  const visibleRows = rows.filter((row) => (row.projectId ?? null) === projectId)
  const [shells, setShells] = useState<readonly ShellRow[]>([])
  const [max, setMax] = useState(4)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Set once the host's terminal list has arrived, so auto-open knows what exists. */
  const [ready, setReady] = useState(false)
  const attached = useRef(new Map<string, Attached>())
  const mountRef = useRef<HTMLDivElement | null>(null)
  /** Auto-open fires once per mount; closing the last terminal must not reopen it. */
  const autoOpened = useRef(false)

  /** Build (or reuse) the xterm instance backing one terminal id. */
  const attach = useCallback((id: string, cols: number, rows_: number): Attached | undefined => {
    const existing = attached.current.get(id)
    if (existing !== undefined) return existing
    const mount = mountRef.current
    if (mount === null || workspaceId === null) return undefined

    const host = document.createElement('div')
    // The gutter belongs here, not on the mount: an absolutely positioned
    // child resolves `inset-0` against the mount's padding box, so padding
    // there would be covered rather than seen. FitAddon reads this element's
    // content box, so the columns shrink to match instead of overflowing.
    host.className = 'absolute inset-0 pl-3 pr-2 py-2'
    mount.appendChild(host)

    const term = new Terminal({
      cols,
      rows: rows_,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      // A docked panel is narrower than a real terminal window, and a Git Bash
      // prompt carrying user@host, the path and a branch runs past 90 columns
      // on its own. 12px buys roughly seven columns over the shell's 13px
      // without dropping below comfortable reading size.
      fontSize: 12,
      theme: themeFromTokens(),
      cursorBlink: true,
      scrollback: 5_000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    const record: Attached = { term, fit, host, pendingInput: '', inputTimer: undefined, resizeTimer: undefined, acceptInput: true }

    // `onData` fires for keystrokes AND for replies xterm synthesizes while
    // parsing output (Primary DA `ESC[?1;2c` is the one Git Bash provokes with
    // `CSI c` at startup and again on every resize). A reload replays
    // scrollback into a fresh instance, so that reply would be written back
    // into a shell whose line discipline is already echoing — which is the
    // stray `1;2c` on the prompt. Replies are not input; only keystrokes are.
    term.onData((chunk) => {
      if (!record.acceptInput) return
      record.pendingInput += chunk
      if (record.inputTimer !== undefined) return
      record.inputTimer = setTimeout(() => {
        record.inputTimer = undefined
        const payload = record.pendingInput
        record.pendingInput = ''
        if (payload === '') return
        void writeTerminal(workspaceId, id, payload).catch((cause: unknown) => setError(String(cause)))
      }, INPUT_FLUSH_MS)
    })

    term.onResize(({ cols: nextCols, rows: nextRows }) => {
      if (record.resizeTimer !== undefined) clearTimeout(record.resizeTimer)
      record.resizeTimer = setTimeout(() => {
        record.resizeTimer = undefined
        void resizeTerminal(workspaceId, id, nextCols, nextRows).catch(() => undefined)
      }, RESIZE_DEBOUNCE_MS)
    })

    attached.current.set(id, record)
    return record
  }, [workspaceId])

  const detach = useCallback((id: string): void => {
    const record = attached.current.get(id)
    if (record === undefined) return
    if (record.inputTimer !== undefined) clearTimeout(record.inputTimer)
    if (record.resizeTimer !== undefined) clearTimeout(record.resizeTimer)
    record.term.dispose()
    record.host.remove()
    attached.current.delete(id)
  }, [])

  // Load the catalog, then follow the workspace's terminal stream. The
  // snapshot carries scrollback, so a reload reattaches instead of restarting.
  useEffect(() => {
    if (workspaceId === null) return undefined
    let live = true
    const instances = attached.current

    void listTerminals(workspaceId).then((listing) => {
      if (!live) return
      setShells(listing.shells)
      setMax(listing.max)
      setUnavailable(listing.available ? null : listing.unavailable ?? 'no PTY backend on this host')
    }).catch((cause: unknown) => {
      if (live) setError(String(cause))
    })

    const unsubscribe = subscribeTerminals(workspaceId, (frame) => {
      if (!live) return
      if (frame.kind === 'snapshot') {
        // A snapshot also arrives on every EventSource reconnect, so it must
        // be treated as the full truth, not as more output: replay it into a
        // cleared terminal instead of appending a second copy, and drop any
        // instance the host no longer knows about (a restarted host reports
        // none, and those views would otherwise linger forever).
        const present = new Set(frame.terminals.map((entry) => entry.id))
        for (const id of [...attached.current.keys()]) {
          if (!present.has(id)) detach(id)
        }
        setRows(frame.terminals.map(({ scrollback: _scrollback, ...info }) => info))
        for (const entry of frame.terminals) {
          // Another project's shell stays alive on the host but is not drawn
          // here; attaching it would show its prompt in this project's view.
          if ((entry.projectId ?? null) !== projectId) continue
          const record = attach(entry.id, entry.cols, entry.rows)
          if (record === undefined) continue
          // Writes are parsed on a later turn, and a replayed `CSI c` (Git
          // Bash sends one at startup and on resize) makes xterm answer
          // `ESC[?1;2c` through onData. Hold input across that turn so the
          // answer is not written into the shell as `1;2c`.
          record.acceptInput = false
          if (record.inputTimer !== undefined) {
            clearTimeout(record.inputTimer)
            record.inputTimer = undefined
            record.pendingInput = ''
          }
          record.term.reset()
          record.term.write(fromBase64(entry.scrollback), () => {
            record.acceptInput = true
          })
        }
        setActiveId((current) => {
          const mine = frame.terminals.filter((entry) => (entry.projectId ?? null) === projectId)
          return current !== null && mine.some((entry) => entry.id === current) ? current : mine[0]?.id ?? null
        })
        setReady(true)
        return
      }
      if (frame.kind === 'created') {
        setRows((current) => current.some((row) => row.id === frame.terminal.id) ? current : [...current, frame.terminal])
        // The stream is per workspace, so a shell opened for another project
        // arrives here too. Remember it, but do not surface it in this view.
        if ((frame.terminal.projectId ?? null) !== projectId) return
        attach(frame.terminal.id, frame.terminal.cols, frame.terminal.rows)
        setActiveId(frame.terminal.id)
        return
      }
      if (frame.kind === 'data') {
        attached.current.get(frame.terminalId)?.term.write(fromBase64(frame.data))
        return
      }
      const record = attached.current.get(frame.terminalId)
      record?.term.write(`\r\n\u001b[2m[${frame.reason === 'idle' ? 'closed: idle' : `exited: ${frame.exitCode}`}]\u001b[0m\r\n`)
      setRows((current) => current.filter((row) => row.id !== frame.terminalId))
      setActiveId((current) => (current === frame.terminalId ? null : current))
      window.setTimeout(() => detach(frame.terminalId), 1_500)
    })

    return () => {
      live = false
      unsubscribe()
      for (const id of [...instances.keys()]) detach(id)
    }
  }, [workspaceId, projectId, attach, detach])

  const open = useCallback(async (shellId?: string): Promise<void> => {
    if (workspaceId === null) return
    setError(null)
    try {
      await createTerminal(workspaceId, {
        cols: 80,
        rows: 24,
        ...(shellId !== undefined ? { shellId } : {}),
        ...(projectId !== null ? { projectId } : {}),
      })
    } catch (cause: unknown) {
      setError(String(cause))
    }
  }, [workspaceId, projectId])

  /**
   * The remembered shell, but only while the host still offers it — an
   * uninstalled shell must fall back to the host's order rather than fail
   * every open.
   */
  const preferredShell = defaultShell !== null && defaultShell !== undefined
    && shells.some((shell) => shell.id === defaultShell)
    ? defaultShell
    : undefined

  // Opening the Terminal view should land in a usable shell, not in a picker:
  // once per mount, an empty workspace gets one terminal on the preferred
  // shell. Closing the last one is a decision, so it is never undone here.
  useEffect(() => {
    if (!ready || autoOpened.current || unavailable !== null || visibleRows.length > 0) return
    autoOpened.current = true
    void open(preferredShell)
  }, [ready, unavailable, visibleRows.length, preferredShell, open])

  // Only the selected terminal is visible, and it refits whenever it becomes
  // so: xterm cannot measure a hidden element, so fitting on mount alone
  // leaves a wrong geometry behind every tab switch and sheet open.
  useEffect(() => {
    for (const [id, record] of attached.current) {
      const visible = id === activeId
      record.host.style.display = visible ? 'block' : 'none'
      if (!visible) continue
      try {
        record.fit.fit()
      } catch {
        // The panel can be zero-sized mid-transition; the observer refits.
      }
      record.term.focus()
    }
  }, [activeId, rows])

  useEffect(() => {
    const mount = mountRef.current
    if (mount === null) return undefined
    const observer = new ResizeObserver(() => {
      const record = activeId === null ? undefined : attached.current.get(activeId)
      if (record === undefined) return
      try {
        record.fit.fit()
      } catch {
        // Zero-sized during a layout transition; the next callback refits.
      }
    })
    observer.observe(mount)
    return () => observer.disconnect()
  }, [activeId])

  const close = async (id: string): Promise<void> => {
    if (workspaceId === null) return
    try {
      await killTerminal(workspaceId, id)
    } catch (cause: unknown) {
      setError(String(cause))
    }
  }

  if (workspaceId === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="terminal" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">No workspace selected</p>
        <p className="m-0 max-w-xs text-[13px] text-fg-muted">Pick a workspace to open a terminal in it.</p>
      </div>
    )
  }

  if (unavailable !== null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="terminal" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">Terminals are unavailable on this host</p>
        <p className="m-0 max-w-md text-[13px] text-fg-muted">{unavailable}</p>
      </div>
    )
  }

  // The cap is the workspace's, so shells open in other projects count.
  const atCap = rows.length >= max

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5" role="toolbar" aria-label="Terminals">
        {visibleRows.map((row) => (
          <span
            key={row.id}
            className={cn('group flex h-7 shrink-0 items-center rounded-md', row.id === activeId ? 'bg-muted' : 'hover:bg-hover')}
          >
            <button
              type="button"
              aria-pressed={row.id === activeId}
              title={`${row.label} — ${row.cwd}`}
              onClick={() => setActiveId(row.id)}
              className={cn('flex h-full items-center gap-1.5 pl-2 pr-1 text-[12px]', row.id === activeId ? 'text-fg' : 'text-fg-muted hover:text-fg')}
            >
              <Icon name="terminal" size={13} />
              {row.label}
            </button>
            <button
              type="button"
              aria-label={`Close ${row.label}`}
              title="Close"
              onClick={() => void close(row.id)}
              className="mr-1 flex size-5 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg"
            >
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
        {/* The primary action never asks: it opens the shell already chosen. */}
        <button
          type="button"
          aria-label="New terminal"
          title={atCap ? `At most ${max} terminals per workspace` : 'New terminal'}
          disabled={atCap}
          onClick={() => void open(preferredShell)}
          className={NEW_TERMINAL_CLASS}
        >
          <Icon name="plus" size={14} />
        </button>
        {/* With one shell there is nothing to choose and nothing to configure. */}
        {shells.length > 1 ? (
          <Menu
            label="Terminal shells"
            triggerClassName={NEW_TERMINAL_CLASS}
            trigger={() => <Icon name="chevron" size={13} />}
          >
            {(close) => (
              <>
                <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-muted">Open a shell</p>
                {shells.map((shell) => (
                  <button
                    key={shell.id}
                    type="button"
                    role="menuitem"
                    className={menuItemClass}
                    disabled={atCap}
                    onClick={() => { close(); void open(shell.id) }}
                  >
                    <Icon name="terminal" size={13} />
                    {shell.label}
                  </button>
                ))}
                {onDefaultShell !== undefined ? (
                  <>
                    <div className="my-1 h-px bg-line" aria-hidden="true" />
                    <p className="px-2.5 pb-1 text-xs font-medium text-fg-muted">Default shell</p>
                    {[{ id: null, label: 'Host default' }, ...shells.map((shell) => ({ id: shell.id as string | null, label: shell.label }))].map((option) => {
                      const selected = (defaultShell ?? null) === option.id
                      return (
                        <button
                          key={option.id ?? 'host-default'}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={menuItemClass}
                          onClick={() => { close(); onDefaultShell(option.id) }}
                        >
                          <Icon name={selected ? 'check' : 'circle'} size={13} className={selected ? undefined : 'opacity-40'} />
                          {option.label}
                        </button>
                      )
                    })}
                  </>
                ) : null}
              </>
            )}
          </Menu>
        ) : null}
        {onHide !== undefined ? (
          <>
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Close terminal (Ctrl+`)"
              title="Close terminal (Ctrl+`)"
              onClick={onHide}
              className={NEW_TERMINAL_CLASS}
            >
              <Icon name="close" size={14} />
            </button>
          </>
        ) : null}
      </div>

      {error !== null ? (
        <p role="alert" className="m-0 border-b border-line px-3 py-1.5 text-[12px] text-danger">{error}</p>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg" ref={mountRef}>
        {visibleRows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Icon name="terminal" size={22} className="text-fg-faint" />
            <p className="m-0 text-sm font-medium">No terminal open</p>
            <p className="m-0 max-w-xs text-[13px] text-fg-muted">
              Open one to run commands yourself. This shell is separate from the assistant&apos;s tools.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default TerminalPanel
