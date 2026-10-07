import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AppConfigView, LimitEdit, LimitSource } from '../../../src/harness/config/types.ts'
import type { LimitField, LimitKey } from '../../../src/harness/limits-config.ts'
import { getAppConfig, HttpError, patchAppConfig, reloadAppConfig } from '../../lib/api.ts'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { InlineConfirm, Notice, PanelBody, PanelFooter, PanelIntro, Section, useActionRunner, type NoticeState } from './settings-kit.tsx'

/** What the dialog needs to guard leaving this tab. */
export interface AdvancedGuard {
  readonly dirty: boolean
  readonly busy: boolean
  readonly discard: () => void
}

type ViewField = AppConfigView['fields'][number]

/**
 * Pending intent for one field, kept apart from the descriptor so a refreshed
 * baseline never rewrites it: a typed override (raw text, validated before
 * save) or an explicit reset back to the inherited value.
 */
type Intent = { readonly op: 'set'; readonly raw: string } | { readonly op: 'unset' }
type Edits = Readonly<Partial<Record<LimitKey, Intent>>>

const GROUPS: readonly { readonly id: LimitField['group']; readonly title: string }[] = [
  { id: 'requests', title: 'Requests' },
  { id: 'tools', title: 'Tools' },
  { id: 'context', title: 'Context' },
  { id: 'admission', title: 'Admission' },
]

const SOURCE_LABEL: Readonly<Record<LimitSource, string>> = {
  library: 'Default',
  host: 'Host default',
  file: 'Config file',
  explicit: 'Host override',
}

/** Counts are bare numbers; every other unit is shown beside the value. */
const UNIT_LABEL: Readonly<Record<LimitField['unit'], string>> = { ms: 'ms', bytes: 'bytes', chars: 'chars', count: '', ratio: 'ratio' }

/** What saving nothing for this field would leave in the file: its override, else the inherited value. */
function baselineOf(view: AppConfigView, field: ViewField): number {
  return field.fileValue ?? view.inherited[field.key]
}

/** Client-side check against the descriptor; the server re-validates every edit. */
function validate(field: LimitField, raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 'Enter a value.'
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return 'Enter a number.'
  if (field.integer && !Number.isInteger(value)) return 'Must be a whole number.'
  if (field.exclusiveMinimum ? value <= field.minimum : value < field.minimum) {
    return field.exclusiveMinimum ? `Must be greater than ${field.minimum}.` : `Must be at least ${field.minimum}.`
  }
  if (value > field.maximum) return `Must be at most ${field.maximum}.`
  return null
}

/** Whether an intent would change nothing against this descriptor. */
function isNoop(view: AppConfigView, field: ViewField, intent: Intent): boolean {
  if (intent.op === 'unset') return field.fileValue === undefined
  return intent.raw.trim() !== '' && Number(intent.raw) === baselineOf(view, field)
}

/**
 * Carry pending edits onto a refreshed descriptor. Edits that the new file
 * already satisfies are dropped, and so are edits to fields the host has
 * since locked — they could never be saved — which are reported by name.
 * Edits whose file value changed underneath them are kept but reported, so
 * the operator reviews the new baseline before anything is resubmitted.
 */
function rebase(edits: Edits, before: AppConfigView, after: AppConfigView): {
  readonly edits: Edits
  readonly changed: readonly LimitKey[]
  readonly locked: readonly string[]
} {
  const next: Partial<Record<LimitKey, Intent>> = {}
  const changed: LimitKey[] = []
  const locked: string[] = []
  for (const [key, intent] of Object.entries(edits) as [LimitKey, Intent][]) {
    const now = after.fields.find((field) => field.key === key)
    if (now === undefined || isNoop(after, now, intent)) continue
    if (now.locked) {
      locked.push(now.label)
      continue
    }
    next[key] = intent
    const was = before.fields.find((field) => field.key === key)
    if (was?.fileValue !== now.fileValue) changed.push(key)
  }
  return { edits: next, changed, locked }
}

/** The server's refusal message and code from a JSON error body, when there is one. */
function refusalOf(cause: unknown): { readonly code: string | null; readonly message: string } {
  if (!(cause instanceof HttpError)) return { code: null, message: cause instanceof Error ? cause.message : String(cause) }
  try {
    const body = JSON.parse(cause.body) as { readonly error?: unknown; readonly code?: unknown }
    if (typeof body.error === 'string') return { code: typeof body.code === 'string' ? body.code : null, message: body.error }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return { code: null, message: cause.body !== '' ? cause.body : `HTTP ${cause.status}` }
}

/**
 * Global limits, edited field by field from the component metadata the
 * descriptor carries. Only changed fields are sent, against the file hash the
 * editor loaded; a conflict refreshes the descriptor and keeps the draft.
 * "Apply file changes" is the separate path that activates manual edits.
 */
export function AdvancedPanel({ onGuardChanged }: { readonly onGuardChanged: (guard: AdvancedGuard) => void }) {
  const [view, setView] = useScopedState<AppConfigView | null>(null)
  const [loadError, setLoadError] = useScopedState<string | null>(null)
  const [edits, setEdits] = useScopedState<Edits>({})
  /** Edited fields that also changed in the file; saving waits until the operator keeps the edits. */
  const [remote, setRemote] = useScopedState<readonly LimitKey[]>([])
  const [conflict, setConflict] = useScopedState(false)
  const [confirmApply, setConfirmApply] = useScopedState(false)
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const load = async (): Promise<void> => {
    setLoadError(null)
    try {
      setView(await getAppConfig())
    } catch (cause) {
      setLoadError(refusalOf(cause).message)
    }
  }
  useEffect(() => { void load() }, [])

  const dirty = Object.keys(edits).length > 0
  const discard = (): void => {
    setEdits({})
    setRemote([])
    setConflict(false)
    setConfirmApply(false)
    setNotice(null)
  }

  // The parent reads the guard while handling Escape or a tab press, so it is
  // published at layout time — never a paint behind the latest keystroke. The
  // discard handed out stays stable and always reaches the current setters.
  const latest = useRef({ discard, onGuardChanged })
  useLayoutEffect(() => { latest.current = { discard, onGuardChanged } })
  const stableDiscard = useRef(() => latest.current.discard()).current
  useLayoutEffect(() => {
    latest.current.onGuardChanged({ dirty, busy: busy !== null, discard: stableDiscard })
  }, [dirty, busy])

  if (view === null) {
    if (loadError === null) return <div className="flex items-center gap-2 text-[13px] text-fg-muted"><Spinner />Loading…</div>
    return (
      <PanelBody>
        <Notice kind="bad" text={loadError} />
        <div><Button size="sm" onClick={() => void load()}>Retry</Button></div>
      </PanelBody>
    )
  }

  const editable = view.hash !== null && busy === null
  const setIntent = (field: ViewField, intent: Intent): void => {
    setEdits((current) => {
      const next = { ...current }
      if (isNoop(view, field, intent)) delete next[field.key]
      else next[field.key] = intent
      return next
    })
    setRemote((current) => current.filter((key) => key !== field.key))
    setNotice(null)
  }

  const errors = view.fields.flatMap((field) => {
    const intent = edits[field.key]
    const error = intent?.op === 'set' ? validate(field, intent.raw) : null
    return error === null ? [] : [field.key]
  })
  const saveBlocker = view.hash === null ? 'Fix the configuration file first.'
    : conflict ? 'Refresh first: the file changed since it was loaded.'
    : remote.length > 0 ? 'Review the fields that changed in the file first.'
    : errors.length > 0 ? 'Fix the highlighted values first.'
    : !dirty ? 'No changes to save.'
    : null

  const save = (): Promise<void> =>
    run('save', async () => {
      if (view.hash === null) return
      // Descriptor order, so the request reads like the form.
      const payload: LimitEdit[] = view.fields.flatMap((field): LimitEdit[] => {
        const intent = edits[field.key]
        if (intent === undefined) return []
        return [intent.op === 'unset' ? { op: 'unset', key: field.key } : { op: 'set', key: field.key, value: Number(intent.raw) }]
      })
      try {
        const next = await patchAppConfig(payload, view.hash)
        setView(next)
        setEdits({})
        setRemote([])
        setNotice({ kind: 'ok', text: 'Saved. New limits apply from the next operation.' })
      } catch (cause) {
        const refusal = refusalOf(cause)
        if (refusal.code === 'conflict') {
          setConflict(true)
          setNotice(null)
        } else setNotice({ kind: 'bad', text: refusal.message })
      }
    })

  /** Conflict recovery: a fresh descriptor and hash under the same draft. Never resubmits by itself. */
  const refresh = (): Promise<void> =>
    run('refresh', async () => {
      try {
        const next = await getAppConfig()
        const rebased = rebase(edits, view, next)
        setView(next)
        setEdits(rebased.edits)
        setRemote(rebased.changed)
        setConflict(false)
        if (rebased.locked.length > 0) {
          const names = rebased.locked.join(', ')
          setNotice({ kind: 'info', text: `${names} ${rebased.locked.length === 1 ? 'is' : 'are'} now locked by the host; your ${rebased.locked.length === 1 ? 'edit was' : 'edits were'} removed.` })
        } else {
          setNotice(rebased.changed.length > 0 ? null : { kind: 'info', text: 'Loaded the latest file. Your edits are kept; save again when ready.' })
        }
      } catch (cause) {
        setNotice({ kind: 'bad', text: refusalOf(cause).message })
      }
    })

  const applyFile = (): Promise<void> =>
    run('apply', async () => {
      setConfirmApply(false)
      try {
        const next = await reloadAppConfig()
        setView(next)
        setEdits({})
        setRemote([])
        setConflict(false)
        setNotice(next.error === undefined ? { kind: 'ok', text: 'Applied the configuration file.' } : null)
      } catch (cause) {
        setNotice({ kind: 'bad', text: refusalOf(cause).message })
      }
    })

  const remoteLabels = view.fields.filter((field) => remote.includes(field.key)).map((field) => field.label)

  return (
    <PanelBody>
      <PanelIntro>
        Limits for every workspace, in their native units. Changes apply from the next operation; a host
        override locks a field. Reset returns a field to its inherited value.
      </PanelIntro>

      {view.error !== undefined ? (
        <Notice kind="bad" text={`The configuration file is invalid: ${view.error}. Fix the file, then apply it.`} />
      ) : null}
      {view.outOfSync ? (
        <div className="flex flex-col gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <span className="flex items-start gap-2">
            <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0">The configuration file changed outside this editor. Fields show the saved values; the active values differ until you apply the file.</span>
          </span>
          {confirmApply ? (
            <InlineConfirm
              message="Applying the file discards your unsaved edits here."
              confirmLabel="Apply and discard edits"
              busy={busy !== null}
              onConfirm={() => void applyFile()}
              onCancel={() => setConfirmApply(false)}
            />
          ) : (
            <div>
              <Button size="sm" disabled={busy !== null} onClick={() => { if (dirty) setConfirmApply(true); else void applyFile() }}>
                {busy === 'apply' ? 'Applying…' : 'Apply file changes'}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {GROUPS.map((group) => (
        <Section key={group.id} title={group.title}>
          <div className="grid min-w-0 gap-5 md:grid-cols-2">
            {view.fields.filter((field) => field.group === group.id).map((field) => {
              const intent = edits[field.key]
              const active = view.active.values[field.key]
              const baseline = baselineOf(view, field)
              const error = intent?.op === 'set' ? validate(field, intent.raw) : null
              const value = field.locked ? String(active)
                : intent?.op === 'set' ? intent.raw
                : intent?.op === 'unset' ? String(view.inherited[field.key])
                : String(baseline)
              const unit = UNIT_LABEL[field.unit]
              return (
                <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
                  <Field label={field.label} hint={error ?? field.hint} tone={error === null ? 'default' : 'bad'}>
                    <TextInput
                      type="number"
                      inputMode="decimal"
                      min={field.minimum}
                      max={field.maximum}
                      step={field.integer ? 1 : 'any'}
                      value={value}
                      invalid={error !== null}
                      disabled={field.locked || !editable}
                      trailing={unit === '' ? undefined : <span className="pr-3 text-xs text-fg-faint">{unit}</span>}
                      onChange={(event) => setIntent(field, { op: 'set', raw: event.target.value })}
                    />
                  </Field>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-faint">
                    <Badge tone={field.locked ? 'amber' : field.source === 'file' ? 'blue' : 'gray'}>{SOURCE_LABEL[field.source]}</Badge>
                    {intent?.op === 'unset' ? <Badge tone="amber">Resets to inherited</Badge> : intent !== undefined ? <Badge tone="amber">Edited</Badge> : null}
                    {remote.includes(field.key) ? <Badge tone="amber">Changed in file: now {baseline}{unit === '' ? '' : ` ${unit}`}</Badge> : null}
                    {field.locked ? (
                      <span className="min-w-0">
                        Locked by the host process{field.shadowed && field.fileValue !== undefined ? `; the file value ${field.fileValue} is ignored` : ''}.
                      </span>
                    ) : active !== baseline && intent === undefined ? (
                      <span className="min-w-0">Active now: {active}{unit === '' ? '' : ` ${unit}`}</span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 px-2"
                      aria-label={`Reset ${field.label}`}
                      title={field.locked ? 'Locked by the host process' : field.fileValue === undefined ? 'Not overridden in the file' : 'Return to the inherited value'}
                      disabled={field.locked || field.fileValue === undefined || intent?.op === 'unset' || !editable}
                      onClick={() => setIntent(field, { op: 'unset' })}
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </Section>
      ))}

      <PanelFooter notice={notice}>
        {conflict ? (
          <div className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <span className="min-w-0 flex-1 basis-48">The configuration file changed since it was loaded. Your edits are kept.</span>
            <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh and keep edits'}</Button>
          </div>
        ) : null}
        {remote.length > 0 ? (
          <div className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <span className="min-w-0 flex-1 basis-48">Also changed in the file: {remoteLabels.join(', ')}. Review the new saved values, then keep your edits to replace them when you save.</span>
            <Button size="sm" onClick={() => setRemote([])}>Keep my edits</Button>
          </div>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || busy !== null} onClick={discard}>Discard edits</Button>
          <Button variant="primary" size="sm" disabled={saveBlocker !== null || busy !== null} title={saveBlocker ?? undefined} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : 'Save changes'}
          </Button>
        </span>
      </PanelFooter>
    </PanelBody>
  )
}
