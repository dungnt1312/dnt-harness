import { useCallback, useEffect, useState } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { getGuardConfig, putGuardConfig, type DangerousCommandsConfig, type CustomRule } from '../../lib/api.ts'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Modal } from '../ui/Modal.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Select } from '../ui/Select.tsx'
import { Switch } from '../ui/Switch.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import Icon from '../common/Icon.tsx'
import {
  EmptyState,
  ItemList,
  ItemRow,
  Notice,
  PanelBody,
  PanelIntro,
  Section,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'
import { matchCommand } from '../../../src/harness/guard/matcher.ts'
import { DEFAULT_CONFIG, PRESET_IDS, PRESET_LABELS, PRESET_RULE_TEXTS } from '../../../src/harness/guard/defaults.ts'
import type { CustomRuleAction, GuardAction } from '../../../src/harness/guard/types.ts'

const PRESET_OPTIONS: readonly { readonly value: GuardAction; readonly label: string }[] = [
  { value: 'deny', label: 'Deny' },
  { value: 'ask', label: 'Ask' },
  { value: 'off', label: 'Off' },
]

const RULE_ACTION_OPTIONS: readonly { readonly value: CustomRuleAction; readonly label: string }[] = [
  { value: 'deny', label: 'Deny' },
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Allow' },
]

function isConflict(cause: unknown): boolean {
  return /409/.test(String(cause))
}

function cloneConfig(config: DangerousCommandsConfig): DangerousCommandsConfig {
  return JSON.parse(JSON.stringify(config)) as DangerousCommandsConfig
}

function serializeConfig(config: DangerousCommandsConfig): string {
  return JSON.stringify(config)
}

function newRuleId(): string {
  return `cr-${Math.random().toString(36).slice(2, 10)}`
}

export function DangerousCommandsPanel(props: { readonly workspaceId: string | null }) {
  return <DangerousCommandsPanelContent key={props.workspaceId} {...props} />
}

function DangerousCommandsPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [config, setConfig] = useScopedState<DangerousCommandsConfig | null>(null)
  const [hash, setHash] = useScopedState<string | null>(null)
  const [baseline, setBaseline] = useScopedState<string | null>(null)
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [conflict, setConflict] = useScopedState(false)
  const [editing, setEditing] = useScopedState<CustomRule | null>(null)
  const [draftPattern, setDraftPattern] = useScopedState('')
  const [draftIsRegex, setDraftIsRegex] = useScopedState(false)
  const [draftAction, setDraftAction] = useScopedState<CustomRuleAction>('deny')
  const [draftDesc, setDraftDesc] = useScopedState('')
  const [draftRegexError, setDraftRegexError] = useScopedState<string | null>(null)
  const [testInput, setTestInput] = useScopedState('')
  const [testResult, setTestResult] = useScopedState<string | null>(null)
  const [expandedPresets, setExpandedPresets] = useState<ReadonlySet<string>>(() => new Set())
  const togglePreset = (id: string): void => {
    setExpandedPresets((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (workspaceId === null) return
    setLoading(true)
    try {
      const result = await getGuardConfig(workspaceId)
      const cfg = result.config as DangerousCommandsConfig
      // Ensure all presets present (server may return defaults)
      const merged: DangerousCommandsConfig = {
        v: 1,
        presets: { ...DEFAULT_CONFIG.presets, ...cfg.presets } as DangerousCommandsConfig['presets'],
        customRules: [...cfg.customRules],
      }
      setConfig(merged)
      setHash(result.hash)
      setBaseline(serializeConfig(merged))
      setConflict(false)
      if (result.warning !== undefined) {
        setNotice({ kind: 'info', text: result.warning })
      } else {
        setNotice(null)
      }
    } catch (cause) {
      setNotice({ kind: 'bad', text: String(cause) })
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { void load() }, [load])

  if (workspaceId === null) return <WorkspaceRequired />
  if (loading || config === null) {
    return (
      <PanelBody>
        <PanelIntro>
          Guard dangerous Bash commands by risk. Presets cover common hazards; custom rules override them.
          Matching is string/regex based — obfuscated payloads may bypass the guard. Not an OS sandbox.
        </PanelIntro>
        <p className="m-0 text-sm text-fg-faint">Loading guard configuration…</p>
      </PanelBody>
    )
  }

  const dirty = baseline !== null && serializeConfig(config) !== baseline

  const setPreset = (id: string, action: GuardAction): void => {
    setConfig((prev) => {
      if (prev === null) return prev
      return { ...prev, presets: { ...prev.presets, [id]: action } }
    })
    setNotice(null)
    setConflict(false)
  }

  const openAdd = (): void => {
    setEditing({ id: '__new__', pattern: '', isRegex: false, action: 'deny' })
    setDraftPattern('')
    setDraftIsRegex(false)
    setDraftAction('deny')
    setDraftDesc('')
    setDraftRegexError(null)
  }

  const openEdit = (rule: CustomRule): void => {
    setEditing(rule)
    setDraftPattern(rule.pattern)
    setDraftIsRegex(rule.isRegex)
    setDraftAction(rule.action)
    setDraftDesc(rule.description ?? '')
    setDraftRegexError(validateRegex(rule.pattern, rule.isRegex))
  }

  const closeDialog = (): void => {
    setEditing(null)
    setDraftRegexError(null)
  }

  const validateRegex = (pattern: string, isRegex: boolean): string | null => {
    if (!isRegex) return null
    if (pattern.trim() === '') return 'Pattern is required.'
    try {
      new RegExp(pattern, 'i')
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  const onPatternChange = (value: string): void => {
    setDraftPattern(value)
    if (draftIsRegex) setDraftRegexError(validateRegex(value, true))
    else setDraftRegexError(null)
  }

  const onIsRegexChange = (next: boolean): void => {
    setDraftIsRegex(next)
    setDraftRegexError(validateRegex(draftPattern, next))
  }

  const canSaveRule = draftPattern.trim() !== '' && (draftIsRegex ? draftRegexError === null : true)

  const saveRule = (): void => {
    if (editing === null || !canSaveRule) return
    const pattern = draftPattern.trim()
    if (editing.id === '__new__') {
      const rule: CustomRule = {
        id: newRuleId(),
        pattern,
        isRegex: draftIsRegex,
        action: draftAction,
        ...(draftDesc.trim() !== '' ? { description: draftDesc.trim() } : {}),
      }
      setConfig((prev) => prev === null ? prev : { ...prev, customRules: [...prev.customRules, rule] })
    } else {
      setConfig((prev) => {
        if (prev === null) return prev
        return {
          ...prev,
          customRules: (prev.customRules.map((r) => {
              if (r.id !== editing.id) return r
              const { description: _old, ...base } = r
              return draftDesc.trim() === ''
                ? { ...base, pattern, isRegex: draftIsRegex, action: draftAction }
                : { ...base, pattern, isRegex: draftIsRegex, action: draftAction, description: draftDesc.trim() }
            }) as unknown as readonly CustomRule[]),
        }
      })
    }
    closeDialog()
    setConflict(false)
    setNotice(null)
  }

  const deleteRule = (id: string): void => {
    setConfig((prev) => prev === null ? prev : { ...prev, customRules: prev.customRules.filter((r) => r.id !== id) })
    setNotice(null)
    setConflict(false)
  }

  const handleTest = (): void => {
    const cmd = testInput.trim()
    if (cmd === '') { setTestResult('Enter a command to test.'); return }
    const m = matchCommand(cmd, config)
    if (m === null) setTestResult('No match — allowed by guard (Mode still applies).')
    else if (m.ruleId !== undefined) setTestResult(`Matched custom rule "${m.pattern}" → ${m.action.toUpperCase()} (${m.reason})`)
    else setTestResult(`Matched ${m.reason} → ${String(m.action).toUpperCase()} (pattern: ${m.pattern})`)
  }

  const save = (): Promise<void> => run('save', async () => {
    if (config === null) return
    try {
      const result = await putGuardConfig(workspaceId, config, hash ?? undefined)
      setHash(result.hash)
      setBaseline(serializeConfig(result.config as DangerousCommandsConfig))
      setConfig(result.config as DangerousCommandsConfig)
      setConflict(false)
      setNotice({ kind: 'ok', text: 'Saved dangerous commands configuration.' })
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(true)
      setNotice({ kind: 'bad', text: 'Configuration changed on disk since you opened it. Reload or overwrite.' })
    }
  })

  const reload = (): Promise<void> => run('reload', async () => {
    await load()
    setNotice({ kind: 'info', text: 'Reloaded server version.' })
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    if (config === null) return
    const fresh = await getGuardConfig(workspaceId)
    const result = await putGuardConfig(workspaceId, config, fresh.hash)
    setHash(result.hash)
    setBaseline(serializeConfig(result.config as DangerousCommandsConfig))
    setConfig(result.config as DangerousCommandsConfig)
    setConflict(false)
    setNotice({ kind: 'ok', text: 'Saved (overwrote server version).' })
  })

  const cancel = (): void => {
    if (baseline !== null) {
      try {
        const parsed = JSON.parse(baseline) as DangerousCommandsConfig
        setConfig(cloneConfig(parsed))
      } catch { /* ignore */ }
    }
    setConflict(false)
    setNotice(null)
    setTestResult(null)
  }

  return (
    <PanelBody>
      <PanelIntro>
        Inspect every <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">Bash</code> command before approval.
        Presets deny or ask for risky patterns; custom rules override presets. Obfuscated payloads may bypass matching — this is not an OS sandbox.
      </PanelIntro>

      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}

      <Section title="Presets" count={PRESET_IDS.length}>
        <ItemList label="Preset groups">
          {PRESET_IDS.map((id) => {
            const info = PRESET_LABELS[id]
            const rules = PRESET_RULE_TEXTS[id] ?? []
            const value = (config.presets as Record<string, GuardAction>)[id] ?? 'off'
            const toneClass = value === 'deny' ? 'text-bad' : value === 'ask' ? 'text-warn' : 'text-fg-faint'
            const expanded = expandedPresets.has(id)
            return (
              <ItemRow
                key={id}
                title={(
                  <>
                    <span className={toneClass}>{info.name}</span>
                    <Badge tone={value === 'deny' ? 'amber' : value === 'ask' ? 'amber' : 'gray'}>{value}</Badge>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-normal text-fg-muted hover:bg-hover hover:text-fg"
                      onClick={() => togglePreset(id)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? 'Hide' : 'Show'} rules for ${info.name}`}
                    >
                      <Icon name="chevron" size={11} className={expanded ? 'rotate-180' : ''} />
                      {expanded ? 'Hide rules' : `${rules.length} rules`}
                    </button>
                  </>
                )}
                meta={`${info.description} — e.g. ${info.examples}`}
                actions={(
                  <Segmented
                    label={`${info.name} action`}
                    value={value}
                    options={PRESET_OPTIONS as unknown as readonly { readonly value: string; readonly label: string }[]}
                    onChange={(v) => setPreset(id, v as GuardAction)}
                  />
                )}
              >
                {expanded ? (
                  <ul className="m-0 flex list-none flex-col gap-1 rounded-lg bg-muted px-3 py-2">
                    {rules.map((rule) => (
                      <li key={rule} className="flex items-start gap-2 text-xs leading-5">
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-fg-faint" aria-hidden />
                        <code className="min-w-0 break-all font-mono text-fg">{rule}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </ItemRow>
            )
          })}
        </ItemList>
      </Section>

      <Section
        title="Custom Rules"
        count={config.customRules.length}
        actions={<Button variant="outline" size="sm" disabled={busy !== null} onClick={openAdd}><Icon name="plus" size={13} />Add rule</Button>}
      >
        {config.customRules.length === 0 ? (
          <EmptyState>No custom rules. Add a pattern to allow, deny, or ask for specific commands. Custom rules are checked before presets.</EmptyState>
        ) : (
          <ItemList label="Custom rules">
            {config.customRules.map((rule) => (
              <ItemRow
                key={rule.id}
                title={(
                  <>
                    <code className="break-all font-mono text-[13px]">{rule.pattern}</code>
                    <Badge tone="gray">{rule.isRegex ? 'Regex' : 'Text'}</Badge>
                    <Badge tone={rule.action === 'deny' ? 'amber' : rule.action === 'ask' ? 'amber' : 'gray'}>{rule.action}</Badge>
                  </>
                )}
                meta={rule.description ?? ''}
                actions={(
                  <>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => openEdit(rule)}>Edit</Button>
                    <IconButton label={`Delete rule ${rule.pattern}`} disabled={busy !== null} onClick={() => deleteRule(rule.id)}><Icon name="trash" size={14} /></IconButton>
                  </>
                )}
              />
            ))}
          </ItemList>
        )}
      </Section>

      <Section title="Test a command">
        <p className="m-0 text-xs text-fg-faint">Preview how the current (unsaved) configuration would handle a command. Uses the same matcher as the server — no round-trip.</p>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 flex-1 basis-64">
            <TextInput
              mono
              aria-label="Test command"
              placeholder="Try a command… e.g. rm -rf /tmp/foo"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleTest() } }}
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleTest}>Test</Button>
        </div>
        {testResult !== null ? (
          <p className="m-0 rounded-lg border border-line bg-muted px-3 py-2 text-[13px]" role="status">{testResult}</p>
        ) : null}
      </Section>

      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <span className="min-w-0 flex-1 basis-48">The file changed on disk since you opened it.</span>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reload()}>Reload server version</Button>
          <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => void overwrite()}>Overwrite anyway</Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy !== null || !dirty} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
        <Button variant="ghost" size="sm" disabled={busy !== null || !dirty} onClick={cancel}>Cancel</Button>
        {dirty ? <span className="self-center text-xs text-fg-faint">Unsaved changes</span> : null}
      </div>

      {editing !== null ? (
        <Modal open label={editing.id === '__new__' ? 'Add rule' : 'Edit rule'} width="md" onDismiss={closeDialog}>
          <div className="flex flex-col gap-4">
            <Field label="Pattern" hint={draftIsRegex ? 'Regular expression (case-insensitive). Invalid regex blocks save.' : 'Case-insensitive substring.'}>
              <TextInput
                mono
                aria-label="Pattern"
                value={draftPattern}
                placeholder={draftIsRegex ? '^rm\\s+-rf' : 'rm -rf ./tmp'}
                onChange={(e) => onPatternChange(e.target.value)}
              />
            </Field>
            {draftRegexError !== null ? <p className="m-0 text-xs text-bad" role="alert">{draftRegexError}</p> : null}
            <Switch label="Regex" hint="Treat pattern as a regular expression." checked={draftIsRegex} onChange={onIsRegexChange} />
            <Field label="Action">
              <Select
                label="Action"
                value={draftAction}
                options={RULE_ACTION_OPTIONS as unknown as readonly { readonly value: string; readonly label: string }[]}
                onChange={(v) => setDraftAction(v as CustomRuleAction)}
              />
            </Field>
            <Field label="Description" hint="Optional note shown in the table.">
              <TextInput
                aria-label="Description"
                value={draftDesc}
                placeholder="Allow cleaning tmp in CI"
                onChange={(e) => setDraftDesc(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" disabled={!canSaveRule} onClick={saveRule}>{editing.id === '__new__' ? 'Add rule' : 'Save rule'}</Button>
              <Button variant="ghost" size="sm" onClick={closeDialog}>Cancel</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </PanelBody>
  )
}
