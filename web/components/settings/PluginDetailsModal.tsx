import { useEffect, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Modal } from '../ui/Modal.tsx'
import { pluginDetails, type PluginDetailsView, type PluginItemView } from '../../lib/api.ts'

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  relative: 'bundled in marketplace',
  github: 'GitHub',
  url: 'git repository',
  git: 'git repository',
  'git-subdir': 'git repository folder',
  installed: 'installed copy',
}

function ItemSection({ title, items, mono = true }: { readonly title: string; readonly items: readonly PluginItemView[]; readonly mono?: boolean }) {
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-faint">{title} <span className="font-normal">{items.length}</span></h3>
      <ul aria-label={title} className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0">
        {items.map((item) => (
          <li key={item.name} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
            <span className={mono ? 'truncate font-mono text-[12.5px]' : 'truncate text-[13px]'}>{item.name}</span>
            {item.description !== undefined ? <span className="line-clamp-2 text-xs text-fg-faint">{item.description}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  )
}

/**
 * What one plugin brings: manifest facts plus its commands, skills, agents,
 * hook events and MCP servers. A plugin that is not installed is read by the
 * server from its marketplace source (a git clone can take a few seconds).
 */
export function PluginDetailsModal({ workspaceId, projectId, pluginId, installed, busy, onInstall, onClose }: {
  readonly workspaceId: string
  readonly projectId?: string
  readonly pluginId: string
  readonly installed: boolean
  readonly busy: boolean
  readonly onInstall: () => void
  readonly onClose: () => void
}) {
  const [details, setDetails] = useScopedState<PluginDetailsView | null>(null)
  const [error, setError] = useScopedState<string | null>(null)

  useEffect(() => {
    setDetails(null)
    setError(null)
    pluginDetails(workspaceId, pluginId, projectId).then(setDetails, (cause: unknown) => setError(String(cause instanceof Error ? cause.message : cause)))
  }, [workspaceId, pluginId, projectId])

  const [name, marketplace] = [pluginId.slice(0, pluginId.lastIndexOf('@')), pluginId.slice(pluginId.lastIndexOf('@') + 1)]
  const empty = details !== null && details.commands.length + details.skills.length + details.agents.length + details.hooks.length + details.mcpServers.length === 0

  return (
    <Modal
      open
      label={`Plugin ${pluginId}`}
      width="lg"
      onDismiss={onClose}
      header={(
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono text-[14px] font-semibold">{name}</span>
            <span className="text-xs text-fg-faint">@{marketplace}</span>
            {details?.version !== undefined ? <Badge>{details.version}</Badge> : null}
            {details?.category !== undefined ? <Badge>{details.category}</Badge> : null}
            {installed ? <Badge tone="green">installed</Badge> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!installed ? (
              <Button variant="primary" size="sm" disabled={busy} onClick={onInstall}>
                {busy ? 'Installing…' : <><Icon name="arrowDown" size={13} />Install</>}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close plugin details"><Icon name="close" size={14} /></Button>
          </div>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        {error !== null ? <p role="alert" className="m-0 text-[13px] text-bad">Could not read this plugin: {error}</p> : null}
        {details === null && error === null ? (
          <p className="m-0 text-[13px] text-fg-muted" aria-live="polite">Reading plugin contents… (plugins hosted in git are fetched first)</p>
        ) : null}
        {details !== null ? (
          <>
            {details.description !== undefined ? <p className="m-0 text-[13px] leading-5 text-fg-muted">{details.description}</p> : null}
            <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
              {details.author !== undefined ? <Fact label="Author">{details.author}</Fact> : null}
              <Fact label="Source">
                {SOURCE_LABEL[details.source.kind] ?? details.source.kind}
                {details.source.location !== '' ? <span className="ml-1.5 font-mono text-xs text-fg-faint">{details.source.location}</span> : null}
              </Fact>
              {details.homepage !== undefined ? <Fact label="Homepage"><a href={details.homepage} target="_blank" rel="noreferrer noopener" className="text-link hover:underline">{details.homepage}</a></Fact> : null}
              {details.repository !== undefined && details.repository !== details.homepage ? <Fact label="Repository"><a href={details.repository} target="_blank" rel="noreferrer noopener" className="text-link hover:underline">{details.repository}</a></Fact> : null}
              {details.license !== undefined ? <Fact label="License">{details.license}</Fact> : null}
              {details.keywords !== undefined ? <Fact label="Keywords">{details.keywords.join(', ')}</Fact> : null}
            </dl>
            {empty ? <p className="m-0 text-[13px] text-fg-muted">This plugin contributes no commands, skills, agents, hooks or MCP servers that dnt-harness runs.</p> : null}
            <ItemSection title="Skills" items={details.skills} />
            <ItemSection title="Commands" items={details.commands.map((item) => ({ ...item, name: `/${item.name}` }))} />
            <ItemSection title="Agents" items={details.agents} />
            <ItemSection title="MCP servers" items={details.mcpServers.map((server) => ({ name: server.name, description: server.type }))} />
            <ItemSection title="Hooks" items={details.hooks.map((event) => ({ name: event }))} />
            {details.hooks.length > 0 || details.mcpServers.length > 0 ? (
              <p className="m-0 flex items-start gap-1.5 text-xs text-fg-faint"><Icon name="alertTriangle" size={13} />Hooks and MCP servers run commands on this machine once the plugin is enabled.</p>
            ) : null}
            {details.notes.length > 0 ? <p className="m-0 text-xs text-fg-faint">{details.notes.join(' · ')}</p> : null}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
