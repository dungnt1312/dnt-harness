// @vitest-environment jsdom
/**
 * The terminal panel's own behaviour: catalog-driven shell picker, tab strip,
 * cross-project visibility, scrollback reattach from the snapshot, batched
 * input, and the unavailable-host message.
 *
 * xterm is mocked. jsdom has no renderer or layout, so asserting against a
 * real terminal here would prove nothing about rendering while making the
 * suite depend on canvas internals. Real typing, colour and reflow belong to
 * the Playwright pass.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const written: string[] = []
const disposed: string[] = []

/** A stand-in xterm: records what the panel writes and exposes its onData hook. */
class MockTerminal {
  static last: MockTerminal | undefined
  static instances: MockTerminal[] = []
  data: ((chunk: string) => void) | undefined
  resize: ((size: { cols: number; rows: number }) => void) | undefined
  readonly writes: string[] = []

  constructor(readonly options: Record<string, unknown>) {
    MockTerminal.last = this
    MockTerminal.instances.push(this)
  }
  loadAddon(): void {}
  open(): void {}
  write(chunk: string, callback?: () => void): void {
    this.writes.push(chunk)
    written.push(chunk)
    // xterm parses a write on a later turn and only then invokes the callback.
    // Replies synthesized during that parse (the `1;2c` bug) arrive through
    // onData before the callback, so the mock preserves that ordering.
    queueMicrotask(() => {
      if (chunk.includes('[c')) this.data?.('[?1;2c')
      callback?.()
    })
  }
  onData(listener: (chunk: string) => void): void {
    this.data = listener
  }
  onResize(listener: (size: { cols: number; rows: number }) => void): void {
    this.resize = listener
  }
  reset(): void {
    this.writes.length = 0
    written.push('[reset]')
  }
  focus(): void {}
  dispose(): void {
    disposed.push('disposed')
  }
}

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

const api = vi.hoisted(() => ({
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  killTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  subscribeTerminals: vi.fn(),
}))

vi.mock('../../lib/api.ts', () => ({
  ...api,
  // The real base64 helpers: the panel's decode path is part of what is tested.
  fromBase64: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
  toBase64: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
}))

const { TerminalPanel, clearAutoOpenClaims } = await import('./TerminalPanel.tsx')

type Frame = Parameters<Parameters<typeof api.subscribeTerminals>[1]>[0]

let host: HTMLDivElement
let root: Root | undefined
let push: (frame: Frame) => void

const row = (id: string, label = 'Git Bash', shellId = 'bash') => ({
  id,
  workspaceId: 'ws',
  shellId,
  label,
  cwd: '/work',
  cols: 80,
  rows: 24,
  createdAt: 1,
})

beforeEach(() => {
  written.length = 0
  disposed.length = 0
  MockTerminal.instances = []
  MockTerminal.last = undefined
  vi.clearAllMocks()
  clearAutoOpenClaims()
  global.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as never
  api.listTerminals.mockResolvedValue({
    terminals: [],
    shells: [{ id: 'bash', label: 'Git Bash' }, { id: 'powershell', label: 'PowerShell' }],
    available: true,
  })
  api.createTerminal.mockResolvedValue(row('terminal-1'))
  api.killTerminal.mockResolvedValue({ killed: true })
  api.writeTerminal.mockResolvedValue({})
  api.resizeTerminal.mockResolvedValue(row('terminal-1'))
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api.subscribeTerminals.mockImplementation((_ws: string, onFrame: (frame: Frame) => void) => {
    push = onFrame
    return () => {}
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  if (root !== undefined) act(() => root.unmount())
  root = undefined
  host.remove()
})

async function mount(props: {
  workspaceId?: string | null
  projectId?: string | null
  defaultShell?: string | null
  onDefaultShell?: (shellId: string | null) => void
  onHide?: () => void
  bindingReady?: boolean
} = {}): Promise<void> {
  if (root === undefined) {
    root = createRoot(host)
  }
  await act(async () => {
    root.render(
      <TerminalPanel
        workspaceId={props.workspaceId === undefined ? 'ws' : props.workspaceId}
        projectId={props.projectId ?? null}
        defaultShell={props.defaultShell ?? null}
        {...(props.onDefaultShell !== undefined ? { onDefaultShell: props.onDefaultShell } : {})}
        {...(props.onHide !== undefined ? { onHide: props.onHide } : {})}
        bindingReady={props.bindingReady ?? true}
      />,
    )
  })
}

/** Unmount the current tree; the next mount starts a fresh root, like a remount. */
async function unmount(): Promise<void> {
  await act(async () => root.unmount())
  root = undefined as unknown as Root
}

describe('terminal panel', () => {
  it('offers only the shells the host reported', async () => {
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    const picker = host.querySelector<HTMLButtonElement>('button[aria-label="Terminal shells"]')
    expect(picker).not.toBeNull()
    await act(async () => picker!.click())

    // The picker is a portalled menu, so it renders outside the panel's host.
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(labels).toContain('Git Bash')
    expect(labels).toContain('PowerShell')
    // cmd was not in the catalog, so it must not be offered.
    expect(labels).not.toContain('Command Prompt')
  })

  it('dismisses the shell picker on Escape instead of leaving it pinned open', async () => {
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Terminal shells"]')!.click())
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull()

    await act(async () => {
      document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    })
    expect(document.querySelector('[role="menuitem"]')).toBeNull()
  })

  it('opens one terminal by itself so the view never lands on a picker', async () => {
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    expect(api.createTerminal).toHaveBeenCalledTimes(1)
    // No shellId: with no preference the host picks, which is Git Bash first
    // and PowerShell when Git Bash is absent.
    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.not.objectContaining({ shellId: expect.anything() }))
  })

  it('auto-opens the preferred shell when one is remembered', async () => {
    await mount({ defaultShell: 'powershell' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.objectContaining({ shellId: 'powershell' }))
  })

  it('ignores a remembered shell the host no longer offers', async () => {
    await mount({ defaultShell: 'fish' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    // Falling back to the host's order beats failing every open.
    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.not.objectContaining({ shellId: expect.anything() }))
  })

  it('does not auto-open again after the last terminal is closed', async () => {
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    expect(api.createTerminal).toHaveBeenCalledTimes(1)

    await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))
    await act(async () => push({ kind: 'exit', terminalId: 'terminal-1', exitCode: 0, reason: 'killed' }))

    // Closing the last terminal is a decision, not a gap to fill.
    expect(api.createTerminal).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('No terminal open')
  })

  it('does not auto-open when the mount inherits a shell and it later exits', async () => {
    // Ctrl+` reopened over a live shell (a hidden footer kept it alive): this
    // mount adopted that shell instead of opening one, and when it exits the
    // close is still final — no fresh shell appears in its place.
    const onHide = vi.fn()
    await mount({ onHide })
    await act(async () => push({
      kind: 'snapshot',
      terminals: [{ ...row('terminal-1'), scrollback: '' }],
    }))
    expect(api.createTerminal).not.toHaveBeenCalled()

    await act(async () => push({ kind: 'exit', terminalId: 'terminal-1', exitCode: 0, reason: 'killed' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })

    expect(api.createTerminal).not.toHaveBeenCalled()
    expect(onHide).toHaveBeenCalledTimes(1)
  })

  it('closes the footer itself once the last shell exits, but stays for a fresh one', async () => {
    const onHide = vi.fn()
    await mount({ onHide })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))

    await act(async () => push({ kind: 'exit', terminalId: 'terminal-1', exitCode: 0, reason: 'exit' }))
    // The exit note gets its moment before the surface folds.
    expect(onHide).not.toHaveBeenCalled()
    await act(async () => push({ kind: 'created', terminal: row('terminal-2', 'PowerShell', 'powershell') }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    // A shell opened during the notice window keeps the surface open.
    expect(onHide).not.toHaveBeenCalled()

    await act(async () => push({ kind: 'exit', terminalId: 'terminal-2', exitCode: 0, reason: 'exit' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    expect(onHide).toHaveBeenCalledTimes(1)
  })

  it('closes the footer after the last exit only when it can hide, and the workbench stays', async () => {
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))
    await act(async () => push({ kind: 'exit', terminalId: 'terminal-1', exitCode: 0, reason: 'exit' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })

    // No onHide: the workbench tab cannot fold itself, so the empty state
    // remains until the operator opens or closes it.
    expect(host.textContent).toContain('No terminal open')
  })

  it('does not auto-open on a host with no PTY backend', async () => {
    api.listTerminals.mockResolvedValue({
      terminals: [],
      shells: [],
      available: false,
      unavailable: 'node-pty is not available (test)',
    })
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    expect(api.createTerminal).not.toHaveBeenCalled()
  })

  it('holds the auto-open while the project binding is still loading, then opens for the project', async () => {
    await act(async () => {
      root.render(<TerminalPanel workspaceId="ws" projectId={null} defaultShell={null} bindingReady={false} />)
    })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    // The session list has not landed yet: opening now would create the shell
    // in the host's default folder instead of the conversation's project.
    expect(api.createTerminal).not.toHaveBeenCalled()

    // The binding resolves (project known); the held auto-open may fire.
    await act(async () => {
      root.render(<TerminalPanel workspaceId="ws" projectId="project-1" defaultShell={null} bindingReady />)
    })
    expect(api.createTerminal).toHaveBeenCalledTimes(1)
    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.objectContaining({ projectId: 'project-1' }))
  })

  it('disables manual opens while the project binding is still loading', async () => {
    await mount({ bindingReady: false })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    const plus = host.querySelector<HTMLButtonElement>('button[aria-label="New terminal"]')
    expect(plus).not.toBeNull()
    expect(plus!.disabled).toBe(true)
    await act(async () => plus!.click())
    expect(api.createTerminal).not.toHaveBeenCalled()
  })

  it('records a new default shell without opening one', async () => {
    const onDefaultShell = vi.fn()
    await mount({ onDefaultShell })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    api.createTerminal.mockClear()

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Terminal shells"]')!.click())
    const radios = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[]
    const powershell = radios.find((item) => item.textContent?.includes('PowerShell'))
    expect(powershell).toBeDefined()
    await act(async () => powershell!.click())

    expect(onDefaultShell).toHaveBeenCalledWith('powershell')
    expect(api.createTerminal).not.toHaveBeenCalled()
  })

  it('replays snapshot scrollback so a reload reattaches instead of restarting', async () => {
    await mount()
    await act(async () => push({
      kind: 'snapshot',
      terminals: [{ ...row('terminal-1'), scrollback: Buffer.from('previous output', 'utf8').toString('base64') }],
    }))

    expect(written).toContain('previous output')
    expect(host.textContent).toContain('Git Bash')
  })

  it('does not type the device-attributes reply from a replayed query into the shell', async () => {
    await mount()
    // Git Bash's startup (and every resize) contains `CSI c`. Replaying it must
    // not send xterm's `ESC[?1;2c` answer back to the PTY — the shell echoes
    // that as the stray `1;2c` on the prompt.
    const scrollback = 'MINGW64 /work\r\n\u001b[c$ '
    await act(async () => push({
      kind: 'snapshot',
      terminals: [{ ...row('terminal-1'), scrollback: Buffer.from(scrollback, 'utf8').toString('base64') }],
    } as Frame))
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.writeTerminal).not.toHaveBeenCalled()

    // Keystrokes after the replay still go through.
    const term = MockTerminal.instances[0]
    act(() => term?.data?.('ls\r'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(api.writeTerminal).toHaveBeenCalledWith('ws', 'terminal-1', 'ls\r')
  })

  it('replays a reconnect snapshot into a cleared terminal instead of doubling it', async () => {
    await mount()
    const snapshot = {
      kind: 'snapshot',
      terminals: [{ ...row('terminal-1'), scrollback: Buffer.from('output', 'utf8').toString('base64') }],
    }
    await act(async () => push(snapshot as Frame))
    // EventSource reconnects on its own and the host re-sends the snapshot.
    await act(async () => push(snapshot as Frame))

    const term = MockTerminal.instances[0]
    expect(MockTerminal.instances).toHaveLength(1)
    // Cleared before the replay, so the scrollback is present exactly once.
    expect(term?.writes).toEqual(['output'])
  })

  it('drops terminals a reconnect snapshot no longer reports', async () => {
    await mount()
    await act(async () => push({
      kind: 'snapshot',
      terminals: [{ ...row('terminal-1'), scrollback: '' }],
    } as Frame))
    expect(MockTerminal.instances).toHaveLength(1)

    // A restarted host reports none; the stale view must not linger.
    await act(async () => push({ kind: 'snapshot', terminals: [] } as Frame))

    expect(disposed).toHaveLength(1)
    expect(host.textContent).toContain('No terminal open')
  })

  it('batches keystrokes into one request instead of one per character', async () => {
    vi.useFakeTimers()
    try {
      await mount()
      await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))

      const term = MockTerminal.last
      expect(term).toBeDefined()
      act(() => {
        term!.data?.('l')
        term!.data?.('s')
        term!.data?.('\r')
      })
      expect(api.writeTerminal).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(20)
      })
      expect(api.writeTerminal).toHaveBeenCalledTimes(1)
      expect(api.writeTerminal).toHaveBeenCalledWith('ws', 'terminal-1', 'ls\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounces resize so dragging the divider does not flood the host', async () => {
    vi.useFakeTimers()
    try {
      await mount()
      await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))

      const term = MockTerminal.last
      act(() => {
        term!.resize?.({ cols: 90, rows: 30 })
        term!.resize?.({ cols: 100, rows: 32 })
        term!.resize?.({ cols: 120, rows: 40 })
      })
      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      expect(api.resizeTerminal).toHaveBeenCalledTimes(1)
      expect(api.resizeTerminal).toHaveBeenCalledWith('ws', 'terminal-1', 120, 40)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes the conversation project so the shell opens in it', async () => {
    api.listTerminals.mockResolvedValue({
      terminals: [],
      shells: [{ id: 'bash', label: 'Git Bash' }],
      available: true,
    })
    await mount({ projectId: 'project-7', defaultShell: 'bash' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    // The auto-opened terminal already carries the project and the preference.
    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.objectContaining({ projectId: 'project-7', shellId: 'bash' }))

    // And so does one opened by hand afterwards.
    api.createTerminal.mockClear()
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New terminal"]')!.click())
    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.objectContaining({ projectId: 'project-7', shellId: 'bash' }))
  })

  it('shows only the open project terminals and opens one of its own', async () => {
    await mount({ projectId: 'project-7' })
    await act(async () => push({
      kind: 'snapshot',
      terminals: [
        { ...row('terminal-1'), projectId: 'project-7', scrollback: Buffer.from('mine', 'utf8').toString('base64') },
        { ...row('terminal-2', 'PowerShell', 'powershell'), projectId: 'project-9', scrollback: Buffer.from('theirs', 'utf8').toString('base64') },
      ],
    } as Frame))

    // The other project's shell is alive on the host and shows as a dimmed tab,
    // but its output is never drawn or replayed here.
    expect(host.querySelectorAll('span[title*="another project"]')).toHaveLength(1)
    expect(written).toContain('mine')
    expect(written).not.toContain('theirs')
    expect(MockTerminal.instances).toHaveLength(1)
    // This project already has a shell, so none is opened for it.
    expect(api.createTerminal).not.toHaveBeenCalled()
  })

  it('opens a shell for a project whose folder has none yet, even while another project has one', async () => {
    await mount({ projectId: 'project-7' })
    await act(async () => push({
      kind: 'snapshot',
      terminals: [{ ...row('terminal-2'), projectId: 'project-9', scrollback: '' }],
    } as Frame))

    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.objectContaining({ projectId: 'project-7' }))
  })

  it('does not stack another shell when session switches remount the view', async () => {
    // Session A (project-7) spends its auto-open; switching to session B in
    // another folder remounts the panel (the key follows the project) and
    // spends project-9's; switching back must not open a second project-7
    // shell — the '+' button is the way to a new one.
    await mount({ projectId: 'project-7' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    expect(api.createTerminal).toHaveBeenCalledTimes(1)

    await unmount()
    await mount({ projectId: 'project-9' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    // project-9's own first open, not a second project-7 shell.
    expect(api.createTerminal).toHaveBeenCalledTimes(1)

    await unmount()
    api.createTerminal.mockClear()
    await mount({ projectId: 'project-7' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    expect(api.createTerminal).not.toHaveBeenCalled()
    expect(host.textContent).toContain('No terminal open')
  })

  it('still opens for a project whose claim exists but which has no live shell from a previous page load', async () => {
    // The claim is page-lifetime, not durable: a shell that died with the
    // previous page (or was closed there) leaves this mount empty and the
    // claim spent — but this is a new page, so the project gets one shell.
    await mount({ projectId: 'project-7' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    expect(api.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not spend a project claim while the binding is loading, then unmounts', async () => {
    // The claim is spent only when an open actually fires. A mount that
    // unmounts while still holding the open (binding loading) leaves the
    // project's allowance intact for the next mount.
    await act(async () => {
      root.render(<TerminalPanel workspaceId="ws" projectId="project-1" defaultShell={null} bindingReady={false} />)
    })
    await unmount()
    await mount({ projectId: 'project-1' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    expect(api.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('opens for this project even when other projects already hold live shells', async () => {
    await mount({ projectId: 'project-7' })
    await act(async () => push({
      kind: 'snapshot',
      terminals: ['other-1', 'other-2', 'other-3'].map((id) => ({
        ...row(id), projectId: 'project-9',
        scrollback: Buffer.from('private output').toString('base64'),
      })),
    } as Frame))

    // There is no quota: the view still opens its own shell.
    expect(api.createTerminal).toHaveBeenCalledWith('ws', expect.objectContaining({ projectId: 'project-7' }))
    // Foreign shells stay visible as dimmed tabs, never replayed here.
    expect(host.querySelectorAll('span[title*="another project"]')).toHaveLength(3)
    expect(written).not.toContain('private output')
    expect(MockTerminal.instances).toHaveLength(0)

    // Closing one from its dimmed tab stops that shell.
    const closeButtons = [...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button[aria-label^="Close "]')]
    await act(async () => closeButtons[1]!.click())
    expect(api.killTerminal).toHaveBeenCalledWith('ws', 'other-2')
  })

  it('hydrates foreign tabs from GET without waiting for SSE', async () => {
    api.listTerminals.mockResolvedValue({
      terminals: ['other-1', 'other-2'].map((id) => ({ ...row(id), projectId: 'project-9' })),
      shells: [{ id: 'bash', label: 'Git Bash' }], available: true,
    })
    await mount({ projectId: 'project-7' })

    // The auto-open waits for the stream's snapshot, not the GET.
    expect(api.createTerminal).not.toHaveBeenCalled()
    expect(host.querySelectorAll('span[title*="another project"]')).toHaveLength(2)
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="New terminal"]')?.disabled).toBe(false)
    expect(MockTerminal.instances).toHaveLength(0)
  })

  it('hydrates a create response when SSE is missing, then replays its snapshot once', async () => {
    api.createTerminal.mockResolvedValue({ ...row('terminal-1'), projectId: 'project-7' })
    await mount({ projectId: 'project-7' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

    expect(host.querySelector('button[aria-label="Close Git Bash"]')).not.toBeNull()
    expect(MockTerminal.instances).toHaveLength(1)
    await act(async () => push({ kind: 'created', terminal: { ...row('terminal-1'), projectId: 'project-7' } }))
    await act(async () => push({ kind: 'snapshot', terminals: [{
      ...row('terminal-1'), projectId: 'project-7', scrollback: Buffer.from('replayed output').toString('base64'),
    }] } as Frame))
    expect(MockTerminal.instances).toHaveLength(1)
    expect(MockTerminal.instances[0]?.writes).toEqual(['replayed output'])
  })

  it('does not let a late GET resurrect rows removed by a stream snapshot', async () => {
    let resolve!: (listing: unknown) => void
    api.listTerminals.mockReturnValue(new Promise((done) => { resolve = done }))
    await mount({ projectId: 'project-7', bindingReady: false })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    await act(async () => resolve({
      terminals: [{ ...row('stale'), projectId: 'project-9' }],
      shells: [{ id: 'bash', label: 'Git Bash' }], available: true,
    }))
    // The stream snapshot is the truth: the GET must not resurrect its row.
    expect(host.querySelectorAll('span[title*="another project"]')).toHaveLength(0)
  })

  it('opens past any number of existing terminals', async () => {
    await mount()
    await act(async () => push({
      kind: 'snapshot',
      terminals: ['terminal-1', 'terminal-2', 'terminal-3', 'terminal-4', 'terminal-5'].map((entry) => ({ ...row(entry), scrollback: '' })),
    } as Frame))

    const plus = host.querySelector<HTMLButtonElement>('button[aria-label="New terminal"]')
    expect(plus?.disabled).toBe(false)
    await act(async () => plus!.click())
    expect(api.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('reports the exit and drops the tab', async () => {
    await mount()
    await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))
    expect(host.textContent).toContain('Git Bash')

    await act(async () => push({ kind: 'exit', terminalId: 'terminal-1', exitCode: 3, reason: 'exit' }))

    expect(written.some((chunk) => chunk.includes('exited: 3'))).toBe(true)
    expect(host.textContent).toContain('No terminal open')
  })

  it('hands the surface to a remaining tab when the active one exits', async () => {
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [{ ...row('terminal-1'), scrollback: '' }, { ...row('terminal-2'), scrollback: '' }] }))
    const tabs = [...host.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[]
    await act(async () => tabs[1]!.click())

    await act(async () => push({ kind: 'exit', terminalId: 'terminal-2', exitCode: 0, reason: 'exit' }))

    const active = host.querySelector('button[aria-pressed="true"]')
    expect(active).not.toBeNull()
    expect(active?.getAttribute('title')).toContain('Git Bash')
    expect(host.querySelectorAll('button[aria-pressed]')).toHaveLength(1)
  })

  it('keeps the remembered shell when the stream snapshot beats the listing', async () => {
    let resolveListing!: (value: unknown) => void
    api.listTerminals.mockReturnValue(new Promise((resolve) => { resolveListing = resolve }) as never)
    await mount({ defaultShell: 'powershell' })
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    expect(api.createTerminal).not.toHaveBeenCalled()

    await act(async () => resolveListing({
      terminals: [],
      shells: [{ id: 'bash', label: 'Git Bash' }, { id: 'powershell', label: 'PowerShell' }],
      available: true,
    }))

    expect(api.createTerminal).toHaveBeenCalledTimes(1)
    expect(api.createTerminal.mock.calls[0]?.[1]).toMatchObject({ shellId: 'powershell' })
  })

  it('does not try to spawn when the snapshot beats a listing that reports no PTY', async () => {
    let resolveListing!: (value: unknown) => void
    api.listTerminals.mockReturnValue(new Promise((resolve) => { resolveListing = resolve }) as never)
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))
    await act(async () => resolveListing({ terminals: [], shells: [], available: false, unavailable: 'no pty' }))

    expect(api.createTerminal).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Terminals are unavailable on this host')
  })

  it('opens one shell when the footer and the workbench tab mount together on an empty project', async () => {
    const pushes: Array<(frame: Frame) => void> = []
    api.subscribeTerminals.mockImplementation((_ws: string, onFrame: (frame: Frame) => void) => {
      pushes.push(onFrame)
      return () => {}
    })
    await act(async () => {
      root.render(
        <>
          <TerminalPanel workspaceId="ws" projectId="project-1" defaultShell={null} onHide={() => {}} bindingReady />
          <TerminalPanel workspaceId="ws" projectId="project-1" defaultShell={null} bindingReady />
        </>,
      )
    })
    await act(async () => { for (const deliver of pushes) deliver({ kind: 'snapshot', terminals: [] }) })

    expect(api.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('repaints live terminals when the app theme flips', async () => {
    await mount()
    await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))
    const term = MockTerminal.last!
    document.documentElement.style.setProperty('--bg', '#ffffff')
    await act(async () => {
      document.documentElement.dataset['theme'] = 'light'
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect((term.options['theme'] as Record<string, string>)['background']).toBe('#ffffff')
    document.documentElement.style.removeProperty('--bg')
    delete document.documentElement.dataset['theme']
  })

  it('starts a new shell at the size of the shell already on the surface', async () => {
    await mount()
    await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))
    Object.assign(MockTerminal.last!, { cols: 132, rows: 41 })
    api.createTerminal.mockClear()

    const newButton = host.querySelector('button[aria-label="New terminal"]') as HTMLButtonElement
    await act(async () => newButton.click())

    expect(api.createTerminal.mock.calls[0]?.[1]).toMatchObject({ cols: 132, rows: 41 })
  })

  it('explains an unavailable host instead of showing a broken terminal', async () => {
    api.listTerminals.mockResolvedValue({
      terminals: [],
      shells: [],
      available: false,
      unavailable: 'node-pty is not available (test)',
    })
    await mount()

    expect(host.textContent).toContain('Terminals are unavailable on this host')
    expect(host.textContent).toContain('node-pty is not available (test)')
  })

  it('asks for a workspace rather than opening a shell with no scope', async () => {
    await mount({ workspaceId: null })
    expect(host.textContent).toContain('No workspace selected')
    expect(api.subscribeTerminals).not.toHaveBeenCalled()
  })
})
