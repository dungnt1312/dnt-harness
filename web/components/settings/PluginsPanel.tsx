import { useCallback, useEffect } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import {
  addMarketplace,
  listMarketplaces,
  listPlugins,
  pluginAction,
  removeMarketplace,
  updateMarketplace,
  type MarketplaceView,
  type PluginRowView,
  type PluginScope,
} from '../../lib/api.ts'
import {
  EmptyState,
  InlineConfirm,
  InlineSwitch,
  ItemList,
  ItemRow,
  LoadFailed,
  PanelBody,
  PanelFooter,
  PanelIntro,
  RowMenu,
  Section,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'

const SCOPE_LABEL: Readonly<Record<PluginScope, string>> = {
  user: '~/.claude',
  workspace: 'Workspace',
  project: 'Project',
  local: 'Project (local)',
}

/** One line saying what a plugin brings, e.g. "2 commands · 1 skill · hooks · MCP: docs". */
export function componentSummary(components: PluginRowView['components']): string {
  if (components === undefined) return ''
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
  return [
    components.commands > 0 ? plural(components.commands, 'command') : '',
    components.skills > 0 ? plural(components.skills, 'skill') : '',
    components.agents > 0 ? plural(components.agents, 'agent') : '',
    components.hooks ? 'hooks' : '',
    components.mcpServers.length > 0 ? `MCP: ${components.mcpServers.join(', ')}` : '',
  ].filter((part) => part !== '').join(' · ')
}

function sourceText(source: MarketplaceView['source']): string {
  return source.repo ?? source.url ?? source.path ?? source.source
}

/**
 * Claude Code plugins (Settings → Plugins). Marketplaces are shared by the
 * whole host; install and enable write `enabledPlugins` in the chosen scope's
 * settings file — the workspace (`<ws>/settings.json`), or the bound
 * project's `.claude/settings.json` / `.claude/settings.local.json`.
 * `~/.claude/settings.json` is read, never written.
 */
export function PluginsPanel(props: { readonly workspaceId: string | null; readonly projectId?: string | null }) {
  return <PluginsPanelContent key={`${props.workspaceId}:${props.projectId ?? ''}`} {...props} />
}

function PluginsPanelContent({ workspaceId, projectId }: { readonly workspaceId: string | null; readonly projectId?: string | null }) {
  const project = projectId ?? undefined
  const [plugins, setPlugins] = useScopedState<readonly PluginRowView[] | null>(null)
  const [suggested, setSuggested] = useScopedState<readonly string[]>([])
  const [marketplaces, setMarketplaces] = useScopedState<readonly MarketplaceView[]>([])
  const [loadError, setLoadError] = useScopedState<string | null>(null)
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [source, setSource] = useScopedState('')
  const [scope, setScope] = useScopedState<PluginScope>('workspace')
  const [confirm, setConfirm] = useScopedState<{ readonly kind: 'uninstall' | 'remove'; readonly id: string } | null>(null)
  const [query, setQuery] = useScopedState('')
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const load = useCallback(async () => {
    if (workspaceId === null) return
    try {
      const [listed, markets] = await Promise.all([listPlugins(workspaceId, project), listMarketplaces()])
      setPlugins(listed.plugins)
      setSuggested(Object.keys(listed.suggestedMarketplaces))
      setMarketplaces(markets.marketplaces)
      setLoadError(null)
    } catch (cause) {
      setLoadError(String(cause))
    }
  }, [workspaceId, project])

  useEffect(() => { void load() }, [load])

  if (workspaceId === null) return <WorkspaceRequired />
  if (loadError !== null && plugins === null) return <LoadFailed what="plugins" error={loadError} busy={busy !== null} onRetry={() => void load()} />

  const act = (id: string, action: 'install' | 'enable' | 'disable' | 'uninstall' | 'update', at: PluginScope, done: string): void => {
    void run(`${action}:${id}`, async () => {
      const result = await pluginAction(workspaceId, id, action, at, project)
      setPlugins(result.plugins)
      setNotice(result.notes !== undefined && result.notes.length > 0
        ? { kind: 'info', text: `${done}. ${result.notes.join(' ')}` }
        : { kind: 'ok', text: done })
      setConfirm(null)
    })
  }

  const scopes: readonly { value: PluginScope; label: string }[] = [
    { value: 'workspace', label: 'Workspace' },
    ...(project !== undefined ? [{ value: 'project' as const, label: 'Project' }, { value: 'local' as const, label: 'Local' }] : []),
  ]
  const installedIds = new Set((plugins ?? []).filter((plugin) => plugin.installed).map((plugin) => plugin.id))
  const needle = query.trim().toLowerCase()
  const available = marketplaces.flatMap((market) => (market.document?.plugins ?? []).map((entry) => ({ ...entry, id: `${entry.name}@${market.name}`, marketplace: market.name })))
    .filter((entry) => !installedIds.has(entry.id))
    .filter((entry) => needle === '' || `${entry.name} ${entry.description ?? ''} ${entry.category ?? ''}`.toLowerCase().includes(needle))

  return (
    <PanelBody>
      <PanelIntro>
        Claude Code plugins bundle commands, skills, agents, hooks and MCP servers. Installing or enabling a plugin lets its hooks and MCP servers run commands on this machine — install only plugins you trust.
      </PanelIntro>

      <Section title="Installed" count={plugins?.length ?? 0}>
        {plugins === null ? <EmptyState>Loading…</EmptyState> : plugins.length === 0 ? (
          <EmptyState>No plugins yet. Add a marketplace below, then install from it.</EmptyState>
        ) : (
          <ItemList label="Installed plugins">
            {plugins.map((plugin) => {
              const decided = plugin.enabled
              const canToggle = plugin.installed
              const summary = componentSummary(plugin.components)
              return (
                <ItemRow
                  key={plugin.id}
                  title={(
                    <>
                      <span className="truncate font-mono text-[13px]">{plugin.id}</span>
                      {plugin.version !== undefined ? <Badge>{plugin.version}</Badge> : null}
                      {plugin.active ? <Badge tone="green">active</Badge> : plugin.installed ? <Badge>off</Badge> : <Badge tone="amber">not installed</Badge>}
                      {decided !== undefined ? <Badge tone="blue" title={`enabledPlugins in ${SCOPE_LABEL[decided.scope]} settings`}>{decided.value ? 'on' : 'off'} · {SCOPE_LABEL[decided.scope]}</Badge> : null}
                    </>
                  )}
                  meta={[plugin.description, summary].filter((part) => part !== undefined && part !== '').join(' — ')}
                  actions={(
                    <>
                      {canToggle ? (
                        <InlineSwitch
                          label="Enabled"
                          ariaLabel={`Enable ${plugin.id} in ${SCOPE_LABEL[scope]} settings`}
                          checked={plugin.active}
                          disabled={busy !== null}
                          title={`Writes enabledPlugins in ${SCOPE_LABEL[scope]} settings`}
                          onChange={(next) => act(plugin.id, next ? 'enable' : 'disable', scope, `${plugin.id} ${next ? 'enabled' : 'disabled'} in ${SCOPE_LABEL[scope]} settings`)}
                        />
                      ) : (
                        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => act(plugin.id, 'install', scope, `Installed ${plugin.id}`)}>
                          <Icon name="arrowDown" size={13} />Install
                        </Button>
                      )}
                      {plugin.installed ? (
                        <RowMenu
                          label={`Actions for ${plugin.id}`}
                          disabled={busy !== null}
                          actions={[
                            { label: 'Update', icon: 'refresh', onSelect: () => act(plugin.id, 'update', scope, `Updated ${plugin.id}`) },
                            ...plugin.installedScopes.filter((at) => at !== 'user').map((at) => ({
                              label: `Uninstall (${SCOPE_LABEL[at]})`, icon: 'trash' as const, danger: true,
                              onSelect: () => setConfirm({ kind: 'uninstall', id: `${plugin.id}\u0000${at}` }),
                            })),
                          ]}
                        />
                      ) : null}
                    </>
                  )}
                >
                  {plugin.error !== undefined ? <p className="m-0 text-xs text-bad">{plugin.error}</p> : null}
                  {plugin.notes !== undefined ? <p className="m-0 text-xs text-fg-faint">{plugin.notes.join(' · ')}</p> : null}
                  {confirm?.kind === 'uninstall' && confirm.id.startsWith(`${plugin.id}\u0000`) ? (() => {
                    const at = confirm.id.split('\u0000')[1] as PluginScope
                    return (
                      <InlineConfirm
                        message={`Uninstall ${plugin.id} from ${SCOPE_LABEL[at]}? Its MCP servers stop and its files leave the cache when no other scope uses them.`}
                        confirmLabel="Remove plugin"
                        busy={busy !== null}
                        onCancel={() => setConfirm(null)}
                        onConfirm={() => act(plugin.id, 'uninstall', at, `Uninstalled ${plugin.id}`)}
                      />
                    )
                  })() : null}
                </ItemRow>
              )
            })}
          </ItemList>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
          <span>Install and switch at</span>
          <Segmented label="Settings scope" value={scope} options={scopes} onChange={setScope} disabled={busy !== null} />
          {project === undefined ? <span className="text-fg-faint">Bind a project to choose project scope.</span> : null}
        </div>
      </Section>

      <Section title="Marketplaces" count={marketplaces.length}>
        {suggested.length > 0 ? (
          <p className="m-0 text-[13px] text-fg-muted">This project's settings suggest: {suggested.join(', ')} (<code>extraKnownMarketplaces</code>).</p>
        ) : null}
        {marketplaces.length > 0 ? (
          <ItemList label="Marketplaces">
            {marketplaces.map((market) => (
              <ItemRow
                key={market.name}
                title={<><span className="font-mono text-[13px]">{market.name}</span><Badge>{market.document?.plugins.length ?? 0} plugins</Badge></>}
                meta={market.error ?? sourceText(market.source)}
                actions={(
                  <RowMenu
                    label={`Actions for ${market.name}`}
                    disabled={busy !== null}
                    actions={[
                      { label: 'Update', icon: 'refresh', onSelect: () => void run(`market:${market.name}`, async () => { await updateMarketplace(market.name); await load(); setNotice({ kind: 'ok', text: `Updated ${market.name}` }) }) },
                      { label: 'Remove', icon: 'trash', danger: true, onSelect: () => setConfirm({ kind: 'remove', id: market.name }) },
                    ]}
                  />
                )}
              >
                {confirm?.kind === 'remove' && confirm.id === market.name ? (
                  <InlineConfirm
                    message={`Remove marketplace ${market.name}? Installed plugins stay installed.`}
                    confirmLabel="Remove marketplace"
                    busy={busy !== null}
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => void run(`market:${market.name}`, async () => { await removeMarketplace(market.name); setConfirm(null); await load(); setNotice({ kind: 'ok', text: `Removed ${market.name}` }) })}
                  />
                ) : null}
              </ItemRow>
            ))}
          </ItemList>
        ) : null}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const value = source.trim()
            if (value === '') return
            void run('market:add', async () => {
              const added = await addMarketplace(value)
              setSource('')
              await load()
              setNotice({ kind: 'ok', text: `Added ${added.name} (${added.plugins} plugins)` })
            })
          }}
        >
          <div className="min-w-0 flex-1 basis-64">
            <Field label="Add marketplace" hint="owner/repo on GitHub, a git URL (append #ref for a branch or tag), or an absolute folder path.">
              <TextInput mono value={source} placeholder="anthropics/claude-plugins-official" onChange={(event) => setSource(event.target.value)} aria-label="Marketplace source" />
            </Field>
          </div>
          <Button type="submit" variant="primary" size="sm" disabled={busy !== null || source.trim() === ''}>{busy === 'market:add' ? 'Adding…' : 'Add'}</Button>
        </form>
      </Section>

      {marketplaces.length > 0 ? (
        <Section title="Available" count={available.length} actions={<TextInput value={query} placeholder="Filter" onChange={(event) => setQuery(event.target.value)} aria-label="Filter available plugins" />}>
          {available.length === 0 ? <EmptyState>Nothing to show.</EmptyState> : (
            <ItemList label="Available plugins">
              {available.slice(0, 200).map((entry) => (
                <ItemRow
                  key={entry.id}
                  title={<><span className="font-mono text-[13px]">{entry.name}</span><span className="text-xs text-fg-faint">@{entry.marketplace}</span>{entry.category !== undefined ? <Badge>{entry.category}</Badge> : null}</>}
                  meta={entry.description}
                  actions={(
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => act(entry.id, 'install', scope, `Installed ${entry.id} in ${SCOPE_LABEL[scope]}`)}>
                      {busy === `install:${entry.id}` ? 'Installing…' : <><Icon name="arrowDown" size={13} />Install</>}
                    </Button>
                  )}
                />
              ))}
            </ItemList>
          )}
        </Section>
      ) : null}

      <PanelFooter notice={notice} />
    </PanelBody>
  )
}
