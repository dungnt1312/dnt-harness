import * as RadixSelect from '@radix-ui/react-select'
import * as Tabs from '@radix-ui/react-tabs'
import { ProjectsPanel } from './ProjectsPanel.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon, { type IconName } from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Modal } from '../ui/Modal.tsx'
import { Select } from '../ui/Select.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import {
  createProvider,
  deleteProvider,
  fetchProviderModels,
  testProvider,
  updateProvider,
} from '../../lib/api.ts'
import {
  THINKING_LABELS,
  modelContext,
  modelVision,
} from '../../lib/model-info.ts'
import { ModelSettingsDialog, SyncModelsDialog } from './model-dialogs.tsx'
import { AgentsPanel, HooksPanel, McpPanel, MemoryPanel, SecretsPanel, SkillsPanel } from './ManagementPanels.tsx'
import { PermissionsPanel, type PermissionsSubTab } from './PermissionsPanel.tsx'
import { UnsavedChangesContext, type UnsavedChangesApi } from './unsaved-changes.tsx'
import { SubTabs } from './settings-kit.tsx'
import { SystemPromptsPanel } from './SystemPromptsPanel.tsx'
import { UsagePanel } from './UsagePanel.tsx'
import { ModelAliasesPanel } from './ModelAliasesPanel.tsx'
import { ImagesPanel } from './ImagesPanel.tsx'
import { modelOptions } from '../../lib/providers.ts'
import type { ModelSettings, ProjectRow, ProviderSummary } from '../../lib/types.ts'

/** Settings are grouped per concern; providers keep their own full editor. */
type SettingsTab = 'providers' | 'usage' | 'projects' | 'permissions' | 'prompts' | 'skills' | 'memory' | 'agents' | 'mcp' | 'hooks' | 'secrets'

const LEGACY_TAB_REDIRECT: Readonly<Record<string, SettingsTab>> = {
  modes: 'permissions',
  'dangerous-commands': 'permissions',
  // Model aliases and image generation are sub-tabs of Providers & Models.
  'model-aliases': 'providers',
  'image-generation': 'providers',
  'image-understanding': 'providers',
}

/** Sub-tabs of Providers & Models: everything that picks an endpoint or a model. */
type ModelsSubTab = 'providers' | 'model-aliases' | 'images'
type LegacyModelsSubTab = 'image-generation' | 'image-understanding'

const MODELS_SUB_TABS: readonly { readonly value: ModelsSubTab; readonly label: string; readonly hint: string; readonly icon: IconName }[] = [
  { value: 'providers', label: 'Providers', hint: 'Model endpoints and keys', icon: 'globe' },
  { value: 'model-aliases', label: 'Model aliases', hint: 'Global subagent model mappings', icon: 'gitBranch' },
  { value: 'images', label: 'Images', hint: 'Models for image generation and understanding', icon: 'fileImage' },
]

/** Legacy tab ids that named a Providers & Models sub-pane directly. */
function modelsSubOf(raw: string | undefined): ModelsSubTab | undefined {
  if (raw === 'image-generation' || raw === 'image-understanding') return 'images'
  return raw === 'model-aliases' || raw === 'images' ? raw : undefined
}

/** Legacy links that named a Permissions sub-pane directly. */
function permissionsSubOf(raw: string | undefined): PermissionsSubTab | undefined {
  return raw === 'dangerous-commands' ? 'guard' : undefined
}

function normalizeTab(raw: string | undefined): SettingsTab | undefined {
  if (raw === undefined) return undefined
  if (raw in LEGACY_TAB_REDIRECT) return LEGACY_TAB_REDIRECT[raw]
  return raw as SettingsTab
}

/** The tab Settings last showed, so reopening without a deep link lands there again. */
export const SETTINGS_TAB_STORAGE_KEY = 'dnt-harness.settings-tab.v1'

function readStoredTab(): SettingsTab | undefined {
  try {
    const raw = normalizeTab(window.localStorage.getItem(SETTINGS_TAB_STORAGE_KEY) ?? undefined)
    return TABS.some((entry) => entry.id === raw) ? raw : undefined
  } catch {
    return undefined // Storage may be unavailable; fall back to the default tab.
  }
}

function storeTab(tab: SettingsTab): void {
  try { window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tab) } catch { /* best-effort */ }
}

const TABS: readonly { readonly id: SettingsTab; readonly label: string; readonly hint: string; readonly icon: IconName }[] = [
  { id: 'providers', label: 'Providers & Models', hint: 'Model endpoints, aliases, and image generation', icon: 'globe' },
  { id: 'usage', label: 'Usage', hint: 'Token usage across every workspace', icon: 'layers' },
  { id: 'projects', label: 'Projects', hint: 'Folders conversations in this workspace can work in', icon: 'folder' },
  { id: 'permissions', label: 'Permissions', hint: 'Modes & dangerous command guard', icon: 'shield' },
  { id: 'prompts', label: 'System Prompts', hint: 'Replace the fixed base & subagent prompts for this workspace', icon: 'fileText' },
  { id: 'skills', label: 'Skills', hint: 'SKILL.md instruction packages', icon: 'zap' },
  { id: 'memory', label: 'Memory', hint: 'Notes the model recalls in this workspace', icon: 'lightbulb' },
  { id: 'agents', label: 'Agents', hint: 'Roles a conversation can delegate to', icon: 'gitBranch' },
  { id: 'mcp', label: 'MCP', hint: 'Tool servers over stdio or HTTP', icon: 'terminal' },
  { id: 'hooks', label: 'Hooks', hint: 'Commands that run around tool calls and sessions', icon: 'wrench' },
  { id: 'secrets', label: 'Secrets', hint: 'Encrypted credentials for MCP servers', icon: 'key' },
]

/** Nav groups: global settings first, then the active workspace's. */
const TAB_GROUPS: readonly { readonly label: string; readonly ids: readonly SettingsTab[] }[] = [
  { label: 'Global', ids: ['providers', 'usage'] },
  { label: 'Workspace', ids: ['projects', 'permissions', 'prompts', 'skills', 'memory', 'agents', 'mcp', 'hooks', 'secrets'] },
]

interface Draft {
  readonly name: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly enabled: boolean
  readonly models: readonly string[]
  /** Working copy of the per-model overrides (context window, vision, thinking). */
  readonly modelSettings: Record<string, ModelSettings>
}

type Busy = 'save' | 'sync' | 'test' | 'delete' | null

const BLANK: Draft = { name: '', baseUrl: '', apiKey: '', enabled: true, models: [], modelSettings: {} }

function draftOf(provider: ProviderSummary): Draft {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: '',
    enabled: provider.enabled,
    models: provider.models,
    modelSettings: Object.fromEntries(Object.entries(provider.modelSettings ?? {}).map(([model, settings]) => [model, { ...settings }])),
  }
}

/** Entries only for models still on the list, and only fields actually set. */
function pruneSettings(models: readonly string[], settings: Record<string, ModelSettings>): Record<string, ModelSettings> {
  const pruned: Record<string, ModelSettings> = {}
  for (const model of models) {
    const entry = settings[model]
    if (entry === undefined) continue
    const clean: ModelSettings = {
      ...(entry.contextTokens !== undefined && entry.contextTokens > 0 ? { contextTokens: entry.contextTokens } : {}),
      ...(entry.vision !== undefined ? { vision: entry.vision } : {}),
      ...(entry.thinkingLevel !== undefined && entry.thinkingLevel in THINKING_LABELS ? { thinkingLevel: entry.thinkingLevel } : {}),
    }
    if (Object.keys(clean).length > 0) pruned[model] = clean
  }
  return pruned
}

/** Accept a pasted list too: one per line, comma, or whitespace separated. */
function parseModels(raw: string): readonly string[] {
  return [...new Set(raw.split(/[\n,\s]+/).map((name) => name.trim()).filter((name) => name !== ''))]
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Provider settings: left rail selects, right pane edits one OpenAI-completions
 * endpoint. The key field starts blank on an existing provider so submitting it
 * untouched retains the stored secret — only `keyMasked` ever reaches this
 * component, never the raw key.
 */
export function SettingsModal({
  open,
  providers,
  activeProvider,
  activeModel,
  onDismiss,
  onRefresh,
  workspaceId,
  initialTab, workspaceName, projects = [], onProjectsChanged = async () => {}, onSkillsChanged = () => {}, sessionCounts = {},
  activeProjectId = null,
}: {
  /** Deep link; when absent Settings reopens on the tab it last showed. */
  readonly initialTab?: SettingsTab | 'modes' | 'dangerous-commands' | ModelsSubTab | LegacyModelsSubTab | undefined
  /** The open conversation's project: its `.claude/` layers show in Agents and Hooks. */
  readonly activeProjectId?: string | null
  readonly workspaceName?: string | undefined
  readonly projects?: readonly ProjectRow[]
  readonly onProjectsChanged?: () => Promise<void>
  readonly onSkillsChanged?: () => void
  readonly sessionCounts?: Readonly<Record<string, number>>
  readonly open: boolean
  readonly workspaceId: string | null
  readonly providers: readonly ProviderSummary[]
  readonly activeProvider: string
  readonly activeModel?: string
  readonly onDismiss: () => void
  readonly onRefresh: () => Promise<void>
}) {
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  /** Dirty flags reported by the workspace panels (see unsaved-changes.tsx). */
  const panelDirty = useRef(new Map<string, boolean>())
  const panelsDirty = (): boolean => [...panelDirty.current.values()].some(Boolean)
  const unsavedApi = useMemo<UnsavedChangesApi>(() => ({
    report: (key, isDirty) => {
      if (isDirty) panelDirty.current.set(key, true)
      else panelDirty.current.delete(key)
    },
    confirmDiscard: (action) => setPendingLeave(() => action),
  }), [])
  const [tab, setTabState] = useState<SettingsTab>('providers')
  const setTab = (next: SettingsTab): void => {
    setTabState(next)
    storeTab(next)
  }
  const [modelsSub, setModelsSub] = useState<ModelsSubTab>('providers')
  /** The provider editor (with its own footer) is showing. */
  const providerEditor = tab === 'providers' && modelsSub === 'providers'
  // Roles pin a model from the same enabled provider/model list the composer
  // offers, so a role can never name an endpoint the host cannot serve.
  const roleModelOptions = useMemo(
    () => modelOptions({ provider: null, model: null, providers, models: [] }),
    [providers],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState<{ readonly kind: 'ok' | 'bad'; readonly text: string } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [modelDraft, setModelDraft] = useState('')
  /** Whether the "add model" input is revealed; the button stands in for it. */
  const [addingModel, setAddingModel] = useState(false)
  /** The model whose settings dialog is open. */
  const [editingModel, setEditingModel] = useState<string | null>(null)
  /** What the endpoint offered, awaiting the operator's selection. */
  const [syncOffer, setSyncOffer] = useState<readonly string[] | null>(null)
  /** Model row being dragged, and the row it currently hovers. */
  const [dragModel, setDragModel] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  /**
   * Per-model connection verdict, shown on the row it belongs to. Keyed by
   * model so testing one row never rewrites another's result, and cleared
   * whenever the draft changes because a verdict describes the saved
   * configuration rather than edits still in flight.
   */
  const [modelTests, setModelTests] = useState<Record<string, { readonly status: 'testing' | 'ok' | 'bad'; readonly error?: string }>>({})
  const nameRef = useRef<HTMLInputElement | null>(null)
  const modelDraftRef = useRef<HTMLInputElement | null>(null)
  const nameFieldId = useId()

  const selected = useMemo(
    () => providers.find((provider) => provider.id === selectedId),
    [providers, selectedId],
  )
  const isNew = selectedId === null

  /** Whether this open has picked a provider to show; false while the list is still empty. */
  const seeded = useRef(false)
  useEffect(() => {
    if (!open) return
    const first = providers.find((provider) => provider.id === activeProvider) ?? providers[0]
    seeded.current = first !== undefined
    setTab(normalizeTab(initialTab) ?? readStoredTab() ?? 'providers')
    setModelsSub(modelsSubOf(initialTab) ?? 'providers')
    setSelectedId(first?.id ?? null)
    setDraft(first === undefined ? BLANK : draftOf(first))
    setNotice(null)
    setShowKey(false)
    setConfirmDelete(false)
    setModelDraft('')
    setAddingModel(false)
    setEditingModel(null)
    setSyncOffer(null)
  }, [open]) // Seed once per open so a background refresh never discards edits.

  // Settings opened before providers loaded: show the real provider once the
  // list arrives, unless the user already started typing a new one.
  useEffect(() => {
    if (!open || seeded.current || providers.length === 0) return
    seeded.current = true
    if (selectedId !== null || JSON.stringify(draft) !== JSON.stringify(BLANK) || modelDraft !== '') return
    const first = providers.find((provider) => provider.id === activeProvider) ?? providers[0]
    if (first === undefined) return
    setSelectedId(first.id)
    setDraft(draftOf(first))
  }, [providers])

  // Opening Settings at another tab while it is already open still switches.
  useEffect(() => {
    const next = normalizeTab(initialTab)
    if (open && next !== undefined) {
      setTab(next)
      const sub = modelsSubOf(initialTab)
      if (sub !== undefined) setModelsSub(sub)
    }
  }, [initialTab])

  const dirty = useMemo(() => {
    if (selected === undefined) return JSON.stringify(draft) !== JSON.stringify(BLANK)
    const base = draftOf(selected)
    return (
      draft.name !== base.name ||
      draft.baseUrl !== base.baseUrl ||
      draft.apiKey !== '' ||
      draft.enabled !== base.enabled ||
      !sameList(draft.models, base.models) ||
      JSON.stringify(pruneSettings(draft.models, draft.modelSettings)) !== JSON.stringify(pruneSettings(base.models, base.modelSettings))
    )
  }, [draft, selected])

  /**
   * Leaving a tab or the dialog unmounts the panel, so ANY unsaved draft —
   * provider or workspace panel — must be confirmed first, not just ours.
   */
  const leave = (action: () => void) => {
    if (busy !== null) return
    if (dirty || modelDraft.trim() !== '' || panelsDirty()) setPendingLeave(() => action)
    else action()
  }
  const dismiss = () => leave(onDismiss)
  const discardDraft = (): void => {
    setDraft(selected === undefined ? BLANK : draftOf(selected))
    setModelDraft('')
    setAddingModel(false)
    setNotice(null)
    setModelTests({})
  }
  if (!open) return null

  const patch = (next: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...next }))
    setNotice(null)
    // A verdict describes the configuration that was on disk when it ran, so
    // any edit invalidates every row rather than leaving a stale "OK" behind.
    setModelTests({})
  }

  const select = (provider: ProviderSummary): void => {
    setSelectedId(provider.id)
    setDraft(draftOf(provider))
    setNotice(null)
    setShowKey(false)
    setConfirmDelete(false)
    setModelDraft('')
    setAddingModel(false)
    setEditingModel(null)
    setSyncOffer(null)
    setModelTests({})
  }

  const beginNew = (): void => {
    setSelectedId(null)
    setDraft(BLANK)
    setNotice(null)
    setShowKey(false)
    setConfirmDelete(false)
    setModelDraft('')
    setAddingModel(false)
    setEditingModel(null)
    setSyncOffer(null)
    setModelTests({})
    nameRef.current?.focus()
  }

  const urlLooksWrong = draft.baseUrl !== '' && !/^https?:\/\//.test(draft.baseUrl.trim())

  const run = async (kind: Busy, action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await action()
    } catch (cause) {
      setNotice({ kind: 'bad', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(null)
    }
  }

  const save = (): Promise<void> =>
    run('save', async () => {
      const name = draft.name.trim()
      const baseUrl = draft.baseUrl.trim()
      if (name === '' || baseUrl === '') {
        setNotice({ kind: 'bad', text: 'Name and Base URL are required.' })
        return
      }
      if (urlLooksWrong) {
        setNotice({ kind: 'bad', text: 'Base URL must start with http:// or https://' })
        return
      }
      const shared = {
        name,
        baseUrl,
        enabled: draft.enabled,
        models: draft.models,
        // Always sent (even empty): the patch REPLACES the whole map, so an
        // empty object is how cleared overrides reach the server.
        modelSettings: pruneSettings(draft.models, draft.modelSettings),
      }
      const saved = isNew
        ? await createProvider({ ...shared, apiKey: draft.apiKey.trim() })
        : await updateProvider(selectedId, {
            ...shared,
            ...(draft.apiKey.trim() !== '' ? { apiKey: draft.apiKey.trim() } : {}),
          })
      await onRefresh()
      setSelectedId(saved.id)
      setDraft(draftOf(saved))
      setShowKey(false)
      setNotice({ kind: 'ok', text: `Saved “${saved.name}”.` })
    })

  /**
   * Ask the endpoint what it offers and let the operator choose. The probe
   * writes nothing, so a list nobody confirmed can never replace the stored
   * models — the selection lands in the draft and saves with everything else.
   */
  const sync = (): Promise<void> =>
    run('sync', async () => {
      if (selectedId === null) return
      const result = await fetchProviderModels(selectedId)
      if (result.models.length === 0) {
        setNotice({ kind: 'bad', text: 'The endpoint returned no models. Add model IDs instead.' })
        return
      }
      setSyncOffer(result.models)
    })

  /** Apply the sync selection to the draft. */
  const applySync = (models: readonly string[]): void => {
    setSyncOffer(null)
    patch({ models })
  }

  /** Commit one model's dialog: an id change moves its overrides with it. */
  const applyModelSettings = (previous: string, id: string, settings: ModelSettings): void => {
    const models = draft.models.map((model) => (model === previous ? id : model))
    const modelSettings = { ...draft.modelSettings }
    delete modelSettings[previous]
    if (Object.keys(settings).length > 0) modelSettings[id] = settings
    setEditingModel(null)
    patch({ models, modelSettings })
  }

  const test = (): Promise<void> =>
    run('test', async () => {
      if (selectedId === null) return
      const result = await testProvider(selectedId)
      setNotice(result.ok
        ? { kind: 'ok', text: 'Connection verified. The endpoint returned a completion.' }
        : { kind: 'bad', text: result.error ?? 'Connection failed.' })
    })

  const remove = (): Promise<void> =>
    run('delete', async () => {
      if (selectedId === null) return
      await deleteProvider(selectedId)
      await onRefresh()
      setConfirmDelete(false)
      const remaining = providers.filter((provider) => provider.id !== selectedId)
      const next = remaining[0]
      if (next === undefined) beginNew()
      else select(next)
      setNotice({ kind: 'ok', text: 'Provider deleted.' })
    })

  /**
   * Why one model cannot be tested yet, or null when it can. A ping uses the
   * SAVED provider entry, so unsaved edits — a new id, a changed key or URL —
   * are not what would run; the operator must save them first.
   */
  const modelTestBlocker = (model: string): string | null =>
    selected === undefined ? 'Add the provider first.'
      : !selected.enabled ? 'Enable and save this provider first.'
        : !selected.models.includes(model) ? 'Save this model to the provider first.'
          : dirty ? 'Save or discard your changes first.'
            : busy !== null ? 'Another action is running.'
              : null

  const testModel = async (model: string): Promise<void> => {
    if (selectedId === null || modelTestBlocker(model) !== null) return
    setBusy('test')
    setModelTests((all) => ({ ...all, [model]: { status: 'testing' } }))
    // The verdict belongs to the row, so a refusal is caught here rather than
    // escaping to the panel-level notice: a failed ping would otherwise read
    // as the whole provider being broken and leave this row spinning forever.
    try {
      const result = await testProvider(selectedId, model)
      setModelTests((all) => ({
        ...all,
        [model]: result.ok ? { status: 'ok' } : { status: 'bad', error: result.error ?? 'Connection failed.' },
      }))
    } catch (cause) {
      setModelTests((all) => ({
        ...all,
        [model]: { status: 'bad', error: cause instanceof Error ? cause.message : String(cause) },
      }))
    } finally {
      setBusy(null)
    }
  }

  const addModels = (): void => {
    const parsed = parseModels(modelDraft)
    if (parsed.length === 0) return
    const merged = [...new Set([...draft.models, ...parsed])]
    patch({ models: merged })
    setModelDraft('')
  }

  /**
   * Reorder the list in place. The saved order is what the composer picker
   * shows, so this is the operator's way to put favourite models on top.
   */
  const moveModel = (name: string, target: number): void => {
    const from = draft.models.indexOf(name)
    if (from < 0) return
    const to = Math.max(0, Math.min(draft.models.length - 1, target))
    if (from === to) return
    const models = [...draft.models]
    models.splice(from, 1)
    models.splice(to, 0, name)
    patch({ models })
  }

  const dropModel = (name: string): void => {
    const models = draft.models.filter((model) => model !== name)
    const { [name]: _dropped, ...modelSettings } = draft.modelSettings
    void _dropped
    if (editingModel === name) setEditingModel(null)
    patch({ models, modelSettings })
  }

  const activeTab = TABS.find((entry) => entry.id === tab)
  const activeHint = tab === 'providers' ? MODELS_SUB_TABS.find((entry) => entry.value === modelsSub)?.hint : activeTab?.hint
  const tabTrigger = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-link disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-hover data-[state=active]:font-medium data-[state=active]:text-fg'
  const testBlocker = isNew ? 'Add the provider first.' : dirty ? 'Save your changes first — the test uses the saved configuration.' : null

  return (
    <><Modal open={open} onDismiss={dismiss} label="Settings" width="xl" bodyClassName="flex p-0 overflow-hidden">
      <Tabs.Root className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row" value={tab} orientation="vertical" onValueChange={(value) => leave(() => setTab(value as SettingsTab))}>
        <aside className="flex shrink-0 flex-col border-line bg-sidebar max-sm:border-b sm:w-56 sm:border-r">
          <div className="hidden h-14 items-center px-5 sm:flex"><span className="text-[15px] font-semibold">Settings</span></div>
          <div className="px-4 py-3 sm:hidden">
            <span className="sr-only">Settings section</span>
            <RadixSelect.Root value={tab} onValueChange={(value) => leave(() => setTab(value as SettingsTab))}>
              <RadixSelect.Trigger className="flex h-10 w-full items-center justify-between rounded-lg border border-line bg-bg px-3 text-sm" aria-label="Settings section">
                <RadixSelect.Value />
                <RadixSelect.Icon aria-hidden="true"><Icon name="chevron" size={15} /></RadixSelect.Icon>
              </RadixSelect.Trigger>
              <RadixSelect.Portal>
                <RadixSelect.Content className="z-50 max-h-[min(70vh,30rem)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-2xl border border-line bg-surface p-1.5 text-fg shadow-pop" position="popper" sideOffset={6} collisionPadding={8}>
                  <RadixSelect.Viewport>
                    {TAB_GROUPS.map((group) => (
                      <RadixSelect.Group key={group.label}>
                        <RadixSelect.Label className="px-2.5 pb-1 pt-2 text-xs font-medium text-fg-faint">{group.label}</RadixSelect.Label>
                        {group.ids.map((id) => {
                          const entry = TABS.find((item) => item.id === id)
                          return entry === undefined ? null : (
                            <RadixSelect.Item key={entry.id} value={entry.id} className="relative flex min-h-10 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none data-[highlighted]:bg-hover">
                              <Icon name={entry.icon} size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
                              <span className="flex-1"><RadixSelect.ItemText>{entry.label}</RadixSelect.ItemText></span>
                              <RadixSelect.ItemIndicator><Icon name="check" size={14} /></RadixSelect.ItemIndicator>
                            </RadixSelect.Item>
                          )
                        })}
                      </RadixSelect.Group>
                    ))}
                  </RadixSelect.Viewport>
                </RadixSelect.Content>
              </RadixSelect.Portal>
            </RadixSelect.Root>
          </div>
          <Tabs.List className="hidden min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-4 sm:flex" aria-label="Settings sections">
            {TAB_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                <div className="px-3 pb-1 text-xs font-medium text-fg-faint">{group.label}</div>
                {group.ids.map((id) => {
                  const entry = TABS.find((item) => item.id === id)
                  return entry === undefined ? null : (
                    <Tabs.Trigger key={entry.id} value={entry.id} className={tabTrigger} disabled={busy !== null && entry.id !== tab}>
                      <Icon name={entry.icon} size={16} className="shrink-0" aria-hidden="true" />
                      <span className="truncate">{entry.label}</span>
                    </Tabs.Trigger>
                  )
                })}
              </div>
            ))}
          </Tabs.List>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-2">
            <div className="flex min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="m-0 text-base font-semibold">{activeTab?.label ?? 'Settings'}</h2>
                {tab === 'providers' || tab === 'usage'
                  ? <Badge>All workspaces</Badge>
                  : <Badge tone="blue" title="These settings apply only to this workspace.">Workspace: {workspaceName ?? workspaceId ?? 'none'}</Badge>}
              </div>
              <span className="truncate text-[13px] text-fg-faint">{activeHint ?? ''}</span>
            </div>
            <IconButton label="Close settings" size="md" disabled={busy !== null} onClick={dismiss}><Icon name="close" size={18} /></IconButton>
          </header>

          <Tabs.Content key={tab} value={tab} tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-5 outline-none">

            {tab === 'providers' ? (
              <div className="mb-5">
                <SubTabs
                  label="Providers & Models"
                  value={modelsSub}
                  onChange={(value) => { if (value !== modelsSub) leave(() => setModelsSub(value)) }}
                  tabs={MODELS_SUB_TABS}
                />
              </div>
            ) : null}
            {tab === 'usage' ? <UsagePanel /> : !providerEditor ? (
              <UnsavedChangesContext.Provider value={unsavedApi}>
                {tab === 'providers' && modelsSub === 'model-aliases' ? <ModelAliasesPanel providers={providers} /> : null}
                {tab === 'providers' && modelsSub === 'images' ? <ImagesPanel providers={providers} /> : null}
                {tab === 'projects' ? <ProjectsPanel workspaceId={workspaceId} projects={projects} onChanged={onProjectsChanged} sessionCounts={sessionCounts} /> : null}
                {tab === 'permissions' ? <PermissionsPanel workspaceId={workspaceId} onChanged={onRefresh} initialSub={permissionsSubOf(initialTab)} /> : null}
                {tab === 'prompts' ? <SystemPromptsPanel workspaceId={workspaceId} /> : null}
                {tab === 'skills' ? <SkillsPanel workspaceId={workspaceId} onChanged={onSkillsChanged} /> : null}
                {tab === 'memory' ? <MemoryPanel workspaceId={workspaceId} projects={projects} /> : null}
                {tab === 'agents' ? <AgentsPanel workspaceId={workspaceId} projectId={activeProjectId} modelOptions={roleModelOptions} /> : null}
                {tab === 'mcp' ? <McpPanel workspaceId={workspaceId} /> : null}
                {tab === 'hooks' ? <HooksPanel workspaceId={workspaceId} projectId={activeProjectId} /> : null}
                {tab === 'secrets' ? <SecretsPanel workspaceId={workspaceId} /> : null}
              </UnsavedChangesContext.Provider>
            ) : (
              <div className="grid min-w-0 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
                <aside className="flex min-w-0 flex-col gap-1">
                  <span className="flex h-8 items-center px-1 text-xs font-medium text-fg-faint">Providers</span>
                  <div className="flex flex-col gap-px" role="listbox" aria-label="Providers">
                    {providers.map((provider) => {
                      const isSelected = provider.id === selectedId
                      return (
                        <button
                          key={provider.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => { if (!isSelected) leave(() => select(provider)) }}
                          className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-link ${isSelected ? 'bg-hover font-medium' : ''}`}
                        >
                          <span className="truncate text-sm">{provider.name}</span>
                          {provider.id === activeProvider ? <Badge title="Currently used for new conversations">in use</Badge> : null}
                          <span className={`ml-auto size-2 shrink-0 rounded-full ${provider.enabled ? 'bg-ok' : 'bg-line-strong'}`} aria-hidden="true" />
                          <span className="sr-only">{provider.enabled ? 'Enabled' : 'Disabled'}</span>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      role="option"
                      aria-selected={isNew}
                      onClick={() => leave(beginNew)}
                      className={`mt-1 flex min-h-9 w-full items-center gap-2 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-left text-sm text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-link ${isNew ? 'bg-hover text-fg' : ''}`}
                    >
                      <Icon name="plus" size={14} />Add provider
                    </button>
                  </div>
                </aside>

                <div className="flex min-w-0 flex-col gap-5">
                  {/* The name IS the title: one editable heading instead of a
                      heading plus a Name field repeating it. */}
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <h3 className="sr-only">{isNew ? 'Add provider' : selected?.name ?? 'Provider'}</h3>
                    <label className="sr-only" htmlFor={nameFieldId}>Name</label>
                    {/* Sized to its content so the rename affordance sits next
                        to the name instead of across the pane. */}
                    <input
                      ref={nameRef}
                      id={nameFieldId}
                      value={draft.name}
                      placeholder={isNew ? 'New provider' : 'Provider name'}
                      spellCheck={false}
                      size={16}
                      className="min-w-0 max-w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-lg font-semibold outline-none [field-sizing:content] hover:border-line focus:border-line"
                      onChange={(event) => patch({ name: event.target.value })}
                    />
                    <IconButton label="Rename provider" onClick={() => nameRef.current?.focus()}><Icon name="pencil" size={14} /></IconButton>
                    <Badge tone={draft.enabled ? 'green' : 'gray'}>{draft.enabled ? 'Enabled' : 'Disabled'}</Badge>
                    {dirty ? <Badge tone="amber">Unsaved</Badge> : null}
                    <span className="ml-auto flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => patch({ enabled: !draft.enabled })}>
                        <Icon name={draft.enabled ? 'circle' : 'circleDot'} size={13} />{draft.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      {isNew ? null : (
                        <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
                          <Icon name="trash" size={13} />Delete provider
                        </Button>
                      )}
                    </span>
                  </div>

                  <div className="flex flex-col gap-4">
                    <Field label="Base URL" tone={urlLooksWrong ? 'bad' : 'default'} hint={urlLooksWrong ? 'Enter an HTTP or HTTPS URL.' : '/chat/completions and /models are appended to this.'}>
                      <TextInput mono invalid={urlLooksWrong} value={draft.baseUrl} placeholder="https://api.openai.com/v1" leading={<Icon name="globe" size={15} />} onChange={(event) => patch({ baseUrl: event.target.value })} />
                    </Field>
                    <Field
                      label="API key"
                      hint={isNew
                        ? 'Optional for keyless endpoints; stored server-side.'
                        : selected?.keyMasked === ''
                          ? 'No key stored.'
                          : `Stored ${selected?.keyMasked ?? ''}`}
                    >
                      <TextInput
                        mono
                        type={showKey ? 'text' : 'password'}
                        value={draft.apiKey}
                        autoComplete="off"
                        placeholder={isNew ? 'sk-…' : 'Keep current key'}
                        leading={<Icon name="key" size={15} />}
                        trailing={<IconButton label={showKey ? 'Hide key' : 'Show key'} onClick={() => setShowKey((prev) => !prev)}><Icon name={showKey ? 'eyeOff' : 'eye'} size={15} /></IconButton>}
                        onChange={(event) => patch({ apiKey: event.target.value })}
                      />
                    </Field>
                  </div>

                  <section className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-[13px] font-medium text-fg">Model list<Badge>{draft.models.length}</Badge></span>
                      <Button variant="outline" size="sm" disabled={isNew || busy !== null} onClick={() => void sync()}>
                        <Icon name="refresh" size={14} />{busy === 'sync' ? 'Syncing…' : 'Sync from /models'}
                      </Button>
                    </div>

                    {draft.models.length === 0 ? (
                      <p className="m-0 flex items-center gap-2 rounded-xl border border-dashed border-line px-3.5 py-3 text-[13px] text-fg-muted">
                        <Icon name="info" size={15} />No models yet. Sync from the endpoint, or add model IDs.
                      </p>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {draft.models.map((model, index) => {
                          const isLive = selected?.id === activeProvider && model === activeModel
                          const settings = draft.modelSettings[model]
                          const context = modelContext(model, settings)
                          const verdict = modelTests[model]
                          const blocker = modelTestBlocker(model)
                          const canTest = blocker === null && verdict?.status !== 'testing'
                          return (
                            <li
                              key={model}
                              className={`flex flex-col rounded-lg ${dragModel === model ? 'opacity-50' : ''} ${dragOver === model && dragModel !== null && dragModel !== model ? 'ring-2 ring-link' : ''}`}
                              onDragOver={(event) => {
                                if (dragModel === null) return
                                event.preventDefault()
                                event.dataTransfer.dropEffect = 'move'
                                if (dragOver !== model) setDragOver(model)
                              }}
                              onDrop={(event) => {
                                event.preventDefault()
                                if (dragModel !== null) moveModel(dragModel, index)
                                setDragModel(null)
                                setDragOver(null)
                              }}
                            >
                              {/* One pill per model, metadata right-aligned inside it and
                                  actions outside: 40 rows of an endpoint's catalog stay
                                  scannable by id instead of by chip soup. The grip drags
                                  the row (or ↑/↓/Home/End while focused) — this order is
                                  the order the composer's model picker shows. */}
                              <div className="group/model flex min-w-0 items-center gap-1">
                                <button
                                  type="button"
                                  draggable
                                  aria-label={`Reorder ${model} (position ${index + 1} of ${draft.models.length}); use arrow keys to move`}
                                  title="Drag to reorder"
                                  className="flex h-9 w-5 shrink-0 cursor-grab items-center justify-center rounded text-fg-faint hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link active:cursor-grabbing"
                                  onDragStart={(event) => {
                                    event.dataTransfer.effectAllowed = 'move'
                                    event.dataTransfer.setData('text/plain', model)
                                    setDragModel(model)
                                  }}
                                  onDragEnd={() => { setDragModel(null); setDragOver(null) }}
                                  onKeyDown={(event) => {
                                    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
                                    const jump = event.key === 'Home' ? 0 : event.key === 'End' ? draft.models.length - 1 : null
                                    if (step === 0 && jump === null) return
                                    event.preventDefault()
                                    moveModel(model, jump ?? index + step)
                                    const target = event.currentTarget
                                    requestAnimationFrame(() => target.focus())
                                  }}
                                >
                                  <Icon name="grip" size={14} />
                                </button>
                                <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                                  <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{model}</code>
                                  {isLive ? <Badge tone="green" title="Used for new conversations">in use</Badge> : null}
                                  {modelVision(model, settings) === true ? <Badge tone="blue">Vision</Badge> : null}
                                  <Badge
                                    tone={context.overridden ? 'blue' : 'gray'}
                                    title={context.overridden
                                      ? `Custom context window: ${context.tokens.toLocaleString()} tokens`
                                      : `Catalog context window: ${context.tokens.toLocaleString()} tokens`}
                                  >
                                    {context.label}
                                  </Badge>
                                </span>
                                {/* Row tools fade in on hover/focus so a 40-model catalog
                                    is not a column of 120 icons; touch keeps them visible. */}
                                <span className="flex shrink-0 items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/model:opacity-100 [@media(hover:hover)]:group-focus-within/model:opacity-100">
                                  <IconButton
                                    label={verdict?.status === 'testing' ? `Testing ${model}` : `Test model ${model}`}
                                    disabled={!canTest}
                                    onClick={() => void testModel(model)}
                                  >
                                    {verdict?.status === 'testing' ? <Spinner size={14} /> : <Icon name="zap" size={14} />}
                                  </IconButton>
                                  <IconButton label={`Edit ${model} settings`} onClick={() => setEditingModel(model)}>
                                    <Icon name="sliders" size={14} />
                                  </IconButton>
                                  <IconButton label={`Remove model ${model}`} className="hover:text-bad" onClick={() => dropModel(model)}><Icon name="trash" size={14} /></IconButton>
                                </span>
                              </div>
                              {verdict?.status === 'ok' ? (
                                <p className="m-0 mt-1 flex items-center gap-1.5 pl-1 text-[12px] text-ok" role="status"><Icon name="check" size={13} />Model replied.</p>
                              ) : verdict?.status === 'bad' ? (
                                <div className="mt-1"><ErrorNotice raw={verdict.error ?? 'Connection failed.'} /></div>
                              ) : null}
                            </li>
                          )
                        })}
                      </ul>
                    )}

                    {addingModel || modelDraft !== '' ? (
                      <div className="flex gap-2">
                        <TextInput
                          ref={modelDraftRef}
                          mono
                          className="flex-1"
                          aria-label="Model IDs to add"
                          value={modelDraft}
                          placeholder="gpt-5.6-sol, gpt-5.6-terra"
                          onChange={(event) => setModelDraft(event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModels() } }}
                        />
                        <Button variant="outline" size="sm" className="h-9" disabled={modelDraft.trim() === ''} onClick={addModels}><Icon name="plus" size={13} />Add</Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => { setAddingModel(true); requestAnimationFrame(() => modelDraftRef.current?.focus()) }}
                      >
                        <Icon name="plus" size={13} />Add model
                      </Button>
                    )}
                  </section>
                </div>
              </div>
            )}
          </Tabs.Content>

          {providerEditor && notice !== null ? (
            // Outside the scrolling pane, so a save or test result is always in view.
            <div className="shrink-0 border-t border-line px-5 pt-3">
              {notice.kind === 'bad'
                ? <ErrorNotice raw={notice.text} />
                : <p className="m-0 flex items-center gap-2 rounded-lg bg-ok-soft px-3 py-2 text-[13px] text-ok" role="status"><Icon name="check" size={15} />{notice.text}</p>}
            </div>
          ) : null}
          {providerEditor ? (
            <footer className={`flex shrink-0 flex-wrap items-center gap-2 px-5 py-3 ${notice === null ? 'border-t border-line' : ''}`}>
              {/* Why Test is unavailable, as text rather than a hover-only tooltip. */}
              <span className={`flex min-w-0 flex-1 items-center gap-2 text-[13px] ${dirty ? 'text-warn' : 'text-fg-faint'}`}>
                <span className={`size-1.5 shrink-0 rounded-full ${dirty ? 'bg-warn' : 'bg-line-strong'}`} aria-hidden="true" />
                <span className="truncate">{dirty ? (isNew ? 'New provider — not saved yet' : 'Unsaved changes · save before testing') : 'All changes saved'}</span>
              </span>
              <Button variant="outline" size="sm" disabled={testBlocker !== null || busy !== null} title={testBlocker ?? 'Send a short completion with the saved configuration'} onClick={() => void test()}><Icon name="zap" size={13} />{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
              <Button variant="ghost" size="sm" disabled={busy !== null || !dirty} onClick={discardDraft}>Discard</Button>
              <Button variant="primary" size="sm" disabled={busy !== null || !dirty} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : isNew ? 'Add provider' : 'Save changes'}</Button>
            </footer>
          ) : null}
        </div>
      </Tabs.Root>
    </Modal>
    <ConfirmDialog
      open={pendingLeave !== null}
      title="Discard unsaved changes?"
      body={<p className="m-0">Edits that have not been saved will be lost.</p>}
      confirmLabel="Discard changes"
      onDismiss={() => setPendingLeave(null)}
      onConfirm={() => { const action = pendingLeave; setPendingLeave(null); discardDraft(); action?.() }}
    />
    {editingModel !== null && draft.models.includes(editingModel) ? (
      <ModelSettingsDialog
        model={editingModel}
        settings={draft.modelSettings[editingModel]}
        takenIds={draft.models.filter((model) => model !== editingModel)}
        onCancel={() => setEditingModel(null)}
        onSave={(id, settings) => applyModelSettings(editingModel, id, settings)}
      />
    ) : null}
    {syncOffer !== null ? (
      <SyncModelsDialog
        providerName={selected?.name ?? draft.name}
        available={syncOffer}
        current={draft.models}
        onCancel={() => setSyncOffer(null)}
        onConfirm={applySync}
      />
    ) : null}
    <ConfirmDialog
      open={confirmDelete && !isNew}
      title={`Delete “${selected?.name ?? 'this provider'}”?`}
      confirmLabel={busy === 'delete' ? 'Deleting…' : 'Delete permanently'}
      busy={busy !== null}
      body={<p className="m-0">Conversations keep their history, but nothing can use this endpoint until it is added again.</p>}
      onDismiss={() => { if (busy === null) setConfirmDelete(false) }}
      onConfirm={() => void remove()}
    />
    </>
  )
}
