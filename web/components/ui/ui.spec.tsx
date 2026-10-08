import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Icon, { ICON_NAMES } from '../common/Icon.tsx'
import { SHOW_SLOTS } from '../../lib/config.ts'
import { activeModelValue, decodeModelChoice, encodeModelChoice, modelOptions } from '../../lib/providers.ts'
import { SettingsModal } from '../settings/SettingsModal.tsx'
import { Button } from './Button.tsx'
import { IconButton } from './IconButton.tsx'
import { Kbd } from './Kbd.tsx'
import { Badge } from './Badge.tsx'
import { CodeChip } from './CodeChip.tsx'
import { Panel } from './Panel.tsx'
import { TextInput } from './TextInput.tsx'
import { Select } from './Select.tsx'
import { Modal } from './Modal.tsx'
import { Field } from './Field.tsx'
import { Switch } from './Switch.tsx'
import { ToolCard } from '../chat/MessageParts.tsx'
import { ApprovalBar } from '../chat/ApprovalBar.tsx'

describe('icon set', () => {
  it('covers the shell vocabulary', () => {
    for (const name of [
      'plus', 'close', 'chevron', 'chevronRight', 'copy', 'check', 'trash', 'pencil', 'search', 'arrowDown', 'arrowUp',
      'folder', 'messageSquare', 'panelRight', 'panelLeft', 'alertTriangle', 'sliders', 'square', 'squarePen',
      'sun', 'moon', 'monitor', 'lightbulb', 'layers', 'shield', 'bell',
    ]) {
      expect(ICON_NAMES, name).toContain(name)
    }
  })

  it('renders an svg with stroke styling and merges extra classes', () => {
    const html = renderToStaticMarkup(<Icon name="folder" size={14} className="text-ok" />)
    expect(html).toContain('<svg')
    expect(html).toContain('stroke-width="1.8"')
    expect(html).toContain('class="icon text-ok"')
  })
})

describe('feature flag', () => {
  it('ships with future-view slots hidden', () => {
    expect(SHOW_SLOTS).toBe(false)
  })
})

describe('runtime provider UI helpers', () => {
  const meta = {
    provider: 'cliproxy1',
    model: 'gpt-5.6-sol',
    folder: '/workspace',
    models: ['gpt-5.6-sol'],
    providers: [
      { id: 'cliproxy1', name: 'cliproxy1', baseUrl: 'http://proxy/v1', enabled: true, keyMasked: '••••1234', models: ['gpt-5.6-sol', 'gpt-5.6-terra'] },
      { id: 'disabled', name: 'disabled', baseUrl: 'http://off/v1', enabled: false, keyMasked: '••••9999', models: ['nope'] },
    ],
  } as const

  it('encodes a model choice without ambiguity and excludes disabled providers', () => {
    expect(encodeModelChoice('cliproxy1', 'gpt-5.6-sol')).toBe('cliproxy1:gpt-5.6-sol')
    expect(decodeModelChoice('cliproxy1:gpt-5.6-sol')).toEqual({ provider: 'cliproxy1', model: 'gpt-5.6-sol' })
    expect(decodeModelChoice('not-a-choice')).toBeNull()
    expect(modelOptions(meta).map((option) => option.value)).toEqual(['cliproxy1:gpt-5.6-sol', 'cliproxy1:gpt-5.6-terra'])
    expect(activeModelValue(meta)).toBe('cliproxy1:gpt-5.6-sol')
  })

  it('settings dialog exposes all eleven sections as linked tabs and lists providers', () => {
    const html = renderToStaticMarkup(
      <SettingsModal open workspaceId="ws-1" providers={meta.providers} activeProvider="cliproxy1" activeModel="gpt-5.6-sol" onDismiss={() => undefined} onRefresh={async () => undefined} />,
    )
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Settings"')
    expect((html.match(/role="tab"/g) ?? []).length).toBe(11)
    // Radix mounts the active panel only; each tab still owns a controls link.
    expect((html.match(/role="tabpanel"/g) ?? []).length).toBe(1)
    expect((html.match(/aria-controls=/g) ?? []).length).toBeGreaterThanOrEqual(11)
    const tabTags = html.match(/<[a-z]+[^>]*role="tab"[^>]*>/g) ?? []
    expect(tabTags.filter((tag) => tag.includes('aria-selected="true"')).length).toBe(1)
    const labels = [...html.matchAll(/<button(?=[^>]*role="tab")[\s\S]*?<\/button>/g)]
      .map((match) => match[0].replace(/<[^>]+>/g, ''))
    expect(labels).toEqual(['Providers', 'Usage', 'Projects', 'Permissions', 'System Prompts', 'Skills', 'Memory', 'Agents', 'MCP', 'Hooks', 'Secrets'])
    expect(html).toContain('cliproxy1')
    // The model count belongs to the list it counts, not to the rail row too.
    expect(html).toContain('Model list')
    expect(html).toContain('Test connection')
  })

  it('settings dialog never renders a raw key field value', () => {
    const html = renderToStaticMarkup(
      <SettingsModal open workspaceId="ws-1" providers={meta.providers} activeProvider="cliproxy1" onDismiss={() => undefined} onRefresh={async () => undefined} />,
    )
    expect(html).toContain('type="password"')
    expect(html).not.toMatch(/value="sk-/)
  })
})

describe('primitives', () => {
  it('Button defaults to a non-submitting button and disables visibly', () => {
    const html = renderToStaticMarkup(<Button variant="primary" disabled>go</Button>)
    expect(html).toContain('type="button"')
    expect(html).toContain('disabled')
    expect(html).toContain('bg-primary')
  })

  it('IconButton carries an accessible name', () => {
    const html = renderToStaticMarkup(<IconButton label="Close" onClick={() => undefined}><span>x</span></IconButton>)
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('title="Close"')
  })

  it('Badge tones, Kbd, CodeChip, Panel render their content', () => {
    const html = renderToStaticMarkup(
      <>
        <Badge tone="amber">pending</Badge>
        <Kbd>Ctrl+N</Kbd>
        <CodeChip title="web/App.tsx">web/App.tsx</CodeChip>
        <Panel variant="raised">body</Panel>
      </>,
    )
    expect(html).toContain('text-warn')
    expect(html).toContain('<kbd')
    expect(html).toContain('<code')
    expect(html).toContain('body')
  })

  it('Modal renders nothing while closed and carries dialog semantics when open', () => {
    expect(renderToStaticMarkup(<Modal open={false} onDismiss={() => undefined} label="x"><p>body</p></Modal>)).toBe('')
    const html = renderToStaticMarkup(<Modal open onDismiss={() => undefined} label="Settings" width="md" header={<strong>Head</strong>}><p>body</p></Modal>)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Settings"')
    expect(html).toContain('<header')
    expect(html).toContain('Head')
  })

  it('Field links label and hint to its control, tone-aware', () => {
    const html = renderToStaticMarkup(
      <Field label="Base URL" tone="bad" hint="Enter an HTTP or HTTPS URL."><TextInput value="ftp://x" readOnly invalid /></Field>,
    )
    const id = /<label[^>]*for="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeDefined()
    expect(html).toContain(`id="${id}"`)
    expect(html).toContain(`aria-describedby="${id}-hint"`)
    expect(html).toContain('text-bad')
    expect(html).toContain('aria-invalid="true"')
  })

  it('Field links its hint to a custom Select trigger', () => {
    const html = renderToStaticMarkup(
      <Field label="Vision" hint="Choose a capability override.">
        <Select value="auto" options={[{ value: 'auto', label: 'Auto' }]} onChange={() => undefined} label="Vision capability" />
      </Field>,
    )
    const id = /<label[^>]*for="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeDefined()
    expect(html).toContain(`<button type="button" id="${id}"`)
    expect(html).toContain(`aria-describedby="${id}-hint"`)
  })

  it('Switch exposes switch semantics with its label and hint', () => {
    const html = renderToStaticMarkup(<Switch checked label="Enabled" hint="Hidden from the picker when off." onChange={() => undefined} />)
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('Hidden from the picker when off.')
  })

  it('TextInput renders leading content and a monospace variant', () => {
    const html = renderToStaticMarkup(<TextInput mono leading={<b>i</b>} placeholder="Search…" readOnly />)
    expect(html).toContain('<b>i</b>')
    expect(html).toContain('font-mono')
    expect(html).toContain('placeholder="Search…"')
  })

  it('Select closed renders a listbox trigger, merges trigger classes and honors a custom trigger', () => {
    const closed = renderToStaticMarkup(<Select value="deepseek-chat" options={[{ value: 'deepseek-chat', label: 'deepseek-chat' }, { value: 'other', label: 'other' }]} onChange={() => undefined} label="Model" triggerClassName="extra-trigger" />)
    expect(closed).toContain('aria-haspopup="listbox"')
    expect(closed).not.toContain('role="listbox"')
    expect(closed).toContain('extra-trigger')
    const custom = renderToStaticMarkup(<Select value="m" options={[{ value: 'm', label: 'm' }]} onChange={() => undefined} renderTrigger={() => <button type="button">custom-trigger</button>} />)
    expect(custom).toContain('custom-trigger')
  })
})

describe('chat surfaces', () => {
  it('ToolCard shows the tool, its target and running state while pending', () => {
    const pending = renderToStaticMarkup(<ToolCard item={{ kind: 'tool', call: { id: 't1', name: 'read', args: { path: 'src/x.ts', limit: 5 } } }} />)
    // While pending the kind says so in its -ing form, shimmering; there is no spinner.
    expect(pending).toContain('Reading')
    expect(pending).toContain('text-shimmer')
    expect(pending).not.toContain('animate-spin-slow')
    expect(pending).toContain('x.ts')
    // The file keeps its own type icon in every state.
    expect(pending).toContain('/material-icons/typescript.svg')
    const settled = renderToStaticMarkup(<ToolCard item={{ kind: 'tool', call: { id: 't1', name: 'read', args: { path: 'src/x.ts', limit: 5 } }, result: { ok: true, output: 'x' } }} />)
    expect(settled).toContain('>Read<')
    expect(settled).not.toContain('text-shimmer')
  })

  it('ApprovalBar shows one card per pending call', () => {
    const html = renderToStaticMarkup(<ApprovalBar approvals={[{ approvalId: 'a1', call: { id: 't', name: 'edit', args: { path: 'web/App.tsx' } } }]} onAnswer={async () => undefined} />)
    expect(html).toContain('web/App.tsx')
    expect(html).toContain('Exact arguments')
    expect(html).toContain('Allow once')
    expect(html).toContain('Deny')
  })
})
