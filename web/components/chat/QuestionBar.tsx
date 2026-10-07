import { useEffect, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Button } from '../ui/Button.tsx'
import { formatCountdown } from '../../lib/format.ts'
import type { PendingQuestion, QuestionReply } from '../../lib/types.ts'

type Reply = QuestionReply

interface Draft {
  readonly selected: readonly string[]
  readonly other: string
}

const EMPTY: Draft = { selected: [], other: '' }

/** True when every question has a choice or typed text. */
export function draftsComplete(drafts: readonly Draft[], count: number): boolean {
  for (let i = 0; i < count; i++) {
    const draft = drafts[i] ?? EMPTY
    if (draft.selected.length === 0 && draft.other.trim() === '') return false
  }
  return true
}

function QuestionCard({ row, onAnswer, now }: {
  readonly row: PendingQuestion
  readonly onAnswer: (questionId: string, reply: Reply) => Promise<void>
  readonly now: number
}) {
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => row.questions.map(() => EMPTY))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const update = (index: number, change: (draft: Draft) => Draft): void => {
    setDrafts((all) => all.map((draft, at) => at === index ? change(draft) : draft))
  }
  const send = async (reply: Reply): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try { await onAnswer(row.questionId, reply) }
    catch (cause) { setError(String(cause)) }
    finally { setSubmitting(false) }
  }
  const complete = draftsComplete(drafts, row.questions.length)
  const remaining = row.expiresAt - now

  return (
    <article aria-busy={submitting} aria-label="Question from the assistant" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-composer">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-hover text-fg"><Icon name="messageSquare" size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-medium">
            {row.childSessionId !== undefined
              ? <>Child agent {row.definitionName !== undefined ? <strong className="font-semibold">{row.definitionName}</strong> : null} needs your input</>
              : 'The assistant needs your input'}
          </p>
          <p className="m-0 text-xs text-fg-faint">
            {remaining > 0
              ? <>Waits <span className="font-mono">{formatCountdown(row.expiresAt, now)}</span> for an answer.</>
              : 'Expired — the assistant continued without an answer.'}
          </p>
        </div>
      </div>
      {row.questions.map((question, index) => {
        const draft = drafts[index] ?? EMPTY
        const name = `${row.questionId}-${index}`
        return (
          <fieldset key={name} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 flex flex-wrap items-center gap-2 p-0 text-sm text-fg">
              {question.header !== undefined ? <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-fg-muted">{question.header}</span> : null}
              <span>{question.question}</span>
              {question.multiSelect ? <span className="text-xs text-fg-faint">(choose any)</span> : null}
            </legend>
            {question.options.map((option) => {
              const checked = draft.selected.includes(option.label)
              return (
                <label key={option.label} className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm ${checked ? 'border-line-strong bg-hover' : 'border-line hover:bg-hover'}`}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={name}
                    className="mt-1"
                    checked={checked}
                    disabled={submitting}
                    onChange={() => update(index, (current) => ({
                      ...current,
                      selected: question.multiSelect
                        ? (checked ? current.selected.filter((label) => label !== option.label) : [...current.selected, option.label])
                        : [option.label],
                    }))}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{option.label}</span>
                    {option.description !== undefined ? <span className="block text-xs text-fg-muted">{option.description}</span> : null}
                  </span>
                </label>
              )
            })}
            <input
              type="text"
              aria-label={`Other answer for: ${question.question}`}
              placeholder="Other — type your own answer"
              className="h-9 rounded-xl border border-line bg-transparent px-3 text-sm outline-none focus:border-line-strong"
              value={draft.other}
              disabled={submitting}
              maxLength={4000}
              onChange={(event) => {
                const other = event.target.value
                // Typing replaces a single choice; with multiSelect it adds to them.
                update(index, (current) => ({ selected: question.multiSelect || other.trim() === '' ? current.selected : [], other }))
              }}
            />
          </fieldset>
        )
      })}
      {error !== '' ? <ErrorNotice raw={error} announce={false} /> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={submitting} onClick={() => void send({ decline: true })}>Skip</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={submitting || !complete}
          onClick={() => void send({
            answers: drafts.map((draft) => draft.other.trim() === '' ? { selected: draft.selected } : { selected: draft.selected, other: draft.other.trim() }),
          })}
        >
          {submitting ? 'Sending…' : 'Send answer'}
        </Button>
      </div>
    </article>
  )
}

/**
 * AskUserQuestion prompts above the composer. Each card holds its own draft;
 * Skip tells the model the user declined, Send returns the chosen labels and
 * any typed text. The model's turn is paused until one of those happens.
 */
export function QuestionBar({ questions, onAnswer }: {
  readonly questions: readonly PendingQuestion[]
  readonly onAnswer: (questionId: string, reply: Reply) => Promise<void>
}) {
  const [now, setNow] = useState(() => Date.now())
  const active = questions.length > 0
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => { window.clearInterval(id) }
  }, [active])
  if (!active) return null
  return (
    <section aria-label="Questions from the assistant" className="flex max-h-[min(55dvh,32rem)] flex-col gap-2 overflow-y-auto">
      {questions.map((row) => <QuestionCard key={row.questionId} row={row} onAnswer={onAnswer} now={now} />)}
    </section>
  )
}
