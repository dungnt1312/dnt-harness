import { useCallback, useEffect, useState } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { getSystemPrompts, putSystemPrompts, type SystemPromptsResponse } from '../../lib/api.ts'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import Icon from '../common/Icon.tsx'
import {
  CodeArea,
  Notice,
  PanelBody,
  PanelFooter,
  PanelIntro,
  Section,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'

/**
 * Workspace-authored replacements for the fixed harness system prompts.
 * Two editors — the root conversation base prompt and the subagent preamble —
 * each shown with its effective text so the operator always edits what a
 * request will actually carry.
 */

interface Draft {
  readonly base: string
  readonly child: string
}

const draftOf = (response: SystemPromptsResponse): Draft => ({ base: response.base.text, child: response.child.text })

/** The builder's estimate: chars/4, matching the context budget's numbers. */
function estimateLabel(text: string): string {
  const chars = text.length
  return `${chars.toLocaleString()} chars · ~${Math.ceil(chars / 4).toLocaleString()} tok (est)`
}

function isConflict(cause: unknown): boolean {
  return /409|conflict/i.test(String(cause))
}

export function SystemPromptsPanel(props: { readonly workspaceId: string | null }) {
  return <SystemPromptsPanelContent key={props.workspaceId} {...props} />
}

function SystemPromptsPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [response, setResponse] = useScopedState<SystemPromptsResponse | null>(null)
  const [draft, setDraft] = useScopedState<Draft | null>(null)
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [conflict, setConflict] = useScopedState(false)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (workspaceId === null) return
    setLoading(true)
    try {
      const result = await getSystemPrompts(workspaceId)
      setResponse(result)
      setDraft(draftOf(result))
      setConflict(false)
      setNotice(result.warning !== undefined ? { kind: 'info', text: result.warning } : null)
    } catch (cause) {
      setNotice({ kind: 'bad', text: String(cause) })
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { void load() }, [load])

  if (workspaceId === null) return <WorkspaceRequired />
  if (loading || response === null || draft === null) {
    return (
      <PanelBody>
        <PanelIntro>
          Replace the fixed system prompts for THIS workspace. The base prompt opens every conversation; the subagent
          prompt frames every delegated role. Other workspaces keep the defaults.
        </PanelIntro>
        <p className="m-0 text-sm text-fg-faint">Loading system prompts…</p>
      </PanelBody>
    )
  }

  const baseline = draftOf(response)
  const dirty = draft.base !== baseline.base || draft.child !== baseline.child

  const patch = (next: Partial<Draft>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...next }))
    setNotice(null)
    setConflict(false)
  }

  const save = (): Promise<void> => run('save', async () => {
    try {
      const result = await putSystemPrompts(workspaceId, { base: draft.base, child: draft.child }, response.hash)
      setResponse(result)
      setDraft(draftOf(result))
      setConflict(false)
      setNotice({ kind: 'ok', text: 'Saved. The next request in this workspace uses the new prompt.' })
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(true)
      setNotice({ kind: 'bad', text: 'The prompts changed elsewhere since you opened this panel. Reload or overwrite.' })
    }
  })

  const reload = (): Promise<void> => run('reload', async () => {
    await load()
    setNotice({ kind: 'info', text: 'Reloaded the server version.' })
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    const fresh = await getSystemPrompts(workspaceId)
    const result = await putSystemPrompts(workspaceId, { base: draft.base, child: draft.child }, fresh.hash)
    setResponse(result)
    setDraft(draftOf(result))
    setConflict(false)
    setNotice({ kind: 'ok', text: 'Saved (overwrote the server version).' })
  })

  const editor = (key: 'base' | 'child', title: string, hint: string) => {
    const entry = response[key]
    const defaulted = entry.overridden === false
    return (
      <Section
        title={title}
        actions={<Badge tone={entry.overridden ? 'blue' : 'gray'}>{entry.overridden ? 'Custom' : 'Default'}</Badge>}
      >
        <p className="m-0 text-[13px] text-fg-muted">{hint}</p>
        <CodeArea
          tall
          aria-label={title}
          value={draft[key]}
          onChange={(event) => patch({ [key]: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-faint">{estimateLabel(draft[key])}</span>
          {draft[key] !== response.defaults[key] ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => patch({ [key]: response.defaults[key] })}
              title="Fill the editor with the harness default text"
            >
              <Icon name="refresh" size={13} />Reset to default
            </Button>
          ) : null}
        </div>
      </Section>
    )
  }

  return (
    <PanelBody>
      <PanelIntro>
        Replace the fixed system prompts for THIS workspace. The <b>base prompt</b> opens every root conversation; the{' '}
        <b>subagent prompt</b> frames every delegated role. Clearing an editor (or saving it blank) falls back to the
        default; other workspaces are never affected. Mode instructions, roles and skill text are edited in their own tabs.
      </PanelIntro>

      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}

      {editor('base', 'Base prompt (conversations)', 'Sent as the first system block of every root conversation in this workspace.')}
      {editor('child', 'Subagent prompt (delegated roles)', 'Sent to every subagent this workspace delegates to, before the role’s own instructions.')}

      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <span className="min-w-0 flex-1 basis-48">The prompts changed on the server since you opened this panel.</span>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reload()}>Reload server version</Button>
          <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => void overwrite()}>Overwrite anyway</Button>
        </div>
      ) : null}

      <PanelFooter notice={null}>
        <Button variant="primary" size="sm" disabled={busy !== null || !dirty} onClick={() => void save()}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null || !dirty}
          onClick={() => { setDraft(baseline); setNotice(null); setConflict(false) }}
        >
          Cancel
        </Button>
        {dirty ? <span className="self-center text-xs text-fg-faint">Unsaved changes</span> : null}
      </PanelFooter>
    </PanelBody>
  )
}
