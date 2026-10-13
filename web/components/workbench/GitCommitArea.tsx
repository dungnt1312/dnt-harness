import { useRef, useState, type KeyboardEvent } from 'react'
import Icon from '../common/Icon.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { Modal } from '../ui/Modal.tsx'
import type { GitChange, GitOperationDone, GitOperationInput, GitStatusReport } from '../../lib/api.ts'
import { changeCounts, commitButton, commitButtonTitle } from './git-panel-model.ts'
import type { GitRun } from './use-git-operation.tsx'

const signoffKey = (projectId: string): string => `dnt-harness.git.signoff.${projectId}`

function readSignoff(projectId: string): boolean {
  try { return window.localStorage.getItem(signoffKey(projectId)) === '1' } catch { return false }
}

function writeSignoff(projectId: string, value: boolean): void {
  try { window.localStorage.setItem(signoffKey(projectId), value ? '1' : '0') } catch { /* storage may be unavailable */ }
}

/** Zed `check_for_pushed_commits` lists `refs/remotes/<remote>/<branch>` as `<remote>/<branch>`. */
const remoteRefName = (ref: string): string => ref.replace(/^refs\/remotes\//, '')

/**
 * Zed's commit editor and footer: the message, the split Commit button with
 * its Amend / Signoff / Skip Hooks menu, the "update your most recent commit"
 * row while amending, and the last commit with Uncommit. The rules come from
 * `git-panel-model.ts` (`commitButton`); the sequences from `commit_changes`,
 * `uncommit` and `set_amend_pending`. State lives here, so the owner mounts one
 * per project (`key`). `onDone` receives each mutating operation's answer.
 */
export function GitCommitArea({ projectId, report, changes, run, enqueue, onDone }: {
  readonly projectId: string
  readonly report: GitStatusReport
  /** The changes as the reader sees them (a queued staging click already applied). */
  readonly changes: readonly GitChange[]
  readonly run: GitRun
  /** The panel's queue: a commit or uncommit runs after the stage, discard and trash clicks before it. */
  readonly enqueue: (task: () => Promise<void>) => void
  readonly onDone: (done: GitOperationDone | undefined) => void
}) {
  const [text, setText] = useState('')
  const [amend, setAmend] = useState(false)
  // Zed `original_commit_message`: what the editor held before Amend replaced it.
  const original = useRef<string | null>(null)
  const [signoff, setSignoff] = useState(() => readSignoff(projectId))
  const [skipHooks, setSkipHooks] = useState(false)
  // Zed `pending_commit`: a commit or an uncommit is running.
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pushed, setPushed] = useState<{ readonly refs: readonly string[]; readonly prior: string } | null>(null)

  const head = report.head
  const counts = changeCounts(changes)
  const button = commitButton({
    conflicts: counts.hasUnstagedConflicts,
    staged: counts.hasStaged,
    tracked: counts.hasTracked,
    amend,
    pending: busy,
    message: text.trim() !== '',
  })
  const label = commitButtonTitle({ amend, staged: counts.hasStaged, tracked: counts.hasTracked })
  const command = `git commit${amend ? ' --amend' : ''}${signoff ? ' --signoff' : ''}${skipHooks ? ' --no-verify' : ''}`
  const tooltip = button.enabled ? `${button.title}\n${command}` : button.title

  /** Zed `set_amend_pending`: save the draft on entering amend mode, restore it on leaving. */
  const setAmendPending = (value: boolean): void => {
    if (value && !amend) original.current = text.trim() === '' ? null : text
    else if (!value && amend) {
      setText(original.current ?? '')
      original.current = null
    }
    setAmend(value)
  }

  /** Zed `toggle_amend_pending`: entering amend mode loads the last commit's message. */
  const toggleAmend = (): void => {
    const next = !amend
    setAmendPending(next)
    if (next && head !== null) setText(head.message || head.subject)
  }

  const toggleSignoff = (): void => {
    const next = !signoff
    setSignoff(next)
    writeSignoff(projectId, next)
  }

  /** Zed `commit_changes`. */
  const commit = async (): Promise<void> => {
    if (busy) return
    if (counts.hasUnstagedConflicts) {
      setNotice('There are still conflicts. You must stage these before committing')
      return
    }
    if (text.trim() === '') return
    if (!counts.hasStaged && !counts.hasTracked && !amend) {
      setNotice('No changes to commit')
      return
    }
    // Everything the commit needs is read now: the click's view (a queued staging click already applied).
    const amending = amend
    const input: GitOperationInput = { type: 'commit', message: text, amend: amending, signoff, noVerify: skipHooks, tracked: !counts.hasStaged }
    // Busy from the click: Amend and Cancel stay off until the answer, so a draft restored meanwhile cannot be wiped.
    setBusy(true)
    // Behind the panel's pending stage, discard and trash clicks, in click order.
    enqueue(async () => {
      let done: GitOperationDone | undefined
      try {
        done = await run(input)
      } finally {
        setBusy(false)
      }
      onDone(done)
      if (done?.ok !== true) return
      setSkipHooks(false)
      if (amending) setAmendPending(false)
      else {
        setText('')
        original.current = null
      }
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void commit()
    }
  }

  const performUncommit = async (prior: string): Promise<void> => {
    let done: GitOperationDone | undefined
    try {
      done = await run({ type: 'uncommit' })
    } finally {
      setBusy(false)
    }
    onDone(done)
    if (done?.ok === true) setText(prior)
  }

  /**
   * Zed `uncommit`, with `check_for_pushed_commits` asking first when the commit left this machine.
   * Both the query and the uncommit wait their turn in the panel's queue; the dialog does not hold it.
   */
  const uncommit = (): void => {
    if (busy || head === null) return
    const prior = head.message || head.subject
    setBusy(true)
    enqueue(async () => {
      let found: GitOperationDone | undefined
      try {
        found = await run({ type: 'pushed-to' })
      } catch (cause) {
        setBusy(false)
        throw cause
      }
      if (found?.ok !== true) {
        setBusy(false)
        return
      }
      const refs = (found.pushedTo ?? []).map(remoteRefName)
      if (refs.length > 0) setPushed({ refs, prior })
      else await performUncommit(prior)
    })
  }

  const toggleItem = (name: string, checked: boolean, onSelect: () => void, close: () => void, hint?: string, disabled = false) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      className={menuItemClass}
      {...(hint !== undefined ? { title: hint } : {})}
      onClick={() => { close(); onSelect() }}
    >
      <span className="inline-flex w-4 shrink-0 justify-center">{checked ? <Icon name="check" size={13} /> : null}</span>
      {name}
    </button>
  )

  return (
    <div role="group" aria-label="Commit" className="shrink-0 border-t border-line">
      {amend ? (
        <div className="flex items-center justify-between gap-1.5 border-b border-line px-2 py-1.5">
          <span className="min-w-0 truncate text-xs text-fg-muted">This will update your most recent commit.</span>
          <Button size="sm" variant="outline" className="h-7 px-2.5" disabled={busy} onClick={() => setAmendPending(false)}>Cancel</Button>
        </div>
      ) : null}
      <div className="p-2 pb-1.5">
        <textarea
          aria-label="Commit message"
          placeholder="Enter commit message"
          rows={3}
          value={text}
          spellCheck
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="block w-full resize-none rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-fg-faint"
        />
      </div>
      <div className="flex items-center justify-end px-2 pb-2">
        <span className="inline-flex" title={tooltip}>
          <Button
            size="sm"
            variant="outline"
            className="rounded-r-none border-r-0 px-3"
            disabled={!button.enabled}
            title={tooltip}
            onClick={() => void commit()}
          >
            {label}
          </Button>
        </span>
        <Menu
          label="Commit options"
          side="top"
          align="end"
          triggerClassName="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-l-none rounded-r-full border border-line-strong text-fg hover:bg-hover"
          trigger={() => <Icon name="chevron" size={12} />}
        >
          {(close) => (
            <>
              {head !== null ? toggleItem('Amend', amend, toggleAmend, close, undefined, busy) : null}
              {toggleItem('Signoff', signoff, toggleSignoff, close)}
              {toggleItem('Skip Hooks', skipHooks, () => setSkipHooks((value) => !value), close, 'git commit --no-verify')}
            </>
          )}
        </Menu>
      </div>
      {head !== null ? (
        <div className="flex items-center justify-between gap-1.5 border-t border-line px-2 py-1">
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-fg-muted" title={head.message || head.subject}>{head.subject}</span>
          {head.hasParent ? (
            <IconButton label="Uncommit" title={'Uncommit\ngit reset HEAD^ --soft'} disabled={busy} onClick={() => void uncommit()}>
              <Icon name="undo" size={14} />
            </IconButton>
          ) : null}
        </div>
      ) : null}
      <Modal open={notice !== null} onDismiss={() => setNotice(null)} label={notice ?? ''} width="sm">
        <p className="m-0 text-sm font-medium">{notice}</p>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" autoFocus onClick={() => setNotice(null)}>OK</Button>
        </div>
      </Modal>
      <ConfirmDialog
        open={pushed !== null}
        title="Are you sure?"
        confirmLabel="Uncommit"
        body={<p className="m-0 break-words">This commit was already pushed to {pushed?.refs.join(', ')}.</p>}
        onDismiss={() => { setPushed(null); setBusy(false) }}
        onConfirm={() => {
          const prior = pushed?.prior ?? ''
          setPushed(null)
          enqueue(() => performUncommit(prior))
        }}
      />
    </div>
  )
}
