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
    expect(html).toContain('aria-label="New role"')
    expect(html).toContain('aria-label="Search roles"')
    // Spawning belongs to the conversation, not to Settings.
    expect(html).not.toContain('Spawn')
  })
})

describe('agent runs panel', () => {
  it('explains the missing conversation', () => {
    expect(renderToStaticMarkup(<AgentRunsPanel workspaceId="ws-1" rootSessionId={null} />)).toContain('No conversation selected')
    expect(renderToStaticMarkup(<AgentRunsPanel workspaceId={null} rootSessionId={null} />)).toContain('No conversation selected')
  })

  it('offers manual delegation and follows runs once a conversation is open', () => {
    const html = renderToStaticMarkup(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />)
    expect(html).toContain('Spawn subagent')
    expect(html).toContain('Subagent role')
    expect(html).toContain('Subagent brief')
    expect(html).toContain('Active · 0')
    expect(html).toContain('Ended · 0')
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
    [{ hooks: [] }, '"hooks" must be an object'],
    [{ hooks: { PreToolUse: {} } }, 'PreToolUse must be an array'],
    [{ hooks: { PreToolUse: [null] } }, 'PreToolUse[0] must be an object'],
    [{ hooks: { PreToolUse: [{ matcher: 1, hooks: [] }] } }, 'matcher must be a string'],
    [{ hooks: { PreToolUse: [{ matcher: 'Bash' }] } }, 'PreToolUse[0].hooks must be an array'],
    [{ hooks: { PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] } }, 'type must be "command"'],
    [{ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout: 0 }] }] } }, 'timeout must be a positive number of seconds'],
    [{ hooks: { Nope: [] } }, 'unknown hook event "Nope"'],
  ] as const)('rejects malformed Claude hooks sections without casting them: %#', (input, message) => {
    expect(() => validateHooksConfig(input)).toThrow(message)
  })

  it('keeps Claude events dnt-harness does not fire instead of rejecting the file', () => {
    expect(validateHooksConfig({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }] } }).hooks.PermissionRequest).toHaveLength(1)
  })

  it('accepts a Claude Code hooks section', () => {
    expect(validateHooksConfig({ hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/guard.sh', timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } })).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/guard.sh', timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
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
    expect(html).toContain('New memory entry')
    expect(html).toContain('No memory entries yet')
    expect(html).toContain('Select an entry to preview it, or create a new one.')
    // With no projects there is only the workspace tier, so no scope filter.
    expect(html).not.toContain('Filter by scope')
  })
  it('memory offers a scope filter once the workspace has projects', () => {
    const projects = [{ id: 'project-1', name: 'dnt-harness', path: '/work/dnt-harness', order: 0 }] as never
    const html = renderToStaticMarkup(<MemoryPanel workspaceId="ws-1" projects={projects} />)
    expect(html).toContain('Filter by scope')
    expect(html).toContain('All (0)')
  })
  it('skills list offers a create form with layer guidance', () => {
    const html = renderToStaticMarkup(<SkillsPanel workspaceId="ws-1" />)
    expect(html).toContain('New skill')
    expect(html).toContain('Source folders')
    expect(html).toContain('first match wins')
  })
})
