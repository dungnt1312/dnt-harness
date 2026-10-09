import { useCallback, useEffect, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Switch } from '../ui/Switch.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { RowMenu } from '../settings/settings-kit.tsx'
import { cn } from '../../lib/cn.ts'
import { createChannel, deleteChannel, listChannels, testChannel, updateChannel, type ChannelConfigInput, type ChannelKind, type NotifyChannel } from '../../lib/api.ts'

const LABELS: Readonly<Record<ChannelKind, string>> = { telegram: 'Telegram', teams: 'Microsoft Teams', discord: 'Discord' }

const HELP: Readonly<Record<ChannelKind, string>> = {
  telegram: 'Create a bot with @BotFather and paste its token. Send the bot a message first, then use your chat id (from @userinfobot) or @channelname.',
  teams: 'In Teams, add a Workflows "Post to a channel when a webhook request is received" flow (or an Incoming Webhook connector) and paste its URL.',
  discord: 'In Discord, open Server Settings, then Integrations, then Webhooks, create one and copy its URL.',
}

/** The Web Push target id; every other target is a channel id. */
export const PUSH_TARGET = 'push'

/**
 * The editor's "Notify me" block: a switch, then one toggle chip per
 * destination (Web Push and each channel). `targets` null means every
 * destination; the first toggle turns it into an explicit list.
 */
export function NotifyTargets({ enabled, onEnabled, targets, onTargets, errorText }: {
  readonly enabled: boolean
  readonly onEnabled: (next: boolean) => void
  readonly targets: readonly string[] | null
  readonly onTargets: (next: readonly string[]) => void
  readonly errorText: (cause: unknown) => string
}) {
  const [channels, setChannels] = useState<readonly NotifyChannel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    listChannels().then(
      (rows) => { if (!cancelled) setChannels(rows) },
      (cause: unknown) => { if (!cancelled) { setChannels([]); setError(errorText(cause)) } },
    )
    return () => { cancelled = true }
  }, [errorText])

  const options = [
    { id: PUSH_TARGET, label: 'Web Push', detail: 'your devices', off: false },
    ...(channels ?? []).map((row) => ({ id: row.id, label: row.name, detail: LABELS[row.kind], off: !row.enabled })),
  ]
  const all = options.map((option) => option.id)
  const selected = new Set(targets ?? all)
  const toggle = (id: string): void => {
    const next = selected.has(id) ? all.filter((value) => value !== id && selected.has(value)) : all.filter((value) => value === id || selected.has(value))
    onTargets(next)
  }
  // Ids saved earlier whose channel was deleted since: dropped silently by the host.
  const reachable = options.filter((option) => selected.has(option.id) && !option.off).length

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5">
      <Switch
        checked={enabled}
        label="Notify me with the result"
        hint={enabled
          ? 'The agent\'s final reply is sent to the destinations below. Failures and approvals waiting are sent there too.'
          : 'Results stay in the run\'s conversation. Failures and approvals waiting are still sent to the destinations below.'}
        onChange={onEnabled}
      />
      <div role="group" aria-label="Send to" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-xs text-fg-muted">Send to</span>
        {channels === null ? <span className="text-xs text-fg-faint">Loading channels…</span> : options.map((option) => {
          const on = selected.has(option.id)
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              title={option.off ? `${option.label} is turned off in Notifications` : option.detail}
              onClick={() => toggle(option.id)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
                on ? 'border-primary bg-primary text-primary-fg' : 'border-line text-fg-muted hover:text-fg',
                option.off && 'opacity-50',
              )}
            >
              {on ? <Icon name="check" size={13} /> : null}
              {option.label}
              <span className={on ? 'text-xs opacity-80' : 'text-xs text-fg-faint'}>{option.off ? 'off' : option.detail}</span>
            </button>
          )
        })}
      </div>
      {error !== null ? <p className="m-0 text-xs text-bad">Channels could not be loaded: {error}</p> : null}
      {channels !== null && reachable === 0 ? (
        <p className="m-0 text-xs text-warn">No destination selected: nothing will be sent, not even failures.</p>
      ) : channels !== null && channels.length === 0 ? (
        <p className="m-0 text-xs text-fg-faint">Add Telegram, Teams or Discord under Notifications on the Automations page.</p>
      ) : null}
    </div>
  )
}

/**
 * Notification channels beyond push: Telegram bot, Teams webhook, Discord
 * webhook. Secrets are write-only: editing leaves a blank field unchanged.
 */
export function NotifyChannelsPanel({ notify, errorText }: {
  readonly notify: (text: string, tone?: 'ok') => void
  readonly errorText: (cause: unknown) => string
}) {
  const [rows, setRows] = useState<readonly NotifyChannel[] | null>(null)
  const [editing, setEditing] = useState<NotifyChannel | 'new' | null>(null)
  const load = useCallback(async () => {
    try {
      setRows(await listChannels())
    } catch (cause) {
      notify(errorText(cause))
      setRows([])
    }
  }, [notify, errorText])
  useEffect(() => { void load() }, [load])

  const run = async (action: () => Promise<void>, done?: string): Promise<void> => {
    try {
      await action()
      if (done !== undefined) notify(done, 'ok')
      await load()
    } catch (cause) {
      notify(errorText(cause))
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">Channels</span>
        {editing === null ? <Button size="sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} />Add channel</Button> : null}
      </div>
      {rows !== null && rows.length === 0 && editing === null ? (
        <p className="m-0 text-[13px] text-fg-muted">Also send results to Telegram, Microsoft Teams or Discord.</p>
      ) : null}
      {rows?.map((row) => (
        editing !== 'new' && editing?.id === row.id ? (
          <ChannelForm key={row.id} existing={row} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await load() }} notify={notify} errorText={errorText} />
        ) : (
          <div key={row.id} className="flex items-center gap-2 text-[13px]">
            <Badge tone="gray">{LABELS[row.kind]}</Badge>
            <span className="min-w-0 flex-1 truncate text-fg">
              {row.name} <span className="text-fg-faint">{row.summary}</span>
              {row.mentions !== undefined && row.mentions.length > 0 ? <span className="text-fg-faint"> · @{row.mentions.join(', @')}</span> : null}
            </span>
            <Switch checked={row.enabled} label={row.enabled ? 'On' : 'Off'} onChange={(enabled) => void run(() => updateChannel(row.id, { enabled }).then(() => undefined))} />
            <RowMenu
              label={`Actions for ${row.name}`}
              actions={[
                { label: 'Send test', icon: 'send', onSelect: () => void run(() => testChannel(row.id), `Test sent to ${row.name}`) },
                { label: 'Edit', icon: 'pencil', onSelect: () => setEditing(row) },
                { label: 'Delete', icon: 'trash', danger: true, onSelect: () => { if (window.confirm(`Delete channel "${row.name}"?`)) void run(() => deleteChannel(row.id)) } },
              ]}
            />
          </div>
        )
      ))}
      {editing === 'new' ? <ChannelForm onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await load() }} notify={notify} errorText={errorText} /> : null}
    </div>
  )
}

function ChannelForm({ existing, onCancel, onSaved, notify, errorText }: {
  readonly existing?: NotifyChannel
  readonly onCancel: () => void
  readonly onSaved: () => Promise<void>
  readonly notify: (text: string, tone?: 'ok') => void
  readonly errorText: (cause: unknown) => string
}) {
  const [kind, setKind] = useState<ChannelKind>(existing?.kind ?? 'telegram')
  const [name, setName] = useState(existing?.name ?? '')
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [mentions, setMentions] = useState((existing?.mentions ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  const editing = existing !== undefined
  const secretHint = editing ? 'Leave blank to keep the saved value' : undefined

  const save = async (): Promise<void> => {
    setBusy(true)
    const config: ChannelConfigInput = kind === 'telegram'
      ? { botToken, chatId }
      : { webhookUrl, ...(kind === 'teams' ? { mentions } : {}) }
    try {
      if (existing === undefined) {
        const created = await createChannel({ kind, name, config })
        // A fresh channel proves itself right away; a failure keeps it, with the reason.
        await testChannel(created.id).then(
          () => notify(`${created.name} added; a test message was sent`, 'ok'),
          (cause: unknown) => notify(`${created.name} added, but the test failed: ${errorText(cause)}`),
        )
      } else {
        // Teams always sends its config: mentions are editable on their own,
        // and a blank webhook field keeps the saved URL host-side.
        const hasSecret = kind === 'telegram' ? botToken !== '' || chatId !== '' : webhookUrl !== ''
        await updateChannel(existing.id, { name, ...(hasSecret || kind === 'teams' ? { config } : {}) })
        notify('Channel saved', 'ok')
      }
      await onSaved()
    } catch (cause) {
      notify(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const complete = editing || (kind === 'telegram' ? botToken.trim() !== '' && chatId.trim() !== '' : webhookUrl.trim() !== '')
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-bg p-3">
      {!editing ? (
        <Segmented
          label="Channel type"
          value={kind}
          options={(Object.keys(LABELS) as ChannelKind[]).map((value) => ({ value, label: LABELS[value] }))}
          onChange={setKind}
        />
      ) : <span className="text-[13px] font-medium">{LABELS[kind]}</span>}
      <p className="m-0 text-xs text-fg-muted">{HELP[kind]}</p>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">Name
        <TextInput value={name} placeholder={LABELS[kind]} maxLength={60} onChange={(event) => setName(event.target.value)} />
      </label>
      {kind === 'telegram' ? (
        <>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">Bot token
            <TextInput type="password" autoComplete="off" mono value={botToken} placeholder={secretHint ?? '123456789:AA…'} onChange={(event) => setBotToken(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">Chat id
            <TextInput mono value={chatId} placeholder={secretHint ?? '123456789 or @channelname'} onChange={(event) => setChatId(event.target.value)} />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">Webhook URL
          <TextInput type="password" autoComplete="off" mono value={webhookUrl} placeholder={secretHint ?? (kind === 'discord' ? 'https://discord.com/api/webhooks/…' : 'https://…')} onChange={(event) => setWebhookUrl(event.target.value)} />
        </label>
      )}
      {kind === 'teams' ? (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">Mention (optional)
          <TextInput value={mentions} placeholder="name@company.com, other@company.com" onChange={(event) => setMentions(event.target.value)} />
          <span className="text-fg-faint">Work emails to @mention on every message, separated by commas.</span>
        </label>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={busy || !complete} onClick={() => void save()}>{editing ? 'Save' : 'Add and test'}</Button>
      </div>
    </div>
  )
}
