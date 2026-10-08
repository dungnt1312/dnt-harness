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
  RowMenu,
  FormActions,
} from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

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
  disabled: 'Not running. Enable it to start the server.',
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

/**
 * Names the live server listed, and whether the saved allowlist exposes each
 * one. The full list folds behind a one-line count so a server with dozens of
 * tools does not turn its row into a wall of badges; warnings stay visible.
 */
function DiscoveredTools({ row }: { readonly row: McpServerRow }) {
  const tools = row.discoveredTools ?? []
  const hasWarnings = (row.unmatchedAllowlist?.length ?? 0) > 0 || (row.unusableTools?.length ?? 0) > 0
  if (tools.length === 0 && !hasWarnings) return null
  const allowed = row.allowedTools
  const restricted = allowed !== undefined && allowed.length > 0
  const exposedCount = tools.filter((name) => toolExposed(allowed, row.name, name)).length
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {tools.length > 0 ? (
        <Disclosure
          summary={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{tools.length} {tools.length === 1 ? 'tool' : 'tools'}</span>
              <span className="text-xs font-normal text-fg-faint">
                {restricted ? `${exposedCount} exposed by the allowlist · ${tools.length - exposedCount} hidden` : 'all exposed'}
              </span>
            </span>
          }
        >
          <ul aria-label={`Tools from ${row.name}`} className="m-0 flex list-none flex-wrap gap-1 p-0">
            {tools.map((name) => {
              const exposed = toolExposed(allowed, row.name, name)
              return (
                <li key={name}>
                  {exposed ? (
                    <Badge tone="blue" className="font-mono">{name}</Badge>
                  ) : (
                    <Badge tone="gray" className="font-mono text-fg-faint line-through" title="Hidden by the allowlist">
                      <Icon name="eyeOff" size={11} aria-hidden="true" />{name}<span className="sr-only"> hidden</span>
                    </Badge>
                  )}
                </li>
              )
            })}
          </ul>
        </Disclosure>
      ) : null}
      {row.unmatchedAllowlist !== undefined && row.unmatchedAllowlist.length > 0 ? (
        <p className="m-0 text-xs text-warn">Allowlist names not on this server: {row.unmatchedAllowlist.join(', ')}</p>
      ) : null}
      {row.unusableTools !== undefined && row.unusableTools.length > 0 ? (
        <p className="m-0 text-xs text-warn">
          Not sent to the model, because model providers reject these names (letters, numbers, _ and - only, at most 64 characters including the mcp__{row.name}__ prefix): {row.unusableTools.join(', ')}
        </p>
      ) : null}
    </div>
  )
}

/** Why the server is not usable right now, and what it last wrote to stderr. */
function ServerDiagnostics({ row }: { readonly row: McpServerRow }) {
  const hasLog = row.stderrTail !== undefined && row.stderrTail !== ''
  if (row.lastError === undefined && !hasLog) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {row.lastError !== undefined ? (
        <p className="m-0 text-xs text-bad">Last connection attempt failed: {row.lastError}. Conversations continue without this server's tools until it connects.</p>
      ) : null}
      {hasLog ? (
        <Disclosure summary="Server log (stderr, secrets masked)">
          <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] text-fg-muted">{row.stderrTail}</pre>
        </Disclosure>
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
  /** Import is its own view too, so the list is never buried under two forms. */
  const [importing, setImporting] = useScopedState(false)
  const [confirmDelete, setConfirmDelete] = useScopedState<string | null>(null)
  const [confirmEnable, setConfirmEnable] = useScopedState<string | null>(null)
  /** "Add" with a taken name replaces a server: ask before doing that. */
  const [confirmReplace, setConfirmReplace] = useScopedState(false)
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

  const formBaseline = editing === null ? BLANK_FORM : formOf(editing.name, editing.stored)
  const guardDiscard = useUnsavedChanges(
    (editorOpen && JSON.stringify(form) !== JSON.stringify(formBaseline)) || importContent.trim() !== '',
  )

  if (workspaceId === null) return <WorkspaceRequired />

  const view: 'list' | 'edit' | 'import' = editorOpen ? 'edit' : importing ? 'import' : 'list'

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

  /** The editor replaces the list; scroll its top into view and focus the first field. */
  const revealEditor = (): void => {
    window.requestAnimationFrame(() => {
      const editor = editorRef.current
      if (typeof editor?.scrollIntoView === 'function') editor.scrollIntoView({ block: 'start' })
      nameRef.current?.focus()
    })
  }

  const beginEdit = (server: string): Promise<void> => run(`edit:${server}`, async () => {
    const stored = await getMcpServer(workspaceId, server)
    setEditing({ name: server, stored })
    setForm(formOf(server, stored))
    setImporting(false)
    setEditorOpen(true)
    setNotice(null)
    revealEditor()
  })

  const beginAdd = (): void => {
    setEditing(null)
    setForm(BLANK_FORM)
    setImporting(false)
    setEditorOpen(true)
    setNotice(null)
    revealEditor()
  }

  const resetForm = (): void => { setEditing(null); setForm(BLANK_FORM); setEditorOpen(false) }

  const beginImport = (): void => {
    resetForm()
    setImporting(true)
    setNotice(null)
  }

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
    setNotice({ kind: 'ok', text: editing !== null && rows.find((row) => row.name === name)?.enabled === true ? `Saved ${name}.` : `Saved ${name}. It is not running yet — use Enable to start it.` })
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
    setImporting(false)
    setNotice({ kind: 'ok', text: `Imported ${result.imported.join(', ')} (disabled)` })
    await refresh()
  })

  const nameTaken = editing === null && rows.some((row) => row.name === form.name.trim())

  /** Set once a limit is stored, so an existing override is never hidden. */
  const advancedInUse = form.allowedTools.trim() !== '' || form.memoryMb.trim() !== '' || form.cpuPercent.trim() !== '' || form.timeoutMs !== String(DEFAULT_TIMEOUT_MS)

  const serverList = (
    <Section
      title="Servers"
      count={rows.length}
      actions={
        <>
          <IconButton label="Refresh servers" disabled={busy !== null} onClick={() => void refresh()}><Icon name="refresh" size={14} /></IconButton>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => guardDiscard(beginImport)}>Import…</Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => guardDiscard(beginAdd)}><Icon name="plus" size={13} />Add server</Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState>No MCP servers yet. Add one, or import an existing Claude .mcp.json / Codex config.</EmptyState>
      ) : (
        <ItemList label="MCP servers">
          {rows.map((row) => (
            <ItemRow
              key={row.name}
              selected={editing?.name === row.name}
              title={
                <>
                  <span className="break-all">{row.name}</span>
                  <Badge tone={STATUS_TONE[row.status]} {...(row.generation !== undefined ? { title: `generation ${row.generation}` } : {})}>{row.status}</Badge>
                  {row.breakerOpenUntil !== null ? <Badge tone="amber">breaker open</Badge> : null}
                  {row.auditFault === true ? <Badge tone="amber">audit fault</Badge> : null}
                  {row.stale === true ? <Badge tone="amber">stale file</Badge> : null}
                </>
              }
              meta={[
                row.transport === 'http' ? 'Streamable HTTP' : 'stdio',
                STATUS_META[row.status],
              ].filter((line): line is string => line !== undefined && line !== '').join(' · ')}
              actions={
                <>
                  {row.enabled ? (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(row.name, 'disable')}>{busy === `disable:${row.name}` ? 'Disabling…' : 'Disable'}</Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirmEnable(row.name)}>{busy === `enable:${row.name}` ? 'Enabling…' : 'Enable'}</Button>
                  )}
                  <IconButton label={`Edit ${row.name}`} disabled={busy !== null} onClick={() => guardDiscard(() => void beginEdit(row.name))}><Icon name="pencil" size={14} /></IconButton>
                  <RowMenu
                    label={`More actions for ${row.name}`}
                    disabled={busy !== null}
                    actions={[
                      { label: busy === `test:${row.name}` ? 'Testing…' : 'Test connection', icon: 'zap', onSelect: () => void act(row.name, 'test') },
                      { label: 'Reconnect', icon: 'refresh', disabled: !row.enabled, onSelect: () => void act(row.name, 'reconnect') },
                      { label: 'Delete server', icon: 'trash', danger: true, onSelect: () => setConfirmDelete(row.name) },
                    ]}
                  />
                </>
              }
            >
              {confirmEnable === row.name ? (
                <InlineConfirm
                  message={`Start ${row.name}? It runs as you, with network and file access — not a sandbox.`}
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
              <ServerDiagnostics row={row} />
              <DiscoveredTools row={row} />
            </ItemRow>
          ))}
        </ItemList>
      )}
    </Section>
  )

  /** Return from the editor or import view to the list. */
  const backToList = (
    <Button variant="ghost" size="sm" className="-ml-2 self-start" disabled={busy !== null} onClick={() => guardDiscard(() => { resetForm(); setImporting(false); setImportContent('') })}>
      <Icon name="chevronRight" size={13} className="rotate-180" />Back to servers
    </Button>
  )

  return (
    <PanelBody>
      {view === 'list' ? (
        <>
          <div className="flex flex-col gap-2">
            <PanelIntro>
              Connect MCP servers to give the agent extra tools. MCP tools default to ask; requiresUserInteraction always requires approval and cannot become allow. allowedTools filters exposure; it does not grant permission.
            </PanelIntro>
            <IsolationSummary />
          </div>
          {serverList}
        </>
      ) : backToList}

      {view === 'edit' ? (
        <Section
          ref={editorRef}
          title={editing !== null ? `Edit ${editing.name}` : 'Add a server'}
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

          {confirmReplace && nameTaken ? (
            <InlineConfirm
              message={`Replace the existing “${form.name.trim()}”? Its stored env, headers and limits are overwritten by this form.`}
              confirmLabel="Replace server"
              busy={busy === 'save'}
              onConfirm={() => { setConfirmReplace(false); void save() }}
              onCancel={() => setConfirmReplace(false)}
            />
          ) : (
            <FormActions>
              <span className="mr-auto text-xs text-fg-faint">{invalid ?? 'Saving does not start the server — use Enable on the list.'}</span>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => guardDiscard(resetForm)}>Cancel</Button>
              <Button variant="primary" size="sm" disabled={busy !== null || invalid !== null} onClick={() => { if (nameTaken) setConfirmReplace(true); else void save() }}>
                {busy === 'save' ? 'Saving…' : editing !== null ? 'Save server' : nameTaken ? 'Replace server…' : 'Add server'}
              </Button>
            </FormActions>
          )}
        </Section>
      ) : null}

      {view === 'import' ? (
        <Section title="Import servers">
          <PanelIntro>Paste a Claude .mcp.json or Codex configuration. Imported servers stay disabled until you enable them; provenance is recorded.</PanelIntro>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Format</span>
              <Segmented
                label="Import format"
                value={importDialect}
                options={[{ value: 'claude', label: 'Claude .mcp.json' }, { value: 'codex', label: 'Codex (pinned)' }]}
                disabled={busy !== null}
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
          <FormActions>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => guardDiscard(() => { setImporting(false); setImportContent('') })}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={busy !== null || importContent.trim() === '' || codexNeedsVersion} onClick={() => void importServers()}>
              {busy === 'import' ? 'Importing…' : 'Import servers'}
            </Button>
          </FormActions>
        </Section>
      ) : null}

      <PanelFooter notice={notice} />
    </PanelBody>
  )
}
