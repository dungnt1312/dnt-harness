import { useCallback, useEffect, useRef } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'

import { TextInput } from '../ui/TextInput.tsx'
import { beginMcpOAuth, completeMcpOAuth, deleteMcpServer, getMcpServer, importMcpServers, listMcpServers, listSecrets, McpOAuthError, revokeMcpOAuth, setMcpServerAction, setSecret, upsertMcpServer } from '../../lib/api.ts'
import type { McpOAuthState, McpServerRow } from '../../lib/types.ts'
import { catalogServerName, type CatalogEntry } from '../../../src/harness/mcp/catalog.ts'
import { McpCatalogView } from './McpCatalogView.tsx'
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

/** How an HTTP server authenticates. OAuth is discovered and signed into from the list. */
type AuthMode = 'none' | 'bearer' | 'oauth'
type ClientAuthMethod = 'client_secret_post' | 'client_secret_basic'

/** Shared with the callback page the host serves (`src/web/mcp-oauth-connect.ts`). */
const OAUTH_CHANNEL = 'dnt-harness-mcp-oauth'
const SECRET_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

interface ServerForm {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly command: string
  readonly args: string
  readonly url: string
  readonly authMode: AuthMode
  readonly tokenRef: string
  /** OAuth: optional client the user created at a provider without registration. */
  readonly clientId: string
  readonly clientSecretRef: string
  readonly clientAuthMethod: ClientAuthMethod
  readonly allowedTools: string
  readonly timeoutMs: string
  readonly memoryMb: string
  readonly cpuPercent: string
  readonly enabled: boolean
}

const BLANK_FORM: ServerForm = {
  name: '', transport: 'stdio', command: '', args: '', url: '', authMode: 'bearer', tokenRef: '${MCP_TOKEN}',
  clientId: '', clientSecretRef: '', clientAuthMethod: 'client_secret_post',
  allowedTools: '', timeoutMs: String(DEFAULT_TIMEOUT_MS), memoryMb: '', cpuPercent: '', enabled: false,
}

const OAUTH_BADGE: Readonly<Record<McpOAuthState['state'], { readonly label: string; readonly tone: 'green' | 'amber' | 'gray' }>> = {
  connected: { label: 'Connected', tone: 'green' },
  needs_sign_in: { label: 'Needs sign-in', tone: 'amber' },
  not_connected: { label: 'Not connected', tone: 'gray' },
}

/** A pending sign-in: the state the callback page will report back. */
interface PendingSignIn {
  readonly server: string
  readonly state: string
}

const linesToArray = (raw: string): string[] => raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const asLines = (value: unknown): string => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('\n') : '')
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** Fill the form from a stored config; unknown fields stay in `stored` and survive saving. */
function formOf(name: string, stored: Record<string, unknown>): ServerForm {
  const auth = asRecord(stored['auth'])
  const limits = asRecord(stored['resourceLimits'])
  const authMode: AuthMode = auth['type'] === 'managed_oauth' ? 'oauth' : auth['type'] === 'bearer' ? 'bearer' : stored['transport'] === 'http' ? 'none' : 'bearer'
  return {
    name,
    transport: stored['transport'] === 'http' ? 'http' : 'stdio',
    command: asString(stored['command']),
    args: asLines(stored['args']),
    url: asString(stored['url']),
    authMode,
    tokenRef: auth['type'] === 'bearer' ? asString(auth['token']) : '',
    clientId: auth['type'] === 'managed_oauth' ? asString(auth['clientId']) : '',
    clientSecretRef: auth['type'] === 'managed_oauth' ? asString(auth['clientSecret']) : '',
    clientAuthMethod: auth['tokenEndpointAuth'] === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post',
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
  if (form.transport === 'http' && form.authMode === 'bearer' && form.tokenRef.trim() !== '' && !SECRET_REF.test(form.tokenRef.trim())) return 'The bearer token must be a ${SECRET_NAME} reference.'
  if (form.transport === 'http' && form.authMode === 'oauth') {
    if (form.clientSecretRef.trim() !== '' && !SECRET_REF.test(form.clientSecretRef.trim())) return 'The client secret must be a ${SECRET_NAME} reference.'
    if (form.clientSecretRef.trim() !== '' && form.clientId.trim() === '') return 'Enter the client ID that goes with the client secret.'
  }
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
  const nextAuth = authOf(form, storedAuth)
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

/**
 * The `auth` block the form stands for. Bearer and OAuth are rebuilt from
 * the form; "None" keeps only an auth type the form cannot show (legacy
 * external tokens), so switching away from OAuth really drops it.
 */
function authOf(form: ServerForm, stored: Record<string, unknown>): Record<string, unknown> | undefined {
  if (form.authMode === 'bearer') return form.tokenRef.trim() !== '' ? { type: 'bearer', token: form.tokenRef.trim() } : undefined
  if (form.authMode === 'oauth') {
    const url = form.url.trim()
    let provider = url
    try { provider = new URL(url).host } catch { /* formError reports the URL */ }
    const clientId = form.clientId.trim()
    const secret = form.clientSecretRef.trim()
    return {
      type: 'managed_oauth',
      provider,
      resource: url,
      ...(clientId !== '' ? { clientId } : {}),
      ...(clientId !== '' && secret !== '' ? { clientSecret: secret, tokenEndpointAuth: form.clientAuthMethod } : {}),
      ...(stored['type'] === 'managed_oauth' && Array.isArray(stored['scopes']) ? { scopes: stored['scopes'] } : {}),
    }
  }
  return stored['type'] === 'oauth' || stored['type'] === 'external_token' ? stored : undefined
}

function toolExposed(allowed: readonly string[] | undefined, server: string, name: string): boolean {
  if (allowed === undefined || allowed.length === 0) return true
  return allowed.includes(name) || allowed.includes(`mcp__${server}__${name}`)
}

/**
 * Names the live server listed, and whether the saved allowlist exposes each
 * one. Shown flat — a collapsed box around a handful of badges read as chrome
 * with nothing behind it. Warnings stay visible beside the badges.
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
        <>
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] font-medium">
            <span>{tools.length} {tools.length === 1 ? 'tool' : 'tools'}</span>
            <span className="text-xs font-normal text-fg-faint">
              {restricted ? `${exposedCount} exposed by the allowlist · ${tools.length - exposedCount} hidden` : 'all exposed'}
            </span>
          </p>
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
        </>
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
  /** The catalog is a third view; the list stays the tab's home. */
  const [browsing, setBrowsing] = useScopedState(false)
  /** Names of the workspace's secrets (never values), to skip asking for a key it already has. */
  const [secretNames, setSecretNames] = useScopedState<ReadonlySet<string>>(new Set())
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

  /** A sign-in tab is open; the callback page reports its state on {@link OAUTH_CHANNEL}. */
  const [pendingSignIn, setPendingSignIn] = useScopedState<PendingSignIn | null>(null)
  /** Why Connect needs a client, shown above the editor's client section. */
  const [clientNeeded, setClientNeeded] = useScopedState<string | null>(null)

  const refresh = useCallback(async () => {
    if (workspaceId === null) return
    try { setRows(await listMcpServers(workspaceId)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  const finishSignIn = useCallback(async (pending: PendingSignIn): Promise<void> => {
    if (workspaceId === null) return
    setPendingSignIn(null)
    try {
      const result = await completeMcpOAuth(workspaceId, pending.server, pending.state)
      setNotice(result.status === 'failed'
        ? { kind: 'bad', text: `${pending.server} is signed in, but the server did not start. Check its status below.` }
        : { kind: 'ok', text: `${pending.server} is connected.` })
    } catch (cause) {
      setNotice({ kind: 'bad', text: `Sign-in for ${pending.server} did not finish: ${cause instanceof Error ? cause.message : String(cause)}` })
    } finally {
      await refresh()
    }
  }, [workspaceId, refresh])

  // The callback page is same-origin, so it reaches this tab over BroadcastChannel.
  useEffect(() => {
    if (pendingSignIn === null || typeof BroadcastChannel === 'undefined') return undefined
    const channel = new BroadcastChannel(OAUTH_CHANNEL)
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; state?: unknown } | null
      if (data?.type === 'mcp-oauth' && data.state === pendingSignIn.state) void finishSignIn(pendingSignIn)
    }
    return () => channel.close()
  }, [pendingSignIn, finishSignIn])

  const formBaseline = editing === null ? BLANK_FORM : formOf(editing.name, editing.stored)
  const guardDiscard = useUnsavedChanges(
    (editorOpen && JSON.stringify(form) !== JSON.stringify(formBaseline)) || importContent.trim() !== '',
  )

  if (workspaceId === null) return <WorkspaceRequired />

  const view: 'list' | 'edit' | 'import' | 'catalog' = editorOpen ? 'edit' : importing ? 'import' : browsing ? 'catalog' : 'list'

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

  /**
   * Open a blank tab inside the click (popup blockers allow that), then point
   * it at the provider once the host has discovered and registered.
   */
  const connect = (row: McpServerRow): Promise<void> => run(`oauth:${row.name}`, async () => {
    const tab = window.open('', '_blank')
    const scopes = row.oauth?.missingScope !== undefined ? row.oauth.missingScope.split(/\s+/).filter((scope) => scope !== '') : []
    let started: { readonly authorizationUrl: string; readonly state: string }
    try {
      started = await beginMcpOAuth(workspaceId, row.name, scopes)
    } catch (cause) {
      tab?.close()
      if (cause instanceof McpOAuthError && cause.code === 'client_required') {
        setClientNeeded(cause.message)
        await beginEditNow(row.name)
        return
      }
      setNotice({ kind: 'bad', text: `${row.name}: ${cause instanceof Error ? cause.message : String(cause)}` })
      return
    }
    if (tab !== null) tab.location.href = started.authorizationUrl
    else window.open(started.authorizationUrl, '_blank')
    setPendingSignIn({ server: row.name, state: started.state })
    setNotice({ kind: 'ok', text: `Waiting for sign-in to ${row.name} in the new tab…` })
  })

  const disconnect = (server: string): Promise<void> => run(`oauth:${server}`, async () => {
    try {
      const result = await revokeMcpOAuth(workspaceId, server)
      setNotice({ kind: 'ok', text: result.remote === 'failed' ? `${server} is disconnected here; the provider did not confirm revoking the token.` : `${server} is disconnected.` })
    } finally {
      await refresh()
    }
  })

  const beginEditNow = async (server: string): Promise<void> => {
    const stored = await getMcpServer(workspaceId, server)
    setEditing({ name: server, stored })
    setForm(formOf(server, stored))
    setImporting(false)
    setEditorOpen(true)
    setNotice(null)
    revealEditor()
  }

  const beginEdit = (server: string): Promise<void> => run(`edit:${server}`, async () => {
    setClientNeeded(null)
    const stored = await getMcpServer(workspaceId, server)
    setEditing({ name: server, stored })
    setForm(formOf(server, stored))
    setImporting(false)
    setEditorOpen(true)
    setNotice(null)
    revealEditor()
  })

  const beginAdd = (): void => {
    setClientNeeded(null)
    setEditing(null)
    setForm(BLANK_FORM)
    setImporting(false)
    setBrowsing(false)
    setEditorOpen(true)
    setNotice(null)
    revealEditor()
  }

  const resetForm = (): void => { setEditing(null); setForm(BLANK_FORM); setEditorOpen(false); setClientNeeded(null) }

  const beginImport = (): void => {
    resetForm()
    setImporting(true)
    setBrowsing(false)
    setNotice(null)
  }

  const beginBrowse = (): Promise<void> => run('catalog', async () => {
    resetForm()
    setImporting(false)
    setNotice(null)
    // Secret names only; a failure just means every key is asked for again.
    try { setSecretNames(new Set((await listSecrets(workspaceId)).map((secret) => secret.name))) } catch { setSecretNames(new Set()) }
    setBrowsing(true)
  })

  /**
   * Install a catalog entry: store the key(s) the person typed, then save the
   * server under a free name. Saving never starts it (Enable does), so a
   * failed secret write stops before anything is saved.
   */
  const installFromCatalog = (entry: CatalogEntry, config: Record<string, unknown>, secrets: Readonly<Record<string, string>>): Promise<void> => {
    let failed = false
    return run(`install:${entry.id}`, async () => {
      try {
        for (const [name, value] of Object.entries(secrets)) await setSecret(workspaceId, name, value)
        if (Object.keys(secrets).length > 0) setSecretNames((current) => new Set([...current, ...Object.keys(secrets)]))
        const name = catalogServerName(entry.id, rows.map((row) => row.name))
        await upsertMcpServer(workspaceId, name, config)
        const missing = entry.secrets.filter((secret) => !secretNames.has(secret.name) && secrets[secret.name] === undefined).map((secret) => secret.name)
        const next = entry.config['auth'] !== null && typeof entry.config['auth'] === 'object' && (entry.config['auth'] as { type?: unknown }).type === 'managed_oauth'
          ? 'Use Connect to sign in, then Enable to start it.'
          : missing.length > 0
            ? `Add ${missing.join(', ')} in the Secrets tab, then Enable to start it.`
            : 'Use Enable to start it.'
        setNotice({ kind: 'ok', text: `Installed ${name}. ${next}` })
        await refresh()
      } catch (cause) {
        failed = true
        setNotice({ kind: 'bad', text: `Could not install ${entry.title}: ${cause instanceof Error ? cause.message : String(cause)}` })
      }
    }).then(() => { if (failed) throw new Error('install failed') })
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
    setNotice({
      kind: 'ok',
      text: form.transport === 'http' && form.authMode === 'oauth' && rows.find((row) => row.name === name)?.oauth?.state !== 'connected'
        ? `Saved ${name}. Use Connect to sign in, then Enable to start it.`
        : editing !== null && rows.find((row) => row.name === name)?.enabled === true ? `Saved ${name}.` : `Saved ${name}. It is not running yet — use Enable to start it.`,
    })
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
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => guardDiscard(beginImport)}>Import…</Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => guardDiscard(() => void beginBrowse())}>Browse catalog</Button>
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
                  {row.oauth !== undefined ? <Badge tone={OAUTH_BADGE[row.oauth.state].tone} title="OAuth">{OAUTH_BADGE[row.oauth.state].label}</Badge> : null}
                </>
              }
              meta={[
                row.transport === 'http' ? 'Streamable HTTP' : 'stdio',
                row.oauth?.state === 'needs_sign_in' && row.oauth.missingScope !== undefined
                  ? `OAuth: needs scope ${row.oauth.missingScope} — use Reconnect to grant it.`
                  : row.oauth !== undefined && row.oauth.state !== 'connected'
                    ? 'OAuth: sign in with Connect before the server can start.'
                    : STATUS_META[row.status],
              ].filter((line): line is string => line !== undefined && line !== '').join(' · ')}
              actions={
                <>
                  {row.oauth !== undefined && row.oauth.state !== 'connected' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${row.oauth.state === 'needs_sign_in' ? 'Reconnect' : 'Connect'} ${row.name}`}
                      disabled={busy !== null}
                      onClick={() => void connect(row)}
                    >
                      {busy === `oauth:${row.name}` ? 'Opening…' : row.oauth.state === 'needs_sign_in' ? 'Reconnect' : 'Connect'}
                    </Button>
                  ) : null}
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
                      ...(row.oauth !== undefined && row.oauth.state !== 'not_connected'
                        ? [{ label: 'Disconnect OAuth', icon: 'lock' as const, onSelect: () => void disconnect(row.name) }]
                        : []),
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

  /** Return from the editor, import, or catalog view to the list. */
  const backToList = (
    <Button variant="ghost" size="sm" className="-ml-2 self-start" disabled={busy !== null} onClick={() => guardDiscard(() => { resetForm(); setImporting(false); setBrowsing(false); setImportContent('') })}>
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
          {pendingSignIn !== null ? (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-[13px]">
              <span className="mr-auto">Waiting for sign-in to {pendingSignIn.server}. Finish it in the tab that opened; this completes on its own.</span>
              <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void finishSignIn(pendingSignIn)}>Finish sign-in</Button>
              <Button variant="ghost" size="sm" onClick={() => setPendingSignIn(null)}>Cancel</Button>
            </div>
          ) : null}
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
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Authentication</span>
                  <Segmented
                    label="Authentication"
                    value={form.authMode}
                    options={[{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'oauth', label: 'OAuth' }]}
                    onChange={(authMode) => patch({ authMode })}
                  />
                </div>
                {form.authMode === 'bearer' ? (
                  <Field label="Bearer token reference" hint="Only a ${SECRET_NAME} reference; store the value in the Secrets tab. Leave blank for no bearer token.">
                    <TextInput mono value={form.tokenRef} placeholder="${MCP_TOKEN}" onChange={(e) => patch({ tokenRef: e.target.value })} />
                  </Field>
                ) : form.authMode === 'oauth' ? (
                  <p className="m-0 self-end text-xs text-fg-faint">
                    After saving, use Connect on the list. dnt-harness finds the provider's sign-in and registers itself where the provider allows it.
                  </p>
                ) : null}
              </>
            )}
          </div>

          {form.transport === 'http' && form.authMode === 'oauth' ? (
            <Disclosure summary="OAuth client · only for providers without registration" defaultOpen={clientNeeded !== null || form.clientId !== ''}>
              {clientNeeded !== null ? <p className="m-0 text-xs text-warn">{clientNeeded}</p> : null}
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Client ID" hint="From the OAuth app you created. Leave blank to let dnt-harness register.">
                  <TextInput mono value={form.clientId} onChange={(e) => patch({ clientId: e.target.value })} />
                </Field>
                <Field label="Client secret reference" hint="A ${SECRET_NAME} reference to the Secrets tab. Blank for a public client.">
                  <TextInput mono value={form.clientSecretRef} placeholder="${OAUTH_CLIENT_SECRET}" onChange={(e) => patch({ clientSecretRef: e.target.value })} />
                </Field>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Secret sent as</span>
                  <Segmented
                    label="Secret sent as"
                    value={form.clientAuthMethod}
                    options={[{ value: 'client_secret_post', label: 'Form body' }, { value: 'client_secret_basic', label: 'HTTP Basic' }]}
                    onChange={(clientAuthMethod) => patch({ clientAuthMethod })}
                  />
                </div>
              </div>
            </Disclosure>
          ) : null}

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

      {view === 'catalog' ? (
        <>
          <PanelIntro>
            Pick a server to add it. Installing saves it switched off, and stores a key in Secrets if you enter one; nothing runs until you press Enable. Anyone can publish an MCP server, so install only ones you trust.
          </PanelIntro>
          <McpCatalogView host={{ serverNames: new Set(rows.map((row) => row.name)), secretNames, busy: busy !== null, install: installFromCatalog }} />
        </>
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
