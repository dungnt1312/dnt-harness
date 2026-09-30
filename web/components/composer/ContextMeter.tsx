import { Menu } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import { budgetTone, contextFill } from '../../lib/format.ts'
import type { ContextBreakdownView, ContextManifestView } from '../../lib/api.ts'

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

/** Small progress ring for the trigger chip. */
function Ring({ ratio, tone }: { readonly ratio: number; readonly tone: keyof typeof TONE_STROKE }) {
  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="-rotate-90">
      <circle cx="9" cy="9" r={radius} fill="none" strokeWidth="2.25" className="stroke-line-strong" />
      {ratio > 0 ? (
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
 * tokens, never percentages. Before the first request it says so.
 */
export function ContextMeter({ manifest }: { readonly manifest: ContextManifestView | null }) {
  const fill = manifest !== null ? contextFill(manifest) : null
  const tone = fill !== null ? budgetTone(fill.used, fill.limit) : 'ok'
  const summary = fill !== null
    ? `${formatTokens(fill.used)} / ${formatTokens(fill.limit)}`
    : null
  const breakdown = manifest?.breakdown
  const breakdownTotal = breakdown !== undefined ? CATEGORIES.reduce((total, category) => total + breakdown[category.key], 0) : 0

  return (
    <Menu
      label={summary !== null ? `Context window ${summary}` : 'Context window'}
      panelRole="dialog"
      side="top"
      align="end"
      triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-hover [@media(pointer:coarse)]:size-11"
      panelClassName="w-72 p-4"
      trigger={() => <Ring ratio={fill?.ratio ?? 0} tone={tone} />}
    >
      {() => (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold">Context window</span>
            {summary !== null ? (
              <span className="font-mono text-xs text-fg-muted" title={fill?.estimated === true ? 'Estimated (chars/4); the provider did not report usage' : 'Prompt tokens reported by the provider'}>
                {summary}
              </span>
            ) : null}
          </div>

          {fill === null ? (
            <p className="text-fg-muted">No recorded request context for this conversation.</p>
          ) : (
            <>
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
                    <li key={category.key} className="flex items-center gap-2.5" title={`${breakdown[category.key].toLocaleString()} tokens, estimated (chars/4)`}>
                      <span className={cn('size-2 shrink-0 rounded-full', category.shade)} aria-hidden="true" />
                      <span className="flex-1 text-fg-muted">{category.label}</span>
                      <span className="font-mono text-xs">{formatTokens(breakdown[category.key])}</span>
                    </li>
                  ))}
                  <li className="text-xs text-fg-faint">Estimated tokens (chars/4). The total above is the provider count when it reported one.</li>
                </ul>
              ) : null}

              <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                <span className="text-fg-muted">Average cache hit rate</span>
                <span className="font-mono text-xs">{fill.cacheHitRate !== undefined ? `${Math.round(fill.cacheHitRate * 100)}%` : '—'}</span>
              </div>
            </>
          )}
        </div>
      )}
    </Menu>
  )
}
