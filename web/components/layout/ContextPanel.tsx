import { useEffect, useState, type ReactNode } from 'react'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { useToast } from '../common/Toast.tsx'
import { Button } from '../ui/Button.tsx'
import { compactSession, type ContextManifestView, type StreamState } from '../../lib/api.ts'
import { budgetTone } from '../../lib/format.ts'
import { cn } from '../../lib/cn.ts'
import type { Meta, SessionModel, WorkspaceMeta } from '../../lib/types.ts'

export type SessionControlsStatus = 'loading' | 'unavailable'

const STREAM_LABELS: Readonly<Record<StreamState, string>> = {
  idle: 'No conversation selected',
  open: 'open',
  reconnecting: 'reconnecting…',
  connecting: 'connecting…',
}

const TONE_BAR: Readonly<Record<'ok' | 'warn' | 'bad', string>> = { ok: 'bg-fg', warn: 'bg-warn', bad: 'bg-bad' }

function Card({ title, action, children }: { readonly title: string; readonly action?: ReactNode; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-xs font-medium text-fg-faint">{title}</h3>
        {action}
      </div>
      <dl className="m-0 flex flex-col divide-y divide-line rounded-xl border border-line">{children}</dl>
    </section>
  )
}

function Row({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-3 px-3 py-2 text-[13px]">
      <dt className="w-20 shrink-0 text-fg-muted">{term}</dt>
      <dd className="m-0 min-w-0 flex-1 break-words">{children}</dd>
    </div>
  )
}

export interface ContextPanelProps {
  readonly meta: Meta | WorkspaceMeta | null
  /** Effective controls for the open conversation, if one has been fetched. */
  readonly sessionModel?: SessionModel
  /** Live global controls; legacy `source: 'global'` conversations display these, not their cached GET response. */
  readonly globalDefaults?: { readonly provider: string | null; readonly model: string | null }
  /** Existing-session load failure/loading; drafts omit this and use global defaults. */
  readonly sessionControlsStatus?: SessionControlsStatus
  readonly stream: StreamState
  readonly sessionId: string | null
  readonly sessionFolder: string | null
  readonly eventCount: number
  readonly manifest?: ContextManifestView | null
  readonly workspaceId?: string | null
  readonly running?: boolean
  readonly modeLabel?: string | null
  readonly onCompacted?: () => void
  readonly onOpenSettingsTab?: (tab: 'skills' | 'memory') => void
}

export function ContextPanel({ meta, sessionModel, globalDefaults, sessionControlsStatus, stream, sessionId, sessionFolder, eventCount, manifest, workspaceId, running = false, modeLabel, onCompacted, onOpenSettingsTab }: ContextPanelProps) {
  const toast = useToast()
  const controls = sessionModel?.source === 'global'
    ? globalDefaults ?? { provider: null, model: null }
    : sessionModel ?? { provider: meta?.provider ?? null, model: meta?.model ?? null }
  const folder = sessionFolder ?? (('folder' in (meta ?? {}) ? String((meta as { folder?: string }).folder ?? '') : '') || '—')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (running && !busy) setConfirming(false)
  }, [busy, running])

  const compact = async (): Promise<void> => {
    if (workspaceId === null || workspaceId === undefined || sessionId === null || running || busy) return
    setBusy(true)
    try {
      const result = await compactSession(workspaceId, sessionId)
      toast.notify(`Compacted — ${result.summaryChars} chars summarized through seq ${result.coversSeq}.`, 'ok')
      setConfirming(false)
      onCompacted?.()
    } catch (cause) {
      toast.notify(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const canCompact = workspaceId !== null && workspaceId !== undefined && sessionId !== null
  const budget = manifest?.budget
  const tone = budget !== undefined ? budgetTone(budget.usedTokens, budget.availableTokens) : 'ok'
  const percent = budget === undefined ? 0 : Math.min(100, Math.round((budget.usedTokens / Math.max(1, budget.availableTokens)) * 100))
  const settingsLink = (tab: 'skills' | 'memory', names: readonly string[]): ReactNode => onOpenSettingsTab !== undefined
    ? <button type="button" className="text-left text-link hover:underline" onClick={() => onOpenSettingsTab(tab)}>{names.join(', ')}</button>
    : names.join(', ')

  return (
    <section aria-label="Conversation context" className="flex flex-col gap-5">
      <Card title="Conversation">
        <Row term="id"><code className="text-xs">{sessionId !== null ? `${sessionId.slice(0, 9)}…` : '—'}</code></Row>
        <Row term="events">{eventCount}</Row>
        <Row term="stream">{STREAM_LABELS[stream]}</Row>
      </Card>

      <Card title="Effective controls">
        <Row term="provider">{sessionControlsStatus === 'loading' ? 'Loading…' : sessionControlsStatus === 'unavailable' ? 'Unavailable' : controls.provider || '—'}</Row>
        <Row term="model">{sessionControlsStatus === 'loading' ? 'Loading…' : sessionControlsStatus === 'unavailable' ? 'Unavailable' : controls.model || 'Not configured'}</Row>
        <Row term="mode">{modeLabel ?? '—'}</Row>
        <Row term="folder"><code className="text-xs">{folder}</code></Row>
      </Card>

      <Card
        title="Last request manifest"
        action={(
          <Button
            size="sm"
            variant="outline"
            disabled={!canCompact || running || busy}
            title={!canCompact ? 'Select a conversation' : running ? 'Stop the turn first' : 'Summarize older turns into a checkpoint'}
            onClick={() => setConfirming(true)}
          >
            {busy ? 'Compacting…' : 'Compact…'}
          </Button>
        )}
      >
        {manifest !== undefined && manifest !== null ? (
          <>
            <Row term="mode">{manifest.modeId} · rev {manifest.modeRevision}</Row>
            <Row term="budget">
              {budget !== undefined ? (
                <span className="flex flex-col gap-1.5">
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
                    <span className={cn('block h-full rounded-full', TONE_BAR[tone])} style={{ width: `${percent}%` }} />
                  </span>
                  <span>~{budget.usedTokens}/{budget.availableTokens} tok {budget.estimated ? '(est)' : '(verified)'}</span>
                </span>
              ) : '—'}
            </Row>
            <Row term="history">{manifest.history.setting}: {manifest.history.includedTurns} turns{manifest.history.omittedTurns > 0 ? ` (${manifest.history.omittedTurns} omitted)` : ''}</Row>
            <Row term="tools">{manifest.sources.toolNames !== undefined && manifest.sources.toolNames.length > 0 ? manifest.sources.toolNames.join(', ') : String(manifest.sources.toolSchemas)}</Row>
            {manifest.sources.child !== undefined ? (
              <Row term="role">
                <span title={`instructions sha256 ${manifest.sources.child.instructionsHash}`}>
                  {manifest.sources.child.definition} · {manifest.sources.child.instructionsHash.slice(0, 12)}
                </span>
              </Row>
            ) : null}
            {manifest.sources.parentContext !== undefined ? (
              <Row term="parent context">
                <span title={`sha256 ${manifest.sources.parentContext.hash}`}>
                  {manifest.sources.parentContext.chars.toLocaleString()} chars · {manifest.sources.parentContext.hash.slice(0, 12)}
                </span>
              </Row>
            ) : manifest.omissions.some((omission) => omission.startsWith('parent-context:')) ? (
              <Row term="parent context">{manifest.omissions.find((omission) => omission.startsWith('parent-context:'))?.slice('parent-context: '.length)}</Row>
            ) : null}
            {manifest.sources.skills.length > 0 ? <Row term="skills">{settingsLink('skills', manifest.sources.skills)}</Row> : null}
            {manifest.sources.memory.length > 0 ? <Row term="memory">{settingsLink('memory', manifest.sources.memory)}</Row> : null}
            {manifest.omissions.length > 0 ? <Row term="omitted"><span title={manifest.omissions.join('\n')}>{manifest.omissions.length} sources omitted</span></Row> : null}
          </>
        ) : (
          <div className="px-3 py-3 text-[13px] text-fg-muted">
            <dt className="sr-only">Manifest</dt>
            <dd className="m-0">No request has been assembled for this conversation yet.</dd>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirming && !running}
        title="Compact this conversation?"
        confirmLabel="Compact"
        tone="success"
        busy={busy || running}
        onConfirm={() => void compact()}
        onDismiss={() => { if (!busy) setConfirming(false) }}
        body={<p className="m-0">Older turns will be summarized into a checkpoint and omitted from future requests. The full log stays on disk; compaction cannot be undone in the live context.</p>}
      />
    </section>
  )
}
