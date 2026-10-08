import { useCallback, useEffect, useRef } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { deleteSecret, listSecrets, setSecret } from '../../lib/api.ts'
import {
  EmptyState,
  InlineConfirm,
  ItemList,
  ItemRow,
  Notice,
  PanelBody,
  PanelIntro,
  Section,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
  FormActions,
} from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

/** Secret names are referenced as ${NAME}, so they follow environment-variable rules. */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Secrets: masked names only; saving an existing name rotates it and reconnects affected servers. */
export function SecretsPanel(props: { readonly workspaceId: string | null }) {
  return <SecretsPanelContent key={props.workspaceId} {...props} />
}

function SecretsPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [rows, setRows] = useScopedState<readonly { readonly name: string }[]>([])
  const [name, setName] = useScopedState('')
  const [value, setValue] = useScopedState('')
  const [showValue, setShowValue] = useScopedState(false)
  const [confirming, setConfirming] = useScopedState<string | null>(null)
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const valueRef = useRef<HTMLInputElement | null>(null)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refresh = useCallback(async () => {
    if (workspaceId === null) return
    try { setRows(await listSecrets(workspaceId)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  useUnsavedChanges(value !== '')

  if (workspaceId === null) return <WorkspaceRequired />

  const trimmed = name.trim()
  const nameInvalid = trimmed !== '' && !SECRET_NAME.test(trimmed)
  const exists = rows.some((row) => row.name === trimmed)

  const save = (): Promise<void> => run('save', async () => {
    const result = await setSecret(workspaceId, trimmed, value)
    setNotice({
      kind: 'ok',
      text: `${exists ? 'Rotated' : 'Saved'} ${result.rotated}${result.reconnected !== undefined && result.reconnected.length > 0 ? ` — reconnected: ${result.reconnected.join(', ')}` : ''}`,
    })
    setName('')
    setValue('')
    setShowValue(false)
    await refresh()
  })

  const remove = (secret: string): Promise<void> => run(`delete:${secret}`, async () => {
    await deleteSecret(workspaceId, secret)
    setConfirming(null)
    setNotice({ kind: 'ok', text: `Deleted ${secret}` })
    await refresh()
  })

  return (
    <PanelBody>
      <PanelIntro>
        Secrets are encrypted at rest with AES-256-GCM. The master key requires user-scoped ACL/chmod permissions and fails closed if they cannot be set.
        Only key names are displayed. Reference a key from MCP env, headers, or auth as <code>{'${NAME}'}</code>.
      </PanelIntro>
      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}

      <Section title="Stored keys" count={rows.length}>
        {rows.length === 0 ? <EmptyState>No secrets stored.</EmptyState> : (
          <ItemList label="Stored secrets">
            {rows.map((row) => (
              <ItemRow
                key={row.name}
                title={<><Icon name="key" size={14} className="text-fg-faint" /><code className="break-all font-mono text-[13px]">{row.name}</code></>}
                meta="Value hidden"
                actions={
                  <>
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { setName(row.name); setValue(''); valueRef.current?.focus() }}><Icon name="pencil" size={13} />Replace value</Button>
                    <IconButton label={`Delete ${row.name}`} disabled={busy !== null} onClick={() => setConfirming(row.name)}><Icon name="trash" size={14} /></IconButton>
                  </>
                }
              >
                {confirming === row.name ? (
                  <InlineConfirm
                    message={`Delete “${row.name}”? Servers that reference it will fail to start.`}
                    confirmLabel="Delete permanently"
                    busy={busy === `delete:${row.name}`}
                    onConfirm={() => void remove(row.name)}
                    onCancel={() => setConfirming(null)}
                  />
                ) : null}
              </ItemRow>
            ))}
          </ItemList>
        )}
      </Section>

      <Section title={exists ? `Replace ${trimmed}` : 'Add a key'}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => { event.preventDefault(); if (trimmed !== '' && !nameInvalid && value !== '') void save() }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Key name" tone={nameInvalid ? 'bad' : 'default'} hint={nameInvalid ? 'Use letters, numbers, and underscores; do not start with a number.' : exists ? 'This key exists — saving replaces its value.' : 'For example MCP_TOKEN.'}>
              <TextInput mono invalid={nameInvalid} value={name} placeholder="MCP_TOKEN" autoComplete="off" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Value" hint="The value is never displayed again after saving.">
              <TextInput
                ref={valueRef}
                mono
                type={showValue ? 'text' : 'password'}
                value={value}
                autoComplete="off"
                trailing={<IconButton label={showValue ? 'Hide value' : 'Show value'} onClick={() => setShowValue((shown) => !shown)}><Icon name={showValue ? 'eyeOff' : 'eye'} size={15} /></IconButton>}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          </div>
          <FormActions>
            <Button type="submit" variant="primary" size="sm" disabled={busy !== null || trimmed === '' || nameInvalid || value === ''}>
              {busy === 'save' ? 'Saving…' : exists ? 'Replace key' : 'Save key'}
            </Button>
          </FormActions>
        </form>
      </Section>
    </PanelBody>
  )
}
