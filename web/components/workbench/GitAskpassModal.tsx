import { useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Button } from '../ui/Button.tsx'
import { Modal } from '../ui/Modal.tsx'

const GITHUB_DOCS = 'https://docs.github.com/en/get-started/git-basics/set-up-git#authenticating-with-github-from-git'

/** Zed `AskPassModal::render_hint`. */
export function showsGithubHint(prompt: string): boolean {
  return (prompt.includes('Password') || prompt.includes('Username')) && prompt.includes('github.com')
}

/**
 * The credential prompt a running Git operation raised (Zed `AskPassModal`).
 * The answer lives in the input only while the modal is open: confirming hands
 * it to `onConfirm` and the modal unmounts, so nothing keeps it afterwards. An
 * empty answer cannot be sent — on the wire it is the same as a cancel — so
 * Confirm stays disabled until something is typed. A yes/no or username prompt
 * is not a secret, so only the other prompts are masked (Zed `set_masked`).
 */
export function GitAskpassModal({ operation, prompt, onConfirm, onCancel }: {
  readonly operation: string
  readonly prompt: string
  readonly onConfirm: (answer: string) => void
  readonly onCancel: () => void
}) {
  const [answer, setAnswer] = useState('')
  const masked = !(prompt.includes('yes/no') || prompt.includes('Username'))
  const submit = (): void => {
    if (answer === '') return
    const value = answer
    setAnswer('')
    onConfirm(value)
  }
  return (
    <Modal open onDismiss={onCancel} label={`git ${operation}`} width="sm">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <h2 className="m-0 flex items-center gap-1.5 font-mono text-sm font-semibold">
          <Icon name="gitBranch" size={13} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 truncate">{operation}</span>
        </h2>
        <p className="m-0 whitespace-pre-wrap break-words font-mono text-[13px]">{prompt}</p>
        <input
          type={masked ? 'password' : 'text'}
          aria-label={prompt}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          className="h-9 rounded-lg border border-line bg-bg px-2.5 font-mono text-[13px] text-fg outline-none focus:border-fg-faint"
        />
        {showsGithubHint(prompt) ? (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-muted/40 px-2.5 py-2 text-xs text-fg-muted">
            <span className="min-w-0 flex-1">You may need to configure git for Github.</span>
            <a href={GITHUB_DOCS} target="_blank" rel="noreferrer noopener" className="shrink-0 text-link hover:underline">Learn more</a>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={answer === ''}>Confirm</Button>
        </div>
      </form>
    </Modal>
  )
}
