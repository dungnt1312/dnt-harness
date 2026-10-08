// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CopyButton from '../components/common/CopyButton.tsx'
import { ApprovalBar } from '../components/chat/ApprovalBar.tsx'
import { Composer } from '../components/composer/Composer.tsx'
import { ScopeControl } from '../components/layout/ScopeControl.tsx'
import { ModeMenu } from '../components/composer/ComposerControls.tsx'
import { ToastHost, useToast } from '../components/common/Toast.tsx'
import { ToolCard, ActivityBlock, AssistantMessage, DelegationCard, AuditLine, StatusLine, UserBubble, summarizeActivity } from '../components/chat/MessageParts.tsx'
import { QueuedBar } from '../components/chat/QueuedBar.tsx'
import { groupBlocks, rowItems, turnFooters } from '../components/chat/Transcript.tsx'
import { activeMinimapIndex, minimapEntries, minimapPreview, minimapScrollTarget } from '../components/chat/ConversationMinimap.tsx'
import { modeLabel, errorSummary } from './copy.ts'
import { emptyDraft, textDraft } from './composer-draft.ts'
import { budgetTone, formatTime } from './format.ts'
import { hiddenSpawnCalls } from './spawn-merge.ts'
import { createProjector, projectItems } from './project.ts'
import { compactSession, fetchHooks, saveHooks, setHookActive, renameWorkspace, listProjectFiles, readProjectFile } from './api.ts'
import { ContextPanel } from '../components/layout/ContextPanel.tsx'
import { Workbench, type WorkbenchView } from '../components/workbench/Workbench.tsx'
import { closeFileTab, useWorkbenchFiles } from '../hooks/useWorkbenchFiles.ts'
import { useWorkbenchTabs } from '../hooks/useWorkbenchTabs.ts'
import { WORKBENCH_TABS_STORAGE_KEY } from './workbench-preferences.ts'
import { Sidebar, type SidebarProps } from '../components/layout/Sidebar.tsx'
import { ChatHeader } from '../components/layout/ChatHeader.tsx'
import { HooksPanel } from '../components/settings/ManagementPanels.tsx'
import { SessionList } from '../components/session/SessionList.tsx'
import { WorkspacePopover } from '../components/layout/WorkspacePopover.tsx'
import { ErrorBoundary } from '../components/common/ErrorBoundary.tsx'
import { useApprovalNotify } from '../hooks/useApprovalNotify.ts'
import type { SseEvent } from './types.ts'
import type { ViewItem } from './project.ts'

vi.mock('./api.ts', () => ({
  attachmentUrl: (workspaceId: string, id: string) => `/api/workspaces/${workspaceId}/attachments/${id}`,
  renameWorkspace: vi.fn(async () => ({ id: 'w1', name: 'Renamed', archived: false, createdAt: 0 })),
  setWorkspaceArchived: vi.fn(async () => ({ id: 'w1', name: 'W', archived: true, createdAt: 0 })),
  deleteWorkspace: vi.fn(async () => ({ deleted: true })),
  compactSession: vi.fn(async () => ({ coversSeq: 42, summaryChars: 900 })),
  listSkills: vi.fn(async () => []),
  saveSkill: vi.fn(async () => ({ name: 's', hash: 'h' })),
  getSkill: vi.fn(async () => ({ name: 's', title: 's', description: '', source: 'workspace' as const, hash: 'h', instructions: 'body' })),
  deleteSkill: vi.fn(async () => ({ deleted: true })),
  fetchHooks: vi.fn(async () => ({ file: '/ws/settings.json', hooks: {}, disableAllHooks: false, sources: [], effective: [], disabled: false, diagnostics: [] })),
  saveHooks: vi.fn(async () => ({ saved: true })),
  setHookActive: vi.fn(async (_ws: string, id: string, active: boolean) => ({ id, active })),
  searchMemory: vi.fn(async () => []),
  readMemory: vi.fn(async () => ({ id: 'm', title: 'm', pinned: false, createdAt: 0, updatedAt: 0, body: 'b', hash: 'h' })),
  createMemory: vi.fn(async () => ({ id: 'm', title: 'm', pinned: false, createdAt: 0, updatedAt: 0, body: 'b', hash: 'h' })),
  updateMemory: vi.fn(async () => ({ id: 'm', title: 'm', pinned: false, createdAt: 0, updatedAt: 0, body: 'b', hash: 'h2' })),
  deleteMemory: vi.fn(async () => ({ forgotten: true })),
  listProjectFiles: vi.fn(async (_ws: string, _project: string, folder: string) => folder === ''
    ? { path: '', entries: [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'README.md', path: 'README.md', kind: 'file', size: 12 }] }
    : { path: folder, entries: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file', size: 26 }] }),
  readProjectFile: vi.fn(async (_ws: string, _project: string, path: string) => ({path, size: 26, binary: false, truncated: false, content: "export const answer = 42\n<raw>\n" })),
  fetchGitStatus: vi.fn(async () => ({ branch: "main", truncated: false, changes: [{ path: "docs/README.md", status: "modified", added: 1, removed: 2 }] })),
  fetchGitDiff: vi.fn(async () => ({ path: "docs/README.md", binary: false, truncated: false, lines: [{ kind: "del", text: "npm run chat:mock" }, { kind: "add", text: "npm run chat" }] })),
}))

// Responsive primitives need matchMedia in jsdom.
if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
}
let root: Root | undefined
let host: HTMLDivElement
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
async function mount(view: ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(view)) }
afterEach(async () => { vi.clearAllMocks(); if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined })
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))! }
function bodyButton(text: string) { return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)! }
function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
/** Drives the workbench with real view/tab state so the nav picker is exercised, not stubbed. */
function WorkbenchProbe({ view, events, project = null }: { readonly view: WorkbenchView; readonly events: readonly SseEvent[]; readonly project?: { id: string; name: string; path: string } | null }) {
  const files = useWorkbenchFiles(project?.id ?? null)
  const [selected, setSelected] = useState<WorkbenchView>(view)
  const [views, setViews] = useState<readonly WorkbenchView[]>(['files', view])
  return <Workbench workspaceId="w1" project={project} view={selected} onView={setSelected} views={views} onViews={setViews} files={files} events={events} expanded={false} onClose={() => {}} context={{ meta: null, stream: 'open', sessionId: 's1', sessionFolder: null, eventCount: events.length }} />
}
/**
 * The same wiring the app uses: one per-session record drives both the
 * strip and the selected view, and `patchTabs` merges a partial patch —
 * so a close that removes a tab and a select that re-adds the active view
 * cannot disagree the way two independent setState calls can.
 */
function WorkbenchPreferenceProbe({ events }: { readonly events: readonly SseEvent[] }) {
  const { tabs, patchTabs } = useWorkbenchTabs('w1:s1')
  const files = useWorkbenchFiles(null)
  return <Workbench workspaceId="w1" project={null} view={tabs.inspectorTab} onView={(view) => patchTabs({ inspectorTab: view })} views={tabs.inspectorViews} onViews={(views) => patchTabs({ inspectorViews: views })} files={files} events={events} expanded={false} onClose={() => {}} context={{ meta: null, stream: 'open', sessionId: 's1', sessionFolder: null, eventCount: events.length }} />
}
/** Seed the persisted per-session strip the app would have loaded before the probe mounts. */
function seedWorkbench(inspectorTab: WorkbenchView, inspectorViews: readonly WorkbenchView[]) {
  window.localStorage.setItem(WORKBENCH_TABS_STORAGE_KEY, JSON.stringify({
    'w1:s1': { inspectorTab, inspectorViews },
  }))
}
const composerBase = { onDraft: () => {}, onSend: () => {}, onStop: () => {}, modelValue: 'p/m', modes: [], modeValue: null, onMode: () => {} }

describe('mounted production controls', () => {
  it('accepts synchronous approval callbacks through the public contract', async () => {
    const answer = vi.fn()
    await mount(<ApprovalBar approvals={[{ approvalId: 'a', call: { id: 'c', name: 'bash', args: {} } }]} onAnswer={answer} />)
    await act(async () => button('Allow once').click())
    expect(answer).toHaveBeenCalledWith('a', true)
  })
  it('locks approval synchronously against double submission and shows original failure', async () => {
    let reject!: (e: Error) => void
    const answer = vi.fn(() => new Promise<void>((_, no) => { reject = no }))
    await mount(<ApprovalBar approvals={[{ approvalId: 'a', call: { id: 'c', name: 'bash', args: { command: 'exact command' } } }]} onAnswer={answer} />)
    const allow = button('Allow once')
    await act(async () => { allow.click(); allow.click() })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('a', true)
    expect(button('Deny').disabled).toBe(true)
    await act(async () => reject(new Error('approval 404 resolved')))
    expect(host.textContent).toContain('no longer pending')
    expect(host.querySelector('.error-notice pre')?.textContent).toContain('approval 404 resolved')
  })
  it('IME and Shift+Enter do not send; Enter sends only an eligible draft', async () => {
    const send = vi.fn()
    await mount(<ToastHost><Composer {...composerBase} connected running={false} draft={textDraft('Dữ liệu giữ nguyên')} onSend={send} /></ToastHost>)
    const input = host.querySelector<HTMLElement>('[data-composer-input]')!
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })) })
    expect(send).not.toHaveBeenCalled()
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(send).toHaveBeenCalledTimes(1)
    expect(input.textContent).toBe('Dữ liệu giữ nguyên')
  })
  it('while running with a draft the send becomes Queue next to Stop and Enter still submits', async () => {
    const send = vi.fn()
    await mount(<ToastHost><Composer {...composerBase} connected running draft={textDraft('follow-up')} onSend={send} /></ToastHost>)
    const queue = host.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]')
    expect(queue?.disabled).toBe(false)
    expect(host.querySelector('button[aria-label="Stop work"]')).not.toBeNull()
    const input = host.querySelector<HTMLElement>('[data-composer-input]')!
    expect(input.dataset['placeholder']).toBe('Queue a follow-up…')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(send).toHaveBeenCalledTimes(1)
    expect(host.querySelector('button[aria-label="Send"]')).toBeNull()
  })
  it('while running, Enter queues; Ctrl/Cmd+Enter and the Steer button steer', async () => {
    const send = vi.fn()
    await mount(<ToastHost><Composer {...composerBase} connected running draft={textDraft('do this instead')} onSend={send} /></ToastHost>)
    const input = host.querySelector<HTMLElement>('[data-composer-input]')!
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })))
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })))
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Steer"]')!.click())
    expect(send.mock.calls.map((call) => call[0])).toEqual(['queue', 'steer', 'steer', 'steer'])
  })
  it('idle, Ctrl+Enter is a plain send and no Steer button is shown', async () => {
    const send = vi.fn()
    await mount(<ToastHost><Composer {...composerBase} connected running={false} draft={textDraft('hello')} onSend={send} /></ToastHost>)
    expect(host.querySelector('button[aria-label^="Steer"]')).toBeNull()
    const input = host.querySelector<HTMLElement>('[data-composer-input]')!
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })))
    expect(send).toHaveBeenCalledWith('queue')
  })
  it('while running with an empty draft only Stop is offered', async () => {
    await mount(<ToastHost><Composer {...composerBase} connected running draft={emptyDraft} /></ToastHost>)
    expect(host.querySelector('button[aria-label="Stop work"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="Queue message"]')).toBeNull()
  })
  it('keeps reconnecting drafts editable and does not imply stopped work', async () => {
    const draft = 'draft survives reconnect'
    await mount(<ToastHost><Composer {...composerBase} connected={false} running draft={textDraft(draft)} /></ToastHost>)
    const input = host.querySelector<HTMLElement>('[data-composer-input]')!
    expect(input.getAttribute('contenteditable')).toBe('true')
    expect(input.textContent).toBe(draft)
    expect(host.querySelector('button[aria-label="Stop work"]')).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]')?.disabled).toBe(true)
  })
  it('tool disclosure preserves exact arguments and external output', async () => {
    await mount(<ToolCard item={{ kind: 'tool', call: { id: 'c', name: 'custom_tool', args: { path: 'C:/Dự án', secretName: 'NO_TRANSLATION' } }, result: { ok: false, output: 'lỗi từ công cụ <raw>' } }} />)
    expect(host.querySelector('pre')).toBeNull()
    expect(host.textContent).toContain('Failed')
    await act(async () => host.querySelector('button')!.click())
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('lỗi từ công cụ <raw>')
    await act(async () => button('View call details').click())
    expect(host.querySelector('pre[aria-label="Arguments"]')?.textContent).toContain('C:/Dự án')
  })
})

describe('conversation minimap', () => {
  it('activates the upper user message when two are visible in the viewport', () => {
    const rows = [{ index: 0, top: 120, bottom: 170 }, { index: 1, top: 440, bottom: 530 }]
    expect(activeMinimapIndex(rows, 0, 500)).toBe(0)
    expect(activeMinimapIndex(rows, 150, 500)).toBe(0)
    expect(activeMinimapIndex(rows, 170, 500)).toBe(1)
  })

  it('keeps the most recent preceding message active when none are visible', () => {
    const rows = [{ index: 0, top: 100, bottom: 150 }, { index: 1, top: 700, bottom: 750 }]
    expect(activeMinimapIndex(rows, 200, 300)).toBe(0)
    expect(activeMinimapIndex(rows, 0, 50)).toBe(0)
    expect(activeMinimapIndex(rows, 800, 900)).toBe(1)
  })

  it('scrolls the clicked message to the top of the reading area', () => {
    expect(minimapScrollTarget(6000, 600, 12000)).toBe(5984)
    expect(minimapScrollTarget(6000, 600, 6200)).toBe(5600)
  })

  it('maps only user messages, not assistant activity or system lines', () => {
    const entries = minimapEntries([
      { kind: 'user', content: 'Chốt gửi theo đề xuất, sau đó test với environment staging.' },
      { kind: 'assistant', content: 'Đã chốt và triển khai luồng IEM theo mô hình hybrid.', live: false, thinking: [], thinkingLive: false },
      { kind: 'tool', call: { id: 'a', name: 'Read', args: {} } },
      { kind: 'user', content: 'Tiếp tục theo dõi log trên staging.' },
      { kind: 'status', reason: 'failed' },
      { kind: 'audit', icon: 'allow', text: 'Allowed · Bash' },
    ])
    expect(entries.map((entry) => entry.index)).toEqual([0, 3])
    expect(entries[0]?.title).toContain('Chốt gửi theo đề xuất')
    expect(entries.every((entry) => entry.width >= 8 && entry.width <= 20)).toBe(true)
  })

  it('removes markdown noise and separates a compact tooltip title and detail', () => {
    const preview = minimapPreview('## Phần đã triển khai\n\nĐã thêm **Redis checkpoint** và scheduler để chạy an toàn trên staging trước khi cutover chính thức.')
    expect(preview.title).not.toMatch(/[#*]/)
    expect(preview.title).toContain('Phần đã triển khai')
    expect(preview.detail).toContain('staging')
  })
})

describe('transcript grouping', () => {
  it('packs consecutive activity rows into one block and drops empty markers', () => {
    const blocks = groupBlocks([
      { kind: 'user', content: 'go' },
      { kind: 'tool', call: { id: 'a', name: 'Read', args: {} } },
      { kind: 'tool', call: { id: 'b', name: 'Bash', args: {} } },
      { kind: 'audit', icon: 'allow', text: 'Allowed · Bash' },
      { kind: 'assistant', content: 'done', live: false, thinking: [], thinkingLive: false },
      { kind: 'status', reason: 'completed' },
      { kind: 'status', reason: 'provider: 500' },
      { kind: 'status', reason: 'failed' },
      { kind: 'status', reason: 'limit' },
    ])
    expect(blocks.map((block) => block.kind === 'activity' ? `activity:${block.rows.length}` : block.row.item.kind)).toEqual(['user', 'activity:3', 'assistant', 'status', 'status'])
  })
  it('keeps every consecutive work row in one run, edits and delegations included', () => {
    const blocks = groupBlocks([
      { kind: 'user', content: 'go' },
      { kind: 'tool', call: { id: 'a', name: 'Grep', args: {} } },
      { kind: 'tool', call: { id: 'b', name: 'Read', args: {} } },
      { kind: 'tool', call: { id: 'c', name: 'Edit', args: {} } },
      { kind: 'tool', call: { id: 'd', name: 'Read', args: {} } },
      { kind: 'assistant', content: '', live: false, thinking: ['weighing options'], thinkingLive: false },
      { kind: 'tool', call: { id: 'e', name: 'Read', args: {} } },
      { kind: 'delegation', childSessionId: 'child', definition: 'explorer', brief: 'look', status: 'completed' },
    ])
    // Thinking renders, but it does not split the work around it: a split
    // would put a block margin on both sides of it, twice the gap everywhere
    // else. A real answer still breaks the run.
    expect(blocks.map((block) => block.kind === 'activity' ? `activity:${block.rows.length}` : block.row.item.kind))
      .toEqual(['user', 'activity:7'])
  })
  it('merges tool rows across invisible tool-only assistant steps into one tight block', () => {
    const emptyStep = { kind: 'assistant' as const, content: '', live: false, thinking: [] as string[], thinkingLive: false }
    const blocks = groupBlocks([
      { kind: 'user', content: 'go' },
      { kind: 'tool', call: { id: 'a', name: 'Bash', args: {} } },
      emptyStep,
      { kind: 'tool', call: { id: 'b', name: 'Read', args: {} } },
      emptyStep,
      { kind: 'audit', icon: 'allow', text: 'Allowed · Read' },
      emptyStep,
      { kind: 'assistant', content: 'done', live: false, thinking: [], thinkingLive: false },
      { kind: 'assistant', content: '', live: true, thinking: [], thinkingLive: false },
    ])
    expect(blocks.map((block) => block.kind === 'activity' ? `activity:${block.rows.length}` : block.row.item.kind)).toEqual(['user', 'activity:3', 'assistant', 'assistant'])
  })
})

describe('transcript grouping: hidden spawns and open turns', () => {
  const shape = (blocks: ReturnType<typeof groupBlocks>) => blocks.map((block) => block.kind === 'activity' ? `activity:${block.rows.length}:${block.turnOpen ? 'open' : 'closed'}` : block.row.item.kind)
  const step = (turnOpen: boolean) => ({ kind: 'assistant' as const, content: '', live: false, thinking: [] as string[], thinkingLive: false, turnId: 't1', turnOpen })
  it('leaves a spawn call its delegation row absorbed out of the run', () => {
    const blocks = groupBlocks([
      { kind: 'user', content: 'go' },
      { kind: 'tool', call: { id: 'spawn', name: 'Agent', args: { action: 'spawn' } }, result: { ok: true, output: '{}' } },
      { kind: 'delegation', childSessionId: 'child', definition: 'explorer', brief: 'look', status: 'completed' },
      { kind: 'tool', call: { id: 'a', name: 'Read', args: {} } },
    ], new Set(['spawn']))
    expect(shape(blocks)).toEqual(['user', 'activity:2:closed'])
  })
  it('marks the tail run of a turn still open, even between steps with nothing running', () => {
    const items = [
      { kind: 'user' as const, content: 'go' },
      step(true),
      { kind: 'tool' as const, call: { id: 'a', name: 'Read', args: {} }, result: { ok: true, output: 'x' } },
      step(true),
    ]
    expect(shape(groupBlocks(items))).toEqual(['user', 'activity:1:open'])
    expect(shape(groupBlocks(items.map((item) => item.kind === 'assistant' ? step(false) : item)))).toEqual(['user', 'activity:1:closed'])
  })
})

describe('activity block summary', () => {
  const toolRow = (id: string, name: string, ok = true): Extract<ViewItem, { kind: 'tool' }> => ({
    kind: 'tool', call: { id, name, args: name === 'Grep' ? { pattern: id } : name === 'Bash' ? { command: `echo ${id}` } : { path: `app/Services/Deep/Nested/${id}.php` } }, result: { ok, output: 'x' }, ts: 0, doneAt: 5,
  })
  const toggles = () => host.querySelectorAll('button[aria-expanded]')
  it('collapses a settled run into one summary line and expands on demand', async () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => toolRow(id, id === 'd' ? 'Grep' : 'Read'))
    await mount(<ActivityBlock items={rows}>{rows.map((row) => <ToolCard key={row.call.id} item={row} />)}</ActivityBlock>)
    const header = host.querySelector('button')!
    expect(header.textContent).toContain('Explore')
    expect(header.textContent).toContain('3 files, 1 search')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    // Collapsed means collapsed: the rows themselves are not in the document.
    expect(host.querySelectorAll('button').length).toBe(1)
    await act(async () => header.click())
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    // The header and the one row that opens; the clean reads are lines, not toggles.
    expect(toggles().length).toBe(2)
    expect(host.textContent).toContain('c.php')
  })
  it('folds a settled run even when one failed, and says how many need attention', async () => {
    const rows = [toolRow('a', 'Read'), toolRow('b', 'Read'), toolRow('c', 'Bash', false), toolRow('d', 'Read')]
    await mount(<ActivityBlock items={rows}>{rows.map((row) => <ToolCard key={row.call.id} item={row} />)}</ActivityBlock>)
    const header = host.querySelector('button')!
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toContain('1 failed')
  })
  it('leaves a short run alone — no summary to hide three rows behind', async () => {
    const rows = [toolRow('a', 'Read'), toolRow('b', 'Read'), toolRow('c', 'Read')]
    await mount(<ActivityBlock items={rows}>{rows.map((row) => <ToolCard key={row.call.id} item={row} />)}</ActivityBlock>)
    expect(host.textContent).not.toContain('Explore')
    expect(host.textContent).toContain('a.php')
    expect(host.textContent).toContain('c.php')
  })
  it('counts calls, ignores reasoning rows, and nests the open run behind a rail', async () => {
    const rows = [toolRow('a', 'Read'), toolRow('b', 'Read'), toolRow('c', 'Grep'), toolRow('d', 'Grep')]
    const items = [...rows, { kind: 'assistant' as const, content: '', live: false, thinking: ['why'], thinkingLive: false }]
    await mount(<ActivityBlock items={items}>{[...rows.map((row) => <ToolCard key={row.call.id} item={row} />), <span key="why">why</span>]}</ActivityBlock>)
    const header = host.querySelector('button')!
    expect(header.textContent).toContain('2 files, 2 searches')
    await act(async () => header.click())
    const body = document.getElementById(header.getAttribute('aria-controls')!)!
    expect(body.className).toContain('border-l')
    expect(body.className).toContain('pl-3.5')
  })
  it('summarizes a running run as running, whatever settled before it', () => {
    const summary = summarizeActivity([
      toolRow('a', 'Read', false),
      { kind: 'tool', call: { id: 'b', name: 'Bash', args: {} } },
    ])
    expect(summary.state).toBe('running')
    expect(summary.live).toBe(true)
    expect(summary.problems).toBe(1)
    expect(summary.kind).toBe('Working')
  })
  it('keeps the folder quiet beside the file and the exact target on hover', async () => {
    await mount(<ToolCard item={toolRow('a', 'Read')} />)
    const line = host.firstElementChild as HTMLElement
    expect(line.textContent).toContain('a.php')
    expect(line.textContent).toContain('app/Services/Deep/Nested')
    expect(line.getAttribute('title')).toBe('app/Services/Deep/Nested/a.php')
  })
})

describe('tool row facts', () => {
  const row = (name: string, args: Record<string, unknown>, result?: { ok: boolean; output: string }): Extract<ViewItem, { kind: 'tool' }> => ({
    kind: 'tool', call: { id: 'c1', name, args }, ts: 0, doneAt: 12, ...(result !== undefined ? { result } : {}),
  })
  const line = () => (host.querySelector('button[aria-expanded]') ?? host.firstElementChild!) as HTMLElement
  it('says a running call is running in its own words, and stops once it settles', async () => {
    await mount(<ToolCard item={row('Read', { path: 'src/harness/tools/service.ts' })} />)
    // A running row must say so on its own, not through the sidebar alone.
    expect(line().textContent).toContain('Reading')
    expect(line().querySelector('.text-shimmer')).not.toBeNull()
    expect(line().textContent).toContain('service.ts')
    await mount(<ToolCard item={row('Read', { path: 'src/harness/tools/service.ts' }, { ok: true, output: 'a\nb\nc' })} />)
    expect(line().querySelector('.text-shimmer')).toBeNull()
    expect(line().textContent).toMatch(/^Read/)
  })
  it('names the lines a read covered, with nothing to click open', async () => {
    await mount(<ToolCard item={row('Read', { path: 'src/harness/tools/service.ts', offset: 100, limit: 61 }, { ok: true, output: 'a\nb\nc' })} />)
    expect(host.querySelector('button[aria-expanded]')).toBeNull()
    expect(line().textContent).toContain('service.ts:100-160')
    expect(line().textContent).toContain('src/harness/tools')
  })
  it('puts a failure on the row instead of behind a click, its reason on hover', async () => {
    await mount(<ToolCard item={row('Read', { path: 'docs/missing.md' }, { ok: false, output: 'no such file: docs/missing.md\ncheck the path' })} />)
    const status = [...line().querySelectorAll('span')].find((span) => span.textContent === 'Failed')!
    expect(status.className).toContain('text-bad')
    expect(status.getAttribute('title')).toBe('no such file: docs/missing.md')
  })
  it('reports a non-zero exit as bad while the recorded outcome stays what the log says', async () => {
    await mount(<ToolCard item={row('Bash', { command: 'npm test -- tools' }, { ok: true, output: '1 failing\n[exit code: 1]' })} />)
    expect(line().textContent).toContain('npm test -- tools')
    expect(line().textContent).not.toContain('Failed')
    expect([...line().querySelectorAll('span')].find((span) => span.textContent === 'Exit 1')?.className).toContain('text-bad')
  })
  it('opens an edit as a diff while copy keeps the exact replacement', async () => {
    await mount(<ToolCard item={row('Edit', { path: 'web/lib/format.ts', old: 'const a = 1', new: 'const a = 2' }, { ok: true, output: 'edited web/lib/format.ts' })} />)
    expect(line().textContent).toContain('format.ts')
    expect(line().textContent).toContain('web/lib')
    // The row leads with what was done, in words, then the file it was done to.
    expect(line().textContent).toMatch(/^Edited.*format\.ts/)
    const added = [...line().querySelectorAll('span')].find((span) => span.textContent === '+1')
    const removed = [...line().querySelectorAll('span')].find((span) => span.textContent === '−1')
    expect(added?.className).toContain('text-ok')
    expect(removed?.className).toContain('text-bad')
    await act(async () => line().click())
    const diff = host.querySelector('[role="group"][aria-label="Diff of web/lib/format.ts"]')!
    expect(diff.textContent).toContain('const a = 1')
    expect(diff.textContent).toContain('const a = 2')
  })
  it('hands the workbench the window the call read, not just the file', async () => {
    const openPath = vi.fn(() => () => {})
    await mount(<ToolCard item={row('Read', { path: 'src/index.ts', offset: 20, limit: 5 }, { ok: true, output: 'x' })} openPath={openPath} />)
    expect(openPath).toHaveBeenCalledWith('src/index.ts', { line: 20, lines: 5 })
  })
  it('names an MCP tool by its server and its own name, never the prefix', async () => {
    await mount(<ToolCard item={{ ...row('mcp__linear__create_issue', { title: 'Fix the row' }, { ok: true, output: 'created ENG-42' }), server: 'linear' }} />)
    expect(line().textContent).toContain('linear')
    expect(line().textContent).toContain('create_issue')
    expect(line().textContent).not.toContain('mcp__')
    await act(async () => line().click())
    expect(host.querySelector('pre[aria-label="Tool output"]')?.textContent).toBe('created ENG-42')
  })
})

describe('failed request line', () => {
  it('stays one quiet line: the raw reason, a retry, nothing else', async () => {
    const retry = vi.fn()
    await mount(<StatusLine reason="provider: Failed to fetch" onRetry={retry} />)
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('provider: Failed to fetch')
    expect(alert.textContent).not.toContain('Request failed.')
    expect(alert.querySelector('details')).toBeNull()
    await act(async () => button('Retry').click())
    expect(retry).toHaveBeenCalledTimes(1)
  })
  it('asks before retrying a turn whose tools already ran', async () => {
    const retry = vi.fn()
    await mount(<StatusLine reason="provider: boom" onRetry={retry} toolsRan />)
    expect(button('Retry').title).toContain('may repeat')
    await act(async () => button('Retry').click())
    expect(retry).not.toHaveBeenCalled()
    // The dialog renders through a portal, outside the mounted host.
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry anyway')
    expect(confirm).toBeDefined()
    await act(async () => confirm!.click())
    expect(retry).toHaveBeenCalledTimes(1)
  })
  it('a steered turn reads as redirected, not as a failure', async () => {
    await mount(<StatusLine reason="steered" />)
    expect(host.textContent).toContain('Redirected')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('queued input bubble', () => {
  it('a queued message offers Send now; a steered one says it is stopping the turn', async () => {
    const sendNow = vi.fn()
    await mount(<QueuedBar items={[{ kind: 'user', content: 'Later', queued: true, inputId: 'i' }]} running onSendNow={sendNow} />)
    await act(async () => button('Send now').click())
    expect(sendNow).toHaveBeenCalledTimes(1)
    await mount(<QueuedBar items={[{ kind: 'user', content: 'Now', queued: true, inputId: 's', steer: true }]} running onSendNow={sendNow} />)
    expect(host.textContent).toContain('stopping the current turn')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Send now')).toBe(false)
  })
  it('a steer stranded by a restart is plain queued input with Send now', async () => {
    await mount(<QueuedBar items={[{ kind: 'user', content: 'Now', queued: true, inputId: 's', steer: true }]} running={false} onSendNow={vi.fn()} />)
    expect(host.textContent).not.toContain('stopping the current turn')
    expect(button('Send now')).toBeDefined()
  })
  it('counts queued messages and lists them in submission order', async () => {
    await mount(<QueuedBar items={[
      { kind: 'user', content: 'First', queued: true, inputId: 'i1' },
      { kind: 'user', content: 'Second', queued: true, inputId: 'i2' },
    ]} running />)
    expect(host.textContent).toContain('2 queued')
    expect(host.textContent).not.toContain('runs after the current turn')
    expect(host.textContent.indexOf('First')).toBeLessThan(host.textContent.indexOf('Second'))
  })
  it('shows image attachments as thumbnails and other files by name, not a count', async () => {
    await mount(<QueuedBar workspaceId="ws" items={[{
      kind: 'user', content: 'Look', queued: true, inputId: 'i1',
      attachments: [
        { id: 'a1', name: 'shot.png', mediaType: 'image/png', bytes: 10 },
        { id: 'a2', name: 'notes.pdf', mediaType: 'application/pdf', bytes: 20 },
      ],
    }]} running />)
    const image = host.querySelector('img') as HTMLImageElement
    expect(image.alt).toBe('shot.png')
    expect(image.getAttribute('src')).toContain('a1')
    expect(host.textContent).toContain('notes.pdf')
    expect(host.textContent).not.toContain('attachment')
  })
  it('edits a queued message in place and deletes one', async () => {
    const onEdit = vi.fn(async () => {})
    const onDelete = vi.fn(async () => {})
    await mount(<QueuedBar items={[{ kind: 'user', content: 'Typo', queued: true, inputId: 'i1' }]} running onEdit={onEdit} onDelete={onDelete} />)
    await act(async () => (host.querySelector('[aria-label="Delete queued message"]') as HTMLButtonElement).click())
    expect(onDelete).toHaveBeenCalledWith('i1')
    await act(async () => (host.querySelector('button[aria-label="Edit queued message"]') as HTMLButtonElement).click())
    const field = host.querySelector('textarea') as HTMLTextAreaElement
    expect(field.value).toBe('Typo')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Fixed')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Save').click())
    expect(onEdit).toHaveBeenCalledWith('i1', 'Fixed')
    expect(host.querySelector('textarea')).toBeNull()
  })
  it('a steer that is stopping the turn cannot be edited or deleted', async () => {
    await mount(<QueuedBar items={[{ kind: 'user', content: 'Now', queued: true, inputId: 's', steer: true }]} running onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(host.querySelector('[aria-label="Edit queued message"]')).toBeNull()
    expect(host.querySelector('[aria-label="Delete queued message"]')).toBeNull()
  })
  it('renders nothing without queued messages', async () => {
    await mount(<QueuedBar items={[]} running onSendNow={vi.fn()} />)
    expect(host.children).toHaveLength(0)
  })
  it('a rejected input reads Not sent and can be reused', async () => {
    const reuse = vi.fn()
    await mount(<UserBubble item={{ kind: 'user', content: 'Blocked', queued: false, notSent: 'rejected' }} onReuse={reuse} />)
    expect(host.textContent).toContain('Not sent')
    expect(host.textContent).not.toContain('Queued')
  })
})

describe('presentation ownership', () => {
  it('maps only bundled mode labels and preserves custom names even for a familiar ID', () => {
    expect(modeLabel({ id: 'plan', name: 'Kế hoạch', source: 'bundled' })).toBe('Plan')
    expect(modeLabel({ id: 'plan', name: 'Kế hoạch riêng', source: 'workspace' })).toBe('Kế hoạch riêng')
  })
  it('formats only verified dates in explicit English', () => {
    expect(formatTime()).toBe('')
    expect(formatTime(1789120800000)).toMatch(/AM|PM/)
  })
  it.each(['archived workspace', 'cannot delete running conversation', 'no provider configured', 'invalid project path', 'Failed to fetch', 'unknown external error'])('provides English guidance without modifying diagnostics: %s', raw => {
    expect(errorSummary(raw)).not.toMatch(/[À-ỹ]/)
    expect(errorSummary(raw).length).toBeGreaterThan(20)
  })
})

describe('mode menu', () => {
  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  it('lists only the modes — a picker, nothing else', async () => {
    const modes = [{ value: 'chat', label: 'Chat' }, { value: 'ask', label: 'Ask before changes' }]
    await mount(<ModeMenu modes={modes} value="ask" onChange={() => {}} />)
    await act(async () => trigger().click())
    const panel = document.body.querySelector<HTMLElement>('[role="menu"]')!
    expect(panel.textContent).toContain('Chat')
    expect(panel.textContent).toContain('Ask before changes')
    const items = [...panel.querySelectorAll('[role="menuitemradio"]')]
    expect(items).toHaveLength(2)
    await act(async () => (items[0] as HTMLButtonElement).click())
  })
})

describe('approval card actions', () => {
  it('offers exactly Allow once and Deny; standing permission lives in Settings → Modes', async () => {
    await mount(<ApprovalBar approvals={[{ approvalId: 'a', call: { id: 'c', name: 'bash', args: {} } }]} onAnswer={vi.fn()} />)
    expect(button('Allow once')).not.toBeNull()
    expect(button('Deny')).not.toBeNull()
    expect(host.textContent).not.toContain('Always allow')
    expect(host.textContent).toContain('Settings → Modes')
  })
  it('keeps the every-time note for interactive tools', async () => {
    await mount(<ApprovalBar approvals={[{ approvalId: 'a', call: { id: 'c', name: 'mcp__s__prompt', args: {} }, interactive: true }]} onAnswer={vi.fn()} />)
    expect(button('Allow once')).not.toBeNull()
    expect(host.textContent).not.toContain('Always allow')
    expect(host.textContent).toContain('requires a decision every time')
  })
  it('shows the decision window and names the child agent that asked', async () => {
    const expiresAt = Date.now() + 90_000
    await mount(<ApprovalBar approvals={[{ approvalId: 'a', call: { id: 'c', name: 'Bash', args: {} }, expiresAt, childSessionId: 'session-abcdefgh1234', definitionName: 'explorer' }]} onAnswer={vi.fn()} />)
    expect(host.textContent).toMatch(/Cancels itself in 1:3\d/)
    expect(host.textContent).toContain('Asked by child agent')
    expect(host.textContent).toContain('explorer')
  })
  it('says a passed deadline cancelled the request instead of letting the card go quiet', async () => {
    await mount(<ApprovalBar approvals={[{ approvalId: 'a', call: { id: 'c', name: 'Bash', args: {} }, expiresAt: Date.now() - 1_000 }]} onAnswer={vi.fn()} />)
    expect(host.textContent).toContain('Expired')
  })
})

describe('queued input projection', () => {
  it('renders the queued twin and replaces it in place by the consuming message', () => {
    const items = projectItems([
      { type: 'turn/start', seq: 0 },
      { type: 'input/queued', seq: 1, inputId: 'i1', content: 'Run the migration' },
      { type: 'user/message', seq: 2, inputId: 'i1', content: 'Run the migration' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'user', content: 'Run the migration', queued: false })
  })
  it('a revised input shows and runs with its new text; a withdrawn one leaves the queue', () => {
    const items = projectItems([
      { type: 'input/queued', seq: 0, inputId: 'i1', content: 'Typo' },
      { type: 'input/queued', seq: 1, inputId: 'i2', content: 'Drop me' },
      { type: 'input/revised', seq: 2, inputId: 'i1', content: 'Fixed' },
      { type: 'input/settled', seq: 3, inputId: 'i2', outcome: 'withdrawn' },
    ])
    expect(items[0]).toMatchObject({ content: 'Fixed', queued: true, inputId: 'i1' })
    expect(items[1]).toMatchObject({ content: 'Drop me', queued: false, withdrawn: true })
    expect(items[1]).not.toHaveProperty('notSent')
  })
  it('keeps the twin queued until its own inputId is consumed', () => {
    const items = projectItems([
      { type: 'input/queued', seq: 0, inputId: 'i1', content: 'First' },
      { type: 'input/queued', seq: 1, inputId: 'i2', content: 'Second' },
      { type: 'user/message', seq: 2, inputId: 'i1', content: 'First' },
    ])
    expect(items).toHaveLength(2)
    const byContent = (content: string) => items.find((item) => item.kind === 'user' && item.content === content)
    expect(byContent('First')).toMatchObject({ queued: false })
    expect(byContent('Second')).toMatchObject({ queued: true })
  })
  it('a message queued behind a turn opens the turn that runs it, below the earlier answer', () => {
    const items = projectItems([
      { type: 'turn/start', seq: 0, turnId: 't1' },
      { type: 'user/message', seq: 1, turnId: 't1', inputId: 'i0', content: 'First ask' },
      { type: 'input/queued', seq: 2, inputId: 'i1', content: 'Follow-up' },
      { type: 'assistant/chunk', seq: 3, turnId: 't1', stepId: 's1', delta: 'First answer' },
      { type: 'turn/end', seq: 4, turnId: 't1' },
      { type: 'turn/start', seq: 5, turnId: 't2' },
      { type: 'user/message', seq: 6, turnId: 't2', inputId: 'i1', content: 'Follow-up' },
      { type: 'assistant/chunk', seq: 7, turnId: 't2', stepId: 's2', delta: 'Second answer' },
    ] as never)
    const order = items.map((item) => (item.kind === 'user' || item.kind === 'assistant' ? item.content : item.kind))
      .filter((text) => typeof text === 'string' && /ask|answer|Follow-up/.test(text))
    expect(order).toEqual(['First ask', 'First answer', 'Follow-up', 'Second answer'])
  })
  it('moving a consumed twin keeps incremental projection identical to a full replay', () => {
    const events = [
      { type: 'turn/start', seq: 0, turnId: 't1' },
      { type: 'user/message', seq: 1, turnId: 't1', inputId: 'i0', content: 'First ask' },
      { type: 'input/queued', seq: 2, inputId: 'i1', content: 'Follow-up' },
      { type: 'assistant/chunk', seq: 3, turnId: 't1', stepId: 's1', delta: 'First answer' },
      { type: 'turn/end', seq: 4, turnId: 't1' },
      { type: 'turn/start', seq: 5, turnId: 't2' },
      { type: 'user/message', seq: 6, turnId: 't2', inputId: 'i1', content: 'Follow-up' },
      { type: 'assistant/chunk', seq: 7, turnId: 't2', stepId: 's2', delta: 'Second answer' },
    ] as never as Parameters<typeof projectItems>[0]
    const projector = createProjector()
    let last: readonly unknown[] = []
    for (const event of events) last = projector.apply([event])
    expect(last).toEqual(projectItems(events))
  })
  it('input the host dispatches at once renders as a sent message, never as queued', () => {
    const accepted = projectItems([
      { type: 'input/queued', seq: 0, inputId: 'i1', content: 'Hello', runsNow: true },
    ])
    expect(accepted[0]).toMatchObject({ kind: 'user', content: 'Hello', queued: false, inputId: 'i1' })
    const ran = projectItems([
      { type: 'input/queued', seq: 0, inputId: 'i1', content: 'Hello', runsNow: true },
      { type: 'turn/start', seq: 1, turnId: 't1' },
      { type: 'user/message', seq: 2, turnId: 't1', inputId: 'i1', content: 'Hello' },
    ])
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({ kind: 'user', content: 'Hello', queued: false })
  })
  it('a runsNow input no turn claimed falls back to the queue when a turn ends', () => {
    const items = projectItems([
      { type: 'turn/start', seq: 0, turnId: 't0' },
      { type: 'input/queued', seq: 1, inputId: 'i1', content: 'Stranded', runsNow: true },
      { type: 'turn/end', seq: 2, turnId: 't0', reason: 'cancelled' },
    ])
    expect(items.find((item) => item.kind === 'user')).toMatchObject({ content: 'Stranded', queued: true, inputId: 'i1' })
  })
})

describe('transcript truthfulness', () => {
  const assistant = (controls?: { model?: string; provider?: string }) => ({
    kind: 'assistant' as const, content: 'answer', live: false, thinking: [] as string[], thinkingLive: false,
    ...(controls !== undefined ? { controls } : {}),
  })
  it('reports the controls that served the answer before the workspace fallback on the turn footer', async () => {
    await mount(<AssistantMessage item={assistant({ model: 'deepseek-v3', provider: 'dntproxy' })} modelLabel="workspace-model" turn={{ text: 'answer' }} />)
    expect(host.textContent).toContain('deepseek-v3 · dntproxy')
    expect(host.textContent).not.toContain('workspace-model')
    expect(host.querySelector('button[aria-label="Copy response"]')).not.toBeNull()
    await mount(<AssistantMessage item={assistant()} modelLabel="workspace-model" turn={{ text: 'answer' }} />)
    expect(host.textContent).toContain('workspace-model')
  })
  it('withholds the turn footer until the turn closes; mid-turn answers never show copy', async () => {
    await mount(<AssistantMessage item={assistant()} modelLabel="workspace-model" />)
    expect(host.querySelector('button[aria-label="Copy response"]')).toBeNull()
  })
  it('places one footer on the last answer of a closed turn carrying the whole turn text', () => {
    const answer = (content: string, extra?: { turnId?: string; turnOpen?: boolean }) => ({
      kind: 'assistant' as const, content, live: false, thinking: [] as string[], thinkingLive: false,
      ...(extra?.turnId !== undefined ? { turnId: extra.turnId } : {}),
      ...(extra?.turnOpen !== undefined ? { turnOpen: extra.turnOpen } : {}),
    })
    const footers = turnFooters([
      answer('step one', { turnId: 't1', turnOpen: false }),
      answer('step two', { turnId: 't1', turnOpen: false }),
      answer('other turn', { turnId: 't2', turnOpen: false }),
      answer('still running', { turnId: 't3', turnOpen: true }),
      answer('legacy without a turn'),
      answer('', { turnId: 't4', turnOpen: false }),
    ])
    expect([...footers.keys()]).toEqual([1, 2, 4])
    expect(footers.get(1)?.text).toBe('step one\n\nstep two')
    expect(footers.get(2)?.text).toBe('other turn')
    expect(footers.get(4)?.text).toBe('legacy without a turn')
  })
  it('stamps answers with their turn and closes them at turn end', () => {
    const items = projectItems([
      { type: 'turn/start', seq: 0, turnId: 't1' },
      { type: 'assistant/chunk', seq: 1, delta: 'partial ' },
      { type: 'assistant/message', seq: 2, content: 'first answer' },
      { type: 'assistant/message', seq: 3, content: 'second answer' },
    ])
    expect(items[0]).toMatchObject({ kind: 'assistant', turnId: 't1', turnOpen: true })
    expect(items[1]).toMatchObject({ kind: 'assistant', turnId: 't1', turnOpen: true })
    const closed = projectItems([
      { type: 'turn/start', seq: 0, turnId: 't1' },
      { type: 'assistant/message', seq: 1, content: 'done' },
      { type: 'turn/end', seq: 2, reason: 'completed' },
    ])
    expect(closed[0]).toMatchObject({ kind: 'assistant', turnId: 't1', turnOpen: false })
  })
  it('renders a recovered tool result as unknown, never failed', async () => {
    await mount(<ToolCard item={{ kind: 'tool', call: { id: 'c', name: 'Bash', args: { command: 'npm install' } }, result: { ok: true, output: 'partial output' }, recovered: true }} />)
    expect(host.textContent).toContain('Unknown')
    expect(host.textContent).not.toContain('Failed')
    await act(async () => host.querySelector('button')!.click())
    const note = host.querySelector('[role="note"]')
    expect(note?.textContent).toContain('Outcome unknown — the host restarted')
    expect(note?.textContent).not.toContain('partial output')
  })
  it('carries the MCP server chip parsed from the mcp__server__tool call name', async () => {
    await mount(<ToolCard item={{ kind: 'tool', call: { id: 'c', name: 'mcp__docs__search', args: { q: 'x' } }, result: { ok: true, output: 'hit' }, server: 'docs' }} />)
    expect([...host.querySelectorAll('span')].some(span => span.textContent === 'docs')).toBe(true)
  })
  it('shows the delegation timeline and opens the child conversation', async () => {
    const onOpen = vi.fn()
    await mount(<DelegationCard item={{ kind: 'delegation', childSessionId: 'child-1', definition: 'explorer', brief: 'Map auth modules', status: 'completed' }} workspaceId={null} onOpen={onOpen} />)
    const head = host.querySelector('button')!
    expect(head.textContent).toMatch(/^Delegated.*explorer/)
    expect(head.textContent).toContain('Map auth modules')
    // The role icon sits in the same rounded chip the panels use.
    const chip = head.querySelector('span')
    expect(chip?.className).toContain('bg-muted')
    expect(chip?.className).toContain('rounded-md')
    expect(chip?.querySelector('svg')).not.toBeNull()
    // A clean finish adds nothing to the row.
    expect(head.textContent).not.toMatch(/Failed|Stopped|Interrupted/)
    await act(async () => head.click())
    expect(host.textContent).toContain('Brief')
    await act(async () => button('Open conversation').click())
    expect(onOpen).toHaveBeenCalledWith('child-1')
  })
  it('keeps a running delegation silent about its result until settled', async () => {
    await mount(<DelegationCard item={{ kind: 'delegation', childSessionId: 'child-2', definition: 'coder', brief: 'Fix', status: 'running' }} workspaceId={null} onOpen={() => {}} />)
    expect(host.querySelector('.text-shimmer')?.textContent).toBe('Delegating')
    await act(async () => host.querySelector('button')!.click())
    expect(host.textContent).not.toContain('Result (')
  })
  it('renders audit lines with a glyph, exact text and duration', async () => {
    await mount(<AuditLine item={{ kind: 'audit', icon: 'block', text: 'hook blocked · PreToolUse · Bash*', durationMs: 120 }} />)
    const note = host.querySelector('[role="note"]')!
    expect(note.querySelector('svg')).not.toBeNull()
    expect(note.textContent).toContain('hook blocked · PreToolUse · Bash*')
    expect(note.textContent).toContain('120ms')
  })
  it('renders nothing for a queued twin — it lives on the composer strip', async () => {
    const onReuse = vi.fn()
    await mount(<UserBubble item={{ kind: 'user', content: 'Run the migration' }} onReuse={onReuse} />)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Reuse in composer"]')!.click())
    expect(onReuse).toHaveBeenCalledWith('Run the migration')
    await mount(<UserBubble item={{ kind: 'user', content: 'Queued work', queued: true }} onReuse={onReuse} />)
    expect(host.textContent).toBe('')
    expect(host.querySelector('button[aria-label="Reuse in composer"]')).toBeNull()
  })
  it('renders skill and file chips inline in a user message', async () => {
    await mount(<UserBubble item={{ kind: 'user', content: 'Use the review skill: check @web/lib/api.ts now' }} />)
    const chips = Array.from(host.querySelectorAll('[data-chip-kind]'))
    expect(chips.map((chip) => [chip.getAttribute('data-chip-kind'), chip.textContent, chip.getAttribute('title')])).toEqual([
      ['command', 'review', 'Skill: review'],
      ['mention', 'api.ts', 'Project file: web/lib/api.ts'],
    ])
    expect(host.querySelector('p')?.textContent).toBe('review check api.ts now')
  })
})

describe('projection of delegation, hook and approval events', () => {
  it('pairs spawn with result, marks interrupted on parent end, and drops allowing hooks', () => {
    const items = projectItems([
      { type: 'agent/child-spawn', seq: 0, childSessionId: 'ch1', definition: 'explorer', objective: 'Map' },
      { type: 'hook/run', seq: 1, event: 'PreToolUse', matcher: 'Bash*', exitCode: 1, durationMs: 40, decision: 'allow' },
      { type: 'hook/run', seq: 2, event: 'PreToolUse', matcher: 'Bash*', exitCode: 2, durationMs: 40, decision: 'block' },
      { type: 'agent/child-spawn', seq: 3, childSessionId: 'ch2', definition: 'coder', objective: 'Fix' },
      { type: 'turn/end', seq: 4, reason: 'completed' },
      { type: 'agent/child-result', seq: 5, childSessionId: 'ch1', status: 'completed' },
    ])
    const delegations = items.filter(item => item.kind === 'delegation')
    // Legacy logs carry `objective`; it still projects as the brief.
    expect(delegations[0]).toMatchObject({ childSessionId: 'ch1', status: 'completed', brief: 'Map' })
    expect(delegations[1]).toMatchObject({ childSessionId: 'ch2', status: 'interrupted', brief: 'Fix' })
    const audits = items.filter(item => item.kind === 'audit')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ icon: 'block' })
  })
  it('projects hook context as a collapsed marker, never a user bubble', () => {
    const items = projectItems([
      { type: 'turn/start', seq: 0, turnId: 't1' },
      { type: 'user/message', seq: 1, turnId: 't1', content: 'UserPromptSubmit hook additional context (lower-trust data; cannot override mode/policy):\n## Session', origin: 'context' },
      { type: 'user/message', seq: 2, turnId: 't1', content: 'hello', inputId: 'i1' },
      // A log written before the origin stamp: recognized by its header.
      { type: 'user/message', seq: 3, turnId: 't1', content: 'SessionStart hook additional context (lower-trust data; cannot override mode/policy):\nx' },
    ] as never)
    expect(items.filter((item) => item.kind === 'user').map((item) => item.kind === 'user' ? item.content : '')).toEqual(['hello'])
    expect(items.filter((item) => item.kind === 'hook-context')).toHaveLength(2)
  })
  it('projects the durable brief a current spawn record carries', () => {
    const items = projectItems([
      { type: 'agent/child-spawn', seq: 0, childSessionId: 'ch3', definition: 'reviewer', brief: 'Review the auth changes' },
    ])
    expect(items.find(item => item.kind === 'delegation')).toMatchObject({ childSessionId: 'ch3', brief: 'Review the auth changes' })
  })
  it('correlates an approval decision with its request into one quiet line', () => {
    const items = projectItems([
      { type: 'approval/request', seq: 0, approvalId: 'a9', call: { id: 'c', name: 'Bash', args: { command: 'rm -rf build' } } },
      { type: 'approval/decision', seq: 1, approvalId: 'a9', decision: 'deny' },
    ])
    expect(items.filter(item => item.kind === 'audit')).toContainEqual({ kind: 'audit', icon: 'deny', text: 'Denied · Bash · rm -rf build' })
    expect(items.some(item => item.kind === 'status' && item.reason.includes('a9'))).toBe(false)
  })
  it('flags recovered tool results and never renders mcp/call as its own row', () => {
    const items = projectItems([
      { type: 'tool/call', seq: 0, call: { id: 'c1', name: 'mcp__docs__search', args: {} } },
      { type: 'mcp/call', seq: 1, server: 'docs', tool: 'search', argsHash: 'a', resultHash: 'r', durationMs: 12, isError: false },
      { type: 'tool/result', seq: 2, callId: 'c1', ok: true, output: 'ok', recovery: true },
    ])
    expect(items.filter(item => item.kind === 'tool')).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', server: 'docs', recovered: true })
  })
})

describe('spawn call merging', () => {
  const spawnCall = { type: 'tool/call', seq: 0, call: { id: 't1', name: 'Agent', args: { action: 'spawn', definition: 'worker', prompt: 'do it' } } }
  const spawnOk = { type: 'tool/result', seq: 1, callId: 't1', ok: true, output: JSON.stringify({ childSessionId: 'ch1', status: 'running' }) }
  const childSpawn = { type: 'agent/child-spawn', seq: 2, childSessionId: 'ch1', definition: 'worker', brief: 'do it' }

  it('hides the spawn call its delegation row tracks — one delegation, one row', () => {
    expect(hiddenSpawnCalls([spawnCall, spawnOk, childSpawn])).toEqual(new Set(['t1']))
  })
  it('keeps a spawn call whose result never recorded: its digest is the only trace', () => {
    expect(hiddenSpawnCalls([spawnCall])).toEqual(new Set())
    expect(hiddenSpawnCalls([{ ...spawnCall }, childSpawn])).toEqual(new Set())
  })
  it('keeps a failed spawn call: the error is on the call row, not the delegation', () => {
    expect(hiddenSpawnCalls([spawnCall, { ...spawnOk, ok: false, output: 'error: no role' }, childSpawn])).toEqual(new Set())
  })
  it('keeps calls of actions that answer without a delegation row', () => {
    const wait = { type: 'tool/call', seq: 0, call: { id: 'w1', name: 'Agent', args: { action: 'wait' } } }
    expect(hiddenSpawnCalls([wait, { type: 'tool/result', seq: 1, callId: 'w1', ok: true, output: '{"children":[]}' }])).toEqual(new Set())
  })
  it('requires the parent log to confirm the child: a stray id hides nothing', () => {
    const other = { ...spawnOk, output: JSON.stringify({ childSessionId: 'elsewhere' }) }
    expect(hiddenSpawnCalls([spawnCall, other, childSpawn])).toEqual(new Set())
  })
})

describe('context compaction + budget bar', () => {
  const manifest = {
    modeId: 'plan', modeRevision: 3,
    budget: { availableTokens: 128000, usedTokens: 48000, estimated: true },
    history: { setting: 'all', includedTurns: 12, omittedTurns: 0 },
    sources: { skills: ['deploy-notes'], memory: [], toolNames: ['Bash'], toolSchemas: 1 },
    omissions: [],
  }
  it('computes the state-colored budget tone thresholds', () => {
    expect(budgetTone(0, 100)).toBe('ok')
    expect(budgetTone(79, 100)).toBe('ok')
    expect(budgetTone(80, 100)).toBe('warn')
    expect(budgetTone(94, 100)).toBe('warn')
    expect(budgetTone(95, 100)).toBe('bad')
    expect(budgetTone(10, 0)).toBe('bad')
  })
  it('shows the provider prompt count over the model window, not the input budget', async () => {
    const reported = {
      ...manifest,
      budget: { availableTokens: 994_880, usedTokens: 48_000, contextLimitTokens: 1_000_000, estimated: false },
      usage: { last: { inputTokens: 139_100 }, cacheableInputTokens: 139_100, cachedInputTokens: 0 },
    }
    await mount(<ToastHost><ContextPanel meta={null} stream="open" sessionId="s1" sessionFolder={null} eventCount={0} manifest={reported} workspaceId="w1" running={false} /></ToastHost>)
    expect(host.textContent).toContain('139100/1000000 tok (reported)')
    expect(host.textContent).not.toContain('~')
    expect(host.textContent).not.toContain('48000')
    expect(host.textContent).not.toContain('994880')
  })
  it('compacts through the confirm dialog and reports the checkpoint outcome', async () => {
    await mount(<ToastHost><ContextPanel meta={null} stream="open" sessionId="s1" sessionFolder={null} eventCount={0} manifest={manifest} workspaceId="w1" running={false} /></ToastHost>)
    expect(host.textContent).toContain('48000/128000 tok (est)')
    await act(async () => button('Compact…').click())
    expect(document.body.textContent).toContain('Compact this conversation?')
    await act(async () => bodyButton('Compact').click())
    expect(compactSession).toHaveBeenCalledWith('w1', 's1')
    expect(document.body.textContent).not.toContain('Compact this conversation?')
  })
  it('shows a child request’s role and inherited parent context, or why it was dropped', async () => {
    const hash = 'c'.repeat(64)
    const child = { ...manifest, sources: { ...manifest.sources, child: { definition: 'explorer', instructionsHash: hash }, parentContext: { hash, chars: 1234 } } }
    await mount(<ToastHost><ContextPanel meta={null} stream="open" sessionId="s1" sessionFolder={null} eventCount={0} manifest={child} workspaceId="w1" running={false} /></ToastHost>)
    expect(host.textContent).toContain(`explorer · ${hash.slice(0, 12)}`)
    expect(host.textContent).toContain('1,234 chars')
    const dropped = { ...manifest, sources: { ...manifest.sources, child: { definition: 'explorer', instructionsHash: hash } }, omissions: ['parent-context: dropped for budget (1234 chars)'] }
    await mount(<ToastHost><ContextPanel meta={null} stream="open" sessionId="s1" sessionFolder={null} eventCount={0} manifest={dropped} workspaceId="w1" running={false} /></ToastHost>)
    expect(host.textContent).toContain('dropped for budget (1234 chars)')
    // A root manifest shows neither row.
    await mount(<ToastHost><ContextPanel meta={null} stream="open" sessionId="s1" sessionFolder={null} eventCount={0} manifest={manifest} workspaceId="w1" running={false} /></ToastHost>)
    expect(host.textContent).not.toContain('parent context')
    expect(host.textContent).not.toContain('role')
  })
  it('disables compaction while a turn runs', async () => {
    await mount(<ToastHost><ContextPanel meta={null} stream="open" sessionId="s1" sessionFolder={null} eventCount={0} manifest={manifest} workspaceId="w1" running /></ToastHost>)
    const compact = button('Compact…')
    expect(compact.disabled).toBe(true)
    expect(compact.title).toBe('Stop the turn first')
  })
  it('invalidates an open compact confirmation when the turn starts and never executes compaction', async () => {
    function Probe() {
      const [running, setRunning] = useState(false)
      return (
        <ToastHost>
          <button type="button" onClick={() => setRunning(true)}>Start running</button>
          <ContextPanel meta={null} stream="open" sessionId="s1" sessionFolder={null} eventCount={0} manifest={manifest} workspaceId="w1" running={running} />
        </ToastHost>
      )
    }
    await mount(<Probe />)
    await act(async () => button('Compact…').click())
    expect(document.body.textContent).toContain('Compact this conversation?')
    await act(async () => button('Start running').click())
    expect(document.body.textContent).not.toContain('Compact this conversation?')
    expect(compactSession).not.toHaveBeenCalled()
  })
  it('shows loading and unavailable instead of workspace defaults for unresolved conversations', async () => {
    const meta = { provider: 'workspace-provider', model: 'workspace-model', models: [], providers: [], workspace: { id: 'w1', name: 'W', archived: false }, projects: [] }
    await mount(<ToastHost><ContextPanel meta={meta} sessionControlsStatus="loading" stream="open" sessionId="s1" sessionFolder={null} eventCount={0} /></ToastHost>)
    expect(host.textContent).toContain('Loading…')
    expect(host.textContent).not.toContain('workspace-provider')
    await mount(<ToastHost><ContextPanel meta={meta} sessionControlsStatus="unavailable" stream="open" sessionId="s1" sessionFolder={null} eventCount={0} /></ToastHost>)
    expect(host.textContent).toContain('Unavailable')
    expect(host.textContent).not.toContain('workspace-model')
  })
  it('uses live global defaults rather than cached legacy-global session controls', async () => {
    await mount(<ToastHost><ContextPanel
      meta={null}
      globalDefaults={{ provider: 'new-provider', model: 'new-model' }}
      sessionModel={{ provider: 'old-provider', model: 'old-model', thinkingLevel: null, source: 'global' }}
      stream="open"
      sessionId="s1"
      sessionFolder={null}
      eventCount={0}
    /></ToastHost>)
    expect(host.textContent).toContain('new-provider')
    expect(host.textContent).toContain('new-model')
    expect(host.textContent).not.toContain('old-provider')
    expect(host.textContent).not.toContain('old-model')
  })

  it('renders the workspace mode row in effective controls', async () => {
    await mount(<ToastHost><ContextPanel meta={null} stream="open" sessionId={null} sessionFolder={null} eventCount={0} modeLabel="Plan" /></ToastHost>)
    expect([...host.querySelectorAll('dt')].some(term => term.textContent === 'mode')).toBe(true)
    expect(host.textContent).toContain('Plan')
  })
  it('renders workbench views and a trajectory from existing events', async () => {
    const events = [
      { type: 'tool/call', seq: 0, call: { id: 'file', name: 'Read', args: { path: 'C:/repo/README.md' } } },
      { type: 'tool/result', seq: 1, callId: 'file', ok: true, output: '# README' },
      { type: 'tool/call', seq: 2, call: { id: 'command', name: 'Bash', args: { command: 'npm test' } } },
      { type: 'tool/result', seq: 3, callId: 'command', ok: false, output: 'failed output' },
    ] as const
    await mount(<ToastHost><WorkbenchProbe view="trajectory" events={events as unknown as never} /></ToastHost>)
    expect(host.querySelector('[role="toolbar"][aria-label="Workbench views"]')).not.toBeNull()
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Trajectory')
  })
  it('renders the trajectory empty state', async () => {
    await mount(<ToastHost><WorkbenchProbe view="trajectory" events={[]} /></ToastHost>)
    expect(host.textContent).toMatch(/trajectory|Trajectory/)
  })
  it('keeps the workbench nav short: unopened views live in the picker and closing one falls back', async () => {
    await mount(<ToastHost><WorkbenchProbe view="files" events={[]} /></ToastHost>)
    const nav = host.querySelector('[role="toolbar"][aria-label="Workbench views"]')!
    const tabs = () => [...nav.querySelectorAll('button[aria-pressed]')].map((tab) => tab.textContent)
    expect(tabs()).toEqual(['Files'])

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open a view"]')!.click())
    await act(async () => bodyButton('Context').click())
    expect(tabs()).toEqual(['Files', 'Context'])
    expect(nav.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Context')

    // Closing the selected view must leave a selected tab behind, never a blank body.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close Context"]')!.click())
    expect(tabs()).toEqual(['Files'])
    expect(nav.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Files')
  })
  it('a single click on a close button closes the tab, also when it is not the selected one', async () => {
    seedWorkbench('trajectory', ['files', 'context', 'trajectory'])
    await mount(<ToastHost><WorkbenchPreferenceProbe events={[]} /></ToastHost>)
    const nav = host.querySelector('[role="toolbar"][aria-label="Workbench views"]')!
    const tabs = () => [...nav.querySelectorAll('button[aria-pressed]')].map((tab) => tab.textContent)
    expect(tabs()).toEqual(['Files', 'Context', 'Trajectory'])

    // Closing a background tab must not touch the selection.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close Context"]')!.click())
    expect(tabs()).toEqual(['Files', 'Trajectory'])
    expect(nav.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Trajectory')

    // Closing the selected tab reveals its neighbour in the same click.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close Trajectory"]')!.click())
    expect(tabs()).toEqual(['Files'])
    expect(nav.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Files')
  })
  const hooksRow = (hooks: unknown = {}) => ({ file: '/ws/settings.json', hooks, disableAllHooks: false, sources: [], effective: [], disabled: false, diagnostics: [] })
  it('hooks raw editor keeps an invalid document intact and refuses to apply or save it', async () => {
    ;(fetchHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce(hooksRow())
    await mount(<ToastHost><HooksPanel workspaceId="ws-1" /></ToastHost>)
    await act(async () => button('Edit raw JSON').click())
    const raw = host.querySelector<HTMLTextAreaElement>('textarea.manage-code-tall')!
    await act(async () => setInput(raw, '[]'))
    await act(async () => button('Apply JSON').click())
    expect(host.textContent).toContain('Hooks validation error: "hooks" must be an object')
    expect(host.querySelector<HTMLTextAreaElement>('textarea.manage-code-tall')?.value).toBe('[]')
    expect(button('Apply JSON')).not.toBeUndefined()
    expect(saveHooks).not.toHaveBeenCalled()
  })
  it.each([
    ['unknown event', '{"Nope":[]}', 'unknown hook event "Nope"'],
    ['non-command hook', '{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"prompt","prompt":"x"}]}]}', 'type must be "command"'],
  ])('hooks raw editor keeps %s verbatim/open and issues zero PUT', async (_case, draft, error) => {
    ;(fetchHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce(hooksRow())
    await mount(<ToastHost><HooksPanel workspaceId="ws-1" /></ToastHost>)
    await act(async () => button('Edit raw JSON').click())
    const raw = host.querySelector<HTMLTextAreaElement>('textarea.manage-code-tall')!
    await act(async () => setInput(raw, draft))
    await act(async () => button('Apply JSON').click())
    expect(host.textContent).toContain(error)
    expect(host.querySelector<HTMLTextAreaElement>('textarea.manage-code-tall')?.value).toBe(draft)
    expect(button('Apply JSON')).not.toBeUndefined()
    expect(saveHooks).not.toHaveBeenCalled()
  })
  it('hooks raw editor validates then saves the exact Claude hooks section', async () => {
    ;(fetchHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce(hooksRow())
    await mount(<ToastHost><HooksPanel workspaceId="ws-1" /></ToastHost>)
    await act(async () => button('Edit raw JSON').click())
    const raw = host.querySelector<HTMLTextAreaElement>('textarea.manage-code-tall')!
    const hooks = { UserPromptSubmit: [{ hooks: [{ type: 'command' as const, command: 'node prompt.mjs --safe', timeout: 7 }] }] }
    await act(async () => setInput(raw, JSON.stringify(hooks)))
    await act(async () => button('Apply JSON').click())
    await act(async () => button('Save changes').click())
    expect(saveHooks).toHaveBeenCalledWith('ws-1', hooks, false)
  })
  it('hooks editor lists every event section and saves the edited section', async () => {
    ;(fetchHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce(hooksRow({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] }))
    await mount(<ToastHost><HooksPanel workspaceId="ws-1" /></ToastHost>)
    for (const label of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification']) expect(host.textContent).toContain(label)
    const matcher = host.querySelector<HTMLInputElement>('.hooks-binding input')!
    expect(matcher.value).toBe('Bash')
    await act(async () => setInput(matcher, 'Write|Edit'))
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Save changes')!.click())
    expect(saveHooks).toHaveBeenCalledWith('ws-1', { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] }, false)
  })

  it('hooks editor asks before removing a hook', async () => {
    ;(fetchHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce(hooksRow({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] }))
    await mount(<ToastHost><HooksPanel workspaceId="ws-1" /></ToastHost>)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove PreToolUse hook 1"]')!.click())
    // Still there until confirmed.
    expect(host.querySelectorAll('.hooks-binding')).toHaveLength(1)
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Remove')!.click())
    expect(host.querySelectorAll('.hooks-binding')).toHaveLength(0)
  })

  it('lists other-layer hooks under their event and switches one off', async () => {
    const row = { id: '0123456789abcdef', event: 'Stop', matcher: '', command: '"/opt/homebrew/bin/node" "/Users/x/.claude/hooks/session-state.cjs"', layer: 'user', source: '/Users/x/.claude/settings.json', active: true, supported: true }
    ;(fetchHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...hooksRow(), effective: [row] })
    await mount(<ToastHost><HooksPanel workspaceId="ws-1" /></ToastHost>)
    const stop = [...host.querySelectorAll('.hooks-event')].find((section) => section.textContent?.startsWith('Stop'))!
    expect(stop.querySelector('.hooks-row')?.textContent).toContain('session-state.cjs')
    await act(async () => stop.querySelector<HTMLButtonElement>('button[role="switch"]')!.click())
    expect(setHookActive).toHaveBeenCalledWith('ws-1', '0123456789abcdef', false)
  })
})

describe('sidebar sections + live rows + workspace management', () => {
  const project = { id: 'p1', name: 'Acme', workspaceId: 'w1', path: 'C:/acme', createdAt: 1 }
  const base = { updatedAt: Date.now(), eventCount: 3, folder: null }
  const sessions = [
    { id: 's1', title: 'Auth refactor', projectId: 'p1', status: 'running' as const, activity: 'model' as const, pendingInputs: 0, ...base },
    { id: 's2', title: 'Crash fix', projectId: 'p1', status: 'idle' as const, pendingInputs: 2, ...base },
    { id: 's3', title: 'Loose chat', status: 'idle' as const, pendingInputs: 0, ...base },
  ] as const
  const sidebarProps = (workspaces: SidebarProps['workspaces'], active: string): SidebarProps => ({
    sessions: [], projects: [], current: null, filter: '', running: false, workspaces, activeWorkspaceId: active,
    newWorkspaceName: '', onNewWorkspaceName: () => {}, onSelectWorkspace: () => {}, onCreateWorkspace: () => {}, onWorkspacesChanged: async () => {},
    onFilter: () => {}, onSelect: () => {}, onNew: () => {}, onNewInProject: () => {}, onRename: () => {}, onDeleteRequest: () => {}, onOpenSettings: () => {},
    notifyEnabled: false, notifyBlocked: false, onToggleNotify: () => {}, theme: 'system', onTheme: () => {}, onClose: () => {},
  })
  it('groups by project and renders loose conversations without a bucket header', async () => {
    await mount(<SessionList sessions={[...sessions]} projects={[project]} current={null} filter="" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onNewInProject={() => {}} />)
    expect(host.textContent).toContain('Acme')
    // The folder header stays clean: running state lives on the session row's
    // leading spinner, not as a count badge on the folder.
    expect(host.textContent).not.toContain('running')
    expect(host.textContent).not.toContain('Chats')
    expect(host.textContent).toContain('Loose chat')
    expect(host.textContent).toContain('working with model')
    expect(host.textContent).toContain('2 queued')
  })
  it('leads a working conversation row with its spinner, ahead of the title', async () => {
    await mount(<SessionList sessions={[...sessions]} projects={[project]} current={null} filter="" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onNewInProject={() => {}} />)
    const row = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Auth refactor'))!
    const text = row.textContent ?? ''
    expect(text.indexOf('working with model')).toBeGreaterThan(-1)
    expect(text.indexOf('working with model')).toBeLessThan(text.indexOf('Auth refactor'))
  })
  it('collapses any project group on toggle, including the one holding the open conversation', async () => {
    await mount(<SessionList sessions={[...sessions]} projects={[project]} current="s1" filter="" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onNewInProject={() => {}} />)
    expect(host.textContent).toContain('Auth refactor')
    await act(async () => button('Acme').click())
    expect(host.textContent).not.toContain('Auth refactor')
    await act(async () => button('Acme').click())
    expect(host.textContent).toContain('Auth refactor')
  })
  it('searches folder names too, keeping that folder and its conversations', async () => {
    const other = { id: 'p2', name: 'dntbrowser', workspaceId: 'w1', path: 'C:/dnt', createdAt: 2 }
    const list = [...sessions, { id: 's4', title: 'Unrelated title', projectId: 'p2', status: 'idle' as const, pendingInputs: 0, ...base }]
    await mount(<SessionList sessions={list} projects={[project, other]} current={null} filter="dnt" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onNewInProject={() => {}} />)
    expect(host.textContent).toContain('dntbrowser')
    expect(host.textContent).toContain('Unrelated title')
    expect(host.textContent).not.toContain('Auth refactor')
  })
  it('marks a folder with a terminal icon while a shell is open in it', async () => {
    await mount(<SessionList sessions={[...sessions]} projects={[project]} current={null} filter="" liveRunning={false} terminalProjects={new Set(['p1'])} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.querySelector('span[title="Terminal or background process active in this folder"]')).not.toBeNull()
  })
  it('marks a folder whose conversation runs a background process even without a shell', async () => {
    const processing = { id: 's5', title: 'Long build', projectId: 'p1', status: 'idle' as const, pendingInputs: 0, runningProcesses: 1, ...base }
    await mount(<SessionList sessions={[processing]} projects={[project]} current={null} filter="" liveRunning={false} terminalProjects={new Set<string>()} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.querySelector('span[title="Terminal or background process active in this folder"]')).not.toBeNull()
  })
  it('leaves a quiet folder unmarked when no shell and no background process', async () => {
    await mount(<SessionList sessions={[...sessions]} projects={[project]} current={null} filter="" liveRunning={false} terminalProjects={new Set<string>()} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.querySelector('span[title="Terminal or background process active in this folder"]')).toBeNull()
  })
  it('lifts pinned conversations above every folder and offers unpinning on the row', async () => {
    const list = [...sessions, { id: 's9', title: 'Kept handy', projectId: 'p1', pinned: true, status: 'idle' as const, pendingInputs: 0, ...base }]
    const togglePinned = vi.fn()
    await mount(<SessionList sessions={list} projects={[project]} current={null} filter="" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onTogglePinned={togglePinned} onNewInProject={() => {}} />)
    const text = host.textContent ?? ''
    expect(text.indexOf('Pinned')).toBeLessThan(text.indexOf('Acme'))
    expect(text.indexOf('Kept handy')).toBeLessThan(text.indexOf('Acme'))
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Options for Kept handy"]')!.click())
    await act(async () => bodyButton('Unpin').click())
    expect(togglePinned).toHaveBeenCalledWith('s9', false)
  })
  it('nests running subagent conversations under their parent row; ended ones stay hidden', async () => {
    const onSelect = vi.fn()
    const list = [
      ...sessions,
      { id: 'c1', title: 'Explore repo', projectId: 'p1', status: 'running' as const, parentSessionId: 's1', pendingInputs: 0, ...base },
      { id: 'c2', title: 'Ended dig', projectId: 'p1', status: 'idle' as const, parentSessionId: 's1', pendingInputs: 0, ...base },
    ]
    await mount(<SessionList sessions={list} projects={[project]} current="c1" filter="" liveRunning={false} onSelect={onSelect} onRename={() => {}} onDeleteRequest={() => {}} />)
    // The running child reads as a branch of its parent; the ended one adds
    // nothing — ended children stay in the parent's Subagents workbench view.
    expect(host.textContent).toContain('Explore repo')
    expect(host.textContent).not.toContain('Ended dig')
    const childRow = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Explore repo'))!
    expect(childRow.getAttribute('aria-current')).toBe('page')
    expect(childRow.textContent).toContain('working')
    // Opening the child conversation navigates to it.
    await act(async () => childRow.click())
    expect(onSelect).toHaveBeenCalledWith('c1')
    // The viewed child stays visible even once its own turn ends.
    await mount(<SessionList sessions={list} projects={[project]} current="c2" filter="" liveRunning={false} onSelect={onSelect} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.textContent).toContain('Ended dig')
    expect(host.textContent).toContain('Explore repo')
    // An ended child vanishes again as soon as another conversation is open.
    await mount(<SessionList sessions={list} projects={[project]} current="s2" filter="" liveRunning={false} onSelect={onSelect} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.textContent).not.toContain('Ended dig')
    // A child-title match keeps its parent row so the nest stays reachable.
    await mount(<SessionList sessions={list} projects={[project]} current={null} filter="explore" liveRunning={false} onSelect={onSelect} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.textContent).toContain('Explore repo')
    expect(host.textContent).toContain('Auth refactor')
    // No child match, no parent: the nest contributes nothing on its own.
    await mount(<SessionList sessions={list} projects={[project]} current={null} filter="nothing-matches" liveRunning={false} onSelect={onSelect} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.textContent).not.toContain('Auth refactor')
  })
  it('reads a subagent conversation as a parent → sub breadcrumb trail in the header', async () => {
    const onSelect = vi.fn()
    await mount(
      <ChatHeader
        sidebarVisible
        stream="open"
        workbenchOpen={false}
        scopeControl={<span>scope</span>}
        title="Explore repo"
        parent={{ title: 'Auth refactor', onSelect }}
        onOpenSidebar={() => {}}
        onNew={() => {}}
        onToggleWorkbench={() => {}}
      />,
    )
    const parentButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Auth refactor')!
    expect(parentButton).toBeTruthy()
    expect(host.textContent).toContain('Explore repo')
    await act(async () => parentButton.click())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
  it('sorts conversations alphabetically from the sidebar sort menu', async () => {
    const base = { updatedAt: Date.now(), eventCount: 3, folder: null }
    const list = [
      { id: 'o1', title: 'Beta build', status: 'idle' as const, pendingInputs: 0, ...base },
      { id: 'o2', title: 'Alpha spec', status: 'idle' as const, pendingInputs: 0, ...base },
      { id: 'o3', title: 'Gamma notes', status: 'idle' as const, pendingInputs: 0, ...base },
    ]
    await mount(<ToastHost><Sidebar {...sidebarProps([{ id: 'w1', name: 'Acme', archived: false, createdAt: 1 }], 'w1')} sessions={list} /></ToastHost>)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Sort and filter conversations"]')!.click())
    await act(async () => bodyButton('Title A–Z').click())
    const text = host.textContent ?? ''
    expect(text.indexOf('Alpha spec')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('Alpha spec')).toBeLessThan(text.indexOf('Beta build'))
    expect(text.indexOf('Beta build')).toBeLessThan(text.indexOf('Gamma notes'))
  })
  it('opens the search field on demand and closes it again, clearing the query', async () => {
    const onFilter = vi.fn()
    const props = sidebarProps([{ id: 'w1', name: 'Acme', archived: false, createdAt: 1 }], 'w1')
    await mount(<ToastHost><Sidebar {...props} onFilter={onFilter} /></ToastHost>)
    const search = () => host.querySelector<HTMLButtonElement>('button[aria-label="Search conversations and folders (Ctrl K)"]')!
    expect(host.querySelector('input[aria-label="Search conversations and folders"]')).toBeNull()
    await act(async () => search().click())
    expect(host.querySelector('input[aria-label="Search conversations and folders"]')).not.toBeNull()
    expect(search().getAttribute('aria-expanded')).toBe('true')
    await act(async () => search().click())
    expect(host.querySelector('input[aria-label="Search conversations and folders"]')).toBeNull()
    expect(onFilter).toHaveBeenCalledWith('')
  })
  it('filters to running conversations and notes when none remain', async () => {
    const base = { updatedAt: Date.now(), eventCount: 3, folder: null }
    const list = [
      { id: 'f1', title: 'Busy turn', status: 'running' as const, activity: 'model' as const, pendingInputs: 0, ...base },
      { id: 'f2', title: 'Quiet turn', status: 'idle' as const, pendingInputs: 0, ...base },
    ]
    const props = sidebarProps([{ id: 'w1', name: 'Acme', archived: false, createdAt: 1 }], 'w1')
    await mount(<ToastHost><Sidebar {...props} sessions={list} /></ToastHost>)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Sort and filter conversations"]')!.click())
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Running only'))!.click())
    expect(host.textContent).toContain('Busy turn')
    expect(host.textContent).not.toContain('Quiet turn')
    await mount(<ToastHost><Sidebar {...props} sessions={[list[1]!]} /></ToastHost>)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Sort and filter conversations"]')!.click())
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Running only'))!.click())
    expect(host.textContent).toContain('No running conversations')
  })
  it('reorders project folders by drag: an edge line previews, the drop reports the order', async () => {
    const projectA = { id: 'pa', name: 'Alpha', workspaceId: 'w1', path: 'C:/a', createdAt: 1 }
    const projectB = { id: 'pb', name: 'Beta', workspaceId: 'w1', path: 'C:/b', createdAt: 2 }
    const dragSessions = [
      { id: 'd1', title: 'One', projectId: 'pa', status: 'idle' as const, pendingInputs: 0, updatedAt: Date.now(), eventCount: 3, folder: null },
      { id: 'd2', title: 'Two', projectId: 'pb', status: 'idle' as const, pendingInputs: 0, updatedAt: Date.now(), eventCount: 3, folder: null },
    ]
    const onReorder = vi.fn()
    await mount(<SessionList sessions={dragSessions} projects={[projectA, projectB]} current={null} filter="" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onReorder={onReorder} />)
    const headers = () => [...host.querySelectorAll<HTMLElement>('[draggable="true"]')]
    expect(headers()).toHaveLength(2)
    const fire = (element: HTMLElement, type: string, clientY = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { setData: vi.fn(), dropEffect: 'none', effectAllowed: 'all' } })
      Object.defineProperty(event, 'clientY', { value: clientY })
      element.dispatchEvent(event)
    }
    await act(async () => fire(headers()[0]!, 'dragstart'))
    // Hovering the lower half of the second header shows the below-edge line.
    await act(async () => fire(headers()[1]!, 'dragover', 100))
    expect(host.querySelector('.bg-primary.absolute')).not.toBeNull()
    // Rows hold still during the drag (moving them cancels native DnD);
    // the drop commits once at the hovered edge.
    expect((host.textContent ?? '').indexOf('Alpha')).toBeLessThan((host.textContent ?? '').indexOf('Beta'))
    await act(async () => fire(headers()[1]!, 'drop'))
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(['pb', 'pa'])
    // Cancelling the drag (dragend without drop) reports nothing.
    await mount(<SessionList sessions={dragSessions} projects={[projectA, projectB]} current={null} filter="" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onReorder={onReorder} />)
    await act(async () => fire(host.querySelectorAll<HTMLElement>('[draggable="true"]')[0]!, 'dragstart'))
    await act(async () => fire(host.querySelectorAll<HTMLElement>('[draggable="true"]')[1]!, 'dragover', 100))
    await act(async () => fire(host.querySelectorAll<HTMLElement>('[draggable="true"]')[0]!, 'dragend'))
    expect(onReorder).toHaveBeenCalledTimes(1)
  })
  it('emphasizes conversation titles and shows a compact relative age per row', async () => {
    const now = Date.now()
    const rows = [
      { id: 't1', title: 'Minutes old', status: 'idle' as const, pendingInputs: 0, updatedAt: now - 5 * 60_000, eventCount: 3, folder: null },
      { id: 't2', title: 'Hours old', status: 'idle' as const, pendingInputs: 0, updatedAt: now - 3 * 3_600_000, eventCount: 3, folder: null },
      { id: 't3', title: 'Weeks old', status: 'idle' as const, pendingInputs: 0, updatedAt: now - 14 * 86_400_000, eventCount: 3, folder: null },
    ]
    await mount(<SessionList sessions={rows} projects={[]} current={null} filter="" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} />)
    expect(host.textContent).toContain('5m')
    expect(host.textContent).toContain('3h')
    expect(host.textContent).toContain('2w')
    // The title carries the row's weight; the age stays quiet at the end.
    const title = [...host.querySelectorAll('span.font-medium')].find((span) => span.textContent === 'Minutes old')!
    expect(title).toBeTruthy()
    expect(title.closest('button')?.textContent).toContain('5m')
  })
  it('offers per-project quick-new and filters by title', async () => {
    const onNewInProject = vi.fn()
    await mount(<SessionList sessions={[...sessions]} projects={[project]} current={null} filter="crash" liveRunning={false} onSelect={() => {}} onRename={() => {}} onDeleteRequest={() => {}} onNewInProject={onNewInProject} />)
    expect(host.textContent).toContain('Crash fix')
    expect(host.textContent).not.toContain('Auth refactor')
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New conversation in Acme"]')!.click())
    expect(onNewInProject).toHaveBeenCalledWith('p1')
  })
  it('surfaces pending approvals, not running counts, on the workspace switcher', async () => {
    const workspaces = [
      { id: 'w1', name: 'Acme', archived: false, createdAt: 1, default: true, running: 2, approvals: 1 },
      { id: 'w2', name: 'Lab', archived: true, createdAt: 2, running: 0, approvals: 0 },
    ]
    await mount(<ToastHost><Sidebar {...sidebarProps(workspaces, 'w1')} /></ToastHost>)
    const switcher = host.querySelector('button[aria-label="Workspace: Acme"]')!
    expect(switcher.textContent).toContain('1 approval pending')
    expect(switcher.textContent).not.toContain('running')
    await mount(<ToastHost><Sidebar {...sidebarProps([workspaces[1]!], 'w2')} /></ToastHost>)
    expect(host.querySelector('button[aria-label="Workspace: Lab"]')?.textContent).toContain('Archived')
    expect(host.textContent).toContain('Workspace archived.')
  })
  it('renames a workspace inline through the API', async () => {
    const onChanged = vi.fn(async () => {})
    const workspaces = [{ id: 'w1', name: 'Old', archived: false, createdAt: 1 }]
    await mount(<ToastHost><WorkspacePopover workspaces={workspaces} activeWorkspaceId="w1" onSelect={() => {}} onChanged={onChanged} newWorkspaceName="" onNewWorkspaceName={() => {}} onCreate={() => {}} /></ToastHost>)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Manage Old"]')!.click())
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Rename Old"]')!.click())
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Workspace name"]')!
    await act(async () => setInput(input, 'Renamed'))
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Save workspace name"]')!.click())
    expect(renameWorkspace).toHaveBeenCalledWith('w1', 'Renamed')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
  it('disables Archive in the manage menu while sessions run', async () => {
    const workspaces = [{ id: 'w1', name: 'Busy', archived: false, createdAt: 1, running: 1, approvals: 0 }]
    await mount(<ToastHost><WorkspacePopover workspaces={workspaces} activeWorkspaceId="w1" onSelect={() => {}} onChanged={async () => {}} newWorkspaceName="" onNewWorkspaceName={() => {}} onCreate={() => {}} /></ToastHost>)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Manage Busy"]')!.click())
    const archive = bodyButton('Archive')
    expect(archive.disabled).toBe(true)
    expect(archive.title).toBe('Stop running sessions first')
  })
})

describe('per-folder show more', () => {
  const project = { id: 'pf', name: 'Long folder', workspaceId: 'w1', path: 'C:/long', createdAt: 1 }
  const now = Date.now()
  const many = Array.from({ length: 7 }, (_, index) => ({
    id: `m${index + 1}`,
    title: `Topic ${index + 1}`,
    projectId: 'pf',
    status: 'idle' as const,
    pendingInputs: 0,
    updatedAt: now - index * 60_000,
    eventCount: 3,
    folder: null,
  }))
  const props = { sessions: many, projects: [project], filter: '', liveRunning: false, onSelect: () => {}, onRename: () => {}, onDeleteRequest: () => {} }
  it('keeps a long folder to five rows and reveals the rest on demand', async () => {
    await mount(<SessionList {...props} current={null} />)
    expect(host.textContent).toContain('Topic 5')
    expect(host.textContent).not.toContain('Topic 6')
    expect(button('Show more').getAttribute('aria-expanded')).toBe('false')
    await act(async () => button('Show more').click())
    expect(host.textContent).toContain('Topic 6')
    expect(host.textContent).toContain('Topic 7')
    expect(button('Show less').getAttribute('aria-expanded')).toBe('true')
    await act(async () => button('Show less').click())
    expect(host.textContent).not.toContain('Topic 6')
    expect(host.textContent).toContain('Topic 5')
  })
  it('never hides search matches behind the toggle', async () => {
    await mount(<SessionList {...props} current={null} filter="Topic" />)
    expect(host.textContent).toContain('Topic 7')
    expect(host.textContent).not.toContain('Show more')
  })
  it('shows the open conversation past the cut without spilling the rest of the folder', async () => {
    await mount(<SessionList {...props} current="m6" />)
    expect(host.textContent).toContain('Topic 6')
    // Grafted onto the preview, not a forced full expansion.
    expect(host.textContent).not.toContain('Topic 7')
    expect(button('Show more')).toBeTruthy()
  })
  it('keeps an explicit expansion sticky when the selection moves on', async () => {
    await mount(<SessionList {...props} current={null} />)
    await act(async () => button('Show more').click())
    await act(async () => root!.render(<SessionList {...props} current="m2" />))
    expect(host.textContent).toContain('Topic 7')
  })
  it('keeps an explicit expansion after a search comes and goes', async () => {
    await mount(<SessionList {...props} current={null} />)
    await act(async () => button('Show more').click())
    await act(async () => root!.render(<SessionList {...props} current={null} filter="Topic 7" />))
    expect(host.textContent).toContain('Topic 7')
    await act(async () => root!.render(<SessionList {...props} current={null} filter="" />))
    expect(host.textContent).toContain('Topic 7')
  })
  it('reports expansion upward so the app shell keeps it across remounts', async () => {
    const onExpandFolder = vi.fn()
    await mount(<SessionList {...props} current={null} expandedFolders={{}} onExpandFolder={onExpandFolder} />)
    await act(async () => button('Show more').click())
    expect(onExpandFolder).toHaveBeenCalledWith('pf', true)
    // Simulates the shell remounting the sidebar with its persisted map.
    await mount(<SessionList {...props} current={null} expandedFolders={{ pf: true }} />)
    expect(host.textContent).toContain('Topic 7')
    expect(button('Show less')).toBeTruthy()
  })
})

describe('global feedback', () => {
  function Boom(): null {
    throw new Error('render exploded')
  }
  it('catches render crashes in a neutral boundary that never blames the data', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await mount(<ErrorBoundary><Boom /></ErrorBoundary>)
      await act(async () => {})
      const alert = host.querySelector('[role="alert"]')!
      expect(alert.textContent).toContain('The conversation data is safe on the server.')
      expect(alert.querySelector('svg')).not.toBeNull()
      expect(host.textContent).toContain('render exploded')
    } finally {
      spy.mockRestore()
    }
  })
  it('renders toast variants with their state icon', async () => {
    const probe: { notify?: (text: string, kind?: 'ok' | 'bad' | 'info') => void } = {}
    function Probe(): null {
      probe.notify = useToast().notify
      return null
    }
    await mount(<ToastHost><Probe /></ToastHost>)
    await act(async () => probe.notify?.('Saved successfully.', 'ok'))
    expect(host.querySelector('svg.text-ok')).not.toBeNull()
    await act(async () => probe.notify?.('Broken input.', 'bad'))
    expect(host.querySelector('svg.text-bad')).not.toBeNull()
    await act(async () => probe.notify?.('Plain information.', 'info'))
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(2)
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(host.querySelectorAll('[role="alert"] [role="alert"]')).toHaveLength(0)
    expect(host.querySelectorAll('button[aria-label="Dismiss notification"]')).toHaveLength(3)
  })
  it('does not stack copies of the same message: a repeat refreshes the one live toast', async () => {
    const probe: { notify?: (text: string, kind?: 'ok' | 'bad' | 'info') => void } = {}
    function Probe(): null {
      probe.notify = useToast().notify
      return null
    }
    await mount(<ToastHost><Probe /></ToastHost>)
    for (let i = 0; i < 5; i++) await act(async () => probe.notify?.('HTTP 503: fetch failed', 'bad'))
    const alerts = host.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.textContent).toContain('HTTP 503')
  })
  it('collapses errors that read the same: distinct raw failures with one summary show once with a count', async () => {
    const probe: { notify?: (text: string, kind?: 'ok' | 'bad' | 'info') => void } = {}
    function Probe(): null {
      probe.notify = useToast().notify
      return null
    }
    await mount(<ToastHost><Probe /></ToastHost>)
    const raws = ['TypeError: Failed to fetch', 'HTTP 502: bad gateway', 'network error on /api/sessions', 'HTTP 503: unavailable']
    for (const raw of raws) await act(async () => probe.notify?.(raw, 'bad'))
    const alerts = host.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.textContent).toContain('HTTP 503: unavailable')
    expect(alerts[0]!.textContent).toContain('×4')
  })
  it('caps the stack: the oldest toast leaves when more than four are live', async () => {
    const probe: { notify?: (text: string, kind?: 'ok' | 'bad' | 'info') => void } = {}
    function Probe(): null {
      probe.notify = useToast().notify
      return null
    }
    await mount(<ToastHost><Probe /></ToastHost>)
    for (let i = 1; i <= 6; i++) await act(async () => probe.notify?.(`failure ${i}`, 'bad'))
    const texts = [...host.querySelectorAll('[role="alert"]')].map((node) => node.textContent)
    expect(texts).toHaveLength(4)
    expect(texts[0]).toContain('failure 3')
    expect(texts[3]).toContain('failure 6')
  })
  it('keeps the notification toggle honest: enabled only after granted permission', async () => {
    let latest: { enabled: boolean; blocked: boolean; toggle: () => void } | undefined
    function Probe(): null {
      latest = useApprovalNotify([], 'Acme')
      return null
    }
    ;(globalThis as any).Notification = { permission: 'denied', requestPermission: async () => 'denied' }
    try {
      window.localStorage?.setItem('notify-approvals', '0')
      await mount(<Probe />)
      expect(latest?.enabled).toBe(false)
      await act(async () => latest?.toggle())
      expect(latest?.enabled).toBe(false)
      expect(latest?.blocked).toBe(true)
    } finally {
      delete (globalThis as any).Notification
    }
  })
})

describe('no-modal new-chat flow (header scope picker)', () => {
  const options = [
    { id: null, name: 'Chat only', path: 'No project folder — chat without file or shell tools' },
    { id: 'p1', name: 'Acme', path: 'C:/acme' },
  ]
  const scopeTrigger = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Conversation scope"]')
  it('renders the picker trigger with the selected label in draft mode', async () => {
    await mount(<ScopeControl scope={null} picker={{ value: 'p1', options, onChange: () => {}, onPickFolder: () => {} }} />)
    expect(scopeTrigger()?.textContent).toContain('Acme')
    expect(scopeTrigger()?.getAttribute('aria-haspopup')).toBe('menu')
  })
  it('lists projects with paths and reports the changed scope', async () => {
    const onChange = vi.fn()
    await mount(<ScopeControl scope={null} picker={{ value: null, options, onChange, onPickFolder: () => {} }} />)
    await act(async () => scopeTrigger()!.click())
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('C:/acme')
    await act(async () => rows[1]!.click())
    expect(onChange).toHaveBeenCalledWith('p1')
  })
  it('switches to Chat only with null and opens the folder picker from the footer', async () => {
    const onChange = vi.fn()
    const onPickFolder = vi.fn()
    await mount(<ScopeControl scope={null} picker={{ value: 'p1', options, onChange, onPickFolder }} />)
    await act(async () => scopeTrigger()!.click())
    const chatOnly = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(b => b.textContent?.includes('Chat only'))!
    await act(async () => chatOnly.click())
    expect(onChange).toHaveBeenCalledWith(null)
    await act(async () => scopeTrigger()!.click())
    const footer = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.includes('Choose folder'))!
    await act(async () => footer.click())
    expect(onPickFolder).toHaveBeenCalledTimes(1)
  })
  it('falls back to the read-only scope display once a conversation is open', async () => {
    await mount(<ScopeControl scope="C:/acme" />)
    expect(scopeTrigger()).toBeNull()
    expect(host.querySelector('[title="C:/acme"]')?.textContent).toContain('acme')
  })
})

describe('mounted clipboard recovery', () => {
  it('announces rejection and supports a successful manual retry without changing text', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce(undefined)
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await mount(<CopyButton text="Dữ liệu nguyên bản" />)
      expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Copy to clipboard')
      await act(async () => host.querySelector('button')!.click())
      expect(host.querySelector('[role=status]')?.textContent).toContain('Could not copy')
      await act(async () => host.querySelector('button')!.click())
      expect(host.querySelector('[role=status]')).toBeNull()
      expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Copied to clipboard')
      expect(writeText).toHaveBeenNthCalledWith(2, 'Dữ liệu nguyên bản')
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })
})

describe('workbench files', () => {
  const project = { id: 'p1', name: 'Acme', path: 'C:/acme' }
  it('closing the front tab reveals its neighbour, then the fixed view', () => {
    const state = { folder: '', openFiles: ['a.ts', 'b.ts', 'c.ts'], activeFile: 'b.ts', focus: null }
    expect(closeFileTab(state, 'b.ts')).toMatchObject({ openFiles: ['a.ts', 'c.ts'], activeFile: 'c.ts' })
    expect(closeFileTab({ ...state, activeFile: 'c.ts' }, 'c.ts')).toMatchObject({ activeFile: 'b.ts' })
    expect(closeFileTab({ ...state, activeFile: 'a.ts' }, 'c.ts')).toMatchObject({ activeFile: 'a.ts' })
    expect(closeFileTab({ folder: '', openFiles: ['a.ts'], activeFile: 'a.ts', focus: null }, 'a.ts')).toMatchObject({ openFiles: [], activeFile: null })
    // A closed tab takes its window with it; the revealed file lands at its top.
    expect(closeFileTab({ ...state, focus: { line: 40, seq: 1 } }, 'b.ts')).toMatchObject({ focus: null })
  })
  it('browses folders, opens a file as a tab with escaped highlighted content, and closes it', async () => {
    await mount(<ToastHost><WorkbenchProbe view="files" events={[]} project={project} /></ToastHost>)
    expect(listProjectFiles).toHaveBeenCalledWith('w1', 'p1', '')
    await act(async () => button('src').click())
    expect(listProjectFiles).toHaveBeenLastCalledWith('w1', 'p1', 'src')
    expect(host.querySelector('button[title="src"]')?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => button('index.ts').click())
    expect(readProjectFile).toHaveBeenCalledWith('w1', 'p1', 'src/index.ts')
    const tab = host.querySelector<HTMLButtonElement>('[aria-label="Open files"] button[title="src/index.ts"][aria-pressed="true"]')
    expect(tab?.textContent).toContain('index.ts')
    const contents = host.querySelector('[aria-label="Contents of src/index.ts"]')!
    expect(contents.textContent).toContain('export const answer = 42')
    expect(contents.querySelector('code')?.innerHTML).toContain('&lt;raw&gt;')
    expect(host.textContent).toContain('C:/acme/src/index.ts')
    const tree = host.querySelector('[aria-label="Project files"]')!
    expect(contents.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const resize = host.querySelector<HTMLElement>('[aria-label="Resize file tree"]')!
    expect(resize.getAttribute('aria-valuenow')).toBe('34')
    await act(async () => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(resize.getAttribute('aria-valuenow')).toBe('36')
    expect(resize.nextElementSibling?.getAttribute('style')).toContain('36%')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Hide file tree"]')!.click())
    expect(resize.classList.contains('hidden')).toBe(true)
    expect(host.querySelector('[aria-label="Project files"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Show file tree"]')!.click())
    expect(resize.classList.contains('hidden')).toBe(false)
    expect(host.querySelector('button[title="src"]')?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => host.querySelector<HTMLButtonElement>('[role="toolbar"][aria-label="Workbench views"] button[aria-pressed="true"]')!.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open a view"]')!.click())
    await act(async () => bodyButton('Context').click())
    expect(host.querySelector('[aria-label="Open files"]')).toBeNull()
    expect(host.querySelector('[aria-label="Project files"]')).toBeNull()
    expect(host.querySelector('[aria-label="Resize file tree"]')).toBeNull()
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Workbench views"] button')].find((item) => item.textContent === 'Files')!.click())
    expect(host.querySelector('[aria-label="Open files"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Project files"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Resize file tree"]')?.getAttribute('aria-valuenow')).toBe('36')
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close src/index.ts"]')!.click())
    expect(host.querySelector('[aria-label="Open files"] button[title="src/index.ts"]')).toBeNull()
    expect(host.querySelector('[aria-label="Project files"]')).not.toBeNull()
    expect(host.textContent).toContain('Open a file from the tree.')
  })
  it('lists changed files with line counts and opens a read-only diff', async () => {
    await mount(<ToastHost><WorkbenchProbe view="git" events={[]} project={project} /></ToastHost>)
    expect(host.textContent).toContain('main')
    expect(host.textContent).toContain('README.md')
    expect(host.textContent).toContain('+1')
    expect(host.textContent).toContain('−2')
    const row = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('README.md'))!
    await act(async () => row.click())
    const diff = host.querySelector('[aria-label="Diff of docs/README.md"]')!
    expect(diff.textContent).toContain('npm run chat:mock')
    expect(diff.textContent).toContain('npm run chat')
  })
  it('explains a chat-only conversation instead of browsing', async () => {
    await mount(<ToastHost><WorkbenchProbe view="files" events={[]} /></ToastHost>)
    expect(host.textContent).toContain('No project folder for this conversation')
    expect(listProjectFiles).not.toHaveBeenCalled()
  })
  it('offers to open a tool path only when the resolver accepts it', async () => {
    const opened = vi.fn()
    const item = { kind: 'tool' as const, call: { id: 'c', name: 'Read', args: { path: 'C:/acme/src/index.ts' } }, result: { ok: true, output: 'x' } }
    await mount(<ToolCard item={item} openPath={() => opened} />)
    await act(async () => (host.querySelector('button[title="Open C:/acme/src/index.ts in workbench"]') as HTMLButtonElement).click())
    expect(opened).toHaveBeenCalledTimes(1)
    await mount(<ToolCard item={item} openPath={() => null} />)
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('index.ts')
  })
})
describe('transcript grouping: agent waits', () => {
  const wait = (id: string, output = JSON.stringify({ children: [{ status: 'running' }] }), ok = true) =>
    ({ kind: 'tool' as const, call: { id, name: 'Agent', args: { action: 'wait' } }, result: { ok, output } })
  const delegation = { kind: 'delegation' as const, childSessionId: 'child', definition: 'reviewer', brief: 'review docs', status: 'running' as const }
  it('folds consecutive waits into one row and counts one agent, not one per wait', () => {
    const items = [{ kind: 'user' as const, content: 'go' }, delegation, ...Array.from({ length: 9 }, (_, i) => wait(`w${i}`))]
    const blocks = groupBlocks(items)
    const run = blocks[1]
    expect(run?.kind).toBe('activity')
    if (run?.kind !== 'activity') return
    expect(run.rows).toHaveLength(2)
    expect(run.rows[1]?.folded).toHaveLength(8)
    const summary = summarizeActivity(run.rows.flatMap(rowItems))
    expect(summary.text).toBe('1 agent, 9 waits')
  })
  it('keeps a failed wait on its own row', () => {
    const blocks = groupBlocks([delegation, wait('a', 'boom', false), wait('b'), wait('c')])
    expect(blocks[0]?.kind === 'activity' ? blocks[0].rows.length : 0).toBe(3)
  })
})
