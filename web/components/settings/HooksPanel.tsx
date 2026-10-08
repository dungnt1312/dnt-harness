import { useCallback, useEffect } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Switch } from '../ui/Switch.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { fetchHooks, saveHooks, setHookActive } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import * as RadixSwitch from '@radix-ui/react-switch'
import type { EffectiveHookRow, HookCommandRow, HookEvent, HookMatcherGroupRow, HooksConfigRow, HooksSectionRow } from '../../lib/types.ts'
import { CodeArea, Disclosure, InlineConfirm, IsolationNote, LoadFailed, Notice, SaveBar, PanelBody, PanelIntro, Section, WorkspaceRequired, useActionRunner, type NoticeState } from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

/** Claude Code hook events dnt-harness fires, with what the matcher matches. */
const HOOK_EVENTS: readonly { readonly key: HookEvent; readonly hint: string; readonly matcher?: string }[] = [
  { key: 'PreToolUse', matcher: 'Tool name regex, e.g. Bash or Write|Edit or mcp__github__.*', hint: 'Before a tool runs. Exit 2 or permissionDecision "deny" blocks; "ask" forces approval; updatedInput rewrites (and re-enters every gate).' },
  { key: 'PostToolUse', matcher: 'Tool name regex', hint: 'After a tool succeeds. Exit 2 / decision "block" sends the reason to the model; additionalContext rides along.' },
  { key: 'PostToolUseFailure', matcher: 'Tool name regex', hint: 'After a tool ran and failed (input has "error"). Denied calls fire no post hook.' },
  { key: 'UserPromptSubmit', hint: 'When a prompt is accepted. stdout or additionalContext is added as context; exit 2 / decision "block" rejects the prompt.' },
  { key: 'Stop', hint: 'When the model finishes. decision "block" + reason continues the turn (check stop_hook_active).' },
  { key: 'SubagentStart', matcher: 'Agent type, e.g. explorer', hint: 'When a subagent starts; additionalContext reaches the subagent.' },
  { key: 'SubagentStop', matcher: 'Agent type', hint: 'When a subagent finishes; decision "block" continues it.' },
  { key: 'Notification', matcher: 'permission_prompt', hint: 'When a permission prompt is waiting. Observe-only.' },
  { key: 'PreCompact', matcher: 'manual or auto', hint: 'Before compaction. continue:false stops it.' },
  { key: 'SessionStart', matcher: 'startup', hint: 'When a conversation starts. stdout or additionalContext joins the first message.' },
  { key: 'SessionEnd', matcher: 'clear', hint: 'When a conversation is deleted. Observe-only.' },
]

/**
 * Claude Code events dnt-harness does not fire yet. They are valid in the
 * file, kept verbatim on save, and listed as "not run" — never rejected.
 */
const CLAUDE_ONLY_EVENTS = new Set<string>(['PermissionRequest'])
const HOOK_EVENT_KEYS = new Set<string>([...HOOK_EVENTS.map((event) => event.key), ...CLAUDE_ONLY_EVENTS])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validate an untrusted Claude Code `hooks` section before it enters typed editor state or is saved. */
export function validateHooksSection(value: unknown): HooksSectionRow {
  if (!isRecord(value)) throw new Error('Hooks validation error: "hooks" must be an object keyed by event.')
  const out: Partial<Record<HookEvent, readonly HookMatcherGroupRow[]>> = {}
  for (const [event, rawGroups] of Object.entries(value)) {
    if (!HOOK_EVENT_KEYS.has(event)) throw new Error(`Hooks validation error: unknown hook event "${event}".`)
    if (!Array.isArray(rawGroups)) throw new Error(`Hooks validation error: ${event} must be an array of matcher groups.`)
    out[event as HookEvent] = rawGroups.map((rawGroup, index): HookMatcherGroupRow => {
      const at = `${event}[${index}]`
      if (!isRecord(rawGroup)) throw new Error(`Hooks validation error: ${at} must be an object.`)
      if (rawGroup.matcher !== undefined && typeof rawGroup.matcher !== 'string') throw new Error(`Hooks validation error: ${at}.matcher must be a string.`)
      if (!Array.isArray(rawGroup.hooks)) throw new Error(`Hooks validation error: ${at}.hooks must be an array.`)
      const hooks = rawGroup.hooks.map((rawHook, hookIndex): HookCommandRow => {
        const where = `${at}.hooks[${hookIndex}]`
        if (!isRecord(rawHook)) throw new Error(`Hooks validation error: ${where} must be an object.`)
        if (rawHook.type !== 'command') throw new Error(`Hooks validation error: ${where}.type must be "command".`)
        if (typeof rawHook.command !== 'string') throw new Error(`Hooks validation error: ${where}.command must be a string.`)
        if (rawHook.timeout !== undefined && (typeof rawHook.timeout !== 'number' || !Number.isFinite(rawHook.timeout) || rawHook.timeout <= 0)) throw new Error(`Hooks validation error: ${where}.timeout must be a positive number of seconds.`)
        return { type: 'command', command: rawHook.command, ...(typeof rawHook.timeout === 'number' ? { timeout: rawHook.timeout } : {}) }
      })
      return { ...(typeof rawGroup.matcher === 'string' ? { matcher: rawGroup.matcher } : {}), hooks }
    })
  }
  return out
}

/** Back-compat name used by older callers/tests: validates a `{ hooks }` document. */
export function validateHooksConfig(value: unknown): { readonly hooks: HooksSectionRow } {
  if (!isRecord(value)) throw new Error('Hooks validation error: document must be an object.')
  return { hooks: validateHooksSection(value.hooks ?? {}) }
}

/**
 * Claude Code hooks editor for the workspace layer (`<ws>/settings.json`).
 * One section per event; each matcher group holds one or more commands. The
 * raw JSON editor shows the exact `hooks` object Claude Code reads.
 */
export function HooksPanel(props: { readonly workspaceId: string | null; readonly projectId?: string | null }) {
  return <HooksPanelContent key={`${props.workspaceId}:${props.projectId ?? ''}`} {...props} />
}

function HooksPanelContent({ workspaceId, projectId }: { readonly workspaceId: string | null; readonly projectId?: string | null }) {
  const [loaded, setLoaded] = useScopedState<HooksConfigRow | null>(null)
  const [hooks, setHooks] = useScopedState<HooksSectionRow | null>(null)
  const [original, setOriginal] = useScopedState<HooksSectionRow | null>(null)
  const [disableAll, setDisableAll] = useScopedState(false)
  const [originalDisableAll, setOriginalDisableAll] = useScopedState(false)
  const [rawMode, setRawMode] = useScopedState(false)
  const [rawDraft, setRawDraft] = useScopedState('')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  /** `event:index` of the group awaiting a remove confirmation. */
  const [removing, setRemoving] = useScopedState<string | null>(null)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const load = useCallback(async () => {
    if (workspaceId === null) return
    try {
      const row = await fetchHooks(workspaceId, projectId)
      const section = validateHooksSection(row.hooks)
      setLoaded(row)
      setHooks(section)
      setOriginal(section)
      setDisableAll(row.disableAllHooks)
      setOriginalDisableAll(row.disableAllHooks)
      setNotice(null)
    } catch (cause) {
      setNotice({ kind: 'bad', text: String(cause) })
    }
  }, [workspaceId, projectId])

  useEffect(() => { void load() }, [load])

  useUnsavedChanges(hooks !== null && (
    (rawMode && rawDraft !== JSON.stringify(hooks, null, 2)) || JSON.stringify(hooks) !== JSON.stringify(original) || disableAll !== originalDisableAll
  ))

  if (workspaceId === null) return <WorkspaceRequired />
  if (hooks === null || loaded === null) {
    return notice?.kind === 'bad'
      ? <LoadFailed what="hooks" error={notice.text} onRetry={() => { setNotice(null); void load() }} />
      : <Notice kind="info" text="Loading hooks…" />
  }

  const dirty = JSON.stringify(hooks) !== JSON.stringify(original) || disableAll !== originalDisableAll
  const commandMissing = Object.values(hooks).some((groups) => groups?.some((group) => group.hooks.length === 0 || group.hooks.some((hook) => hook.command.trim() === ''))) === true

  const update = (mutate: (current: HooksSectionRow) => HooksSectionRow): void => {
    setHooks((current) => (current === null ? current : mutate(current)))
    setNotice(null)
  }
  const setGroups = (event: HookEvent, map: (groups: readonly HookMatcherGroupRow[]) => readonly HookMatcherGroupRow[]): void => {
    update((current) => {
      const next = map(current[event] ?? [])
      const copy: Partial<Record<HookEvent, readonly HookMatcherGroupRow[]>> = { ...current }
      if (next.length === 0) delete copy[event]
      else copy[event] = next
      return copy
    })
  }
  const updateGroup = (event: HookEvent, index: number, map: (group: HookMatcherGroupRow) => HookMatcherGroupRow): void => {
    setGroups(event, (groups) => groups.map((group, i) => (i === index ? map(group) : group)))
  }
  const updateCommand = (event: HookEvent, index: number, hookIndex: number, map: (hook: HookCommandRow) => HookCommandRow): void => {
    updateGroup(event, index, (group) => ({ ...group, hooks: group.hooks.map((hook, i) => (i === hookIndex ? map(hook) : hook)) }))
  }

  const save = (): Promise<void> => run('save', async () => {
    if (commandMissing) return
    let validated: HooksSectionRow
    try { validated = validateHooksSection(hooks) }
    catch (cause) { setNotice({ kind: 'bad', text: cause instanceof Error ? cause.message : String(cause) }); return }
    await saveHooks(workspaceId, validated, disableAll)
    setOriginal(validated)
    setOriginalDisableAll(disableAll)
    setNotice({ kind: 'ok', text: `Saved ${loaded.file}.` })
    void load()
  })

  const openRaw = (): void => { setRawDraft(JSON.stringify(hooks, null, 2)); setRawMode(true); setNotice(null) }
  const applyRaw = (): void => {
    try {
      const parsed: unknown = JSON.parse(rawDraft)
      setHooks(validateHooksSection(parsed))
      setRawMode(false)
      setNotice(null)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setNotice({ kind: 'bad', text: detail.startsWith('Hooks validation error:') ? detail : `Invalid JSON: ${detail}` })
    }
  }

  // Live switch: flips this workspace's on/off state for one hook from any
  // layer; the Claude settings files stay exactly as written.
  const toggle = (hookId: string, active: boolean): Promise<void> => run(`toggle:${hookId}`, async () => {
    await setHookActive(workspaceId, hookId, active)
    setLoaded((current) => current === null ? current : {
      ...current,
      effective: current.effective.map((row) => (row.id === hookId ? { ...row, active } : row)),
    })
  })

  // Hooks of other layers (read-only here), grouped by event.
  const foreign = new Map<string, EffectiveHookRow[]>()
  for (const row of loaded.effective) {
    if (row.layer === 'workspace') continue
    foreign.set(row.event, [...(foreign.get(row.event) ?? []), row])
  }
  /** The workspace-layer row (id/active state) of one editable command. */
  const ownRow = (event: HookEvent, matcher: string | undefined, command: string): EffectiveHookRow | undefined =>
    loaded.effective.find((row) => row.layer === 'workspace' && row.event === event && row.matcher === (matcher ?? '') && row.command === command)
  const activeCount = loaded.effective.filter((row) => row.active && row.supported).length
  const unsupportedEvents = [...new Set(loaded.effective.filter((row) => !row.supported).map((row) => row.event))]

  return (
    <PanelBody>
      <div className="flex flex-col gap-2">
        <IsolationNote />
        <PanelIntro>
          Claude Code hooks from <code>~/.claude/settings.json</code>, this workspace (<code className="break-all">{loaded.file}</code>) and the
          project's <code>.claude/settings*.json</code>. Every matching active hook runs through the shell in the project folder. Switch a hook
          off to stop it in this workspace without editing its file. A hook can narrow what a turn may do, never widen it.
        </PanelIntro>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line p-3.5">
        <Switch
          label="Disable all hooks"
          hint={`Writes disableAllHooks: true to this workspace's settings.json — every layer stops, as in Claude Code. ${activeCount} of ${loaded.effective.length} hooks are active.`}
          checked={disableAll}
          onChange={(next) => { setDisableAll(next); setNotice(null) }}
        />
        <Disclosure summary="Source files">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
            {loaded.sources.map((source) => (
              <li key={source.path} className="flex items-center gap-2">
                <Badge tone={source.exists ? 'blue' : 'gray'}>{source.layer}</Badge>
                <code className="break-all font-mono">{source.path}</code>
                {source.exists ? null : <span className="text-fg-faint">(not present)</span>}
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>

      {loaded.diagnostics.length > 0 ? (
        <Notice kind="info" text={`Skipped entries: ${loaded.diagnostics.join(' · ')}`} />
      ) : null}
      {unsupportedEvents.length > 0 ? (
        <Notice kind="info" text={`Kept but not run by dnt-harness: ${unsupportedEvents.join(', ')}.`} />
      ) : null}

      {rawMode ? (
        <Section title="Raw hooks (workspace settings.json)">
          <Field label='"hooks"' hint="The exact object Claude Code reads. Apply validates it and loads it back into the form; nothing is saved until Save.">
            <CodeArea tall value={rawDraft} onChange={(e) => setRawDraft(e.target.value)} />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setRawMode(false); setNotice(null) }}>Back to form</Button>
            <Button variant="primary" size="sm" onClick={applyRaw}>Apply JSON</Button>
          </div>
        </Section>
      ) : HOOK_EVENTS.map((entry) => {
        const groups = hooks[entry.key] ?? []
        const others = foreign.get(entry.key) ?? []
        const total = others.length + groups.reduce((sum, group) => sum + group.hooks.length, 0)
        return (
          <section key={entry.key} className="hooks-event flex min-w-0 flex-col gap-2 rounded-xl border border-line p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="font-mono text-[13px] font-semibold">{entry.key}</code>
              <Badge>{total}</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-fg-faint" title={entry.hint}>{entry.hint}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setGroups(entry.key, (list) => [...list, { ...(entry.matcher !== undefined ? { matcher: '' } : {}), hooks: [{ type: 'command', command: '' }] }])}
              >
                <Icon name="plus" size={13} />Add
              </Button>
            </div>
            {total === 0 ? <p className="m-0 text-xs text-fg-faint">No hooks.</p> : null}
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {others.map((row) => (
                <HookRow
                  key={row.id}
                  row={row}
                  matcherLabel={entry.matcher}
                  busy={busy !== null}
                  onToggle={(active) => void toggle(row.id, active)}
                />
              ))}
              {groups.flatMap((group, index) => group.hooks.map((hook, hookIndex) => {
                const own = ownRow(entry.key, group.matcher, hook.command)
                return (
                  <li key={`ws-${index}-${hookIndex}`} className="hooks-binding flex min-w-0 flex-col gap-2 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone="blue">workspace</Badge>
                      {entry.matcher !== undefined ? (
                        <TextInput
                          mono
                          aria-label={`Matcher of ${entry.key} hook ${index + 1}`}
                          className="w-40 shrink-0"
                          value={group.matcher ?? ''}
                          placeholder="*"
                          onChange={(e) => updateGroup(entry.key, index, (row) => {
                            const { matcher: _dropped, ...rest } = row
                            void _dropped
                            return e.target.value === '' ? rest : { ...rest, matcher: e.target.value }
                          })}
                        />
                      ) : null}
                      <TextInput
                        mono
                        aria-label={`Command of ${entry.key} hook ${index + 1}`}
                        invalid={hook.command.trim() === ''}
                        className="min-w-0 flex-1"
                        value={hook.command}
                        placeholder={'"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.sh'}
                        onChange={(e) => updateCommand(entry.key, index, hookIndex, (row) => ({ ...row, command: e.target.value }))}
                      />
                      <TextInput
                        mono
                        aria-label={`Timeout in seconds of ${entry.key} hook ${index + 1}`}
                        className="w-16 shrink-0"
                        inputMode="numeric"
                        placeholder="60s"
                        value={hook.timeout !== undefined ? String(hook.timeout) : ''}
                        onChange={(e) => updateCommand(entry.key, index, hookIndex, (row) => {
                          const digits = e.target.value.replace(/\D/g, '')
                          const { timeout: _dropped, ...rest } = row
                          void _dropped
                          return digits === '' || Number(digits) <= 0 ? rest : { ...rest, timeout: Number(digits) }
                        })}
                      />
                      {own !== undefined ? (
                        <ActiveSwitch label={`${entry.key} ${hook.command}`} checked={own.active} disabled={busy !== null} onChange={(active) => void toggle(own.id, active)} />
                      ) : <span className="w-9 shrink-0 text-center text-[10px] text-fg-faint" title="Save to enable the switch">new</span>}
                      <IconButton
                        label={`Remove ${entry.key} hook ${index + 1}`}
                        className="hover:text-bad"
                        disabled={busy !== null}
                        onClick={() => setRemoving(`${entry.key}:${index}:${hookIndex}`)}
                      >
                        <Icon name="trash" size={14} />
                      </IconButton>
                    </div>
                    {removing === `${entry.key}:${index}:${hookIndex}` ? (
                      <InlineConfirm
                        message={`Remove this ${entry.key} hook? It is gone after you save.`}
                        confirmLabel="Remove"
                        busy={false}
                        onConfirm={() => {
                          setRemoving(null)
                          setGroups(entry.key, (list) => list.flatMap((row, i) => {
                            if (i !== index) return [row]
                            const rest = row.hooks.filter((_, h) => h !== hookIndex)
                            return rest.length === 0 ? [] : [{ ...row, hooks: rest }]
                          }))
                        }}
                        onCancel={() => setRemoving(null)}
                      />
                    ) : null}
                  </li>
                )
              }))}
            </ul>
          </section>
        )
      })}
      <SaveBar
        dirty={dirty}
        busy={busy !== null}
        saving={busy === 'save'}
        notice={notice}
        blocker={rawMode ? 'Apply or leave the raw JSON first.' : commandMissing ? 'Every hook needs a command.' : null}
        extra={!rawMode ? <Button variant="outline" size="sm" disabled={busy !== null} onClick={openRaw}><Icon name="fileJson" size={13} />Edit raw JSON</Button> : null}
        onSave={() => void save()}
        onDiscard={() => { if (original !== null) { setHooks(original); setDisableAll(originalDisableAll); setNotice(null) } }}
      />
    </PanelBody>
  )
}

/** A small labelled on/off switch for one hook. */
function ActiveSwitch({ label, checked, disabled, onChange }: { readonly label: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (next: boolean) => void }) {
  return (
    <RadixSwitch.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={`${checked ? 'Deactivate' : 'Activate'} hook ${label}`}
      title={checked ? 'Active — click to switch off in this workspace' : 'Inactive in this workspace — click to switch on'}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong transition-colors disabled:opacity-50 data-[state=checked]:bg-primary"
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-bg shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  )
}

/** One read-only hook from another layer: layer, matcher, command, on/off. */
function HookRow({ row, matcherLabel, busy, onToggle }: {
  readonly row: EffectiveHookRow
  readonly matcherLabel: string | undefined
  readonly busy: boolean
  readonly onToggle: (active: boolean) => void
}) {
  // `"/opt/homebrew/bin/node" "/Users/x/.claude/hooks/privacy-block.cjs"` → `privacy-block.cjs`
  const script = [...row.command.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '').pop() ?? row.command
  const name = script.split(/[\\/]/).pop() ?? script
  return (
    <li className={cn('hooks-row flex min-w-0 items-center gap-2 py-1.5', !row.active && 'opacity-55')}>
      <Badge tone={row.layer === 'user' ? 'green' : 'amber'}>{row.layer === 'user' ? '~/.claude' : row.layer}</Badge>
      {matcherLabel !== undefined ? (
        <code className="w-40 shrink-0 truncate font-mono text-xs text-fg-muted" title={row.matcher === '' ? 'matches everything' : row.matcher}>{row.matcher === '' ? '*' : row.matcher}</code>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px]">{name}</span>
        <code className="truncate font-mono text-[11px] text-fg-faint" title={`${row.command}\n${row.source}`}>{row.command}</code>
      </span>
      {!row.supported ? <Badge>not run</Badge> : null}
      <ActiveSwitch label={`${row.event} ${name}`} checked={row.active} disabled={busy} onChange={onToggle} />
    </li>
  )
}

