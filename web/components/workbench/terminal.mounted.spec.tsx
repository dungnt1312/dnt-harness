// @vitest-environment jsdom
/**
 * The terminal panel's own behaviour: catalog-driven shell picker, tab strip,
 * cap handling, scrollback reattach from the snapshot, batched input, and the
 * unavailable-host message.
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

const { TerminalPanel } = await import('./TerminalPanel.tsx')

type Frame = Parameters<Parameters<typeof api.subscribeTerminals>[1]>[0]

let host: HTMLDivElement
let root: Root
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
  global.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as never
  api.listTerminals.mockResolvedValue({
    terminals: [],
    shells: [{ id: 'bash', label: 'Git Bash' }, { id: 'powershell', label: 'PowerShell' }],
    max: 4,
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
  act(() => root.unmount())
  host.remove()
})

async function mount(props: {
  workspaceId?: string | null
  projectId?: string | null
  defaultShell?: string | null
  onDefaultShell?: (shellId: string | null) => void
} = {}): Promise<void> {
  await act(async () => {
    root.render(
      <TerminalPanel
        workspaceId={props.workspaceId === undefined ? 'ws' : props.workspaceId}
        projectId={props.projectId ?? null}
        defaultShell={props.defaultShell ?? null}
        {...(props.onDefaultShell !== undefined ? { onDefaultShell: props.onDefaultShell } : {})}
      />,
    )
  })
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

  it('does not auto-open on a host with no PTY backend', async () => {
    api.listTerminals.mockResolvedValue({
      terminals: [],
      shells: [],
      max: 4,
      available: false,
      unavailable: 'node-pty is not available (test)',
    })
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [] }))

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
      max: 4,
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

    // The other project's shell is alive on the host but not in this view,
    // and it must not be drawn or replayed here.
    expect(host.textContent).toContain('Git Bash')
    expect(host.textContent).not.toContain('PowerShell')
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

  it('disables opening another terminal at the cap', async () => {
    api.listTerminals.mockResolvedValue({
      terminals: [],
      shells: [{ id: 'bash', label: 'Git Bash' }],
      max: 2,
      available: true,
    })
    await mount()
    await act(async () => push({ kind: 'snapshot', terminals: [row('terminal-1'), row('terminal-2')].map((entry) => ({ ...entry, scrollback: '' })) }))

    const plus = host.querySelector<HTMLButtonElement>('button[aria-label="New terminal"]')
    expect(plus?.disabled).toBe(true)
    expect(plus?.title).toMatch(/At most 2/)
  })

  it('reports the exit and drops the tab', async () => {
    await mount()
    await act(async () => push({ kind: 'created', terminal: row('terminal-1') }))
    expect(host.textContent).toContain('Git Bash')

    await act(async () => push({ kind: 'exit', terminalId: 'terminal-1', exitCode: 3, reason: 'exit' }))

    expect(written.some((chunk) => chunk.includes('exited: 3'))).toBe(true)
    expect(host.textContent).toContain('No terminal open')
  })

  it('explains an unavailable host instead of showing a broken terminal', async () => {
    api.listTerminals.mockResolvedValue({
      terminals: [],
      shells: [],
      max: 4,
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
