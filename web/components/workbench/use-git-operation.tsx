import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useToast } from '../common/Toast.tsx'
import {
  gitOperation,
  HttpError,
  type GitAskpassAnswer,
  type GitAskpassFrame,
  type GitOperationDone,
  type GitOperationInput,
} from '../../lib/api.ts'
import { formatRemoteOutput, type GitRemoteAction } from '../../lib/git-remote-output.ts'
import { GitAskpassModal } from './GitAskpassModal.tsx'
import { showGitOutput } from './GitOutputHost.tsx'

/** Git's own words for a refused request: the server's `{"error":…}` body, else the error text. */
export function failureText(cause: unknown): string {
  if (cause instanceof HttpError) {
    try {
      const message = (JSON.parse(cause.body) as { readonly error?: unknown }).error
      if (typeof message === 'string' && message !== '') return message
    } catch { /* not JSON: the body is the message */ }
    return cause.body || cause.message
  }
  return cause instanceof Error ? cause.message : String(cause)
}

interface PendingPrompt {
  readonly frame: GitAskpassFrame
  readonly settle: (answer: GitAskpassAnswer) => void
}

export interface GitOperationOptions {
  /** A remote action (fetch, pull, push): its success is reported with `formatRemoteOutput`. */
  readonly remote?: GitRemoteAction
}

/** One Git operation as the panel components start it: resolves with the `done` frame, `undefined` when the request itself failed. */
export type GitRun = (input: GitOperationInput, options?: GitOperationOptions) => Promise<GitOperationDone | undefined>

/**
 * Runs Git operations the way Zed's panel reports them. A credential prompt
 * opens the askpass modal and closes again if the operation ends by itself;
 * a failure is a persistent `git <action> failed` toast whose View Log shows
 * Git's output (Zed `show_error_toast`); a cancelled operation is silent; a
 * remote action's success is the `formatRemoteOutput` message with View Log or
 * the pull-request link (Zed `show_remote_output`). `run` never throws: it
 * resolves with the `done` frame, or `undefined` when the request itself failed.
 *
 * Render `dialogs` once, anywhere in the component tree. The output dialog is
 * not part of it: `GitOutputHost` (mounted beside `ToastHost`) owns that.
 */
export function useGitOperation(workspaceId: string, projectId: string): {
  readonly run: GitRun
  readonly dialogs: ReactNode
} {
  const toast = useToast()
  const [prompts, setPrompts] = useState<readonly PendingPrompt[]>([])
  const live = useRef<readonly PendingPrompt[]>([])
  live.current = prompts

  // Leaving with a prompt open answers it as a cancel, so Git is not left waiting.
  // A prompt that arrives after leaving has no modal to show in: it is cancelled
  // on arrival, or git and the repository queue would wait for it forever.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const prompt of live.current) prompt.settle({ cancel: true })
    }
  }, [])

  const askpass = useCallback((frame: GitAskpassFrame, signal: AbortSignal): Promise<GitAskpassAnswer> => (
    new Promise<GitAskpassAnswer>((resolve) => {
      if (!mounted.current) {
        resolve({ cancel: true })
        return
      }
      const settle = (answer: GitAskpassAnswer): void => {
        signal.removeEventListener('abort', onAbort)
        setPrompts((previous) => previous.filter((candidate) => candidate !== entry))
        resolve(answer)
      }
      const onAbort = (): void => settle({ cancel: true })
      const entry: PendingPrompt = { frame, settle }
      if (signal.aborted) {
        resolve({ cancel: true })
        return
      }
      signal.addEventListener('abort', onAbort)
      setPrompts((previous) => [...previous, entry])
    })
  ), [])

  const run = useCallback(async (input: GitOperationInput, options: GitOperationOptions = {}): Promise<GitOperationDone | undefined> => {
    const action = input.type
    const reportFailure = (log: string): void => {
      toast.notify(`git ${action} failed`, 'bad', {
        persistent: true,
        // The headline is the message itself, not an error-category summary.
        plain: true,
        // The log travels in the closure: the toast outlives this panel.
        action: { label: 'View Log', onClick: () => showGitOutput({ action, stdout: '', stderr: log }) },
      })
    }
    let done: GitOperationDone
    try {
      done = await gitOperation(workspaceId, projectId, input, askpass)
    } catch (cause) {
      reportFailure(failureText(cause))
      return undefined
    }
    if (done.cancelled === true) return done
    if (!done.ok) {
      reportFailure(done.stderr.trim() || done.stdout.trim())
      return done
    }
    if (options.remote !== undefined) {
      const success = formatRemoteOutput(options.remote, done)
      const log = success.log
      const link = success.action
      toast.notify(success.message, 'ok', {
        ...(link !== undefined
          ? { action: { label: link.label, onClick: () => { window.open(link.url, '_blank', 'noopener,noreferrer') } } }
          : log !== undefined
            ? { action: { label: 'View Log', onClick: () => showGitOutput({ action, stdout: log.stdout, stderr: log.stderr }) } }
            : {}),
      })
    }
    return done
  }, [workspaceId, projectId, toast, askpass])

  const first = prompts[0]
  const dialogs = (
    <>
      {first !== undefined ? (
        <GitAskpassModal
          key={first.frame.promptId}
          operation={first.frame.operation}
          prompt={first.frame.prompt}
          onConfirm={(password) => first.settle({ password })}
          onCancel={() => first.settle({ cancel: true })}
        />
      ) : null}
    </>
  )
  return { run, dialogs }
}
