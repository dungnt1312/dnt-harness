// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMcpServer, duplicateModeFile, fetchProviderModels, getMcpServer, getModeFile, HttpError, importAgentDefinition, importMcpServers, listModeFiles, listModes, saveModeFile, setModeEnabled, testProvider, upsertMcpServer } from '../../lib/api.ts'
import { emptyModeForm, parseModeForm, permissionKeyError, serializeModeForm } from '../../lib/mode-form.ts'
import { McpPanel } from './McpPanel.tsx'
import { AgentsPanel, definitionDocument } from './AgentsPanel.tsx'
import { ModesPanel } from './ModesPanel.tsx'
import { SettingsModal } from './SettingsModal.tsx'

vi.mock('../../lib/api.ts', () => ({
  HttpError: class HttpError extends Error {
    constructor(readonly status: number, body: string) {
      super(`HTTP ${status}: ${body}`)
      this.name = 'HttpError'
    }
  },
  fetchProviderModels: vi.fn(async () => ({ ok: true, models: ['auto', 'fresh-1'] })),
  testProvider: vi.fn(async () => ({ ok: true })),
  listMcpServers: vi.fn(async () => [{
    name: 'fs', transport: 'stdio', enabled: true, status: 'ready', breakerOpenUntil: null,
    discoveredTools: ['query', 'explode'], allowedTools: ['query'], unmatchedAllowlist: ['missing'],
  }]),
  getMcpServer: vi.fn(async () => ({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], env: { API_KEY: '${API_KEY}' }, enabled: false, timeoutMs: 5000 })),
  upsertMcpServer: vi.fn(async () => ({ saved: 'fs', enabled: false })),
  deleteMcpServer: vi.fn(async () => ({ deleted: 'fs' })),
  importMcpServers: vi.fn(async () => ({ imported: ['x'] })),
  setMcpServerAction: vi.fn(async () => ({ status: 'ready' })),
  listAgentDefinitions: vi.fn(async () => []),
  listChildren: vi.fn(async () => []),
  importAgentDefinition: vi.fn(async () => ({ imported: ['reviewer'] })),
  listModeFiles: vi.fn(async () => []),
  listModes: vi.fn(async () => ({ modes: [], selected: 'chat', revision: 1 })),
  getModeFile: vi.fn(async () => ({ id: 'review-only', raw: 'server version', source: 'workspace', hash: 'hash-1' })),
  saveModeFile: vi.fn(async () => ({ id: 'review-only', name: 'Review only', hash: 'hash-2' })),
  duplicateModeFile: vi.fn(async () => ({ id: 'plan-custom', name: 'Plan custom' })),
  setModeEnabled: vi.fn(async () => ({ id: 'review-only', enabled: false })),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string): HTMLButtonElement => {
  const found = buttons().find((node) => node.textContent === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
const input = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const found = [...document.body.querySelectorAll('label')].find((node) => node.textContent === label)?.control
  if (!(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)) throw new Error(`no field "${label}"`)
  return found
}
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
/** "Add server" names both the section action and the form submit; the submit is last. */
const saveButton = (): HTMLButtonElement => buttons().filter((node) => node.textContent === 'Add server').at(-1)!

describe('MCP panel', () => {
  it('edits a server by merging the form into its stored config, keeping env', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit fs').click())
    expect(getMcpServer).toHaveBeenCalledWith('ws', 'fs')
    expect(input('Command').value).toBe('npx')
    expect((input('Server name') as HTMLInputElement).disabled).toBe(true)
    await act(async () => type(input('Command'), 'node'))
    await act(async () => button('Save changes').click())
    expect(upsertMcpServer).toHaveBeenCalledWith('ws', 'fs', expect.objectContaining({
      transport: 'stdio', command: 'node', args: ['-y', 'fs-mcp'], env: { API_KEY: '${API_KEY}' }, timeoutMs: 5000,
    }))
  })

  it('keeps the form when a save loses a revision race', async () => {
    vi.mocked(upsertMcpServer).mockRejectedValueOnce(new HttpError(409, '{"error":"mcp.json changed since it was loaded"}'))
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit fs').click())
    await act(async () => button('Save changes').click())
    await settle()
    expect(document.body.textContent).toContain('changed since this form was loaded')
    expect(input('Command').value).toBe('npx')
  })

  it('lists each tool the server discovered and marks names the allowlist hides', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    const list = document.querySelector('[aria-label="Tools from fs"]')
    expect(list?.textContent).toContain('query')
    expect(list?.textContent).toContain('explode hidden')
    expect(document.body.textContent).toContain('Allowlist names not on this server: missing')
  })

  it('deletes a server only after an inline confirmation', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Delete fs').click())
    expect(deleteMcpServer).not.toHaveBeenCalled()
    await act(async () => button('Delete server').click())
    expect(deleteMcpServer).toHaveBeenCalledTimes(1)
    expect(deleteMcpServer).toHaveBeenCalledWith('ws', 'fs')
  })

  it('switches transport as one choice and refuses invalid numbers', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Add server').click())
    await act(async () => button('Streamable HTTP').click())
    expect(button('Streamable HTTP').getAttribute('aria-pressed')).toBe('true')
    expect(button('stdio').getAttribute('aria-pressed')).toBe('false')
    expect(input('URL')).toBeTruthy()
    await act(async () => { type(input('Server name'), 'remote'); type(input('URL'), 'https://mcp.example.com/mcp') })
    expect(saveButton().disabled).toBe(false)
    await act(async () => button('Advanced · tool exposure and resource limits').click())
    await act(async () => type(input('Memory limit (MB)'), 'abc'))
    expect(saveButton().disabled).toBe(true)
    expect(upsertMcpServer).not.toHaveBeenCalled()
  })

  it('keeps the list first and only opens the editor on request', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    expect(() => input('Server name')).toThrow()
    await act(async () => button('Add server').click())
    expect(input('Server name')).toBeTruthy()
    // Advanced caps stay folded until asked for, so the common path is short.
    expect(() => input('CPU limit (%)')).toThrow()
    await act(async () => button('Advanced · tool exposure and resource limits').click())
    expect(input('CPU limit (%)')).toBeTruthy()
  })

  it('reopens advanced limits when the stored server already sets one', async () => {
    vi.mocked(getMcpServer).mockResolvedValueOnce({
      name: 'fs', transport: 'stdio', command: 'npx', args: [], enabled: false, timeoutMs: 5000, resourceLimits: { memoryMb: 256 },
    } as never)
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit fs').click())
    expect((input('Memory limit (MB)') as HTMLInputElement).value).toBe('256')
  })

  it('imports Codex configuration with its pinned version', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Import from a Claude .mcp.json or Codex configuration').click())
    await act(async () => button('Codex (pinned)').click())
    await act(async () => type(input('Content'), '[mcp_servers.x]'))
    expect(button('Import servers').disabled).toBe(true)
    await act(async () => type(input('Pinned Codex version'), '0.9.0'))
    await act(async () => button('Import servers').click())
    expect(importMcpServers).toHaveBeenCalledWith('ws', { content: '[mcp_servers.x]', dialect: 'codex', sourceVersion: '0.9.0' })
  })
})

describe('agents panel', () => {
  it('shows a real multi-line import placeholder', async () => {
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await act(async () => button('Import a definition').click())
    const placeholder = input('Definition content').getAttribute('placeholder') ?? ''
    expect(placeholder).toContain('\n')
    expect(placeholder).not.toContain('\\n')
  })

  it('creates a role as a native document through the import route', async () => {
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Create a role').click())
    await act(async () => {
      type(input('Role name'), 'auditor')
      type(input('Description'), 'Reviews changes')
      type(input('Tools'), 'Read\nGrep')
      type(input('Instructions'), 'Review carefully.')
    })
    await act(async () => button('Create role').click())
    expect(importAgentDefinition).toHaveBeenCalledTimes(1)
    const [workspace, name, payload] = vi.mocked(importAgentDefinition).mock.calls[0]!
    expect([workspace, name]).toEqual(['ws', 'auditor'])
    expect(payload.dialect).toBe('mini-dsh')
    expect(payload.content).toContain('name: "auditor"')
    expect(payload.content).toContain('tools: ["Read","Grep"]')
    expect(payload.content).toContain('Review carefully.')
    // Absent means allowed: nothing is written unless the role refuses.
    expect(payload.content).not.toContain('inheritable')
  })

  it('records a refusal of inherited context only when switched off', async () => {
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Create a role').click())
    await act(async () => {
      type(input('Role name'), 'sandboxed')
      type(input('Description'), 'Handles untrusted input')
      type(input('Instructions'), 'Treat inputs as hostile.')
    })
    await act(async () => button('Accept inherited context').click())
    await act(async () => button('Create role').click())
    const [, , payload] = vi.mocked(importAgentDefinition).mock.calls[0]!
    expect(payload.content).toContain('inheritable: false')
  })

  it('definitionDocument writes inheritable only for a refusal', () => {
    const base = { name: 'x', description: 'd', tools: '', disallowedTools: '', instructions: 'i', model: '' }
    expect(definitionDocument(base)).not.toContain('inheritable')
    expect(definitionDocument({ ...base, inheritable: true })).not.toContain('inheritable')
    expect(definitionDocument({ ...base, inheritable: false })).toContain('inheritable: false')
  })
})

describe('modes panel', () => {
  beforeEach(() => {
    vi.mocked(listModeFiles).mockReset()
    vi.mocked(listModes).mockReset()
    vi.mocked(getModeFile).mockReset()
    vi.mocked(saveModeFile).mockReset()
    vi.mocked(duplicateModeFile).mockReset()
    vi.mocked(listModeFiles).mockResolvedValue([])
    vi.mocked(listModes).mockResolvedValue({ modes: [], selected: 'chat', revision: 1 })
    vi.mocked(getModeFile).mockResolvedValue({ id: 'review-only', raw: 'server version', source: 'workspace', hash: 'hash-1' })
    vi.mocked(saveModeFile).mockResolvedValue({ id: 'review-only', name: 'Review only', hash: 'hash-2' })
    vi.mocked(duplicateModeFile).mockResolvedValue({ id: 'plan-custom', name: 'Plan custom' })
  })

  const bundledMode = {
    id: 'plan', name: 'Plan', source: 'bundled' as const, enabled: true,
    toolExposure: ['Read'], permissionDefaults: { Read: 'allow' as const, '*': 'deny' as const, 'mcp__server__*': 'ask' as const },
  }
  const workspaceMode = {
    id: 'review-only', name: 'Review only', source: 'workspace' as const, enabled: true,
    toolExposure: ['Read'], permissionDefaults: { Read: 'allow' as const, '*': 'deny' as const },
  }

  it('keeps bundled modes read-only, lists every permission key, and explains selection snapshots', async () => {
    vi.mocked(listModeFiles).mockResolvedValueOnce([bundledMode, workspaceMode])
    vi.mocked(listModes).mockResolvedValueOnce({ modes: [], selected: 'review-only', revision: 1 })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    expect(document.body.textContent).toContain('allow: Read · ask: mcp__server__* · deny: *')
    expect(document.body.textContent).toContain('applies when the mode is next selected')
    expect(document.body.textContent).toContain('selected')
    expect(buttons().filter((node) => node.textContent === 'Duplicate')).toHaveLength(1)
    expect(document.body.textContent).toContain('Read-only')
    expect(buttons().some((node) => node.textContent === 'Edit' && node.closest('li')?.textContent?.includes('Plan'))).toBe(false)
    expect(buttons().some((node) => node.getAttribute('aria-label') === 'Delete plan')).toBe(false)
    expect(buttons().some((node) => node.textContent === 'Duplicate' && node.closest('li')?.textContent?.includes('Review only'))).toBe(false)
  })

  it('duplicates a bundled mode, refreshes the list, and opens the copy in the form', async () => {
    vi.mocked(listModeFiles)
      .mockResolvedValueOnce([bundledMode])
      .mockResolvedValueOnce([bundledMode, { ...workspaceMode, id: 'plan-custom', name: 'Plan custom' }])
    vi.mocked(getModeFile).mockResolvedValueOnce({
      id: 'plan-custom',
      raw: '---\nname: "Plan custom"\nhistory: "compact"\ntoolExposure: ["Read"]\npermissionDefaults: {"Read": "allow"}\n---\n\nCopied.',
      source: 'workspace',
      hash: 'copy-hash',
    })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Duplicate').click())
    await act(async () => type(input('New mode id'), 'plan-custom'))
    await act(async () => buttons().filter((node) => node.textContent === 'Duplicate').at(-1)!.click())
    expect(duplicateModeFile).toHaveBeenCalledWith('ws', 'plan', 'plan-custom')
    expect(getModeFile).toHaveBeenCalledWith('ws', 'plan-custom')
    expect(input('Name').value).toBe('Plan custom')
    expect(input('Instructions').value).toBe('Copied.')
  })

  it('loads a workspace mode’s real file into the form before editing', async () => {
    vi.mocked(listModeFiles).mockResolvedValueOnce([workspaceMode])
    vi.mocked(getModeFile).mockResolvedValueOnce({
      id: 'review-only',
      raw: '---\nname: "Review only"\npermissionDefaults: {"Read": "allow", "*": "deny"}\n---\n\nRead.',
      source: 'workspace',
      hash: 'hash-1',
    })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit').click())
    expect(getModeFile).toHaveBeenCalledWith('ws', 'review-only')
    expect(input('Name').value).toBe('Review only')
    expect(input('Instructions').value).toBe('Read.')
  })

  it('round-trips form edits into the canonical frontmatter on save', async () => {
    vi.mocked(listModeFiles).mockResolvedValueOnce([workspaceMode])
    vi.mocked(getModeFile).mockResolvedValueOnce({
      id: 'review-only',
      raw: '---\nname: "Review only"\npermissionDefaults: {"Read": "allow"}\n---\n\nRead.',
      source: 'workspace',
      hash: 'hash-1',
    })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit').click())
    await act(async () => type(input('Name'), 'Review stricter'))
    await act(async () => {
      const segments = [...document.body.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Permission for Write"] button')]
      segments.find((node) => node.textContent === 'Ask')!.click()
    })
    await act(async () => button('Save mode').click())
    const [, , content, hash] = vi.mocked(saveModeFile).mock.calls[0]!
    expect(String(content)).toContain('name: "Review stricter"')
    expect(String(content)).toContain('"Write":"ask"')
    expect(String(content)).toContain('"Read":"allow"')
    expect(hash).toBe('hash-1')
  })

  it('serializes identity, sources, exposure, permissions, and instructions to canonical frontmatter', () => {
    const form = {
      ...emptyModeForm(),
      name: 'Review only',
      instructions: 'Read.',
      history: 'compact' as const,
      skills: 'off' as const,
      workspaceInstructions: false,
      memoryPinned: false,
      memoryRetrieval: false,
      exposure: ['Read'],
      permissions: { Read: 'allow' as const, 'mcp__gh__*': 'ask' as const, '*': 'deny' as const },
    }
    const raw = serializeModeForm(form)
    expect(raw).toBe('---\nname: "Review only"\nhistory: compact\nworkspaceInstructions: false\nskills: off\nmemoryPinned: false\nmemoryRetrieval: false\ntoolExposure: ["Read"]\npermissionDefaults: {"Read":"allow","mcp__gh__*":"ask","*":"deny"}\n---\n\nRead.\n')
    expect(parseModeForm(raw)).toEqual(form)
  })

  it('rejects a permission key the gate would never consult', () => {
    expect(permissionKeyError('Read')).toBeNull()
    expect(permissionKeyError('*')).toBeNull()
    expect(permissionKeyError('mcp__github__*')).toBeNull()
    expect(permissionKeyError('mcp__github__create_issue')).toBeNull()
    expect(permissionKeyError('Memory*')).toContain('would never match')
    expect(permissionKeyError('mcp__*__read')).toContain('would never match')
  })

  it('re-reads a raced new mode by its entered id before overwriting', async () => {
    vi.mocked(saveModeFile)
      .mockRejectedValueOnce(new Error('HTTP 409: mode already exists'))
      .mockResolvedValueOnce({ id: 'raced-mode', name: 'Raced mode', hash: 'saved-hash' })
    vi.mocked(getModeFile).mockResolvedValueOnce({ id: 'raced-mode', raw: 'server mode', source: 'workspace', hash: 'fresh-hash' })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('New mode').click())
    await act(async () => {
      type(input('Mode id'), 'raced-mode')
      type(input('Instructions'), 'my new mode')
    })
    await act(async () => button('Save mode').click())
    expect(document.body.textContent).toContain('Overwrite anyway')
    await act(async () => button('Overwrite anyway').click())
    expect(getModeFile).toHaveBeenCalledWith('ws', 'raced-mode')
    expect(String(vi.mocked(saveModeFile).mock.calls[1]![2])).toContain('my new mode')
    expect(vi.mocked(saveModeFile).mock.calls[1]![3]).toBe('fresh-hash')
  })

  it('re-reads the hash before an overwrite after a save conflict', async () => {
    vi.mocked(listModeFiles).mockResolvedValueOnce([workspaceMode])
    vi.mocked(getModeFile)
      .mockResolvedValueOnce({ id: 'review-only', raw: '---\nname: "Review only"\n---\n\nopened', source: 'workspace', hash: 'stale-hash' })
      .mockResolvedValueOnce({ id: 'review-only', raw: '---\nname: "Review only"\n---\n\nfresh server', source: 'workspace', hash: 'fresh-hash' })
    vi.mocked(saveModeFile)
      .mockRejectedValueOnce(new Error('HTTP 409: changed'))
      .mockResolvedValueOnce({ id: 'review-only', name: 'Review only', hash: 'saved-hash' })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit').click())
    await act(async () => type(input('Name'), 'Renamed locally'))
    await act(async () => button('Save mode').click())
    expect(document.body.textContent).toContain('Overwrite anyway')
    await act(async () => button('Overwrite anyway').click())
    expect(getModeFile).toHaveBeenNthCalledWith(2, 'ws', 'review-only')
    expect(String(vi.mocked(saveModeFile).mock.calls[1]![2])).toContain('Renamed locally')
    expect(vi.mocked(saveModeFile).mock.calls[1]![3]).toBe('fresh-hash')
  })

  it('toggles a mode between picker-visible and hidden via its checkbox, refreshing the app selection', async () => {
    vi.mocked(listModeFiles)
      .mockResolvedValueOnce([workspaceMode])
      .mockResolvedValueOnce([{ ...workspaceMode, enabled: false }])
    const onChanged = vi.fn(async () => {})
    await act(async () => root.render(<ModesPanel workspaceId="ws" onChanged={onChanged} />))
    await settle()
    const box = (): HTMLInputElement => document.body.querySelector<HTMLInputElement>('input[aria-label="Offer review-only in the composer picker"]')!
    expect(box().checked).toBe(true)
    await act(async () => box().click())
    expect(setModeEnabled).toHaveBeenCalledWith('ws', 'review-only', false)
    expect(listModeFiles).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('hidden from the composer picker')
    expect(box().checked).toBe(false)

    await act(async () => box().click())
    expect(setModeEnabled).toHaveBeenLastCalledWith('ws', 'review-only', true)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('surfaces the selected-mode refusal when unchecking a selected mode', async () => {
    vi.mocked(listModeFiles).mockResolvedValue([workspaceMode])
    vi.mocked(setModeEnabled).mockRejectedValueOnce(new Error("HTTP 409: mode 'review-only' is selected; select another mode before disabling it"))
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    await act(async () => document.body.querySelector<HTMLInputElement>('input[aria-label="Offer review-only in the composer picker"]')!.click())
    expect(document.body.querySelector('.error-notice')?.textContent ?? document.body.textContent).toContain('select another mode')
    expect(listModeFiles).toHaveBeenCalledTimes(1)
  })
})

describe('settings dialog', () => {
  const providers = [{ id: 'p1', name: 'local', baseUrl: 'http://localhost:8080/v1', enabled: true, keyMasked: '', models: ['auto'] }] as const
  const render = async (): Promise<void> => {
    await act(async () => root.render(
      <SettingsModal open workspaceId="ws" providers={providers} activeProvider="p0" onDismiss={() => {}} onRefresh={async () => {}} />,
    ))
  }

  it('shows the real provider when the list arrives after Settings opened', async () => {
    await act(async () => root.render(
      <SettingsModal open workspaceId="ws" providers={[]} activeProvider="p1" onDismiss={() => {}} onRefresh={async () => {}} />,
    ))
    expect(input('Name').value).toBe('')
    await render()
    expect(input('Name').value).toBe('local')
    expect(button('Save changes')).toBeTruthy()
  })

  it('gives every section tab an icon', async () => {
    await render()
    const tabs = [...document.body.querySelectorAll('[role="tab"]')]
    expect(tabs).toHaveLength(10)
    for (const tab of tabs) expect(tab.querySelector('svg')).not.toBeNull()
  })

  it('states the provider name once, as the editable title, with enablement as state plus a verb', async () => {
    await render()
    // The name is the heading: no separate "Name" row repeating it.
    expect(input('Name').value).toBe('local')
    expect(document.body.textContent).toContain('Enabled')
    await act(async () => button('Disable').click())
    expect(document.body.textContent).toContain('Disabled')
    expect(button('Enable')).toBeTruthy()
  })

  it('keeps one status per fact on a model row, with no per-provider default control', async () => {
    await render()
    const row = [...document.body.querySelectorAll('li')].find((node) => node.textContent?.includes('auto'))!
    expect(row.textContent).not.toContain('provider default')
    expect(row.textContent).not.toContain('text')
    // Context stays, as the one piece of per-model data a row cannot infer.
    expect(row.textContent).toMatch(/\d+[km]/i)
    // Model choice is never per provider: no radio, no aria-pressed toggle.
    expect(row.querySelector('button[aria-pressed]')).toBeNull()
    expect(row.querySelector('button[aria-label*="default model"]')).toBeNull()
  })

  it('reveals the model input only when asked, and deletes from the title row', async () => {
    await render()
    expect(() => button('Model IDs to add')).toThrow()
    await act(async () => button('Add model').click())
    expect(document.body.querySelector('input[aria-label="Model IDs to add"]')).not.toBeNull()
    await act(async () => button('Delete provider').click())
    expect(document.body.textContent).toContain('Delete “local”?')
    expect(button('Delete permanently')).toBeTruthy()
  })

  it('treats a sync as a proposal: the endpoint list is chosen, not applied', async () => {
    await render()
    await act(async () => button('Sync from /models').click())
    expect(fetchProviderModels).toHaveBeenCalledWith('p1')
    // The probe wrote nothing; the dialog asks what to keep.
    expect(document.body.textContent).toContain('2 models offered by this endpoint (1 new)')
    expect(document.body.textContent).toContain('1 selected')
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
    await act(async () => boxes[1]!.click())
    await act(async () => button('Sync 2 models').click())
    const rows = [...document.body.querySelectorAll('li')].map((node) => node.textContent ?? '')
    expect(rows.some((text) => text.includes('fresh-1'))).toBe(true)
    expect(button('Save changes').disabled).toBe(false)
  })

  it('keeps a model the endpoint does not offer, and drops one that is unchecked', async () => {
    vi.mocked(fetchProviderModels).mockResolvedValueOnce({ ok: true, models: ['auto'] })
    await act(async () => root.render(
      <SettingsModal
        open
        workspaceId="ws"
        providers={[{ id: 'p1', name: 'local', baseUrl: 'http://localhost:8080/v1', enabled: true, keyMasked: '', models: ['auto', 'hand-added'] }]}
        activeProvider="p0"
        onDismiss={() => {}}
        onRefresh={async () => {}}
       
      />,
    ))
    await act(async () => button('Sync from /models').click())
    expect(document.body.textContent).toContain('1 model not offered here stays as it is')
    const box = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => box.click()) // uncheck the only offered model
    await act(async () => button('Sync 0 models').click())
    const rows = [...document.body.querySelectorAll('li')].map((node) => node.textContent ?? '')
    expect(rows.some((text) => text.includes('hand-added'))).toBe(true)
    expect(rows.some((text) => text.includes('auto'))).toBe(false)
  })

  it('edits one model in a dialog, carrying its overrides through a rename', async () => {
    await render()
    await act(async () => button('Edit auto settings').click())
    expect(input('Model ID').value).toBe('auto')
    await act(async () => type(input('Model ID'), 'auto-2'))
    await act(async () => button('Save').click())
    const rows = [...document.body.querySelectorAll('li')].map((node) => node.textContent ?? '')
    expect(rows.some((text) => text.includes('auto-2'))).toBe(true)
    // The rename leaves no per-provider default control behind.
    expect(document.body.querySelector('button[aria-pressed]')).toBeNull()
    expect(button('Save changes').disabled).toBe(false)
  })

  it('sets image input as a type checkbox, and can hand it back to the default', async () => {
    await render()
    await act(async () => button('Edit auto settings').click())
    const types = [...document.body.querySelectorAll<HTMLInputElement>('[role="group"][aria-label="Input types"] input')]
    expect(types.map((box) => `${box.checked}/${box.disabled}`)).toEqual(['true/true', 'false/false'])
    await act(async () => types[1]!.click())
    expect(document.body.textContent).toContain('Use the default')
    await act(async () => button('Save').click())
    const row = [...document.body.querySelectorAll('li')].find((node) => node.textContent?.includes('auto'))!
    expect(row.textContent).toContain('Vision')
  })

  it('offers the connection test only for saved configuration', async () => {
    await render()
    expect(button('Test connection').disabled).toBe(false)
    await act(async () => type(input('Name'), 'local edited'))
    expect(button('Test connection').disabled).toBe(true)
  })

  it('tests one model from its row and reports the verdict there', async () => {
    await render()
    expect(button('Test model auto')).not.toBeNull()

    await act(async () => button('Test model auto').click())
    expect(vi.mocked(testProvider)).toHaveBeenCalledWith('p1', 'auto')
    expect(document.body.textContent).toContain('Model replied.')

    // A refusal arrives as a rejected request (the API throws on !ok), and must
    // still land on the row instead of escaping to the panel-level notice.
    vi.mocked(testProvider).mockRejectedValueOnce(new Error('HTTP 502: {"ok":false,"error":"no such model"}'))
    await act(async () => button('Test model auto').click())
    expect(document.body.textContent).not.toContain('Model replied.')
    expect(document.body.querySelector('.error-notice')?.textContent).toContain('no such model')

    await act(async () => type(input('Name'), 'local edited'))
    expect(document.body.querySelector('.error-notice')).toBeNull()
    expect(button('Test model auto').disabled).toBe(true)
  })
})
