import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { getWorkspaceSources, putWorkspaceSources } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import type { ResourceKindRow, ResourceSourcesDoc, SkillRuleRow, SourceLayerRow, WorkspaceSourcesRow } from '../../lib/types.ts'
import {
  ConflictBanner,
  InlineConfirm,
  InlineSwitch,
  ItemList,
  ItemRow,
  LoadFailed,
  Notice,
  PanelBody,
  PanelIntro,
  RowMenu,
  SaveBar,
  SubTabs,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const isConflict = (cause: unknown): boolean => /409/.test(String(cause))

/** One tab per layer, highest precedence first. */
type LayerTab = 'project' | 'workspace' | 'plugin' | 'user' | 'bundled'

const LAYER_TABS: readonly { readonly value: LayerTab; readonly label: string; readonly blurb: string }[] = [
  { value: 'project', label: 'Project', blurb: "Read from the bound project's own folder. Highest precedence: a project resource wins over the same name in any lower layer." },
  { value: 'workspace', label: 'Workspace', blurb: "This workspace's own folder in the app's data directory — the only layer Settings edits." },
  { value: 'plugin', label: 'Plugins', blurb: 'Resources from enabled Claude Code plugins (Settings → Plugins). Their names carry the plugin prefix.' },
  { value: 'user', label: 'User', blurb: 'Your ~/.claude folder, plus any absolute skill folder on this host. Read-only here.' },
  { value: 'bundled', label: 'Bundled', blurb: 'Shipped with the app and read-only. Lowest precedence, so every other layer can override it.' },
]

/** Each resource kind keeps one colour everywhere on this page. */
const KINDS = ['skills', 'agents', 'hooks', 'commands'] as const satisfies readonly ResourceKindRow[]
const KIND_INFO: Readonly<Record<ResourceKindRow, { readonly title: string; readonly tone: 'violet' | 'pink' | 'amber' | 'cyan'; readonly rule: string }>> = {
  skills: { title: 'Skills', tone: 'violet', rule: 'scanned in rule order; the first match wins' },
  agents: { title: 'Agents', tone: 'pink', rule: 'same name: the higher layer wins' },
  hooks: { title: 'Hooks', tone: 'amber', rule: "every enabled layer runs; an off layer's disableAllHooks is ignored" },
  commands: { title: 'Commands', tone: 'cyan', rule: 'same name: the nearest project folder wins' },
}

/** `local` hooks (settings.local.json) belong to the project folder, so they share its tab. */
const tabOfLayer = (layerId: string): LayerTab => (layerId === 'local' ? 'project' : (layerId as LayerTab))
const tabOfRule = (rule: SkillRuleRow): LayerTab => (rule.kind === 'project' ? 'project' : rule.kind === 'workspace' ? 'workspace' : 'user')

const serialize = (doc: ResourceSourcesDoc): string => JSON.stringify(doc)

/**
 * Settings → Sources: where skills, agents, hooks and commands are discovered
 * from, for this workspace. One tab per folder layer; inside a tab each row is
 * one resource kind, told apart by colour. One draft, one Save — the server
 * refuses a stale copy. Switching a layer off stops it being read; it never
 * edits or deletes the files, and a running request keeps what it started with.
 */
export function SourcesPanel(props: { readonly workspaceId: string | null; readonly onChanged?: () => void }) {
  return <SourcesPanelContent key={props.workspaceId} {...props} />
}

function SourcesPanelContent({ workspaceId, onChanged = () => {} }: { readonly workspaceId: string | null; readonly onChanged?: () => void }) {
  const [loaded, setLoaded] = useScopedState<WorkspaceSourcesRow | null>(null)
  const [draft, setDraft] = useScopedState<ResourceSourcesDoc | null>(null)
  const [tab, setTab] = useScopedState<LayerTab>('project')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [conflict, setConflict] = useScopedState(false)
  const [removing, setRemoving] = useScopedState<string | null>(null)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const adopt = (row: WorkspaceSourcesRow): void => {
    setLoaded(row)
    setDraft(row.doc)
  }

  const load = useCallback(async (): Promise<void> => {
    if (workspaceId === null) return
    try {
      adopt(await getWorkspaceSources(workspaceId))
      setConflict(false)
    } catch (cause) {
      setNotice({ kind: 'bad', text: String(cause) })
    }
  }, [workspaceId])

  useEffect(() => { void load() }, [load])

  const dirty = loaded !== null && draft !== null && serialize(draft) !== serialize(loaded.doc)
  useUnsavedChanges(dirty)

  if (workspaceId === null) return <WorkspaceRequired />
  if (loaded === null || draft === null) {
    return notice?.kind === 'bad'
      ? <LoadFailed what="sources" error={notice.text} onRetry={() => { setNotice(null); void load() }} />
      : <Notice kind="info" text="Loading sources…" />
  }

  const edit = (mutate: (doc: ResourceSourcesDoc) => ResourceSourcesDoc): void => {
    setDraft((current) => (current === null ? current : mutate(current)))
    setNotice(null)
  }
  const rules = draft.skills.rules
  const setRules = (next: readonly SkillRuleRow[]): void => edit((doc) => ({ ...doc, skills: { rules: next } }))
  const setLayer = (kind: ResourceKindRow, layer: string, on: boolean): void => edit((doc) => {
    const rest = doc.disabled[kind].filter((id) => id !== layer)
    return { ...doc, disabled: { ...doc.disabled, [kind]: on ? rest : [...rest, layer] } }
  })

  const save = (overwrite: boolean): Promise<void> => run('save', async () => {
    try {
      const expectedHash = overwrite ? (await getWorkspaceSources(workspaceId)).hash : loaded.hash
      const saved = await putWorkspaceSources(workspaceId, draft, expectedHash)
      adopt(saved)
      setConflict(false)
      setNotice({ kind: 'ok', text: 'Sources saved. Running conversations pick them up at their next request.' })
      onChanged()
    } catch (cause) {
      if (isConflict(cause)) { setConflict(true); return }
      setNotice({ kind: 'bad', text: cause instanceof Error ? cause.message : String(cause) })
    }
  })

  const discard = (): void => { setDraft(loaded.doc); setConflict(false); setNotice(null); setRemoving(null) }

  /**
   * Reorder inside this layer only: swap with the neighbouring rule of the same
   * layer and leave every other rule where it is, so a custom order across
   * layers that was stored earlier is preserved.
   */
  const moveRule = (rule: SkillRuleRow, delta: -1 | 1): void => {
    const group = rules.filter((candidate) => tabOfRule(candidate) === tabOfRule(rule))
    const other = group[group.findIndex((candidate) => candidate.id === rule.id) + delta]
    if (other === undefined) return
    const next = [...rules]
    next[rules.findIndex((candidate) => candidate.id === rule.id)] = other
    next[rules.findIndex((candidate) => candidate.id === other.id)] = rule
    setRules(next)
  }

  const kindBadge = (kind: ResourceKindRow, off: boolean): ReactNode => (
    <Badge tone={KIND_INFO[kind].tone} className={cn(off && 'opacity-50')}>{KIND_INFO[kind].title}</Badge>
  )

  const ruleRow = (rule: SkillRuleRow): ReactNode => {
    const group = rules.filter((candidate) => tabOfRule(candidate) === tabOfRule(rule))
    const at = group.findIndex((candidate) => candidate.id === rule.id)
    const label = rule.kind === 'workspace' ? 'Workspace skills' : rule.path ?? rule.id
    return (
      <ItemRow
        key={`rule:${rule.id}`}
        title={(
          <>
            {kindBadge('skills', !rule.enabled)}
            <span className={cn('break-all font-mono text-[13px]', !rule.enabled && 'text-fg-faint')}>{label}</span>
          </>
        )}
        meta={rule.kind === 'workspace' ? "The workspace's own skill folder — path is fixed." : rule.kind === 'project' ? "Relative to the bound project's folder." : 'Absolute folder on this host.'}
        actions={(
          <>
            <InlineSwitch
              ariaLabel={`Enable ${label}`}
              checked={rule.enabled}
              disabled={busy !== null}
              onChange={() => setRules(rules.map((candidate) => (candidate.id === rule.id ? { ...candidate, enabled: !candidate.enabled } : candidate)))}
            />
            <RowMenu
              label={`More actions for ${label}`}
              disabled={busy !== null}
              actions={[
                { label: 'Move up', icon: 'arrowUp', disabled: at === 0, onSelect: () => moveRule(rule, -1) },
                { label: 'Move down', icon: 'arrowDown', disabled: at === group.length - 1, onSelect: () => moveRule(rule, 1) },
                ...(rule.kind !== 'workspace' ? [{ label: 'Remove folder', icon: 'trash' as const, danger: true, onSelect: () => setRemoving(rule.id) }] : []),
              ]}
            />
          </>
        )}
      >
        {removing === rule.id ? (
          <InlineConfirm
            message={`Stop loading skills from ${label}? Files stay on disk. Applies when you save.`}
            confirmLabel="Remove folder"
            busy={busy !== null}
            onConfirm={() => { setRemoving(null); setRules(rules.filter((candidate) => candidate.id !== rule.id)) }}
            onCancel={() => setRemoving(null)}
          />
        ) : null}
      </ItemRow>
    )
  }

  const layerRow = (kind: ResourceKindRow, layer: SourceLayerRow): ReactNode => {
    const on = !draft.disabled[kind].includes(layer.id)
    const live = on && layer.available
    return (
      <ItemRow
        key={`${kind}:${layer.id}`}
        title={(
          <>
            {kindBadge(kind, !live)}
            <span className={cn('break-all font-mono text-[13px]', !live && 'text-fg-faint')}>{layer.path}</span>
          </>
        )}
        meta={!layer.available ? 'Not available on this host.' : on ? undefined : 'Off — not read in this workspace.'}
        actions={(
          <InlineSwitch
            ariaLabel={`${KIND_INFO[kind].title}: ${layer.label} layer`}
            checked={on}
            disabled={busy !== null || !layer.available}
            {...(!layer.available ? { title: 'This host has no such layer' } : {})}
            onChange={(next) => setLayer(kind, layer.id, next)}
          />
        )}
      />
    )
  }

  /** Everything one layer contributes, in the fixed kind order. */
  const rowsOf = (layerTab: LayerTab): ReactNode[] => KINDS.flatMap((kind) => [
    ...(kind === 'skills' ? rules.filter((rule) => tabOfRule(rule) === layerTab).map(ruleRow) : []),
    ...loaded.layers[kind].filter((layer) => tabOfLayer(layer.id) === layerTab).map((layer) => layerRow(kind, layer)),
  ])

  const current = LAYER_TABS.find((candidate) => candidate.value === tab) ?? LAYER_TABS[0]!
  const rows = rowsOf(current.value)

  return (
    <PanelBody>
      <PanelIntro>
        Choose which folder layers this workspace reads skills, agents, hooks and commands from. Turning a layer off only stops it being read — files stay
        untouched. Per-skill and per-hook switches are separate and unchanged.
      </PanelIntro>

      <ul aria-label="Resource kinds" className="m-0 grid list-none gap-x-4 gap-y-1.5 p-0 sm:grid-cols-2">
        {KINDS.map((kind) => (
          <li key={kind} className="flex min-w-0 items-start gap-2 text-xs text-fg-muted">
            <Badge tone={KIND_INFO[kind].tone}>{KIND_INFO[kind].title}</Badge>
            <span className="min-w-0 pt-0.5">{KIND_INFO[kind].rule}</span>
          </li>
        ))}
      </ul>

      {loaded.error !== undefined ? (
        <Notice kind="bad" text={`${loaded.error}. Until it is saved again the server keeps the last valid policy, or reads nothing when there was none. Saving here replaces the file.`} />
      ) : null}
      {conflict ? <ConflictBanner what="sources" busy={busy !== null} onReload={() => void load()} onOverwrite={() => void save(true)} /> : null}

      <div className="flex flex-col gap-3">
        {/* Five tabs are wider than a phone: the strip scrolls sideways instead of overflowing the dialog. */}
        <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1">
          <SubTabs
            label="Source layers"
            value={tab}
            onChange={(next) => { setTab(next); setRemoving(null) }}
            tabs={LAYER_TABS.map((candidate) => ({ value: candidate.value, label: candidate.label, count: rowsOf(candidate.value).length }))}
          />
        </div>
        <p className="m-0 text-xs text-fg-faint">{current.blurb}</p>
        <ItemList label={`${current.label} layer`}>{rows}</ItemList>
        {current.value === 'project' ? (
          <AddRuleForm key="project" kind="project" busy={busy !== null} placeholder="Relative to the project, e.g. .team/skills" onAdd={(path) => setRules([...rules, newRule('project', path)])} />
        ) : null}
        {current.value === 'user' ? (
          <AddRuleForm key="absolute" kind="absolute" busy={busy !== null} placeholder="Absolute, e.g. D:/shared-skills" onAdd={(path) => setRules([...rules, newRule('absolute', path)])} />
        ) : null}
      </div>

      <SaveBar dirty={dirty} busy={busy !== null} saving={busy === 'save'} onSave={() => void save(false)} onDiscard={discard} notice={notice} />
    </PanelBody>
  )
}

const newRule = (kind: 'project' | 'absolute', path: string): SkillRuleRow => ({ id: `rule-${Math.random().toString(36).slice(2, 8)}`, kind, path, enabled: true })

/** Adds one skill folder rule of a fixed kind; it joins at the end (lowest precedence). */
function AddRuleForm({ kind, busy, placeholder, onAdd }: {
  readonly kind: 'project' | 'absolute'
  readonly busy: boolean
  readonly placeholder: string
  readonly onAdd: (path: string) => void
}) {
  const [path, setPath] = useState('')
  const trimmed = path.trim()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line p-3">
        <Badge tone="violet">Skills</Badge>
        <div className="min-w-[200px] flex-1">
          <TextInput className="h-8" mono aria-label="New rule path" value={path} placeholder={placeholder} onChange={(event) => setPath(event.target.value)} />
        </div>
        <Button variant="outline" size="sm" disabled={busy || trimmed === ''} onClick={() => { onAdd(trimmed); setPath('') }}>
          <Icon name="plus" size={13} />{kind === 'project' ? 'Add project folder' : 'Add folder'}
        </Button>
      </div>
      <p className="m-0 text-xs text-fg-faint">
        New skill folders join at the end of their layer — the lowest precedence.
        {kind === 'absolute' ? ' Absolute folders are protected from file-tool grants.' : ''}
      </p>
    </div>
  )
}
