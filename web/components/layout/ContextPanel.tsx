import { useEffect, useState, type ReactNode } from 'react'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { useToast } from '../common/Toast.tsx'
import { Button } from '../ui/Button.tsx'
import { compactSession, CompactionCancelled, type ContextStatus, type ContextView, type StreamState } from '../../lib/api.ts'
import { budgetTone, compactionTokenChange, contextFill, fillBasisTitle, formatPolicyPressure, policyPressure } from '../../lib/format.ts'
import { isAvailableContext } from '../../../src/harness/context/context-state.ts'
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
  readonly manifest?: ContextView | null
  /** Ownership/fetch state of `manifest`; omitted means "whatever `manifest` shows". */
  readonly manifestStatus?: ContextStatus
  readonly workspaceId?: string | null
  readonly running?: boolean
  readonly modeLabel?: string | null
  readonly onCompacted?: () => void
  readonly onOpenSettingsTab?: (tab: 'skills' | 'memory') => void
}

export function ContextPanel({ meta, sessionModel, globalDefaults, sessionControlsStatus, stream, sessionId, sessionFolder, eventCount, manifest: fetched, manifestStatus, workspaceId, running = false, modeLabel, onCompacted, onOpenSettingsTab }: ContextPanelProps) {
  const toast = useToast()
  const status = manifestStatus ?? (fetched === undefined || fetched === null ? 'none' : 'ready')
  const manifest = status === 'ready' ? fetched : null
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
      const change = compactionTokenChange(result)
      toast.notify(`Compacted${change !== undefined ? ` — ${change}` : ''} (${result.summaryChars} chars summarized through seq ${result.coversSeq}).`, 'ok')
      setConfirming(false)
      onCompacted?.()
    } catch (cause) {
      if (cause instanceof CompactionCancelled) {
        // The user stopped it: say so, do not show a failure.
        setConfirming(false)
        toast.notify('Compaction cancelled.')
      } else {
        toast.notify(String(cause))
      }
    } finally {
      setBusy(false)
    }
  }

  const canCompact = workspaceId !== null && workspaceId !== undefined && sessionId !== null
  const available = manifest !== undefined && manifest !== null && isAvailableContext(manifest) ? manifest : null
  const fill = available !== null ? contextFill(available) : undefined
  const tone = fill !== undefined ? budgetTone(fill.used, fill.limit) : 'ok'
  const pressure = available !== null ? policyPressure(available) : undefined
  const percent = fill === undefined ? 0 : Math.round(fill.ratio * 100)
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
        title="Last request"
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
        {status === 'loading' ? (
          <div className="px-3 py-3 text-[13px] text-fg-muted">
            <dt className="sr-only">Manifest</dt>
            <dd className="m-0">Loading context…</dd>
          </div>
        ) : status === 'error' ? (
          <div className="px-3 py-3 text-[13px] text-fg-muted">
            <dt className="sr-only">Manifest</dt>
            <dd className="m-0">Context unavailable</dd>
          </div>
        ) : manifest !== undefined && manifest !== null && !isAvailableContext(manifest) ? (
          <div className="px-3 py-3 text-[13px] text-fg-muted">
            <dt className="sr-only">Manifest</dt>
            <dd className="m-0">Context estimate unavailable until the next request{manifest.display.reason === 'preview-failed' ? ' (compaction preview failed)' : ''}.</dd>
          </div>
        ) : available !== null ? (
          <>
            {available.display?.kind === 'post-compaction' ? (
              <Row term="basis"><span title="Estimate rebuilt after compaction; the next request replaces it.">After compaction · estimated</span></Row>
            ) : null}
            {available.display?.kind !== 'post-compaction' ? (
              <Row term="request">
                {fill?.basis ?? 'estimated'}
                {available.model !== undefined ? ` · ${available.model}` : ''}
              </Row>
            ) : null}
            {pressure !== undefined ? <Row term="auto-compact"><span title="Calibrated pre-trim count over the usable input budget; not the window bar.">trigger: {formatPolicyPressure(pressure)}</span></Row> : null}
            <Row term="mode">{available.modeId} · rev {available.modeRevision}{available.sources.modeSource !== undefined ? ` · ${available.sources.modeSource}` : ''}</Row>
            {available.sources.environment !== undefined ? (
              <Row term="environment">
                <span title={[available.sources.environment.date, available.sources.environment.platform, available.sources.environment.workspacePath, available.sources.environment.gitBranch !== undefined ? `git ${available.sources.environment.gitBranch}` : undefined].filter(Boolean).join('\n') || 'environment facts'}>
                  {available.sources.environment.date ?? '—'}
                  {available.sources.environment.gitBranch !== undefined ? ` · git ${available.sources.environment.gitBranch}` : ''}
                </span>
              </Row>
            ) : null}
            <Row term="window">
              {fill !== undefined ? (
                <span className="flex flex-col gap-1.5">
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
                    <span className={cn('block h-full rounded-full', TONE_BAR[tone])} style={{ width: `${percent}%` }} />
                  </span>
                  <span title={`${fillBasisTitle(fill)}. Denominator is the model context window.`}>
                    {fill.used}/{fill.limit} tok ({fill.basis === 'estimated' ? 'est' : fill.basis})
                  </span>
                </span>
              ) : '—'}
            </Row>
            <Row term="history">{available.history.setting}: {available.history.includedTurns} turns{available.history.omittedTurns > 0 ? ` (${available.history.omittedTurns} omitted)` : ''}</Row>
            <Row term="tools">{available.sources.toolNames !== undefined && available.sources.toolNames.length > 0 ? available.sources.toolNames.join(', ') : String(available.sources.toolSchemas)}</Row>
            {available.sources.child !== undefined ? (
              <Row term="role">
                <span title={`instructions sha256 ${available.sources.child.instructionsHash}`}>
                  {available.sources.child.definition}
                  {available.sources.child.source !== undefined ? ` · ${available.sources.child.source}` : ''}
                  {` · ${available.sources.child.instructionsHash.slice(0, 12)}`}
                </span>
              </Row>
            ) : null}
            {available.sources.parentContext !== undefined ? (
              <Row term="parent context">
                <span title={`sha256 ${available.sources.parentContext.hash}`}>
                  {available.sources.parentContext.chars.toLocaleString()} chars · {available.sources.parentContext.hash.slice(0, 12)}
                </span>
              </Row>
            ) : available.omissions.some((omission) => omission.startsWith('parent-context:')) ? (
              <Row term="parent context">{available.omissions.find((omission) => omission.startsWith('parent-context:'))?.slice('parent-context: '.length)}</Row>
            ) : null}
            {available.sources.skills.length > 0 ? <Row term="skills">{settingsLink('skills', available.sources.skills)}</Row> : null}
            {available.sources.skillCatalog !== undefined ? (
              <Row term="skill catalog">
                <span title={`catalog sha256 ${available.sources.skillCatalog.hash} · ${available.sources.skillCatalog.names.join(', ')}`}>
                  {available.sources.skillCatalog.names.length} listed for discovery
                </span>
              </Row>
            ) : null}
            {available.sources.memory.length > 0 ? <Row term="memory">{settingsLink('memory', available.sources.memory)}</Row> : null}
            {available.omissions.length > 0 ? <Row term="omitted"><span title={available.omissions.join('\n')}>{available.omissions.length} sources omitted</span></Row> : null}
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
