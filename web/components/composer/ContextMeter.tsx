import { Menu } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import { budgetTone, contextFill, fillBasisTitle, formatPolicyPressure, policyPressure } from '../../lib/format.ts'
import { isAvailableContext } from '../../../src/harness/context/context-state.ts'
import type { ContextBreakdownView, ContextStatus, ContextView } from '../../lib/api.ts'
import { composerFocusClass } from './composer-chip.ts'

/** Breakdown rows in the order they render, each a deeper-to-lighter shade. */
const CATEGORIES: readonly { readonly key: keyof ContextBreakdownView; readonly label: string; readonly shade: string }[] = [
  { key: 'messages', label: 'Messages', shade: 'bg-link' },
  { key: 'systemTools', label: 'System tools', shade: 'bg-link/75' },
  { key: 'mcpTools', label: 'MCP tools', shade: 'bg-link/55' },
  { key: 'metaContext', label: 'Meta context', shade: 'bg-link/40' },
  { key: 'skills', label: 'Skills', shade: 'bg-link/28' },
  { key: 'systemPrompt', label: 'System prompt', shade: 'bg-link/18' },
]

/** `950`, `12.3K`, `139.1K`, `1M`, `1.5M` — trailing `.0` dropped. */
export function formatTokens(tokens: number): string {
  const trim = (value: number): string => value.toFixed(1).replace(/\.0$/, '')
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${trim(tokens / 1_000)}K`
  return `${trim(tokens / 1_000_000)}M`
}

const TONE_STROKE = { ok: 'stroke-link', warn: 'stroke-warn', bad: 'stroke-bad' } as const

/**
 * Small progress ring for the trigger chip. With no recorded request it is a
 * faint dashed outline: a grey track with a short arc reads as a spinner.
 */
function Ring({ ratio, tone, empty }: { readonly ratio: number; readonly tone: keyof typeof TONE_STROKE; readonly empty: boolean }) {
  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className={cn('-rotate-90', empty && 'opacity-50')}>
      <circle cx="9" cy="9" r={radius} fill="none" strokeWidth={empty ? 1.5 : 2.25} strokeDasharray={empty ? '2 2.5' : undefined} className="stroke-line-strong" />
      {!empty && ratio > 0 ? (
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(ratio * circumference, 1.5)} ${circumference}`}
          className={TONE_STROKE[tone]}
        />
      ) : null}
    </svg>
  )
}

/**
 * Composer context meter: a ring showing how full the model's context window
 * was on the last request, opening a token count per source. Counts are
 * tokens, never percentages. Before the first request it says so; while the
 * figures load, or when they could not be fetched, it says that instead.
 */
export function ContextMeter({ manifest, status = manifest === null ? 'none' : 'ready' }: { readonly manifest: ContextView | null; readonly status?: ContextStatus }) {
  const shown = status === 'ready' ? manifest : null
  const available = shown !== null && isAvailableContext(shown) ? shown : null
  const postCompact = available?.display?.kind === 'post-compaction'
  const fill = available !== null ? contextFill(available) : null
  const pressure = available !== null ? policyPressure(available) : undefined
  const tone = fill !== null ? budgetTone(fill.used, fill.limit) : 'ok'
  const summary = fill !== null
    ? `${formatTokens(fill.used)} / ${formatTokens(fill.limit)}`
    : null
  const breakdown = available?.breakdown
  const breakdownTotal = breakdown !== undefined ? CATEGORIES.reduce((total, category) => total + breakdown[category.key], 0) : 0

  return (
    <Menu
      label={summary !== null ? `Context window ${summary}` : 'Context window'}
      panelRole="dialog"
      side="top"
      align="end"
      compact
      triggerClassName={cn('flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-hover [@media(pointer:coarse)]:size-9', composerFocusClass)}
      panelClassName="w-72 p-4"
      trigger={() => <Ring ratio={fill?.ratio ?? 0} tone={tone} empty={fill === null} />}
    >
      {() => (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold">Context window</span>
            {summary !== null ? (
              <span className="font-mono text-xs text-fg-muted" title={fill !== null ? fillBasisTitle(fill) : undefined}>
                {summary}
              </span>
            ) : null}
          </div>

          {status === 'loading' ? (
            <p className="text-fg-muted">Loading context…</p>
          ) : status === 'error' ? (
            <p className="text-fg-muted">Context unavailable</p>
          ) : shown !== null && !isAvailableContext(shown) ? (
            <p className="text-fg-muted">Context estimate unavailable until the next request ({shown.display.reason === 'preview-failed' ? 'compaction preview failed' : 'earlier compaction predates full estimates'}).</p>
          ) : fill === null ? (
            <p className="text-fg-muted">No recorded request context for this conversation.</p>
          ) : (
            <>
              {postCompact ? <p className="m-0 text-xs text-fg-faint">After compaction · estimated — the next request replaces this preview.</p> : null}
              {!postCompact ? (
                <dl className="m-0 flex flex-col gap-1 text-xs">
                  <div className="flex items-center justify-between gap-3"><dt className="text-fg-muted">Last request</dt><dd className="m-0 font-mono" title={fillBasisTitle(fill)}>{fill.basis}</dd></div>
                  {available?.model !== undefined ? <div className="flex items-center justify-between gap-3"><dt className="text-fg-muted">Model</dt><dd className="m-0 truncate font-mono">{available.model}</dd></div> : null}
                  {fill.basis !== 'estimated' && available !== null && available.budget.usedTokens !== fill.used ? (
                    <div className="flex items-center justify-between gap-3"><dt className="text-fg-muted">Estimate total</dt><dd className="m-0 font-mono">{formatTokens(available.budget.usedTokens)}</dd></div>
                  ) : null}
                </dl>
              ) : null}
              {pressure !== undefined ? (
                <p className="m-0 text-xs text-fg-muted" title="Auto-compact trigger: calibrated pre-trim count over the usable input budget. Not the window ring.">Auto-compact trigger: {formatPolicyPressure(pressure)}</p>
              ) : null}
              {/* The filled share of the window, split by source in proportion. */}
              <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="presentation">
                <div className="flex h-full" style={{ width: `${fill.ratio * 100}%` }}>
                  {breakdownTotal > 0
                    ? CATEGORIES.map((category) => (
                        <div key={category.key} className={cn('h-full', category.shade)} style={{ width: `${(breakdown![category.key] / breakdownTotal) * 100}%` }} />
                      ))
                    : <div className="h-full w-full bg-link" />}
                </div>
              </div>

              {breakdown !== undefined && breakdownTotal > 0 ? (
                <ul className="flex flex-col gap-2">
                  {CATEGORIES.map((category) => (
                    <li key={category.key} className="flex items-center gap-2.5" title={`${breakdown[category.key].toLocaleString()} tokens, estimated (chars/3)`}>
                      <span className={cn('size-2 shrink-0 rounded-full', category.shade)} aria-hidden="true" />
                      <span className="flex-1 text-fg-muted">{category.label}</span>
                      <span className="font-mono text-xs">{formatTokens(breakdown[category.key])}</span>
                    </li>
                  ))}
                  <li className="text-xs text-fg-faint">Estimated source tokens (chars/3). The total above follows the provider count when one was reported.</li>
                </ul>
              ) : null}

              <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                <span className="text-fg-muted">Session average cache hit rate</span>
                <span className="font-mono text-xs">{fill.cacheHitRate !== undefined ? `${Math.round(fill.cacheHitRate * 100)}%` : '—'}</span>
              </div>
            </>
          )}
        </div>
      )}
    </Menu>
  )
}
