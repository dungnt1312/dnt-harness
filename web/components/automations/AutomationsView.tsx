import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Switch } from '../ui/Switch.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { EmptyState, ItemList, ItemRow, RowMenu } from '../settings/settings-kit.tsx'
import { ModeMenu } from '../composer/ComposerControls.tsx'
import { ModelMenu } from '../composer/ModelMenu.tsx'
import { ThinkingMenu } from '../composer/ThinkingMenu.tsx'
import { composerChipClass } from '../composer/composer-chip.ts'
import {
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  listPushDevices,
  previewSchedules,
  removePushDevice,
  runAutomationNow,
  sendTestPush,
  updateAutomation,
  type AutomationInput,
  type AutomationRow,
  type AutomationRun,
  type AutomationRunStatus,
  type PushDevice,
} from '../../lib/api.ts'
import { describePlan, formatRunTime, newRule, rulesToSchedules, schedulesToRules, type ScheduleRule } from '../../lib/automation-schedule.ts'
import { ScheduleEditor, endFields, endRuleOf, type EndRule } from './ScheduleEditor.tsx'
import { NotifyChannelsPanel, NotifyTargets } from './NotifyChannelsPanel.tsx'
import { decodeModelChoice, encodeModelChoice, type ModelOption } from '../../lib/providers.ts'
import { cn } from '../../lib/cn.ts'
import type { ModelDefaults, ModelSettings, ProjectRow, ProviderSummary } from '../../lib/types.ts'
import { currentEndpoint, enablePush, pushSupport } from '../../pwa/push-client.ts'

/** What the editor needs from the shell to render the composer-style chips. */
export interface AutomationControlsContext {
  readonly projects: readonly ProjectRow[]
  readonly modes: readonly { readonly value: string; readonly label: string }[]
  readonly defaultModeId: string | null
  readonly modelOptions: readonly ModelOption[]
  readonly providers: readonly ProviderSummary[]
  readonly defaults: ModelDefaults | null
}

const STATUS: Readonly<Record<AutomationRunStatus, { readonly label: string; readonly tone: 'gray' | 'blue' | 'green' | 'amber' | 'red' }>> = {
  started: { label: 'Running', tone: 'blue' },
  done: { label: 'Done', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  'needs-approval': { label: 'Needs approval', tone: 'amber' },
  missed: { label: 'Missed', tone: 'gray' },
  'skipped-busy': { label: 'Skipped', tone: 'gray' },
}

function errorText(cause: unknown): string {
  const text = String(cause instanceof Error ? cause.message : cause)
  const match = /HTTP \d+: (.*)$/s.exec(text)
  if (match?.[1] !== undefined) {
    try {
      const parsed = JSON.parse(match[1]) as { error?: string }
      if (typeof parsed.error === 'string') return parsed.error
    } catch {
      return match[1]
    }
  }
  return text
}

/**
 * Automations: the list of scheduled prompts (plus this device's notification
 * setup) or one editor. `automationId` selects the editor; `'new'` is blank.
 */
export function AutomationsView({ workspaceId, automationId, context, onNavigate, onOpenSession, notify }: {
  readonly workspaceId: string
  readonly automationId: string | undefined
  readonly context: AutomationControlsContext
  readonly onNavigate: (automationId: string | undefined) => void
  readonly onOpenSession: (sessionId: string) => void
  readonly notify: (text: string, tone?: 'ok') => void
}) {
  const [rows, setRows] = useState<readonly AutomationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRows(await listAutomations(workspaceId))
      setError(null)
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [workspaceId])

  useEffect(() => { setRows(null); void refresh() }, [refresh])

  const editing = automationId !== undefined
    ? automationId === 'new' ? null : rows?.find((row) => row.id === automationId)
    : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-6">
        {automationId === undefined ? (
          <AutomationList
            rows={rows}
            error={error}
            workspaceId={workspaceId}
            onRetry={() => void refresh()}
            onOpen={onNavigate}
            onChanged={refresh}
            notify={notify}
            onOpenSession={onOpenSession}
          />
        ) : rows === null ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted"><Spinner size={14} />Loading automation…</div>
        ) : editing === undefined ? (
          <EmptyState>This automation no longer exists. <button type="button" className="text-link underline" onClick={() => onNavigate(undefined)}>Back to Automations</button></EmptyState>
        ) : (
          <AutomationEditor
            key={editing?.id ?? 'new'}
            workspaceId={workspaceId}
            row={editing}
            context={context}
            onBack={() => onNavigate(undefined)}
            onSaved={async (saved) => { await refresh(); onNavigate(saved.id) }}
            onOpenSession={onOpenSession}
            notify={notify}
          />
        )}
      </div>
    </div>
  )
}

function AutomationList({ rows, error, workspaceId, onRetry, onOpen, onChanged, notify, onOpenSession }: {
  readonly rows: readonly AutomationRow[] | null
  readonly error: string | null
  readonly workspaceId: string
  readonly onRetry: () => void
  readonly onOpen: (id: string | undefined) => void
  readonly onChanged: () => Promise<void>
  readonly notify: (text: string, tone?: 'ok') => void
  readonly onOpenSession: (sessionId: string) => void
}) {
  const [lastRuns, setLastRuns] = useState<Readonly<Record<string, AutomationRun | undefined>>>({})
  useEffect(() => {
    if (rows === null) return
    let cancelled = false
    void Promise.all(rows.map(async (row) => [row.id, (await listAutomationRuns(workspaceId, row.id).catch(() => []))[0]] as const))
      .then((entries) => { if (!cancelled) setLastRuns(Object.fromEntries(entries)) })
    return () => { cancelled = true }
  }, [rows, workspaceId])

  const toggle = async (row: AutomationRow, enabled: boolean): Promise<void> => {
    try {
      await updateAutomation(workspaceId, row.id, { enabled })
      await onChanged()
    } catch (cause) {
      notify(errorText(cause))
    }
  }
  const remove = async (row: AutomationRow): Promise<void> => {
    if (!window.confirm(`Delete "${row.title}"? Past run conversations are kept.`)) return
    try {
      await deleteAutomation(workspaceId, row.id)
      await onChanged()
      notify('Automation deleted', 'ok')
    } catch (cause) {
      notify(errorText(cause))
    }
  }
  const runNow = async (row: AutomationRow): Promise<void> => {
    try {
      const started = await runAutomationNow(workspaceId, row.id)
      if (started.skipped === true) notify('Still running from the last time; skipped.')
      else if (started.sessionId !== undefined) onOpenSession(started.sessionId)
    } catch (cause) {
      notify(errorText(cause))
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-xl font-semibold tracking-tight">Automations</h1>
          <p className="m-0 text-sm text-fg-muted">Prompts the agent runs on a schedule, each in a new conversation. Runs need this host to be up.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => onOpen('new')}><Icon name="plus" size={15} />New scheduled task</Button>
      </div>

      <NotificationsCard notify={notify} />

      {error !== null ? (
        <EmptyState>Automations could not be loaded: {error}. <button type="button" className="text-link underline" onClick={onRetry}>Retry</button></EmptyState>
      ) : rows === null ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted"><Spinner size={14} />Loading automations…</div>
      ) : rows.length === 0 ? (
        <EmptyState>No automations yet. Create one to have the agent remind you, summarize, or check something on a schedule.</EmptyState>
      ) : (
        <ItemList label="Automations">
          {rows.map((row) => {
            const last = lastRuns[row.id]
            return (
              <ItemRow
                key={row.id}
                title={(
                  <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => onOpen(row.id)}>{row.title}</button>
                )}
                meta={(
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{describePlan(row.schedules, row.endsAt, row.maxRuns)}</span>
                    {row.finished ? <Badge tone="gray">Finished</Badge> : null}
                    {row.enabled && row.nextRuns[0] !== undefined ? <span>Next {formatRunTime(row.nextRuns[0])}</span> : null}
                    {last !== undefined ? <Badge tone={STATUS[last.status].tone}>{STATUS[last.status].label}</Badge> : null}
                  </span>
                )}
                actions={(
                  <>
                    {row.finished ? null : <Switch checked={row.enabled} label={row.enabled ? 'On' : 'Paused'} onChange={(next) => void toggle(row, next)} />}
                    <RowMenu
                      label={`Actions for ${row.title}`}
                      actions={[
                        { label: 'Edit', icon: 'pencil', onSelect: () => onOpen(row.id) },
                        { label: 'Run now', icon: 'zap', onSelect: () => void runNow(row) },
                        { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void remove(row) },
                      ]}
                    />
                  </>
                )}
              />
            )
          })}
        </ItemList>
      )}
    </>
  )
}

/** This device's push subscription plus every registered device. */
function NotificationsCard({ notify }: { readonly notify: (text: string, tone?: 'ok') => void }) {
  const support = useMemo(() => pushSupport(), [])
  const [devices, setDevices] = useState<readonly PushDevice[] | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setDevices(await listPushDevices().catch(() => []))
    setEndpoint(await currentEndpoint().catch(() => null))
  }, [])
  useEffect(() => { void load() }, [load])

  const subscribed = endpoint !== null && devices?.some((device) => device.endpoint === endpoint) === true
  const enable = async (): Promise<void> => {
    setBusy(true)
    try {
      await enablePush()
      await load()
      notify('Notifications enabled on this device', 'ok')
    } catch (cause) {
      notify(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await sendTestPush()
      notify(result.sent > 0 ? `Test sent to ${result.sent} device${result.sent === 1 ? '' : 's'}` : 'No device received the test', result.sent > 0 ? 'ok' : undefined)
      await load()
    } catch (cause) {
      notify(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (device: PushDevice): Promise<void> => {
    try {
      await removePushDevice(device.id)
      await load()
    } catch (cause) {
      notify(errorText(cause))
    }
  }

  return (
    <section aria-label="Notifications" className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="bell" size={16} className="text-fg-muted" />
          <span className="text-sm font-medium">Notifications</span>
          {subscribed ? <Badge tone="green">On for this device</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!subscribed && support === 'supported' ? <Button size="sm" variant="primary" disabled={busy} onClick={() => void enable()}>Enable on this device</Button> : null}
          <Button size="sm" disabled={busy || (devices?.length ?? 0) === 0} onClick={() => void test()}>Test push</Button>
        </div>
      </div>
      {support === 'needs-install' ? (
        <p className="m-0 text-[13px] text-fg-muted">On iPhone and iPad, tap Share, then Add to Home Screen, open the app from there and enable notifications.</p>
      ) : support === 'insecure' ? (
        <p className="m-0 text-[13px] text-fg-muted">Push needs HTTPS. Open this app through an HTTPS address (for example <code>tailscale serve</code>) or on localhost.</p>
      ) : support === 'unsupported' ? (
        <p className="m-0 text-[13px] text-fg-muted">This browser cannot receive push notifications.</p>
      ) : null}
      {devices !== null && devices.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-2 text-[13px] text-fg-muted">
              <span className="truncate">{device.label}{device.endpoint === endpoint ? ' (this device)' : ''}</span>
              <button type="button" className="shrink-0 text-fg-faint hover:text-bad" aria-label={`Remove ${device.label}`} onClick={() => void remove(device)}><Icon name="close" size={14} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <NotifyChannelsPanel notify={notify} errorText={errorText} />
    </section>
  )
}

function AutomationEditor({ workspaceId, row, context, onBack, onSaved, onOpenSession, notify }: {
  readonly workspaceId: string
  readonly row: AutomationRow | null
  readonly context: AutomationControlsContext
  readonly onBack: () => void
  readonly onSaved: (saved: AutomationRow) => Promise<void>
  readonly onOpenSession: (sessionId: string) => void
  readonly notify: (text: string, tone?: 'ok') => void
}) {
  const [tab, setTab] = useState<'settings' | 'history'>('settings')
  const [title, setTitle] = useState(row?.title ?? 'Untitled Automation')
  const [prompt, setPrompt] = useState(row?.prompt ?? '')
  const [rules, setRules] = useState<readonly ScheduleRule[]>(() => (row !== null ? schedulesToRules(row.schedules) : [newRule('daily')]))
  const [end, setEnd] = useState<EndRule>(() => endRuleOf(row?.endsAt ?? null, row?.maxRuns ?? null))
  const [projectId, setProjectId] = useState<string | null>(row?.projectId ?? null)
  const [modeId, setModeId] = useState<string | null>(row?.modeId ?? context.defaultModeId)
  const [controls, setControls] = useState(() => row?.controls ?? context.defaults)
  const [notifyMe, setNotifyMe] = useState(row?.notify ?? true)
  // Null = every destination (also how older rows read); the picker makes it explicit once touched.
  const [targets, setTargets] = useState<readonly string[] | null>(row?.notifyTargets ?? null)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ readonly next: readonly number[] } | { readonly error: string } | null>(null)

  // One-time-only plans have no end condition: they already end.
  const plan = useMemo(() => {
    const schedules = rulesToSchedules(rules)
    const recurring = rules.some((rule) => rule.kind !== 'once')
    return { schedules, ...(recurring ? endFields(end) : { endsAt: null, maxRuns: null }) }
  }, [rules, end])
  useEffect(() => {
    if (plan.schedules.length === 0) { setPreview(null); return }
    if (plan.schedules.some((s) => 'at' in s && Number.isNaN(s.at))) { setPreview({ error: 'Pick a date and time.' }); return }
    let cancelled = false
    const timer = setTimeout(() => {
      previewSchedules(plan)
        .then((result) => { if (!cancelled) setPreview(result) })
        .catch((cause: unknown) => { if (!cancelled) setPreview({ error: errorText(cause) }) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [plan])

  const modelValue = controls?.provider != null && controls.model != null ? encodeModelChoice(controls.provider, controls.model) : null
  const modelId = controls?.model ?? null
  const modelSettings: Readonly<Record<string, ModelSettings>> | undefined = controls?.provider != null
    ? context.providers.find((provider) => provider.id === controls.provider)?.modelSettings
    : undefined
  const modelLabel = context.modelOptions.find((option) => option.value === modelValue)?.label ?? controls?.model ?? 'Default model'

  const noFutureRuns = preview !== null && 'next' in preview && preview.next.length === 0
  const canSave = title.trim() !== '' && prompt.trim() !== '' && rules.length > 0 && !(preview !== null && 'error' in preview) && !noFutureRuns && !saving
  const save = async (): Promise<void> => {
    setSaving(true)
    const input: AutomationInput = {
      title: title.trim(),
      prompt,
      ...plan,
      projectId,
      modeId,
      controls: controls ?? null,
      notify: notifyMe,
      notifyTargets: targets,
      // Saving a plan with runs ahead turns a paused or finished task back on.
      enabled: true,
    }
    try {
      const saved = row === null ? await createAutomation(workspaceId, input) : await updateAutomation(workspaceId, row.id, input)
      notify(row === null ? 'Scheduled task created' : 'Saved', 'ok')
      await onSaved(saved)
    } catch (cause) {
      notify(errorText(cause))
    } finally {
      setSaving(false)
    }
  }

  const projectName = context.projects.find((project) => project.id === projectId)?.name ?? 'Chat only'

  return (
    <>
      <div className="flex flex-col gap-1">
        <button type="button" className="flex w-fit items-center gap-1 text-[13px] text-fg-muted hover:text-fg" onClick={onBack}>
          <Icon name="chevron" size={14} className="rotate-90" />Automations
        </button>
        <h1 className="m-0 text-xl font-semibold tracking-tight">{row === null ? 'New scheduled task' : row.title}</h1>
        <p className="m-0 text-sm text-fg-muted">Configure when this task runs, what it does, and how it works.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Automation view"
          value={tab}
          options={[{ value: 'settings', label: 'Settings' }, { value: 'history', label: 'History' }]}
          onChange={setTab}
        />
        {tab === 'settings' ? (
          <Button variant="primary" size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? <Spinner size={13} /> : null}{row === null ? 'Create scheduled task' : 'Save'}
          </Button>
        ) : null}
      </div>

      {tab === 'history' ? (
        row === null
          ? <EmptyState>History appears after the task is created.</EmptyState>
          : <RunHistory workspaceId={workspaceId} automation={row} onOpenSession={onOpenSession} notify={notify} />
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-fg-muted">Task title</span>
            <TextInput value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-fg-muted">Schedule</span>
            <ScheduleEditor rules={rules} onRules={setRules} end={end} onEnd={setEnd} />
            {preview !== null ? (
              'error' in preview
                ? <p className="m-0 text-[13px] text-bad">{preview.error}</p>
                : preview.next.length === 0
                  ? <p className="m-0 text-[13px] text-warn">This schedule has no runs left. Pick a later time or change when it ends.</p>
                  : <p className="m-0 text-[13px] text-fg-faint">Next: {preview.next.map(formatRunTime).join(', ')}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-fg-muted">Instructions</span>
            <div className="flex flex-col rounded-xl border border-line bg-surface focus-within:border-fg-faint">
              <textarea
                aria-label="Instructions"
                className="min-h-32 resize-y bg-transparent px-3 py-2.5 text-sm outline-none"
                placeholder="e.g. Review commits from the last 24 hours and summarize likely bugs and fixes"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-1 border-t border-line px-1.5 py-1">
                <div className="flex min-w-0 items-center gap-1">
                  <Menu
                    label="Project folder"
                    side="top"
                    compact
                    triggerClassName={composerChipClass}
                    trigger={() => (<><Icon name="folder" size={15} /><span className="truncate">{projectName}</span><Icon name="chevron" size={13} /></>)}
                  >
                    {(close) => (
                      <>
                        <button type="button" role="menuitemradio" aria-checked={projectId === null} className={menuItemClass} onClick={() => { setProjectId(null); close() }}>
                          <span className="flex-1">Chat only</span>{projectId === null ? <Icon name="check" size={15} /> : null}
                        </button>
                        {context.projects.map((project) => (
                          <button key={project.id} type="button" role="menuitemradio" aria-checked={projectId === project.id} className={menuItemClass} onClick={() => { setProjectId(project.id); close() }}>
                            <span className="flex-1 truncate">{project.name}</span>{projectId === project.id ? <Icon name="check" size={15} /> : null}
                          </button>
                        ))}
                      </>
                    )}
                  </Menu>
                  {context.modes.length > 0 && modeId !== null ? (
                    <ModeMenu modes={context.modes} value={modeId} label="Mode for each run" onChange={setModeId} />
                  ) : null}
                </div>
                <div className="flex min-w-0 items-center gap-1">
                  {context.modelOptions.length > 0 ? (
                    <ModelMenu
                      menuLabel="Model for each run"
                      modelLabel={modelLabel}
                      modelValue={modelValue}
                      options={context.modelOptions}
                      providers={context.providers}
                      {...(modelSettings !== undefined ? { modelSettings } : {})}
                      onModel={(value) => {
                        const choice = decodeModelChoice(value)
                        if (choice !== null) setControls({ provider: choice.provider, model: choice.model, thinkingLevel: controls?.thinkingLevel ?? null })
                      }}
                      onManage={() => notify('Manage providers in Settings.')}
                    />
                  ) : null}
                  {modelId !== null ? (
                    <ThinkingMenu
                      menuLabel="Thinking level for each run"
                      model={modelId}
                      value={controls?.thinkingLevel ?? null}
                      {...(modelSettings?.[modelId] !== undefined ? { settings: modelSettings[modelId] } : {})}
                      onSelect={(level) => setControls({ provider: controls?.provider ?? null, model: controls?.model ?? null, thinkingLevel: level })}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <NotifyTargets enabled={notifyMe} onEnabled={setNotifyMe} targets={targets} onTargets={setTargets} errorText={errorText} />
        </div>
      )}
    </>
  )
}

function RunHistory({ workspaceId, automation, onOpenSession, notify }: {
  readonly workspaceId: string
  readonly automation: AutomationRow
  readonly onOpenSession: (sessionId: string) => void
  readonly notify: (text: string, tone?: 'ok') => void
}) {
  const [runs, setRuns] = useState<readonly AutomationRun[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setRuns(await listAutomationRuns(workspaceId, automation.id).catch(() => []))
  }, [workspaceId, automation.id])
  useEffect(() => { void load() }, [load])
  // Live-ish: poll while a run is still open.
  useEffect(() => {
    if (runs?.some((run) => run.status === 'started' || run.status === 'needs-approval') !== true) return
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [runs, load])

  const runNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const started = await runAutomationNow(workspaceId, automation.id)
      notify(started.skipped === true ? 'Still running from the last time; skipped.' : 'Run started', started.skipped === true ? undefined : 'ok')
      await load()
    } catch (cause) {
      notify(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] text-fg-muted">
          {automation.enabled && automation.nextRuns[0] !== undefined ? `Next run ${formatRunTime(automation.nextRuns[0])}` : 'Paused'}
        </span>
        <Button size="sm" disabled={busy} onClick={() => void runNow()}><Icon name="zap" size={14} />Run now</Button>
      </div>
      {runs === null ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted"><Spinner size={14} />Loading history…</div>
      ) : runs.length === 0 ? (
        <EmptyState>No runs yet.</EmptyState>
      ) : (
        <ItemList label="Run history">
          {runs.map((run) => {
            const status = STATUS[run.status]
            const quiet = run.status === 'missed' || run.status === 'skipped-busy'
            return (
              <ItemRow
                key={run.runId}
                title={(
                  <span className={cn('flex items-center gap-2', quiet && 'text-fg-muted')}>
                    {formatRunTime(run.dueAt ?? run.at)}
                    {run.dueAt === null ? <span className="text-xs font-normal text-fg-faint">manual</span> : null}
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </span>
                )}
                {...(run.summary !== undefined || run.error !== undefined ? { meta: run.error ?? run.summary } : {})}
                {...(run.sessionId !== undefined ? { actions: <Button size="sm" variant="ghost" onClick={() => onOpenSession(run.sessionId!)}>Open</Button> } : {})}
              />
            )
          })}
        </ItemList>
      )}
    </div>
  )
}
