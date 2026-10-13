import { useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Button } from '../ui/Button.tsx'
import { formatCountdown } from '../../lib/format.ts'
import { toolFacts } from '../../lib/tool-facts.ts'
import { ToolArguments, hasProseArgs } from './ToolArguments.tsx'
import type { PendingApproval } from '../../lib/types.ts'

const ARGS_DISPLAY_LIMIT = 4000
const NO_PROJECT = 'No project attached'

/**
 * A long folder keeps its END visible (`…\parent\folder`): a start-truncated
 * label would hide exactly the part that says which folder is granted.
 */
export function shortFolder(folder: string, keep = 2): string {
  const parts = folder.split(/[\\/]/).filter((part) => part !== '')
  if (parts.length <= keep + 1) return folder
  const separator = folder.includes('\\') ? '\\' : '/'
  return `…${separator}${parts.slice(-keep).join(separator)}`
}

/**
 * Pending tool approvals, oldest first, above the composer. Allow once / Deny
 * answer only that request (locked while submitting); standing permission is
 * authored in Settings → Modes, never from a pending ask. The one exception
 * is a file path outside the granted folders: the conversation (never a
 * child) may be granted exactly the folder the card names.
 */
export function ApprovalBar({
  approvals, onAnswer, scope = NO_PROJECT,
}: {
  readonly approvals: readonly PendingApproval[]
  readonly onAnswer: (approvalId: string, allow: boolean, scope?: 'once' | 'session') => void | Promise<void>
  readonly scope?: string
}) {
  const locks = useRef(new Set<string>())
  const [submitting, setSubmitting] = useState<readonly string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => Date.now())
  // Only the oldest request — the one to decide — is open by default: a stack
  // of full cards would leave the transcript no room on a short viewport.
  const [showAll, setShowAll] = useState(false)

  // One ticker for the whole bar, and only while a deadline is on screen:
  // an undecided approval is cancelled when it expires, so the window has to
  // be visible rather than inferred from a card that suddenly disappears.
  const counting = approvals.some((row) => row.expiresAt !== undefined)
  useEffect(() => {
    if (!counting) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => { window.clearInterval(id) }
  }, [counting])

  const answer = async (id: string, allow: boolean, answerScope: 'once' | 'session' = 'once'): Promise<void> => {
    if (locks.current.has(id)) return
    locks.current.add(id)
    setSubmitting([...locks.current])
    setErrors((all) => ({ ...all, [id]: '' }))
    try { await Promise.resolve(answerScope === 'session' ? onAnswer(id, allow, 'session') : onAnswer(id, allow)) }
    catch (cause) { setErrors((all) => ({ ...all, [id]: String(cause) })) }
    finally { locks.current.delete(id); setSubmitting([...locks.current]) }
  }

  if (approvals.length === 0) return null
  const hidden = showAll ? 0 : approvals.length - 1
  const visible = hidden > 0 ? approvals.slice(0, 1) : approvals
  return (
    // The live region is the count line alone: announcing a whole card would
    // read its safety note aloud on every new request.
    <section aria-label="Pending approvals" className="flex max-h-[min(45dvh,22rem)] flex-col gap-2 overflow-y-auto">
      {/* The task status above already says an approval is required; the count
          is shown only when it adds something (several requests), but screen
          readers always hear it. */}
      <div role="status" aria-live="polite" className={approvals.length === 1 ? 'sr-only' : 'px-1 text-xs font-medium text-fg-muted'}>
        {approvals.length === 1 ? '1 request' : `${approvals.length} requests`} awaiting a decision
      </div>
      {visible.map(({ approvalId, call, interactive, childSessionId, definitionName, expiresAt, guardWarning, scopeWarning, proposedGrant, proposedAccess }) => {
        const submittingRow = submitting.includes(approvalId)
        const sessionGrant = childSessionId === undefined ? proposedGrant : undefined
        // The same reading the transcript gives a call: a Read's window and a
        // command's verb belong in the decision, not only in the payload.
        const target = toolFacts(call).fullTarget
        const expired = expiresAt !== undefined && expiresAt - now <= 0
        return (
          <article key={approvalId} aria-busy={submittingRow} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-composer">
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn"><Icon name="shield" size={16} /></span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="min-w-0">
                  <p className="m-0 text-sm">Allow <strong className="font-semibold">{call.name}</strong>?</p>
                  <p className="m-0 truncate text-xs text-fg-faint" title={scope}>
                    {scope === NO_PROJECT ? scope : <>in <span className="font-medium text-fg-muted">{shortFolder(scope, 1)}</span></>}
                    {childSessionId !== undefined ? (
                      <span title={childSessionId}>
                        {' · '}asked by child agent {definitionName !== undefined ? <strong className="font-semibold">{definitionName}</strong> : <code>{childSessionId.slice(0, 14)}</code>}
                      </span>
                    ) : null}
                    {interactive === true ? ' · requires a decision every time' : null}
                  </p>
                </div>
                {/* A prose argument (multi-line command, file content) opens in the
                    details below, so the one-line target would only repeat it. */}
                {target !== '' && !(typeof call.args['command'] === 'string' && hasProseArgs({ command: call.args['command'] })) ? (
                  <code aria-label="Target" className="block truncate rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs text-fg" title={target}>{target}</code>
                ) : null}
                {guardWarning !== undefined ? (
                  <p className="m-0 rounded-lg bg-bad-soft px-2 py-1.5 text-xs font-medium text-bad" role="alert">
                    <Icon name="alertTriangle" size={12} className="mr-1 inline" />{guardWarning}
                  </p>
                ) : null}
                {scopeWarning !== undefined ? (
                  <p className="m-0 break-all rounded-lg bg-warn-soft px-2 py-1.5 text-xs font-medium text-warn">
                    <Icon name="alertTriangle" size={12} className="mr-1 inline" />{scopeWarning}
                  </p>
                ) : null}
                {/* A multi-line command or a file's new content cannot be judged from
                    the one-line target above, so those requests open already showing
                    it — the decision is made on the text, not on its first line. */}
                <details className="text-xs text-fg-muted" open={hasProseArgs(call.args)}>
                  <summary className="cursor-pointer select-none" title={call.id}>Details</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    <ToolArguments call={call} limit={ARGS_DISPLAY_LIMIT} />
                    <p className="m-0 text-fg-faint">
                      Allow once and Deny apply to this request only, not the project or future requests. Standing permission is set by the workspace&apos;s mode in Settings → Modes.
                      {sessionGrant !== undefined ? <>{' '}Allowing the folder for this session lets this conversation use it without asking again.</> : null}
                      {' '}Arguments may target systems outside the project; server policy still applies. Call <code>{call.id}</code>.
                    </p>
                  </div>
                </details>
              </div>
            </div>
            {errors[approvalId] ? <ErrorNotice raw={errors[approvalId]!} announce={false} /> : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {expiresAt !== undefined ? (
                <span className="mr-auto flex items-center gap-1 text-xs text-fg-faint" title={expired ? undefined : 'An undecided request is cancelled when this runs out'}>
                  <Icon name="clock" size={12} />
                  {expired
                    ? 'Expired — this request was cancelled and the tool did not run.'
                    : <>Cancels itself in <span className="font-mono">{formatCountdown(expiresAt, now)}</span></>}
                </span>
              ) : null}
              <Button variant="outline" size="sm" disabled={submittingRow} onClick={() => void answer(approvalId, false)}>Deny</Button>
              {sessionGrant !== undefined ? (
                <Button variant="outline" size="sm" disabled={submittingRow} title={sessionGrant} onClick={() => void answer(approvalId, true, 'session')}>
                  <span className="max-w-[min(20rem,calc(100vw-12rem))] truncate">Allow {proposedAccess === 'write' ? 'read & write' : 'read'} in <code>{shortFolder(sessionGrant)}</code> for this session</span>
                </Button>
              ) : null}
              <Button variant="primary" size="sm" disabled={submittingRow} onClick={() => void answer(approvalId, true)}>{submittingRow ? 'Submitting decision…' : 'Allow once'}</Button>
            </div>
          </article>
        )
      })}
      {approvals.length > 1 ? (
        <button
          type="button"
          aria-expanded={showAll}
          className="self-start rounded-lg px-1 text-xs font-medium text-link hover:underline"
          onClick={() => setShowAll((prev) => !prev)}
        >
          {showAll ? 'Show only the oldest request' : `Show ${hidden} more request${hidden === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </section>
  )
}
