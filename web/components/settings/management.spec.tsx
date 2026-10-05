import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentsPanel, HooksPanel, McpPanel, MemoryPanel, SecretsPanel, SkillsPanel, validateHooksConfig } from './ManagementPanels.tsx'
import { AgentRunsPanel } from '../workbench/AgentRunsPanel.tsx'
import { definitionDocument } from './AgentsPanel.tsx'
import { SettingsModal } from './SettingsModal.tsx'

const providers = [
  { id: 'p1', name: 'local', baseUrl: 'http://localhost:8080/v1', enabled: true, keyMasked: '', models: ['auto'] },
] as const

describe('settings management tabs', () => {
  it('renders every management section as a tab', () => {
    const html = renderToStaticMarkup(
      <SettingsModal open workspaceId="ws-1" providers={providers} activeProvider="p1" onDismiss={() => {}} onRefresh={async () => {}} />,
    )
    for (const label of ['Providers', 'Agents', 'MCP', 'Hooks', 'Secrets']) {
      expect(html).toContain(label)
    }
  })

  it('provider editor still works alongside the tabs', () => {
    const html = renderToStaticMarkup(
      <SettingsModal open workspaceId="ws-1" providers={providers} activeProvider="p1" onDismiss={() => {}} onRefresh={async () => {}} />,
    )
    expect(html).toContain('Base URL')
    expect(html).toContain('Sync from /models')
  })
})

describe('agent panel', () => {
  it('requires a workspace and manages roles without any runtime controls', () => {
    const noWorkspace = renderToStaticMarkup(<AgentsPanel workspaceId={null} />)
    expect(noWorkspace).toContain('Choose a workspace first')

    const html = renderToStaticMarkup(<AgentsPanel workspaceId="ws-1" />)
    expect(html).toContain('Roles')
    expect(html).toContain('Create a role')
    // Spawning belongs to the conversation, not to Settings: the tab points
    // at the workbench instead of rendering controls nothing can act on.
    expect(html).toContain('Subagents view of the workbench')
    expect(html).not.toContain('Spawn')
  })
})

describe('agent runs panel', () => {
  it('explains the missing conversation', () => {
    expect(renderToStaticMarkup(<AgentRunsPanel workspaceId="ws-1" rootSessionId={null} />)).toContain('No conversation selected')
    expect(renderToStaticMarkup(<AgentRunsPanel workspaceId={null} rootSessionId={null} />)).toContain('No conversation selected')
  })

  it('follows runs once a conversation is open, with no delegation form', () => {
    const html = renderToStaticMarkup(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />)
    expect(html).toContain('Active · 0')
    expect(html).toContain('Ended · 0')
    expect(html).not.toContain('Spawn')
  })

  it('a role pins its model as provider:model, and blank means inherit', () => {
    const document = definitionDocument({ name: 'researcher', description: 'digs', tools: 'Read', disallowedTools: '', instructions: 'Dig.', model: 'far:gpt-luna' })
    expect(document).toContain('model: "far:gpt-luna"')
    const inheriting = definitionDocument({ name: 'researcher', description: 'digs', tools: 'Read', disallowedTools: '', instructions: 'Dig.', model: '' })
    expect(inheriting).not.toContain('model:')
  })
})

describe('mcp panel', () => {
  it('states isolation honestly and labels exposure vs permission', () => {
    const html = renderToStaticMarkup(<McpPanel workspaceId="ws-1" />)
    // Collapsed detail must never hide the claim itself: the headline states
    // the privilege level even before the disclosure is opened.
    expect(html).toContain('not an OS sandbox')
    expect(html).toContain('default to ask')
    expect(html).toContain('requiresUserInteraction always requires approval')
    expect(html).toContain('filters exposure; it does not grant permission')
  })

  it('opens on the server list, not on an empty form', () => {
    const html = renderToStaticMarkup(<McpPanel workspaceId="ws-1" />)
    expect(html).toContain('Servers')
    expect(html).toContain('Add server')
    // The nine-field editor is a deliberate action, not the landing state.
    expect(html).not.toContain('Runs the executable directly, not through a shell adapter')
  })

  it('requires a workspace before showing configuration', () => {
    expect(renderToStaticMarkup(<McpPanel workspaceId={null} />)).toContain('Choose a workspace first')
  })
})

describe('hooks + secrets panels', () => {
  it.each([
    [null, 'document must be an object'],
    [{}, 'version must be 1'],
    [{ version: 1 }, 'hooks is required'],
    [{ version: 1, hooks: { PreToolUse: {} } }, 'PreToolUse must be an array'],
    [{ version: 1, hooks: { PreToolUse: [null] } }, 'PreToolUse[0] must be an object'],
    [{ version: 1, hooks: { PreToolUse: [{ matcher: '*', type: 'command', command: '', onFailure: 'deny' }] } }, 'command must be a non-empty string'],
    [{ version: 1, hooks: { PreToolUse: [{ matcher: 1, type: 'command', command: 'node guard.mjs', onFailure: 'deny' }] } }, 'matcher must be a string'],
    [{ version: 1, hooks: { PreToolUse: [{ matcher: '*', type: 'shell', command: 'node guard.mjs', onFailure: 'deny' }] } }, 'type must be "command"'],
    [{ version: 1, hooks: { PreToolUse: [{ matcher: '*', type: 'command', command: 'node guard.mjs', args: [1], onFailure: 'deny' }] } }, 'args must be an array of strings'],
    [{ version: 1, hooks: { PreToolUse: [{ matcher: '*', type: 'command', command: 'node guard.mjs', timeoutMs: 0, onFailure: 'deny' }] } }, 'timeoutMs must be a positive finite number'],
    [{ version: 1, hooks: {}, extra: true }, 'unknown top-level key "extra"'],
    [{ version: 1, hooks: { PreToolUse: [{ matcher: '*', type: 'command', command: 'node guard.mjs', onFailure: 'deny', extra: true }] } }, 'PreToolUse[0] has unknown key "extra"'],
    [{ version: 1, hooks: { PreToolUse: [{ matcher: '*', type: 'command', command: 'node guard.mjs', onFailure: 'ignore' }] } }, 'onFailure must be "deny" or "allow"'],
  ] as const)('rejects malformed hooks documents without casting them: %#', (input, message) => {
    expect(() => validateHooksConfig(input)).toThrow(message)
  })

  it('accepts a complete hooks document with partial known event arrays', () => {
    expect(validateHooksConfig({ version: 1, hooks: { PreToolUse: [{ matcher: 'Bash*', type: 'command', command: 'node guard.mjs', args: ['--strict'], timeoutMs: 500, onFailure: 'deny' }] } })).toEqual({
      version: 1,
      hooks: { PreToolUse: [{ matcher: 'Bash*', type: 'command', command: 'node guard.mjs', args: ['--strict'], timeoutMs: 500, onFailure: 'deny' }] },
    })
  })

  it('shows the honest loading state before the config arrives', () => {
    // SSR renders no effects: the form-first editor reports loading, and the
    // per-event sections appear once the document is fetched (mounted test
    // lives with the api mocks).
    const html = renderToStaticMarkup(<HooksPanel workspaceId="ws-1" />)
    expect(html).toContain('Loading hooks')
  })

  it('never renders a secret value, only masked names', () => {
    const html = renderToStaticMarkup(<SecretsPanel workspaceId="ws-1" />)
    expect(html).toContain('encrypted at rest with AES-256-GCM')
    // With no stored keys the panel states the masking contract explicitly.
    expect(html).toContain('Only key names are displayed')
    expect(html).not.toContain('sk-')
  })
})

describe('skills + memory tabs', () => {
  it('renders the new tabs in the grouped nav and honest empty states', () => {
    const html = renderToStaticMarkup(
      <SettingsModal open workspaceId="ws-1" providers={providers} activeProvider="p1" onDismiss={() => {}} onRefresh={async () => {}} />,
    )
    for (const label of ['Global', 'Workspace', 'Skills', 'Memory']) {
      expect(html).toContain(label)
    }
  })
  it('requires a workspace before showing skills or memory', () => {
    expect(renderToStaticMarkup(<SkillsPanel workspaceId={null} />)).toContain('Choose a workspace first')
    expect(renderToStaticMarkup(<MemoryPanel workspaceId={null} />)).toContain('Choose a workspace first')
  })
  it('memory starts empty with search and a create entry point', () => {
    const html = renderToStaticMarkup(<MemoryPanel workspaceId="ws-1" />)
    expect(html).toContain('Search memory')
    expect(html).toContain('New entry')
    expect(html).toContain('No memory entries yet')
  })
  it('skills list offers a create form with layer guidance', () => {
    const html = renderToStaticMarkup(<SkillsPanel workspaceId="ws-1" />)
    expect(html).toContain('New skill')
    expect(html).toContain('Source folders')
    expect(html).toContain('first match wins')
  })
})
