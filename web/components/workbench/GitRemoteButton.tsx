import { useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { useToast } from '../common/Toast.tsx'
import { Button } from '../ui/Button.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { Modal } from '../ui/Modal.tsx'
import type { GitBranchInfo, GitOperationDone } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { GIT_BUTTON_LEFT, GIT_CHEVRON } from './git-controls.ts'
import { remoteButton } from './git-panel-model.ts'
import type { GitRun } from './use-git-operation.tsx'

/** Zed `RemoteOperationKind`. */
type RemoteOperationKind = 'Fetch' | 'Pull' | 'Push'

/** Zed `FetchOptions::All` is offered in the Fetch From picker under this name. */
const FETCH_ALL = '--all'

const NO_PUSH_REMOTE = 'No remote available to push to. Add a remote to be able to publish changes.'

interface PickerRequest {
  readonly title: string
  readonly options: readonly string[]
  readonly settle: (choice: string | null) => void
}

/**
 * Zed's remote split button (`render_remote_button`, `remote_button`): the main
 * button is Fetch, Push, Pull, Publish or Republish by how the branch relates to
 * its upstream, and the menu has the rest. The sequences follow `fetch`,
 * `pull`, `push` and `get_remote`: one remote is used without asking, several
 * open a picker, and only one remote operation runs at a time (`start_remote_operation`).
 * Every operation goes through `run` with its remote action, so the success
 * toast (and pull-request link) is `formatRemoteOutput`'s. There is no
 * confirmation before a push, force push included.
 */
export function GitRemoteButton({ branchInfo, run, onDone }: {
  readonly branchInfo: GitBranchInfo
  readonly run: GitRun
  readonly onDone: (done: GitOperationDone | undefined) => void
}) {
  const toast = useToast()
  const [pending, setPending] = useState<RemoteOperationKind | null>(null)
  const pendingRef = useRef<RemoteOperationKind | null>(null)
  const [picker, setPicker] = useState<PickerRequest | null>(null)
  const pickerRef = useRef<PickerRequest | null>(null)
  pickerRef.current = picker
  // Leaving with a picker open settles it, so the operation does not wait forever.
  useEffect(() => () => { pickerRef.current?.settle(null) }, [])

  const button = remoteButton(branchInfo.upstreamTrack)
  const name = branchInfo.name

  /** Zed `picker_prompt::prompt`: none → nothing, one → that one, several → ask. */
  const pick = (title: string, options: readonly string[]): Promise<string | null> => {
    if (options.length === 0) return Promise.resolve(null)
    if (options.length === 1) return Promise.resolve(options[0]!)
    return new Promise<string | null>((resolve) => {
      const request: PickerRequest = {
        title,
        options,
        settle: (choice) => { setPicker((current) => current === request ? null : current); resolve(choice) },
      }
      setPicker(request)
    })
  }

  /** The `remotes` query; `undefined` when it failed (the toast is already shown). */
  const remotesOf = async (push: boolean, every: boolean): Promise<readonly string[] | undefined> => {
    const found = await run({ type: 'remotes', branch: name, push, all: every })
    return found?.ok === true ? found.remotes ?? [] : undefined
  }

  /** Zed `start_remote_operation`: a second remote operation while one runs is ignored. */
  const start = async (kind: RemoteOperationKind, task: () => Promise<void>): Promise<void> => {
    if (pendingRef.current !== null) return
    pendingRef.current = kind
    setPending(kind)
    try {
      await task()
    } finally {
      pendingRef.current = null
      setPending(null)
    }
  }

  /** Zed `fetch`: Fetch runs `fetch --all`; Fetch From asks for one remote (or all of them). */
  const fetchRemote = (all: boolean): Promise<void> => start('Fetch', async () => {
    if (all) {
      onDone(await run({ type: 'fetch-all' }, { remote: { kind: 'fetch' } }))
      return
    }
    const remotes = await remotesOf(false, true)
    if (remotes === undefined) return
    const choice = await pick('Pick which remote to fetch', remotes.length > 1 ? [...remotes, FETCH_ALL] : remotes)
    if (choice === null) return
    onDone(choice === FETCH_ALL
      ? await run({ type: 'fetch-all' }, { remote: { kind: 'fetch' } })
      : await run({ type: 'fetch', remote: choice }, { remote: { kind: 'fetch', remote: choice } }))
  })

  /** Zed `pull`: the branch is named only when it has no upstream. */
  const pull = (rebase: boolean): Promise<void> => start('Pull', async () => {
    const remotes = await remotesOf(false, false)
    if (remotes === undefined) return
    const remote = await pick('Pick which remote to push to', remotes)
    if (remote === null) return
    onDone(await run(
      { type: 'pull', remote, ...(branchInfo.upstream === undefined ? { branch: name } : {}), rebase },
      { remote: { kind: 'pull', remote } },
    ))
  })

  /** Zed `push`: a branch without a live upstream is published with `--set-upstream`. */
  const push = (force: boolean, selectRemote: boolean): Promise<void> => start('Push', async () => {
    const remotes = await remotesOf(true, selectRemote)
    if (remotes === undefined) return
    if (remotes.length === 0) {
      toast.notify(NO_PUSH_REMOTE, 'bad', { persistent: true, plain: true })
      return
    }
    const remote = await pick('Pick which remote to push to', remotes)
    if (remote === null) return
    const track = branchInfo.upstreamTrack
    const trackedBranch = track.kind === 'tracked' ? branchInfo.upstream?.branch : undefined
    onDone(await run(
      {
        type: 'push',
        remote,
        branch: name,
        upstreamBranch: trackedBranch ?? name,
        setUpstream: !force && (track.kind === 'none' || track.kind === 'gone'),
        force,
      },
      { remote: { kind: 'push', branch: name, remote } },
    ))
  })

  const mainClick = (): void => {
    if (button.action === 'fetch') void fetchRemote(true)
    else if (button.action === 'pull') void pull(false)
    else void push(false, false)
  }

  const tooltip = pending !== null ? `${pending} in Progress…` : `${button.tooltip}\n${button.command}`
  const item = (label: string, onSelect: () => void, close: () => void) => (
    <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onSelect() }}>{label}</button>
  )

  return (
    <>
      <div className="flex shrink-0 items-center" role="group" aria-label="Remote">
        {/* A disabled button takes no pointer events, so the wrapper carries the tooltip too. */}
        <span className="inline-flex" title={tooltip}>
          <Button
            size="sm"
            variant="outline"
            className={GIT_BUTTON_LEFT}
            disabled={pending !== null}
            title={tooltip}
            onClick={mainClick}
          >
            {pending !== null ? <span role="status" aria-label={`${pending} in progress`}><Spinner size={12} /></span> : button.action === 'fetch' ? <Icon name="refresh" size={12} /> : button.action === 'publish' || button.action === 'republish' ? <Icon name="arrowUp" size={12} /> : null}
            {button.label}
            {button.ahead > 0 ? <span className="font-mono text-xs"><span aria-hidden="true">↑</span>{button.ahead}</span> : null}
            {button.behind > 0 ? <span className="font-mono text-xs"><span aria-hidden="true">↓</span>{button.behind}</span> : null}
          </Button>
        </span>
        <Menu
          label="Remote actions"
          side="top"
          align="end"
          disabled={pending !== null}
          triggerClassName={cn(GIT_CHEVRON, 'disabled:pointer-events-none disabled:opacity-40')}
          trigger={() => <Icon name="chevron" size={12} />}
        >
          {(close) => (
            <>
              {item('Fetch', () => void fetchRemote(true), close)}
              {item('Fetch From', () => void fetchRemote(false), close)}
              {item('Pull', () => void pull(false), close)}
              {item('Pull (Rebase)', () => void pull(true), close)}
              <div role="separator" className="my-1 h-px bg-line" />
              {item('Push', () => void push(false, false), close)}
              {item('Push To', () => void push(false, true), close)}
              {item('Force Push', () => void push(true, false), close)}
            </>
          )}
        </Menu>
      </div>
      <Modal open={picker !== null} onDismiss={() => picker?.settle(null)} label={picker?.title ?? ''} width="sm">
        <h2 className="m-0 text-base font-semibold">{picker?.title}</h2>
        <ul className="m-0 mt-3 flex list-none flex-col gap-0.5 p-0">
          {picker?.options.map((option) => (
            <li key={option}>
              <button type="button" className={menuItemClass} onClick={() => picker.settle(option)}>{option}</button>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  )
}
