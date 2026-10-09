// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneAgentToWorkspace, readAgentFile, deleteMcpServer, listAgentDefinitions, duplicateModeFile, fetchProviderModels, getImageGenerationSettings, getImageUnderstandingSettings, getMcpServer, getModeFile, getSystemPrompts, HttpError, importAgentDefinition, importMcpServers, listModeFiles, listModes, putSystemPrompts, saveModeFile, setModeEnabled, testProvider, upsertMcpServer } from '../../lib/api.ts'
import { emptyModeForm, parseModeForm, permissionKeyError, serializeModeForm } from '../../lib/mode-form.ts'
import { McpPanel } from './McpPanel.tsx'
import { AgentsPanel, definitionDocument } from './AgentsPanel.tsx'
import { ModesPanel } from './ModesPanel.tsx'
import { SystemPromptsPanel } from './SystemPromptsPanel.tsx'
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
  getImageGenerationSettings: vi.fn(async () => ({ provider: null, model: null })),
  setImageGenerationSettings: vi.fn(async (value: unknown) => value),
  getImageUnderstandingSettings: vi.fn(async () => ({ provider: null, model: null })),
  setImageUnderstandingSettings: vi.fn(async (value: unknown) => value),
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
  listModelAliases: vi.fn(async () => []),
  cloneAgentToWorkspace: vi.fn(),
  readAgentFile: vi.fn(),
  listChildren: vi.fn(async () => []),
  importAgentDefinition: vi.fn(async () => ({ imported: ['reviewer'] })),
  listModeFiles: vi.fn(async () => []),
  listModes: vi.fn(async () => ({ modes: [], selected: 'ask-before-changes', revision: 1 })),
  getModeFile: vi.fn(async () => ({ id: 'review-only', raw: 'server version', source: 'workspace', hash: 'hash-1' })),
  saveModeFile: vi.fn(async () => ({ id: 'review-only', name: 'Review only', hash: 'hash-2' })),
  duplicateModeFile: vi.fn(async () => ({ id: 'plan-custom', name: 'Plan custom' })),
  setModeEnabled: vi.fn(async () => ({ id: 'review-only', enabled: false })),
  getSystemPrompts: vi.fn(async () => ({
    base: { text: 'DEFAULT BASE', overridden: false },
    child: { text: 'DEFAULT CHILD', overridden: false },
    defaults: { base: 'DEFAULT BASE', child: 'DEFAULT CHILD' },
    hash: 'h0',
  })),
  putSystemPrompts: vi.fn(async (_ws: string, prompts: { readonly base: string; readonly child: string }) => ({
    base: { text: prompts.base, overridden: prompts.base.trim() !== '' },
    child: { text: prompts.child, overridden: prompts.child.trim() !== '' },
    defaults: { base: 'DEFAULT BASE', child: 'DEFAULT CHILD' },
    hash: 'h2',
  })),
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
    await act(async () => button('Save server').click())
    expect(upsertMcpServer).toHaveBeenCalledWith('ws', 'fs', expect.objectContaining({
      transport: 'stdio', command: 'node', args: ['-y', 'fs-mcp'], env: { API_KEY: '${API_KEY}' }, timeoutMs: 5000,
    }))
  })

  it('keeps the form when a save loses a revision race', async () => {
    vi.mocked(upsertMcpServer).mockRejectedValueOnce(new HttpError(409, '{"error":"mcp.json changed since it was loaded"}'))
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit fs').click())
    await act(async () => button('Save server').click())
    await settle()
    expect(document.body.textContent).toContain('changed since this form was loaded')
    expect(input('Command').value).toBe('npx')
  })

  it('lists each tool the server discovered and marks names the allowlist hides', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    // Tools are listed flat — no disclosure to open first.
    expect(document.body.textContent).toContain('1 exposed by the allowlist · 1 hidden')
    const list = document.querySelector('[aria-label="Tools from fs"]')
    expect(list?.textContent).toContain('query')
    expect(list?.textContent).toContain('explode hidden')
    expect(document.body.textContent).toContain('Allowlist names not on this server: missing')
  })

  it('deletes a server only after an inline confirmation', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    // Delete lives in the row's overflow menu, then asks inline.
    await act(async () => button('More actions for fs').click())
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === 'Delete server')!.click())
    expect(deleteMcpServer).not.toHaveBeenCalled()
    await act(async () => buttons().filter((node) => node.textContent === 'Delete server').at(-1)!.click())
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
    // The editor replaces the list instead of stacking under it.
    expect(document.querySelector('[aria-label="MCP servers"]')).toBeNull()
    await act(async () => button('Back to servers').click())
    expect(document.querySelector('[aria-label="MCP servers"]')).not.toBeNull()
    await act(async () => button('Add server').click())
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
    await act(async () => button('Import…').click())
    await act(async () => button('Codex (pinned)').click())
    await act(async () => type(input('Content'), '[mcp_servers.x]'))
    expect(button('Import servers').disabled).toBe(true)
    await act(async () => type(input('Pinned Codex version'), '0.9.0'))
    await act(async () => button('Import servers').click())
    expect(importMcpServers).toHaveBeenCalledWith('ws', { content: '[mcp_servers.x]', dialect: 'codex', sourceVersion: '0.9.0' })
  })
})

describe('MCP panel replace guard', () => {
  it('asks before "Add server" replaces a server with the same name', async () => {
    await act(async () => root.render(<McpPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Add server').click())
    await act(async () => { type(input('Server name'), 'fs'); type(input('Command'), 'node') })
    await act(async () => button('Replace server…').click())
    expect(upsertMcpServer).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Replace the existing “fs”?')
    await act(async () => buttons().filter((node) => node.textContent === 'Replace server').at(-1)!.click())
    await settle()
    expect(upsertMcpServer).toHaveBeenCalledTimes(1)
  })
})

describe('agents panel', () => {
  const explorerRow = {
    source: 'bundled',
    definition: { name: 'explorer', description: 'Finds things', tools: ['Read'], disallowedTools: [], instructions: 'Look **around**.' },
  }
  const userRow = {
    source: 'user',
    path: '/home/u/.claude/agents/code-reviewer.md',
    definition: { name: 'code-reviewer', description: 'Reviews code', tools: ['Read', 'Grep'], disallowedTools: [], instructions: 'Review.', model: 'haiku', droppedTools: ['WebFetch'], unsupported: ['memory'] },
    modelResolution: { inherit: true, unresolved: 'haiku' },
  }
  const workspaceRow = {
    source: 'workspace',
    path: '/data/ws/agents/auditor-file.md',
    overrides: ['user'],
    definition: { name: 'auditor', description: 'Audits', tools: ['Read'], disallowedTools: [], instructions: 'Audit.', model: 'opus' },
    modelResolution: { inherit: false, resolved: 'cliproxy:claude-opus-5-5' },
  }

  it('shows resolved and blocking alias role details and stores the plain alias in the role chooser', async () => {
    const aliased = { ...workspaceRow, definition: { ...workspaceRow.definition, model: 'fast' }, modelResolution: { inherit: false, resolved: 'far:gpt', alias: 'fast', thinkingLevel: null } }
    const blocked = { ...userRow, definition: { ...userRow.definition, model: 'broken' }, modelResolution: { inherit: false, unresolved: 'broken', alias: 'broken', thinkingLevel: 'high', blocked: true, error: 'model alias broken is unusable' } }
    vi.mocked(listAgentDefinitions).mockResolvedValueOnce([aliased, blocked] as never)
    const { listModelAliases } = await import('../../lib/api.ts')
    vi.mocked(listModelAliases).mockResolvedValueOnce([
      { name: 'fast', provider: 'far', model: 'gpt', thinkingLevel: null, revision: 1, status: 'valid', warnings: [] },
      { name: 'broken', provider: 'gone', model: 'old', thinkingLevel: 'high', revision: 1, status: 'invalid', message: 'unusable', warnings: [] },
    ] as never)
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />)); await settle()
    expect(document.body.textContent).toContain('fast → far:gpt · thinking model default')
    await act(async () => button('Edit').click())
    expect(document.body.querySelector<HTMLButtonElement>('button[aria-label="Role model"]')?.title).toContain('fast → far:gpt')
    await act(async () => button('Cancel').click())
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes('code-reviewer'))!.click())
    expect(document.body.textContent).toContain('model alias broken is unusable')
  })

  it('lists roles grouped by layer, opens the first, and shows detail beside the list', async () => {
    vi.mocked(listAgentDefinitions).mockResolvedValueOnce([explorerRow, userRow, workspaceRow] as never)
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await settle()
    const groups = [...document.body.querySelectorAll('[role="listbox"] [role="group"]')].map((group) => group.getAttribute('aria-label'))
    expect(groups).toEqual(['Workspace', '~/.claude', 'Bundled'])
    // The most specific layer is first, and opened by default.
    expect(document.body.querySelector('h3')?.textContent).toBe('auditor')
    expect(document.body.textContent).toContain('opus → cliproxy:claude-opus-5-5')
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes('code-reviewer'))!.click())
    expect(document.body.textContent).toContain('haiku is not served by any provider here')
    expect(document.body.textContent).toContain('WebFetch')
    expect(document.body.textContent).toContain('Clone to workspace')
    // Search narrows the list.
    await act(async () => type(document.body.querySelector<HTMLInputElement>('input[aria-label="Search roles"]')!, 'explor'))
    expect([...document.body.querySelectorAll('[role="option"]')].map((node) => node.textContent)).toEqual([expect.stringContaining('explorer')])
  })

  it('"Clone to workspace" copies the global role under the same name and opens its file', async () => {
    const cloned = { source: 'workspace', path: '/data/ws/agents/code-reviewer.md', overrides: ['user'], definition: { ...userRow.definition } }
    vi.mocked(listAgentDefinitions).mockResolvedValueOnce([userRow] as never).mockResolvedValueOnce([cloned] as never)
    vi.mocked(cloneAgentToWorkspace).mockResolvedValueOnce({ definition: cloned } as never)
    vi.mocked(readAgentFile).mockResolvedValueOnce({ content: '---\nname: code-reviewer\nmemory: project\n---\n\nReview.', hash: 'h1' })
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Clone to workspace').click())
    await settle()
    expect(cloneAgentToWorkspace).toHaveBeenCalledWith('ws', 'code-reviewer')
    expect(readAgentFile).toHaveBeenCalledWith('ws', 'code-reviewer')
    const file = input('Subagent file') as HTMLTextAreaElement
    expect(file.value).toContain('memory: project')
    await act(async () => type(file, file.value.replace('Review.', 'Review harder.')))
    await act(async () => button('Save file').click())
    const [, name, payload] = vi.mocked(importAgentDefinition).mock.calls[0]!
    expect(name).toBe('code-reviewer')
    expect(payload).toMatchObject({ dialect: 'claude', expectedHash: 'h1' })
    expect(payload.content).toContain('memory: project')
    expect(payload.content).toContain('Review harder.')
  })

  it('edits a workspace role in place, keeping its file name', async () => {
    vi.mocked(listAgentDefinitions).mockResolvedValue([workspaceRow] as never)
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('Edit').click())
    await act(async () => type(input('Description'), 'Audits carefully'))
    await act(async () => button('Save changes').click())
    const [, file, payload] = vi.mocked(importAgentDefinition).mock.calls[0]!
    expect(file).toBe('auditor-file')
    expect(payload.content).toContain('description: "Audits carefully"')
    vi.mocked(listAgentDefinitions).mockReset()
    vi.mocked(listAgentDefinitions).mockResolvedValue([])
  })

  it('shows a real multi-line subagent placeholder', async () => {
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await act(async () => button('Paste a subagent file').click())
    const placeholder = input('Subagent file (Markdown + YAML frontmatter)').getAttribute('placeholder') ?? ''
    expect(placeholder).toContain('\n')
    expect(placeholder).not.toContain('\\n')
  })

  it('creates a role as a Claude Code subagent file through the import route', async () => {
    await act(async () => root.render(<AgentsPanel workspaceId="ws" />))
    await settle()
    await act(async () => button('New role').click())
    await act(async () => {
      type(input('Name'), 'auditor')
      type(input('Description'), 'Reviews changes')
      type(input('tools'), 'Read, Grep')
      type(input('Instructions'), 'Review carefully.')
    })
    await act(async () => button('Create role').click())
    expect(importAgentDefinition).toHaveBeenCalledTimes(1)
    const [workspace, name, payload] = vi.mocked(importAgentDefinition).mock.calls[0]!
    expect([workspace, name]).toEqual(['ws', 'auditor'])
    expect(payload.dialect).toBe('claude')
    expect(payload.content).toContain('name: "auditor"')
    expect(payload.content).toContain('tools: Read, Grep')
    expect(payload.content).toContain('Review carefully.')
  })

  it('definitionDocument omits tools to inherit every tool (Claude semantics)', () => {
    const base = { name: 'x', description: 'd', tools: '', disallowedTools: '', instructions: 'i', model: '' }
    expect(definitionDocument(base)).not.toContain('tools:')
    expect(definitionDocument({ ...base, disallowedTools: 'Bash' })).toContain('disallowedTools: Bash')
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
    vi.mocked(listModes).mockResolvedValue({ modes: [], selected: 'ask-before-changes', revision: 1 })
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
    await act(async () => button('Create mode').click())
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

  it('toggles a mode between picker-visible and hidden via its switch, refreshing the app selection', async () => {
    vi.mocked(listModeFiles)
      .mockResolvedValueOnce([workspaceMode])
      .mockResolvedValueOnce([{ ...workspaceMode, enabled: false }])
    const onChanged = vi.fn(async () => {})
    await act(async () => root.render(<ModesPanel workspaceId="ws" onChanged={onChanged} />))
    await settle()
    // A switch (role="switch"), not a native checkbox: its state is aria-checked.
    const box = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Offer review-only in the composer picker"]')!
    expect(box().getAttribute('aria-checked')).toBe('true')
    await act(async () => box().click())
    expect(setModeEnabled).toHaveBeenCalledWith('ws', 'review-only', false)
    expect(listModeFiles).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('hidden from the composer picker')
    expect(box().getAttribute('aria-checked')).toBe('false')

    await act(async () => box().click())
    expect(setModeEnabled).toHaveBeenLastCalledWith('ws', 'review-only', true)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('locks the picker switch on for the selected mode, so the refused action is never offered', async () => {
    vi.mocked(setModeEnabled).mockClear()
    vi.mocked(listModeFiles).mockResolvedValue([bundledMode, workspaceMode])
    vi.mocked(listModes).mockResolvedValue({ modes: [], selected: 'review-only', revision: 1 })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    const switchFor = (id: string): HTMLButtonElement =>
      document.body.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Offer ${id} in the composer picker"]`)!
    const selectedSwitch = switchFor('review-only')
    expect(selectedSwitch.getAttribute('aria-checked')).toBe('true')
    expect(selectedSwitch.disabled).toBe(true)
    expect(selectedSwitch.closest('label')?.getAttribute('title')).toContain('Select another mode')
    await act(async () => selectedSwitch.click())
    expect(setModeEnabled).not.toHaveBeenCalled()
    // Every other row stays switchable.
    expect(switchFor('plan').disabled).toBe(false)
  })

  it('keeps the selected mode locked on even if its stored flag says hidden', async () => {
    vi.mocked(listModeFiles).mockResolvedValue([{ ...workspaceMode, enabled: false }])
    vi.mocked(listModes).mockResolvedValue({ modes: [], selected: 'review-only', revision: 1 })
    await act(async () => root.render(<ModesPanel workspaceId="ws" />))
    await settle()
    const box = document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Offer review-only in the composer picker"]')!
    expect(box.getAttribute('aria-checked')).toBe('true')
    expect(box.disabled).toBe(true)
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
    const sections = [...document.body.querySelectorAll('[aria-label="Settings sections"] [role="tab"]')]
    expect(sections).toHaveLength(11)
    const sub = [...document.body.querySelectorAll('[aria-label="Providers & Models"] [role="tab"]')]
    expect(sub.map((tab) => tab.textContent)).toEqual(['Providers', 'Model aliases', 'Images'])
    for (const tab of [...sections, ...sub]) expect(tab.querySelector('svg')).not.toBeNull()
  })

  it('keeps providers, model aliases, and both image settings as sub-tabs of one section', async () => {
    await render()
    const subTab = (name: string): HTMLElement =>
      [...document.body.querySelectorAll<HTMLElement>('[aria-label="Providers & Models"] [role="tab"]')].find((node) => node.textContent === name)!
    // The provider editor and its footer belong to the Providers sub-tab only.
    expect(input('Name').value).toBe('local')
    expect(button('Save changes')).toBeTruthy()
    await act(async () => subTab('Images').click())
    expect(subTab('Images').getAttribute('aria-selected')).toBe('true')
    expect(document.body.querySelector('[aria-label="Image settings"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Image generation"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Image understanding"]')).not.toBeNull()
    expect([...document.body.querySelectorAll('button')].some((node) => node.textContent === 'Save changes')).toBe(false)
    await act(async () => subTab('Model aliases').click())
    expect(document.body.querySelector('[aria-label="Model alias editor"]')).not.toBeNull()
    await act(async () => subTab('Providers').click())
    expect(input('Name').value).toBe('local')
  })

  it('uses the model-alias selector contract for both image settings', async () => {
    vi.mocked(getImageGenerationSettings).mockResolvedValueOnce({ provider: 'p1', model: 'auto' })
    vi.mocked(getImageUnderstandingSettings).mockResolvedValueOnce({ provider: 'p1', model: 'auto' })
    await render()
    const images = [...document.body.querySelectorAll<HTMLElement>('[aria-label="Providers & Models"] [role="tab"]')].find((node) => node.textContent === 'Images')!
    await act(async () => images.click())
    await settle()

    expect(document.body.querySelector('input[aria-label="Image model"]')).toBeNull()
    expect(document.body.querySelector('input[aria-label="Image understanding model"]')).toBeNull()
    expect(button('Image model')).toBeTruthy()
    expect(button('Image understanding model')).toBeTruthy()
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

  it('reorders models with the grip handle, which marks the draft dirty', async () => {
    await act(async () => root.render(
      <SettingsModal
        open
        workspaceId="ws"
        providers={[{ id: 'p1', name: 'local', baseUrl: 'http://localhost:8080/v1', enabled: true, keyMasked: '', models: ['alpha', 'beta', 'gamma'] }]}
        activeProvider="p0"
        onDismiss={() => {}}
        onRefresh={async () => {}}
      />,
    ))
    const order = (): string[] => [...document.body.querySelectorAll('li code')].map((node) => node.textContent ?? '')
    const press = async (model: string, key: string): Promise<void> => {
      const grip = document.body.querySelector<HTMLButtonElement>(`button[aria-label^="Reorder ${model} "]`)!
      await act(async () => { grip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    }
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    await press('gamma', 'ArrowUp')
    expect(order()).toEqual(['alpha', 'gamma', 'beta'])
    await press('gamma', 'Home')
    expect(order()).toEqual(['gamma', 'alpha', 'beta'])
    await press('gamma', 'End')
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    await press('alpha', 'ArrowDown')
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
    expect(button('Save changes').disabled).toBe(false)
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

describe('system prompts panel', () => {
  const textarea = (label: string): HTMLTextAreaElement => {
    const found = document.body.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
    if (found === null) throw new Error(`no textarea "${label}"`)
    return found
  }

  it('shows the effective prompts, saves an edit, and resets to the default', async () => {
    vi.mocked(getSystemPrompts).mockResolvedValue({
      base: { text: 'HOUSE BASE', overridden: true },
      child: { text: 'DEFAULT CHILD', overridden: false },
      defaults: { base: 'DEFAULT BASE', child: 'DEFAULT CHILD' },
      hash: 'h0',
    })
    await act(async () => root.render(<SystemPromptsPanel workspaceId="ws-1" />))
    await settle()
    expect(getSystemPrompts).toHaveBeenCalledWith('ws-1')
    expect(document.body.textContent).toContain('Custom')
    expect(document.body.textContent).toContain('Default')
    expect(textarea('Base prompt (conversations)').value).toBe('HOUSE BASE')
    expect(textarea('Subagent prompt (delegated roles)').value).toBe('DEFAULT CHILD')

    await act(async () => type(textarea('Base prompt (conversations)'), 'NEW BASE'))
    await act(async () => button('Save changes').click())
    await settle()
    expect(vi.mocked(putSystemPrompts)).toHaveBeenCalledWith('ws-1', { base: 'NEW BASE', child: 'DEFAULT CHILD' }, 'h0')
    expect(document.body.textContent).toContain('Saved.')

    // Reset refills the editor with the harness default; saving lands it as a
    // no-override config on the server side (blank means default).
    await act(async () => button('Reset to default').click())
    expect(textarea('Base prompt (conversations)').value).toBe('DEFAULT BASE')
    await act(async () => button('Save changes').click())
    await settle()
    expect(vi.mocked(putSystemPrompts)).toHaveBeenLastCalledWith('ws-1', { base: 'DEFAULT BASE', child: 'DEFAULT CHILD' }, 'h2')
  })
})
