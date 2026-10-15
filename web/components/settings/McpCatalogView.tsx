import { useMemo } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import {
  applyPlaceholders, catalogAuth, catalogPreview, CATALOG_CATEGORIES, MCP_CATALOG,
  type CatalogEntry,
} from '../../../src/harness/mcp/catalog.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { EmptyState, FilterChips, ItemList, ItemRow, PanelIntro, Section } from './settings-kit.tsx'

const ALL = ' all'
const AUTH_LABEL = { none: 'No sign-in', token: 'Needs a key', oauth: 'Sign in with OAuth' } as const

/** What the catalog needs from the panel: which names and secrets exist, and how to install. */
export interface CatalogHost {
  readonly serverNames: ReadonlySet<string>
  readonly secretNames: ReadonlySet<string>
  readonly busy: boolean
  /** Install: store `secrets` first, then save `config` under a free name. Resolves when done. */
  readonly install: (entry: CatalogEntry, config: Record<string, unknown>, secrets: Readonly<Record<string, string>>) => Promise<void>
}

function matches(entry: CatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return [entry.id, entry.title, entry.description, entry.category].some((text) => text.toLowerCase().includes(needle))
}

/** The inputs one entry still needs: secrets the workspace lacks, and placeholders. */
function InstallForm({ entry, host, values, onChange, onCancel, onInstall }: {
  readonly entry: CatalogEntry
  readonly host: CatalogHost
  readonly values: Readonly<Record<string, string>>
  readonly onChange: (key: string, value: string) => void
  readonly onCancel: () => void
  readonly onInstall: () => void
}) {
  const missingSecrets = entry.secrets.filter((secret) => !host.secretNames.has(secret.name))
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted p-3">
      {entry.placeholders.map((placeholder) => (
        <Field key={placeholder.token} label={placeholder.label} hint={placeholder.hint}>
          <TextInput mono value={values[placeholder.token] ?? ''} onChange={(event) => onChange(placeholder.token, event.target.value)} />
        </Field>
      ))}
      {missingSecrets.map((secret) => (
        <Field
          key={secret.name}
          label={secret.label}
          hint={<>Stored encrypted as <code>{secret.name}</code> in Secrets; never shown again. Leave blank to add it later. <a className="underline" href={secret.obtainUrl} target="_blank" rel="noreferrer">Where to get it</a></>}
        >
          <TextInput mono type="password" autoComplete="off" value={values[secret.name] ?? ''} onChange={(event) => onChange(secret.name, event.target.value)} />
        </Field>
      ))}
      {entry.notes !== undefined ? <p className="m-0 text-xs text-fg-faint">{entry.notes}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          aria-label={`Install ${entry.title}`}
          disabled={host.busy || entry.placeholders.some((placeholder) => (values[placeholder.token] ?? '').trim() === '')}
          onClick={onInstall}
        >
          {host.busy ? 'Installing…' : 'Install'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Settings → MCP → Browse catalog. Installing only saves the server (disabled)
 * and, when asked, stores a key in Secrets; starting it stays a separate,
 * explicit Enable on the list.
 */
export function McpCatalogView({ host }: { readonly host: CatalogHost }) {
  const [query, setQuery] = useScopedState('')
  /** The entry whose inputs are open, and what has been typed into them. */
  const [open, setOpen] = useScopedState<string | null>(null)
  const [values, setValues] = useScopedState<Readonly<Record<string, string>>>({})

  const [category, setCategory] = useScopedState<string>(ALL)
  const matching = useMemo(() => MCP_CATALOG.filter((entry) => matches(entry, query)), [query])
  const categories = CATALOG_CATEGORIES
    .map((item) => ({ value: item.id, label: item.label, count: matching.filter((entry) => entry.category === item.id).length }))
    .filter((item) => item.count > 0)
  const activeCategory = categories.some((item) => item.value === category) ? category : ALL
  const visible = matching.filter((entry) => activeCategory === ALL || entry.category === activeCategory)

  const installed = (entry: CatalogEntry): boolean => host.serverNames.has(entry.id) || [...host.serverNames].some((name) => new RegExp(`^${entry.id}-\\d+$`).test(name))

  const run = (entry: CatalogEntry): void => {
    const placeholderValues = Object.fromEntries(entry.placeholders.map((placeholder) => [placeholder.token, (values[placeholder.token] ?? '').trim()]))
    const secrets = Object.fromEntries(
      entry.secrets
        .filter((secret) => !host.secretNames.has(secret.name) && (values[secret.name] ?? '') !== '')
        .map((secret) => [secret.name, values[secret.name] ?? '']),
    )
    void host.install(entry, applyPlaceholders(entry.config, placeholderValues), secrets).then(() => {
      setOpen(null)
      setValues({})
    }, () => undefined)
  }

  /** Inputs still to collect: any placeholder, and secrets this workspace does not have. */
  const needsSetup = (entry: CatalogEntry): boolean => entry.placeholders.length > 0 || entry.secrets.some((secret) => !host.secretNames.has(secret.name))

  const choose = (entry: CatalogEntry): void => {
    if (!needsSetup(entry)) { run(entry); return }
    setOpen(entry.id)
    setValues({})
  }

  const categoryLabel = new Map(CATALOG_CATEGORIES.map((item) => [item.id, item.label]))
  return (
    <Section title="Catalog" count={visible.length} actions={<TextInput value={query} placeholder="Search servers" aria-label="Search the catalog" onChange={(event) => setQuery(event.target.value)} />}>
      <PanelIntro>Installing saves a server switched off; nothing runs until you switch it on. Anyone can publish an MCP server, so install only ones you trust.</PanelIntro>
      {categories.length > 1 ? (
        <FilterChips label="Category" value={activeCategory} onChange={setCategory} items={[{ value: ALL, label: 'All', count: matching.length }, ...categories]} />
      ) : null}
      {visible.length === 0 ? <EmptyState>Nothing in the catalog matches “{query.trim()}”.</EmptyState> : (
        <ItemList label="Catalog servers">
          {visible.map((entry) => (
            <ItemRow
              key={entry.id}
              title={
                <>
                  <span>{entry.title}</span>
                  {activeCategory === ALL ? <Badge>{categoryLabel.get(entry.category) ?? entry.category}</Badge> : null}
                  {entry.maintainer === 'official' ? <Badge tone="blue" title="Maintained by the vendor. Not a security review.">Official</Badge> : null}
                  {catalogAuth(entry) !== 'none' ? <Badge tone="amber">{AUTH_LABEL[catalogAuth(entry)]}</Badge> : null}
                  {installed(entry) ? <Badge tone="green">Installed</Badge> : null}
                </>
              }
              meta={
                <>
                  <span className="block">{entry.description}</span>
                  <span className="block font-mono">
                    {catalogPreview(entry)}{entry.requires.length > 0 ? ` · needs ${entry.requires.join(', ')}` : ''}
                  </span>
                </>
              }
              actions={
                open === entry.id ? undefined : (
                  <Button variant="outline" size="sm" aria-label={`Install ${entry.title}`} disabled={host.busy} onClick={() => choose(entry)}>
                    <Icon name="arrowDown" size={13} />{needsSetup(entry) ? 'Set up…' : 'Install'}
                  </Button>
                )
              }
            >
              {open === entry.id ? (
                <InstallForm
                  entry={entry}
                  host={host}
                  values={values}
                  onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
                  onCancel={() => { setOpen(null); setValues({}) }}
                  onInstall={() => run(entry)}
                />
              ) : null}
            </ItemRow>
          ))}
        </ItemList>
      )}
    </Section>
  )
}
