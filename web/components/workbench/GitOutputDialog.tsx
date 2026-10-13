import { Button } from '../ui/Button.tsx'
import { Modal } from '../ui/Modal.tsx'

/** What a Git command printed, shown by a toast's "View Log" (Zed `open_output`). */
export interface GitOutput {
  /** The Git action, e.g. `push`: the dialog is titled `<action> output`. */
  readonly action: string
  readonly stdout: string
  readonly stderr: string
}

/** Strips terminal colour and cursor escapes (Zed `terminal::strip_ansi_text`). */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** Read-only output of a Git command: stdout, then stderr, in a focusable monospace scroller. */
export function GitOutputDialog({ output, onClose }: {
  readonly output: GitOutput | null
  readonly onClose: () => void
}) {
  const title = `${output?.action ?? ''} output`
  const parts = output === null ? [] : [output.stdout, output.stderr].map(stripAnsi).filter((part) => part !== '')
  return (
    <Modal open={output !== null} onDismiss={onClose} label={title} width="lg">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <pre
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroller must be keyboard-scrollable
        tabIndex={0}
        aria-label={title}
        className="mt-3 max-h-[min(420px,50dvh)] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-muted/40 p-3 font-mono text-xs"
      >
        {parts.length > 0 ? parts.join('\n') : '(no output)'}
      </pre>
      <div className="mt-5 flex justify-end">
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  )
}
