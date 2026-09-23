import { useCallback, useEffect, useRef } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'

import { TextInput } from '../ui/TextInput.tsx'
import { deleteMcpServer, getMcpServer, importMcpServers, listMcpServers, setMcpServerAction, upsertMcpServer } from '../../lib/api.ts'
import type { McpServerRow } from '../../lib/types.ts'
import {
  CodeArea,
  Disclosure,
  EmptyState,
  InlineConfirm,
  IsolationSummary,
  ItemList,
  ItemRow,
  PanelBody,
  PanelFooter,
  PanelIntro,
  Section,
  WorkspaceRequired,
  parsePositiveInt,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'

const SERVER_NAME = /^[A-Za-z0-9_-]+$/
const DEFAULT_TIMEOUT_MS = 15000
const STATUS_TONE: Readonly<Record<McpServerRow['status'], 'green' | 'amber' | 'gray' | 'blue'>> = {
  ready: 'green',
  failed: 'amber',
  connecting: 'blue',
  disabled: 'gray',
}

/**
 * What a status means for the operator. The server reports state only — the
 * transport error itself is deliberately never returned — so this says what
 * to do next rather than claiming a cause.
 */
const STATUS_META: Readonly<Record<McpServerRow['status'], string | undefined>> = {
  ready: undefined,
  connecting: 'Starting up — tools appear once the handshake completes.',
  failed: 'The connection failed. Check the command and arguments, then reconnect.',
  disabled: undefined,
}

interface ServerForm {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly command: string
  readonly args: string
  readonly url: string
  readonly tokenRef: string
  readonly allowedTools: string
  readonly timeoutMs: string
  readonly memoryMb: string
  readonly cpuPercent: string
  readonly enabled: boolean
}

const BLANK_FORM: ServerForm = {
  name: '', transport: 'stdio', command: '', args: '', url: '', tokenRef: '${MCP_TOKEN}',
  allowedTools: '', timeoutMs: String(DEFAULT_TIMEOUT_MS), memoryMb: '', cpuPercent: '', enabled: false,
}

const linesToArray = (raw: string): string[] => raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const asLines = (value: unknown): string => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('\n') : '')
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** Fill the form from a stored config; unknown fields stay in `stored` and survive saving. */
function formOf(name: string, stored: Record<string, unknown>): ServerForm {
  const auth = asRecord(stored['auth'])
  const limits = asRecord(stored['resourceLimits'])
  return {
    name,
    transport: stored['transport'] === 'http' ? 'http' : 'stdio',
    command: asString(stored['command']),
    args: asLines(stored['args']),
    url: asString(stored['url']),
    tokenRef: auth['type'] === 'bearer' ? asString(auth['token']) : '',
    allowedTools: asLines(stored['allowedTools']),
    timeoutMs: typeof stored['timeoutMs'] === 'number' ? String(stored['timeoutMs']) : String(DEFAULT_TIMEOUT_MS),
    memoryMb: typeof limits['memoryMb'] === 'number' ? String(limits['memoryMb']) : '',
    cpuPercent: typeof limits['cpuPercent'] === 'number' ? String(limits['cpuPercent']) : '',
    enabled: stored['enabled'] === true,
  }
}

/** The first problem with the form, or null when it can be saved. */
function formError(form: ServerForm): string | null {
  if (!SERVER_NAME.test(form.name.trim())) return 'Enter a server name using letters, numbers, underscores, or hyphens.'
  if (form.transport === 'stdio' && form.command.trim() === '') return 'Enter the command that starts the server.'
  if (form.transport === 'http' && !/^https?:\/\//.test(form.url.trim())) return 'Enter an HTTP or HTTPS URL.'
  if (form.transport === 'http' && form.tokenRef.trim() !== '' && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(form.tokenRef.trim())) return 'The bearer token must be a ${SECRET_NAME} reference.'
  if (parsePositiveInt(form.timeoutMs) === null) return 'Timeout must be a positive whole number of milliseconds.'
  if (form.memoryMb.trim() !== '' && parsePositiveInt(form.memoryMb) === null) return 'Memory limit must be a positive whole number of MB, or blank.'
  const cpu = parsePositiveInt(form.cpuPercent)
  if (form.cpuPercent.trim() !== '' && (cpu === null || cpu > 100)) return 'CPU limit must be a whole percentage from 1 to 100, or blank.'
  return null
}

/**
 * Merge the form into the stored config. Fields the form does not own (env,
 * headers, imported extras) are kept; fields of the other transport are dropped.
 */
function configOf(form: ServerForm, stored: Record<string, unknown>): Record<string, unknown> {
  const { command: _command, args: _args, url: _url, auth, resourceLimits: _limits, allowedTools: _allowed, ...rest } = stored
  void _command; void _args; void _url; void _limits; void _allowed
  const memoryMb = parsePositiveInt(form.memoryMb)
  const cpuPercent = parsePositiveInt(form.cpuPercent)
  const storedAuth = asRecord(auth)
  const nextAuth = form.tokenRef.trim() !== ''
    ? { type: 'bearer', token: form.tokenRef.trim() }
    : storedAuth['type'] !== undefined && storedAuth['type'] !== 'bearer' ? storedAuth : undefined
  return {
    ...rest,
    transport: form.transport,
    timeoutMs: parsePositiveInt(form.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    ...(linesToArray(form.allowedTools).length > 0 ? { allowedTools: linesToArray(form.allowedTools) } : {}),
    ...(form.transport === 'stdio'
      ? { command: form.command.trim(), args: linesToArray(form.args) }
      : { url: form.url.trim(), ...(nextAuth !== undefined ? { auth: nextAuth } : {}) }),
    ...(memoryMb !== null || cpuPercent !== null
      ? { resourceLimits: { ...(memoryMb !== null ? { memoryMb } : {}), ...(cpuPercent !== null ? { cpuPercent } : {}) } }
      : {}),
  }
}

function toolExposed(allowed: readonly string[] | undefined, server: string, name: string): boolean {
  if (allowed === undefined || allowed.length === 0) return true
  return allowed.includes(name) || allowed.includes(`mcp__${server}__${name}`)
}

/** Names the live server listed, and whether the saved allowlist exposes each one. */
function DiscoveredTools({ row }: { readonly row: McpServerRow }) {
  const tools = row.discoveredTools ?? []
  if (tools.length === 0 && (row.unmatchedAllowlist === undefined || row.unmatchedAllowlist.length === 0)) return null
  const allowed = row.allowedTools
  const restricted = allowed !== undefined && allowed.length > 0
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="m-0 text-xs text-fg-faint">
        {tools.length === 0
          ? 'No tools listed yet. Enable or test the connection.'
          : restricted
            ? `${tools.length} tools from the server. Only the allowlist is exposed to the agent.`
            : `${tools.length} tools from the server. A blank allowlist exposes all of them.`}
      </p>
      {tools.length > 0 ? (
        <ul aria-label={`Tools from ${row.name}`} className="m-0 flex list-none flex-wrap gap-1 p-0">
          {tools.map((name) => {
            const exposed = toolExposed(allowed, row.name, name)
            return (
              <li key={name}>
                <Badge tone={exposed ? 'blue' : 'amber'} className="font-mono">{exposed ? name : `${name} hidden`}</Badge>
              </li>
            )
          })}
        </ul>
      ) : null}
      {row.unmatchedAllowlist !== undefined && row.unmatchedAllowlist.length > 0 ? (
        <p className="m-0 text-xs text-warn">Allowlist names not on this server: {row.unmatchedAllowlist.join(', ')}</p>
      ) : null}
    </div>
  )
}

/** MCP server management: status, enable/disable/reconnect, edit, delete, import. */
export function McpPanel(props: { readonly workspaceId: string | null }) {
  return <McpPanelContent key={props.workspaceId} {...props} />
}

function McpPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [rows, setRows] = useScopedState<readonly McpServerRow[]>([])
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [form, setForm] = useScopedState<ServerForm>(BLANK_FORM)
  /** Stored config of the server being edited; null while adding a new one. */
  const [editing, setEditing] = useScopedState<{ readonly name: string; readonly stored: Record<string, unknown> } | null>(null)
  /** The editor is opened deliberately, so the list is what the tab opens on. */
  const [editorOpen, setEditorOpen] = useScopedState(false)
  const [confirmDelete, setConfirmDelete] = useScopedState<string | null>(null)
  const [confirmEnable, setConfirmEnable] = useScopedState<string | null>(null)
  const [importDialect, setImportDialect] = useScopedState<'claude' | 'codex'>('claude')
  const [importVersion, setImportVersion] = useScopedState('')
  const [importContent, setImportContent] = useScopedState('')
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))
  const editorRef = useRef<HTMLElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    if (workspaceId === null) return
    try { setRows(await listMcpServers(workspaceId)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  if (workspaceId === null) return <WorkspaceRequired />

  const patch = (next: Partial<ServerForm>): void => { setForm((current) => ({ ...current, ...next })) }

  const act = (server: string, action: 'enable' | 'disable' | 'reconnect' | 'test'): Promise<void> => run(`${action}:${server}`, async () => {
    try {
      const result = await setMcpServerAction(workspaceId, server, action)
      setNotice({
        kind: 'ok',
        text: result.tested === true
          ? `${server}: connection test saw ${(result.tools ?? []).length} tools and left the server unpublished`
          : `${server}: ${result.status ?? 'updated'}`,
      })
    } finally {
      await refresh()
    }
  })

  /**
   * Bring the editor into view: it sits below the list and may be offscreen,
   * so editing a server would otherwise look like nothing happened.
   */
  const revealEditor = (): void => {
    window.requestAnimationFrame(() => {
      const editor = editorRef.current
      if (typeof editor?.scrollIntoView === 'function') editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      nameRef.current?.focus()
    })
  }

  const beginEdit = (server: string): Promise<void> => run(`edit:${server}`, async () => {
    const stored = await getMcpServer(workspaceId, server)
    setEditing({ name: server, stored })
    setForm(formOf(server, stored))
    setEditorOpen(true)
    setNotice(null)
    revealEditor()
  })

  const beginAdd = (): void => {
    setEditing(null)
    setForm(BLANK_FORM)
    setEditorOpen(true)
    setNotice(null)
    revealEditor()
  }

  const resetForm = (): void => { setEditing(null); setForm(BLANK_FORM); setEditorOpen(false) }

  const invalid = formError(form)
  const save = (): Promise<void> => run('save', async () => {
    if (invalid !== null) { setNotice({ kind: 'bad', text: invalid }); return }
    const name = form.name.trim()
    const revision = rows.find((row) => row.name === name)?.revision
    try {
      await upsertMcpServer(workspaceId, name, {
        ...configOf(form, editing?.stored ?? {}),
        ...(revision !== undefined ? { expectedRevision: revision } : {}),
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'HttpError' && 'status' in cause && cause.status === 409) {
        await refresh()
        setNotice({ kind: 'bad', text: `${name} changed since this form was loaded. The list was reloaded and this save was kept. Save again to apply it on top of the current revision.` })
        return
      }
      throw cause
    }
    setNotice({ kind: 'ok', text: `Saved ${name}. Saving does not start a process — use Enable on the list. This is not a sandbox.` })
    resetForm()
    await refresh()
  })

  const remove = (server: string): Promise<void> => run(`delete:${server}`, async () => {
    await deleteMcpServer(workspaceId, server)
    setConfirmDelete(null)
    if (editing?.name === server) resetForm()
    setNotice({ kind: 'ok', text: `Deleted ${server}.` })
    await refresh()
  })

  const codexNeedsVersion = importDialect === 'codex' && importVersion.trim() === ''
  const importServers = (): Promise<void> => run('import', async () => {
    const result = await importMcpServers(workspaceId, {
      content: importContent,
      dialect: importDialect,
      ...(importDialect === 'codex' ? { sourceVersion: importVersion.trim() } : {}),
    })
    setImportContent('')
    setNotice({ kind: 'ok', text: `Imported ${result.imported.join(', ')} (disabled)` })
    await refresh()
  })

  const nameTaken = editing === null && rows.some((row) => row.name === form.name.trim())

  /** Set once a limit is stored, so an existing override is never hidden. */
  const advancedInUse = form.allowedTools.trim() !== '' || form.memoryMb.trim() !== '' || form.cpuPercent.trim() !== '' || form.timeoutMs !== String(DEFAULT_TIMEOUT_MS)

  return (
    <PanelBody>
      <div className="flex flex-col gap-2">
        <PanelIntro>
          MCP tools default to ask. requiresUserInteraction always requires approval and cannot become allow. allowedTools filters exposure; it does not grant permission. Saving a server does not start it. A stdio server runs as you; the watchdog is not a sandbox. An indeterminate result may already have run and is not retried.
        </PanelIntro>
        <IsolationSummary />
      </div>

      <Section
        title="Servers"
        count={rows.length}
        actions={
          <>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void refresh()}><Icon name="refresh" size={13} />Refresh</Button>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={beginAdd}><Icon name="plus" size={13} />Add server</Button>
          </>
        }
      >
        {rows.length === 0 ? <EmptyState>No MCP servers configured in this workspace.</EmptyState> : (
          <ItemList label="MCP servers">
            {rows.map((row) => (
              <ItemRow
                key={row.name}
                selected={editing?.name === row.name}
                title={
                  <>
                    <span className="break-all">{row.name}</span>
                    <Badge>{row.transport}</Badge>
                    <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                    {row.breakerOpenUntil !== null ? <Badge tone="amber">breaker open</Badge> : null}
                    {row.auditFault === true ? <Badge tone="amber">audit fault</Badge> : null}
                    {row.stale === true ? <Badge tone="amber">stale file</Badge> : null}
                  </>
                }
                meta={[
                  STATUS_META[row.status],
                  row.containment,
                  row.generation !== undefined ? `generation ${row.generation}` : undefined,
                ].filter((line): line is string => line !== undefined && line !== '').join(' · ') || undefined}
                actions={
                  <>
                    {row.enabled ? (
                      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(row.name, 'disable')}>{busy === `disable:${row.name}` ? 'Disabling…' : 'Disable'}</Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirmEnable(row.name)}>{busy === `enable:${row.name}` ? 'Enabling…' : 'Enable'}</Button>
                    )}
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(row.name, 'test')}>{busy === `test:${row.name}` ? 'Testing…' : 'Test connection'}</Button>
                    <IconButton label={`Reconnect ${row.name}`} disabled={busy !== null} onClick={() => void act(row.name, 'reconnect')}><Icon name="refresh" size={14} /></IconButton>
                    <IconButton label={`Edit ${row.name}`} disabled={busy !== null} onClick={() => void beginEdit(row.name)}><Icon name="pencil" size={14} /></IconButton>
                    <IconButton label={`Delete ${row.name}`} disabled={busy !== null} onClick={() => setConfirmDelete(row.name)}><Icon name="trash" size={14} /></IconButton>
                  </>
                }
              >
                {confirmEnable === row.name ? (
                  <InlineConfirm
                    message={`Start ${row.name}? It runs as you, with network and file access. This is not a sandbox. Saving did not start it.`}
                    confirmLabel="Start server"
                    busy={busy === `enable:${row.name}`}
                    onConfirm={() => { setConfirmEnable(null); void act(row.name, 'enable') }}
                    onCancel={() => setConfirmEnable(null)}
                  />
                ) : null}
                {confirmDelete === row.name ? (
                  <InlineConfirm
                    message={`Delete ${row.name}? Its process stops and its tools disappear from new requests.`}
                    confirmLabel="Delete server"
                    busy={busy === `delete:${row.name}`}
                    onConfirm={() => void remove(row.name)}
                    onCancel={() => setConfirmDelete(null)}
                  />
                ) : null}
                <DiscoveredTools row={row} />
              </ItemRow>
            ))}
          </ItemList>
        )}
      </Section>

      {editorOpen ? (
        <Section
          ref={editorRef}
          title={editing !== null ? `Edit ${editing.name}` : 'Add a server'}
          actions={<Button variant="ghost" size="sm" disabled={busy !== null} onClick={resetForm}>{editing !== null ? 'Cancel editing' : 'Cancel'}</Button>}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Server name"
              tone={nameTaken ? 'bad' : 'default'}
              hint={editing !== null ? 'The name cannot change; delete and add again to rename.' : nameTaken ? 'A server with this name exists — saving replaces its configuration.' : 'Letters, numbers, underscores, or hyphens.'}
            >
              <TextInput ref={nameRef} mono value={form.name} placeholder="notion" disabled={editing !== null} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Transport</span>
              <Segmented
                label="Transport"
                value={form.transport}
                options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'Streamable HTTP' }]}
                onChange={(transport) => patch({ transport })}
              />
            </div>
            {form.transport === 'stdio' ? (
              <>
                <Field label="Command" hint="Runs the executable directly, not through a shell adapter.">
                  <TextInput mono value={form.command} placeholder="npx" onChange={(e) => patch({ command: e.target.value })} />
                </Field>
                <Field label="Args" hint="One argument per line.">
                  <CodeArea rows={2} value={form.args} onChange={(e) => patch({ args: e.target.value })} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <TextInput mono value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => patch({ url: e.target.value })} />
                </Field>
                <Field label="Bearer token reference" hint="Only a ${SECRET_NAME} reference; store the value in the Secrets tab. Leave blank for no bearer token.">
                  <TextInput mono value={form.tokenRef} placeholder="${MCP_TOKEN}" onChange={(e) => patch({ tokenRef: e.target.value })} />
                </Field>
              </>
            )}
            <p className="text-sm text-muted md:col-span-2">Saving does not start the process. Use Enable on the server list. The server runs with your user account; that is not a sandbox.</p>
          </div>

          {/* Exposure and resource caps: rarely changed, so they start folded. */}
          <Disclosure summary="Advanced · tool exposure and resource limits" defaultOpen={advancedInUse}>
            <Field label="Allowed tools" hint="Leave blank to expose every tool the server lists. One name per line restricts exposure; it does not grant permission.">
              <CodeArea rows={3} value={form.allowedTools} onChange={(e) => patch({ allowedTools: e.target.value })} />
            </Field>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Timeout (ms)" hint={`Defaults to ${DEFAULT_TIMEOUT_MS}.`}>
                <TextInput mono inputMode="numeric" value={form.timeoutMs} onChange={(e) => patch({ timeoutMs: e.target.value })} />
              </Field>
              <Field label="Memory limit (MB)" hint="Blank means unlimited. Exceeding the limit terminates the process tree.">
                <TextInput mono inputMode="numeric" value={form.memoryMb} onChange={(e) => patch({ memoryMb: e.target.value })} />
              </Field>
              <Field label="CPU limit (%)" hint="Measured as CPU delta per second divided by core count; not a sandbox.">
                <TextInput mono inputMode="numeric" value={form.cpuPercent} onChange={(e) => patch({ cpuPercent: e.target.value })} />
              </Field>
            </div>
          </Disclosure>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={busy !== null || invalid !== null} title={invalid ?? undefined} onClick={() => void save()}>
              {busy === 'save' ? 'Saving…' : editing !== null ? 'Save changes' : 'Add server'}
            </Button>
            {invalid !== null && form.name.trim() !== '' ? <span className="text-xs text-fg-faint">{invalid}</span> : null}
          </div>
        </Section>
      ) : null}

      <Section title="Import servers">
        <Disclosure summary="Import from a Claude .mcp.json or Codex configuration">
          <PanelIntro>Imports record provenance. Imported servers always stay disabled and do not start.</PanelIntro>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Format</span>
              <Segmented
                label="Import format"
                value={importDialect}
                options={[{ value: 'claude', label: 'Claude .mcp.json' }, { value: 'codex', label: 'Codex (pinned)' }]}
                onChange={setImportDialect}
              />
            </div>
            {importDialect === 'codex' ? (
              <Field label="Pinned Codex version" hint="Required. Must match the pinned adapter version.">
                <TextInput mono value={importVersion} onChange={(e) => setImportVersion(e.target.value)} />
              </Field>
            ) : null}
            <div className="md:col-span-2">
              <Field label="Content">
                <CodeArea
                  rows={5}
                  value={importContent}
                  placeholder={importDialect === 'claude' ? '{"mcpServers": {"local-fs": {"command": "npx", "args": ["-y", "@example/fs-mcp"]}}}' : 'Codex MCP configuration'}
                  onChange={(e) => setImportContent(e.target.value)}
                />
              </Field>
            </div>
          </div>
          <div>
            <Button variant="outline" size="sm" disabled={busy !== null || importContent.trim() === '' || codexNeedsVersion} onClick={() => void importServers()}>
              {busy === 'import' ? 'Importing…' : 'Import servers'}
            </Button>
          </div>
        </Disclosure>
      </Section>

      <PanelFooter notice={notice} />
    </PanelBody>
  )
}
