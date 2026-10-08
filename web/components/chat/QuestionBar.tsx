import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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

/** True when the question has a choice or typed text. Answers are optional. */
export function draftAnswered(draft: Draft | undefined): boolean {
  return draft !== undefined && (draft.selected.length > 0 || draft.other.trim() !== '')
}

/** Delay before auto-advancing so the user sees the choice land. */
const ADVANCE_MS = 160

function QuestionCard({ row, onAnswer, now }: {
  readonly row: PendingQuestion
  readonly onAnswer: (questionId: string, reply: Reply) => Promise<void>
  readonly now: number
}) {
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => row.questions.map(() => EMPTY))
  const [tab, setTab] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const advanceTimer = useRef<number | undefined>(undefined)
  const sendRef = useRef<HTMLButtonElement>(null)

  useEffect(() => () => { window.clearTimeout(advanceTimer.current) }, [])

  const update = (index: number, change: (draft: Draft) => Draft): void => {
    setDrafts((all) => all.map((draft, at) => at === index ? change(draft) : draft))
  }
  const goTo = (index: number): void => {
    window.clearTimeout(advanceTimer.current)
    setTab(index)
  }
  const send = async (reply: Reply): Promise<void> => {
    if (submitting) return
    window.clearTimeout(advanceTimer.current)
    setSubmitting(true)
    setError('')
    try { await onAnswer(row.questionId, reply) }
    catch (cause) { setError(String(cause)) }
    finally { setSubmitting(false) }
  }
  const remaining = row.expiresAt - now
  const count = row.questions.length
  const active = Math.min(tab, count - 1)
  const question = row.questions[active]!
  const draft = drafts[active] ?? EMPTY
  const last = active === count - 1
  const answeredCount = drafts.filter((d) => draftAnswered(d)).length
  const submit = (): void => {
    void send({
      answers: drafts.map((d) => d.other.trim() === '' ? { selected: d.selected } : { selected: d.selected, other: d.other.trim() }),
    })
  }

  const choose = (label: string): void => {
    if (submitting) return
    const checked = draft.selected.includes(label)
    if (question.multiSelect) {
      update(active, (current) => ({
        ...current,
        selected: checked ? current.selected.filter((l) => l !== label) : [...current.selected, label],
      }))
      return
    }
    // Single choice: picking the current answer again clears it (answers are optional).
    update(active, () => ({ selected: checked ? [] : [label], other: '' }))
    if (checked) return
    window.clearTimeout(advanceTimer.current)
    advanceTimer.current = window.setTimeout(() => {
      if (last) sendRef.current?.focus()
      else setTab(active + 1)
    }, ADVANCE_MS)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return
    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= question.options.length) {
      event.preventDefault()
      choose(question.options[digit - 1]!.label)
    } else if (event.key === 'ArrowRight' && !last) {
      event.preventDefault(); goTo(active + 1)
    } else if (event.key === 'ArrowLeft' && active > 0) {
      event.preventDefault(); goTo(active - 1)
    }
  }

  return (
    <article
      aria-busy={submitting}
      aria-label="Question from the assistant"
      onKeyDown={onKeyDown}
      className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-composer"
    >
      <header className="flex items-center gap-1 border-b border-line px-2">
        {count > 1 ? (
          <div role="tablist" aria-label="Questions" className="flex min-w-0 flex-1 overflow-x-auto">
            {row.questions.map((q, index) => {
              const selected = index === active
              const answered = draftAnswered(drafts[index])
              return (
                <button
                  key={`${row.questionId}-tab-${index}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={q.question}
                  onClick={() => goTo(index)}
                  className={`relative flex h-10 max-w-[11rem] shrink-0 items-center gap-1.5 px-2.5 text-xs transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${selected ? 'text-fg after:bg-fg' : 'text-fg-faint hover:text-fg-muted after:bg-transparent'}`}
                >
                  <span className={`flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] ${answered ? 'bg-ok text-surface' : selected ? 'bg-fg text-surface' : 'bg-hover'}`}>
                    {answered ? <Icon name="check" size={10} /> : index + 1}
                  </span>
                  <span className="truncate">{q.header ?? `Question ${index + 1}`}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 px-2 text-xs text-fg-faint">
            <Icon name="messageSquare" size={13} />
            <span className="truncate">
              {row.childSessionId !== undefined
                ? <>{row.definitionName ?? 'Child agent'} asks</>
                : question.header ?? 'The assistant asks'}
            </span>
          </div>
        )}
        <span className={`shrink-0 px-2 font-mono text-[11px] ${remaining > 0 ? 'text-fg-faint' : 'text-bad'}`} title="Time left to answer">
          {remaining > 0 ? formatCountdown(row.expiresAt, now) : 'expired'}
        </span>
      </header>

      <div role={count > 1 ? 'tabpanel' : undefined} className="flex flex-col gap-3 px-4 pt-4 pb-3">
        <h3 className="m-0 text-[15px] leading-snug font-medium text-fg">
          {question.question}
          {question.multiSelect ? <span className="ml-2 text-xs font-normal text-fg-faint">Choose any</span> : null}
        </h3>
        <div role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question} className="-mx-2 flex flex-col gap-0.5">
          {question.options.map((option, index) => {
            const checked = draft.selected.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={checked}
                disabled={submitting}
                onClick={() => choose(option.label)}
                className={`group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition-colors disabled:opacity-50 ${checked ? 'bg-hover' : 'hover:bg-hover/60'}`}
              >
                <span className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-medium transition-colors ${checked ? 'bg-fg text-surface' : 'bg-hover text-fg-muted group-hover:text-fg'}`}>
                  {checked ? <Icon name="check" size={12} /> : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg">{option.label}</span>
                  {option.description !== undefined ? <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">{option.description}</span> : null}
                </span>
              </button>
            )
          })}
          <label className={`flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors ${draft.other.trim() !== '' ? 'bg-hover' : 'focus-within:bg-hover/60'}`}>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-hover text-fg-muted"><Icon name="pencil" size={11} /></span>
            <input
              type="text"
              aria-label={`Other answer for: ${question.question}`}
              placeholder="Something else…"
              className="h-7 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
              value={draft.other}
              disabled={submitting}
              maxLength={4000}
              onChange={(event) => {
                const other = event.target.value
                window.clearTimeout(advanceTimer.current)
                // Typing replaces a single choice; with multiSelect it adds to them.
                update(active, (current) => ({ selected: question.multiSelect || other.trim() === '' ? current.selected : [], other }))
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (last) submit()
                else goTo(active + 1)
              }}
            />
          </label>
        </div>
        {error !== '' ? <ErrorNotice raw={error} announce={false} /> : null}
      </div>

      <footer className="flex items-center gap-2 px-3 pb-3">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void send({ decline: true })}
          className="h-8 rounded-full px-3 text-[13px] text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          Skip all
        </button>
        <span className="min-w-0 flex-1" />
        {active > 0 ? (
          <Button variant="ghost" size="sm" disabled={submitting} onClick={() => goTo(active - 1)} aria-label="Previous question">
            <Icon name="chevron" size={14} className="rotate-90" />
          </Button>
        ) : null}
        {!last ? (
          <Button variant="outline" size="sm" disabled={submitting} onClick={() => goTo(active + 1)}>
            Next<Icon name="chevronRight" size={14} />
          </Button>
        ) : null}
        <button
          ref={sendRef}
          type="button"
          disabled={submitting}
          onClick={submit}
          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors disabled:opacity-40 ${last ? 'bg-primary text-primary-fg hover:opacity-85' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
        >
          {submitting ? 'Sending…' : count > 1 ? `Send ${answeredCount}/${count}` : 'Send'}
        </button>
      </footer>
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
