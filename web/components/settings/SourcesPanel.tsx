import { useCallback, useEffect, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { getWorkspaceSources, putWorkspaceSources } from '../../lib/api.ts'
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
  Section,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const isConflict = (cause: unknown): boolean => /409/.test(String(cause))

const KIND_TITLES: Readonly<Record<ResourceKindRow, { readonly title: string; readonly hint: string }>> = {
  skills: { title: 'Skills', hint: 'Folder rules decide the scan order (first match wins); plugin and bundled skills ride below them.' },
  agents: { title: 'Agents', hint: 'When two layers define the same role, the more specific one wins; switching a layer off lets a lower one win again.' },
  hooks: { title: 'Hooks', hint: 'Hooks from every enabled layer all run. A layer that is off is not read, so its disableAllHooks does not apply either.' },
  commands: { title: 'Commands', hint: 'Slash commands from the enabled layers; the nearest project folder wins by name.' },
}
const KINDS = Object.keys(KIND_TITLES) as readonly ResourceKindRow[]

const serialize = (doc: ResourceSourcesDoc): string => JSON.stringify(doc)

/**
 * Settings → Sources: where skills, agents, hooks and commands are discovered
 * from, for this workspace. One draft, one Save — the server refuses a stale
 * copy. Switching a layer off stops it being read; it never edits or deletes
 * the files, and an already running request keeps what it started with.
 */
export function SourcesPanel(props: { readonly workspaceId: string | null; readonly onChanged?: () => void }) {
  return <SourcesPanelContent key={props.workspaceId} {...props} />
}

function SourcesPanelContent({ workspaceId, onChanged = () => {} }: { readonly workspaceId: string | null; readonly onChanged?: () => void }) {
  const [loaded, setLoaded] = useScopedState<WorkspaceSourcesRow | null>(null)
  const [draft, setDraft] = useScopedState<ResourceSourcesDoc | null>(null)
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [conflict, setConflict] = useScopedState(false)
  const [removing, setRemoving] = useScopedState<string | null>(null)
  const [newKind, setNewKind] = useScopedState<'project' | 'absolute'>('project')
  const [newPath, setNewPath] = useScopedState('')
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
  const setRules = (rules: readonly SkillRuleRow[]): void => edit((doc) => ({ ...doc, skills: { rules } }))
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

  const rules = draft.skills.rules
  const moveRule = (index: number, delta: -1 | 1): void => {
    const next = [...rules]
    const [row] = next.splice(index, 1)
    if (row === undefined) return
    next.splice(index + delta, 0, row)
    setRules(next)
  }
  const kindLabel = (kind: SkillRuleRow['kind']): string => (kind === 'project' ? 'Project' : kind === 'absolute' ? 'Absolute' : 'Workspace')
  const ruleLabel = (rule: SkillRuleRow): string => (rule.kind === 'workspace' ? 'Workspace skills' : rule.path ?? rule.id)
  const ruleHint = (rule: SkillRuleRow): string =>
    rule.kind === 'workspace' ? "The workspace's own skill folder — path is fixed." : rule.kind === 'project' ? "Relative to the bound project's folder." : 'Absolute folder on this host.'

  const layerRow = (kind: ResourceKindRow, layer: SourceLayerRow): ReactNode => {
    const on = !draft.disabled[kind].includes(layer.id)
    return (
      <ItemRow
        key={`${kind}:${layer.id}`}
        title={(
          <>
            <Badge tone={on && layer.available ? 'green' : 'gray'}>{layer.label}</Badge>
            <span className="break-all font-mono text-[13px]">{layer.path}</span>
          </>
        )}
        meta={!layer.available ? 'Not available on this host.' : on ? undefined : 'Off — not read in this workspace.'}
        actions={(
          <InlineSwitch
            ariaLabel={`${KIND_TITLES[kind].title}: ${layer.label} layer`}
            checked={on}
            disabled={busy !== null || !layer.available}
            {...(!layer.available ? { title: 'This host has no such layer' } : {})}
            onChange={(next) => setLayer(kind, layer.id, next)}
          />
        )}
      />
    )
  }

  return (
    <PanelBody>
      <PanelIntro>
        Choose which folder layers this workspace reads skills, agents, hooks and commands from. Turning a layer off only stops it being read — files stay
        untouched and other resource kinds keep their own settings. Per-skill and per-hook switches are separate and unchanged.
      </PanelIntro>
      {loaded.error !== undefined ? (
        <Notice kind="bad" text={`${loaded.error}. Until it is saved again the server keeps the last valid policy, or reads nothing when there was none. Saving here replaces the file.`} />
      ) : null}
      {conflict ? <ConflictBanner what="sources" busy={busy !== null} onReload={() => void load()} onOverwrite={() => void save(true)} /> : null}

      {KINDS.map((kind) => (
        <Section key={kind} title={KIND_TITLES[kind].title} count={kind === 'skills' ? rules.length + loaded.layers.skills.length : loaded.layers[kind].length}>
          <p className="m-0 text-xs text-fg-faint">{KIND_TITLES[kind].hint}</p>
          {kind === 'skills' ? (
            <div className="space-y-2">
              <ItemList label="Skill source folders">
                {rules.map((rule, index) => (
                  <ItemRow
                    key={rule.id}
                    title={(
                      <>
                        <Badge tone={rule.kind === 'project' ? 'green' : rule.kind === 'absolute' ? 'gray' : 'blue'}>{kindLabel(rule.kind)}</Badge>
                        <span className="break-all font-mono text-[13px]">{ruleLabel(rule)}</span>
                      </>
                    )}
                    meta={ruleHint(rule)}
                    actions={(
                      <>
                        <InlineSwitch
                          label="Enabled"
                          ariaLabel={`Enable ${ruleLabel(rule)}`}
                          checked={rule.enabled}
                          disabled={busy !== null}
                          onChange={() => setRules(rules.map((candidate) => (candidate.id === rule.id ? { ...candidate, enabled: !candidate.enabled } : candidate)))}
                        />
                        <RowMenu
                          label={`More actions for ${ruleLabel(rule)}`}
                          disabled={busy !== null}
                          actions={[
                            { label: 'Move up', icon: 'arrowUp', disabled: index === 0, onSelect: () => moveRule(index, -1) },
                            { label: 'Move down', icon: 'arrowDown', disabled: index === rules.length - 1, onSelect: () => moveRule(index, 1) },
                            ...(rule.kind !== 'workspace' ? [{ label: 'Remove folder', icon: 'trash' as const, danger: true, onSelect: () => setRemoving(rule.id) }] : []),
                          ]}
                        />
                      </>
                    )}
                  >
                    {removing === rule.id ? (
                      <InlineConfirm
                        message={`Stop loading skills from ${ruleLabel(rule)}? Files stay on disk. Applies when you save.`}
                        confirmLabel="Remove folder"
                        busy={busy !== null}
                        onConfirm={() => { setRemoving(null); setRules(rules.filter((candidate) => candidate.id !== rule.id)) }}
                        onCancel={() => setRemoving(null)}
                      />
                    ) : null}
                  </ItemRow>
                ))}
              </ItemList>
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line p-3">
                <div className="w-[150px] shrink-0">
                  <Select
                    label="New rule kind"
                    triggerClassName="h-8 px-2.5 text-[13px]"
                    value={newKind}
                    onChange={(value) => setNewKind(value as 'project' | 'absolute')}
                    options={[
                      { value: 'project', label: 'Project folder' },
                      { value: 'absolute', label: 'Absolute path' },
                    ]}
                  />
                </div>
                <div className="min-w-[200px] flex-1">
                  <TextInput className="h-8" mono aria-label="New rule path" value={newPath} placeholder={newKind === 'project' ? 'Relative, e.g. .team/skills' : 'Absolute, e.g. D:/shared-skills'} onChange={(e) => setNewPath(e.target.value)} />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || newPath.trim() === ''}
                  onClick={() => {
                    const path = newPath.trim()
                    if (path === '') return
                    setRules([...rules, { id: `rule-${Math.random().toString(36).slice(2, 8)}`, kind: newKind, path, enabled: true }])
                    setNewPath('')
                  }}
                >
                  <Icon name="plus" size={13} />Add rule
                </Button>
              </div>
              <p className="m-0 text-xs text-fg-faint">New rules join at the end — the lowest precedence. Absolute folders are protected from file-tool grants.</p>
              <ItemList label="Other skill layers">{loaded.layers.skills.map((layer) => layerRow('skills', layer))}</ItemList>
            </div>
          ) : (
            <ItemList label={`${KIND_TITLES[kind].title} layers`}>{loaded.layers[kind].map((layer) => layerRow(kind, layer))}</ItemList>
          )}
        </Section>
      ))}

      <SaveBar dirty={dirty} busy={busy !== null} saving={busy === 'save'} onSave={() => void save(false)} onDiscard={discard} notice={notice} />
    </PanelBody>
  )
}
