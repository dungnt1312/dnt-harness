import { useEffect, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Select, type SelectOption } from '../ui/Select.tsx'
import { listAgentDefinitions } from '../../lib/api.ts'
import type { AgentDefinitionRow } from '../../lib/types.ts'

const MAIN = '__main__'
const SOURCE_LABELS: Readonly<Record<AgentDefinitionRow['source'], string>> = {
  bundled: 'Built-in roles',
  user: 'Your roles (~/.claude/agents)',
  workspace: 'Workspace roles',
  project: 'Project roles',
}
const SOURCE_ORDER: readonly AgentDefinitionRow['source'][] = ['project', 'workspace', 'user', 'bundled']
const INSTRUCTIONS_PREVIEW = 280

/**
 * The editor's Agent block: who runs the task. A searchable picker on top
 * (main agent, then roles grouped by where they are defined) and, below,
 * what the choice means: the role's tools, model, skills and instructions.
 */
export function AgentSection({ workspaceId, projectId, value, onChange }: {
  readonly workspaceId: string
  readonly projectId: string | null
  readonly value: string | null
  readonly onChange: (next: string | null) => void
}) {
  const [roles, setRoles] = useState<readonly AgentDefinitionRow[] | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    setError(false)
    listAgentDefinitions(workspaceId, projectId).then(
      (rows) => { if (!cancelled) setRoles(rows) },
      () => { if (!cancelled) { setRoles([]); setError(true) } },
    )
    return () => { cancelled = true }
  }, [workspaceId, projectId])

  const sorted = [...(roles ?? [])].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.definition.name.localeCompare(b.definition.name))
  const options: SelectOption[] = [
    { value: MAIN, label: 'Main agent', provider: 'Default' },
    ...sorted.map((row) => ({ value: row.definition.name, label: row.definition.name, provider: SOURCE_LABELS[row.source] })),
  ]
  const selected = value === null ? undefined : roles?.find((row) => row.definition.name === value)
  const missing = value !== null && roles !== null && selected === undefined
  if (missing) options.push({ value, label: `${value} (not available)`, provider: 'Unavailable' })

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-fg-muted">Agent</span>
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
        <Select
          label="Agent that runs each run"
          value={value ?? MAIN}
          options={options}
          onChange={(next) => onChange(next === MAIN ? null : next)}
        />
        {value === null ? (
          <p className="m-0 text-[13px] text-fg-muted">
            A normal conversation: every tool and the context (instructions, memory, skills) that the selected mode allows.
          </p>
        ) : missing ? (
          <p className="m-0 text-[13px] text-bad">
            '{value}' is not available in this workspace or project, so runs will fail. Pick another agent.
          </p>
        ) : selected === undefined ? (
          <p className="m-0 text-[13px] text-fg-faint">{error ? 'Agent roles could not be loaded.' : 'Loading agent…'}</p>
        ) : (
          <RoleDetail key={selected.definition.name} row={selected} />
        )}
      </div>
    </div>
  )
}

function RoleDetail({ row }: { readonly row: AgentDefinitionRow }) {
  const [showAll, setShowAll] = useState(false)
  const { definition } = row
  const model = row.modelResolution?.resolved ?? definition.model ?? 'the task\'s model'
  const instructions = definition.instructions.trim()
  const long = instructions.length > INSTRUCTIONS_PREVIEW
  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      <p className="m-0 text-fg">{definition.description}</p>
      <p className="m-0 text-xs text-fg-faint">
        The run's conversation itself becomes this agent: only the tools below (and only those the mode allows), with this role's instructions in place of the mode's.
      </p>
      <dl className="m-0 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2">
        <dt className="text-fg-muted">Model</dt>
        <dd className="m-0 min-w-0 break-words font-mono text-xs leading-5">{model}</dd>
        <dt className="text-fg-muted">Tools</dt>
        <dd className="m-0 flex min-w-0 flex-wrap gap-1">
          {definition.inheritsTools === true
            ? <Badge tone="amber">All tools</Badge>
            : definition.tools.length === 0
              ? <span className="text-fg-faint">None</span>
              : definition.tools.map((tool) => <Badge key={tool} tone="gray">{tool}</Badge>)}
          {definition.disallowedTools.map((tool) => <Badge key={`no-${tool}`} tone="red">no {tool}</Badge>)}
        </dd>
        {definition.skills !== undefined && definition.skills.length > 0 ? (
          <>
            <dt className="text-fg-muted">Skills</dt>
            <dd className="m-0 flex min-w-0 flex-wrap gap-1">{definition.skills.map((skill) => <Badge key={skill} tone="blue">{skill}</Badge>)}</dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Defined in</dt>
        <dd className="m-0 min-w-0 truncate text-xs leading-5 text-fg-muted" title={row.path}>{row.path ?? row.source}</dd>
      </dl>
      {definition.warnings !== undefined && definition.warnings.length > 0 ? (
        <p className="m-0 flex items-start gap-1.5 text-xs text-warn">
          <Icon name="alertTriangle" size={13} className="mt-0.5 shrink-0" />
          <span>{definition.warnings.join('; ')}</span>
        </p>
      ) : null}
      {instructions !== '' ? (
        <div className="flex flex-col gap-1">
          <span className="text-fg-muted">Instructions</span>
          <pre className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-bg p-2.5 font-sans text-xs leading-5 text-fg-muted">
            {showAll || !long ? instructions : `${instructions.slice(0, INSTRUCTIONS_PREVIEW).trimEnd()}…`}
          </pre>
          {long ? (
            <button type="button" className="w-fit text-xs text-link hover:underline" onClick={() => setShowAll((open) => !open)}>
              {showAll ? 'Show less' : 'Show full instructions'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
