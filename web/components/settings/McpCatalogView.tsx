import { useMemo } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import {
  applyPlaceholders, catalogAuth, catalogPreview, CATALOG_CATEGORIES, MCP_CATALOG,
  type CatalogEntry,
} from '../../../src/harness/mcp/catalog.ts'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { EmptyState, ItemList, ItemRow, Section } from './settings-kit.tsx'

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

  const visible = useMemo(() => MCP_CATALOG.filter((entry) => matches(entry, query)), [query])

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

  return (
    <div className="flex flex-col gap-4">
      <Field label="Search the catalog">
        <TextInput value={query} placeholder="github, database, docs…" onChange={(event) => setQuery(event.target.value)} />
      </Field>
      {visible.length === 0 ? <EmptyState>Nothing in the catalog matches “{query.trim()}”.</EmptyState> : null}
      {CATALOG_CATEGORIES.map((category) => {
        const entries = visible.filter((entry) => entry.category === category.id)
        if (entries.length === 0) return null
        return (
          <Section key={category.id} title={category.label} count={entries.length}>
            <ItemList label={category.label}>
              {entries.map((entry) => (
                <ItemRow
                  key={entry.id}
                  title={
                    <>
                      <span>{entry.title}</span>
                      <Badge tone={entry.maintainer === 'official' ? 'blue' : 'gray'} title="Who maintains the server. Not a security review.">{entry.maintainer === 'official' ? 'Official' : 'Community'}</Badge>
                      <Badge tone={catalogAuth(entry) === 'none' ? 'green' : 'amber'}>{AUTH_LABEL[catalogAuth(entry)]}</Badge>
                      {installed(entry) ? <Badge tone="gray">Added</Badge> : null}
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
                        {needsSetup(entry) ? 'Set up…' : 'Install'}
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
          </Section>
        )
      })}
    </div>
  )
}
