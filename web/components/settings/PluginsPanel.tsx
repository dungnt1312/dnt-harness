import { useCallback, useEffect } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { PluginDetailsModal } from './PluginDetailsModal.tsx'
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
  FilterChips,
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
  SubTabs,
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

/** Sentinel tab/category value; marketplace and category names never start with a space. */
const ALL = ' all'
const OTHER = 'other'
const AVAILABLE_LIMIT = 150

/** Marketplace offered with one click until it is added (the user can still remove it). */
const RECOMMENDED_MARKETPLACE = {
  repo: 'anthropics/claude-plugins-official',
  name: 'claude-plugins-official',
  description: "Anthropic's official Claude Code plugin marketplace.",
} as const

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
  const [marketTab, setMarketTab] = useScopedState<string>(ALL)
  const [category, setCategory] = useScopedState<string>(ALL)
  const [detailsId, setDetailsId] = useScopedState<string | null>(null)
  const [view, setView] = useScopedState<'installed' | 'browse' | 'marketplaces'>('installed')
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
  const recommendedAdded = marketplaces.some((market) => market.name === RECOMMENDED_MARKETPLACE.name || market.source.repo === RECOMMENDED_MARKETPLACE.repo)
  const needle = query.trim().toLowerCase()
  const notInstalled = marketplaces.flatMap((market) => (market.document?.plugins ?? []).map((entry) => ({ ...entry, id: `${entry.name}@${market.name}`, marketplace: market.name })))
    .filter((entry) => !installedIds.has(entry.id))
  // One chip per marketplace that still has something to install (plus All when there are several).
  const marketChips = marketplaces
    .map((market) => ({ value: market.name, label: market.name, count: notInstalled.filter((entry) => entry.marketplace === market.name).length }))
    .filter((chip) => chip.count > 0)
  const marketTabs = [
    ...(marketChips.length > 1 ? [{ value: ALL, label: 'All marketplaces', count: notInstalled.length }] : []),
    ...marketChips,
  ]
  const activeMarket = marketTabs.some((tab) => tab.value === marketTab) ? marketTab : (marketTabs[0]?.value ?? ALL)
  const inMarket = notInstalled
    .filter((entry) => activeMarket === ALL || entry.marketplace === activeMarket)
    .filter((entry) => needle === '' || `${entry.name} ${entry.description ?? ''} ${entry.category ?? ''} ${entry.author ?? ''}`.toLowerCase().includes(needle))
  const categoryCounts = new Map<string, number>()
  for (const entry of inMarket) categoryCounts.set(entry.category ?? OTHER, (categoryCounts.get(entry.category ?? OTHER) ?? 0) + 1)
  const categories = [...categoryCounts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name === OTHER ? 1 : b.name === OTHER ? -1 : b.count - a.count || a.name.localeCompare(b.name)))
  const activeCategory = category === ALL || categoryCounts.has(category) ? category : ALL
  const available = inMarket.filter((entry) => activeCategory === ALL || (entry.category ?? OTHER) === activeCategory)

  const install = (id: string): void => act(id, 'install', scope, `Installed ${id} in ${SCOPE_LABEL[scope]}`)

  return (
    <PanelBody>
      <PanelIntro>
        Claude Code plugins bundle commands, skills, agents, hooks and MCP servers. Installing or enabling a plugin lets its hooks and MCP servers run commands on this machine — install only plugins you trust.
      </PanelIntro>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SubTabs
          label="Plugins view"
          value={view}
          onChange={setView}
          tabs={[
            { value: 'installed', label: 'Installed', count: plugins?.length ?? 0 },
            { value: 'browse', label: 'Browse', count: notInstalled.length },
            { value: 'marketplaces', label: 'Marketplaces', count: marketplaces.length },
          ]}
        />
        {view !== 'marketplaces' ? (
          <span className="flex items-center gap-2 text-[13px] text-fg-muted" title={project === undefined ? 'Bind a project to choose project scope.' : undefined}>
            Install and switch in
            <Segmented label="Settings scope" value={scope} options={scopes} onChange={setScope} disabled={busy !== null} />
          </span>
        ) : null}
      </div>

      {view === 'installed' ? (
      <Section title="Installed plugins">
        {plugins === null ? <EmptyState>Loading…</EmptyState> : plugins.length === 0 ? (
          <EmptyState>No plugins yet. Add a marketplace in Marketplaces, then install from Browse.</EmptyState>
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
                      <span className="break-all">{plugin.name}</span>
                      <Badge tone={plugin.active ? 'green' : plugin.installed ? 'gray' : 'amber'}>{plugin.active ? 'On' : plugin.installed ? 'Off' : 'Not installed'}</Badge>
                      {plugin.version !== undefined ? <Badge>{plugin.version}</Badge> : null}
                    </>
                  )}
                  meta={[
                    `@${plugin.marketplace}`,
                    plugin.description,
                    summary,
                    decided !== undefined ? `${decided.value ? 'Enabled' : 'Disabled'} in ${SCOPE_LABEL[decided.scope]} settings` : undefined,
                  ].filter((part) => part !== undefined && part !== '').join(' · ')}
                  actions={(
                    <>
                      {canToggle ? (
                        <InlineSwitch
                          ariaLabel={`Enable ${plugin.id} in ${SCOPE_LABEL[scope]} settings`}
                          checked={plugin.active}
                          disabled={busy !== null}
                          title={`Writes enabledPlugins in ${SCOPE_LABEL[scope]} settings`}
                          onChange={(next) => act(plugin.id, next ? 'enable' : 'disable', scope, `${plugin.id} ${next ? 'enabled' : 'disabled'} in ${SCOPE_LABEL[scope]} settings`)}
                        />
                      ) : (
                        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => install(plugin.id)}>
                          <Icon name="arrowDown" size={13} />Install
                        </Button>
                      )}
                      {plugin.installed ? (
                        <RowMenu
                          label={`Actions for ${plugin.id}`}
                          disabled={busy !== null}
                          actions={[
                            { label: 'Details', icon: 'info', onSelect: () => setDetailsId(plugin.id) },
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
      </Section>
      ) : null}

      {view === 'marketplaces' ? (
      <Section title="Marketplaces">
        {suggested.length > 0 ? (
          <p className="m-0 text-[13px] text-fg-muted">This project's settings suggest: {suggested.join(', ')} (<code>extraKnownMarketplaces</code>).</p>
        ) : null}
        {marketplaces.length > 0 ? (
          <ItemList label="Marketplaces">
            {marketplaces.map((market) => (
              <ItemRow
                key={market.name}
                title={<><span className="break-all">{market.name}</span><Badge>{market.document?.plugins.length ?? 0} {(market.document?.plugins.length ?? 0) === 1 ? 'plugin' : 'plugins'}</Badge>{market.error !== undefined ? <Badge tone="amber">Failed</Badge> : null}</>}
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
        {!recommendedAdded ? (
          <ItemList label="Recommended marketplaces">
            <ItemRow
              title={<><span className="break-all">{RECOMMENDED_MARKETPLACE.name}</span><Badge tone="blue">Recommended</Badge></>}
              meta={`${RECOMMENDED_MARKETPLACE.description} (${RECOMMENDED_MARKETPLACE.repo})`}
              actions={(
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void run('market:add', async () => {
                    const added = await addMarketplace(RECOMMENDED_MARKETPLACE.repo)
                    await load()
                    setNotice({ kind: 'ok', text: `Added ${added.name} (${added.plugins} plugins)` })
                  })}
                >
                  {busy === 'market:add' ? 'Adding…' : <><Icon name="arrowDown" size={13} />Add</>}
                </Button>
              )}
            />
          </ItemList>
        ) : null}
        <form
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
          {/* The row (input + button) is the Field's control, so the button lines up with the input, not the hint below. */}
          <Field label="Add marketplace" htmlFor="marketplace-source" hint="owner/repo on GitHub, a git URL (append #ref for a branch or tag), or an absolute folder path.">
            <div className="flex items-center gap-2">
              <TextInput
                id="marketplace-source"
                mono
                className="min-w-0 flex-1"
                value={source}
                placeholder="anthropics/claude-plugins-official"
                onChange={(event) => setSource(event.target.value)}
                aria-label="Marketplace source"
                aria-describedby="marketplace-source-hint"
              />
              <Button type="submit" variant="primary" disabled={busy !== null || source.trim() === ''}>{busy === 'market:add' ? 'Adding…' : 'Add'}</Button>
            </div>
          </Field>
        </form>
      </Section>
      ) : null}

      {view === 'browse' ? (
        <Section title="Catalog" count={available.length} actions={<TextInput value={query} placeholder="Search plugins" onChange={(event) => setQuery(event.target.value)} aria-label="Filter available plugins" />}>
          {marketplaces.length === 0 ? (
            <EmptyState>No marketplaces yet. Add one in Marketplaces to browse its plugins.</EmptyState>
          ) : (
            <>
              {marketTabs.length > 1 ? (
                <FilterChips label="Marketplace" value={activeMarket} onChange={(next) => { setMarketTab(next); setCategory(ALL) }} items={marketTabs} />
              ) : null}
              {categories.length > 1 ? (
                <FilterChips
                  label="Category"
                  value={activeCategory}
                  onChange={setCategory}
                  items={[{ value: ALL, label: 'All categories', count: inMarket.length }, ...categories.map((item) => ({ value: item.name, label: item.name, count: item.count }))]}
                />
              ) : null}
              {available.length === 0 ? <EmptyState>Nothing to show.</EmptyState> : (
                <ItemList label="Available plugins">
                  {available.slice(0, AVAILABLE_LIMIT).map((entry) => (
                    <ItemRow
                      key={entry.id}
                      title={(
                        <>
                          <span className="break-all">{entry.name}</span>
                          {entry.category !== undefined && activeCategory === ALL ? <Badge>{entry.category}</Badge> : null}
                        </>
                      )}
                      meta={<span className="line-clamp-2" title={entry.description}>{[`@${entry.marketplace}`, entry.description].filter((part) => part !== undefined && part !== '').join(' · ')}</span>}
                      actions={(
                        <>
                          <IconButton label={`Details for ${entry.id}`} onClick={() => setDetailsId(entry.id)}><Icon name="info" size={14} /></IconButton>
                          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => install(entry.id)} aria-label={`Install ${entry.id}`}>
                            <Icon name="arrowDown" size={13} />{busy === `install:${entry.id}` ? 'Installing…' : 'Install'}
                          </Button>
                        </>
                      )}
                    />
                  ))}
                </ItemList>
              )}
              {available.length > AVAILABLE_LIMIT ? <p className="m-0 text-xs text-fg-faint">Showing {AVAILABLE_LIMIT} of {available.length}. Search or pick a category to narrow the list.</p> : null}
            </>
          )}
        </Section>
      ) : null}

      {detailsId !== null ? (
        <PluginDetailsModal
          workspaceId={workspaceId}
          {...(project !== undefined ? { projectId: project } : {})}
          pluginId={detailsId}
          installed={installedIds.has(detailsId)}
          busy={busy === `install:${detailsId}`}
          onInstall={() => install(detailsId)}
          onClose={() => setDetailsId(null)}
        />
      ) : null}

      <PanelFooter notice={notice} />
    </PanelBody>
  )
}
