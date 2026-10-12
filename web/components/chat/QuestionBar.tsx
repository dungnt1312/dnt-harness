import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
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

const FOOT_BTN = 'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs transition-colors disabled:opacity-40'

/** Radio = circle with a dot, checkbox = rounded square with a tick. */
function ChoiceMark({ multi, checked, dashed = false }: {
  readonly multi: boolean
  readonly checked: boolean
  readonly dashed?: boolean
}) {
  const shape = multi ? 'rounded-[4px]' : 'rounded-full'
  const state = checked
    ? 'border-primary bg-primary text-primary-fg'
    : `${dashed ? 'border-dashed' : ''} border-fg-faint/70 group-hover:border-fg-muted`
  return (
    <span aria-hidden="true" className={`mt-px flex size-4 shrink-0 items-center justify-center border-[1.5px] transition-colors ${shape} ${state}`}>
      {checked ? (multi ? <Icon name="check" size={10} /> : <span className="size-1.5 rounded-full bg-primary-fg" />) : null}
    </span>
  )
}

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
      <header className="flex items-center gap-1 border-b border-line px-1.5">
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
                  className={`relative flex h-8 max-w-[11rem] shrink-0 items-center gap-1.5 px-2 text-xs transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${selected ? 'text-fg after:bg-fg' : 'text-fg-faint hover:text-fg-muted after:bg-transparent'}`}
                >
                  <span className={`flex size-3.5 shrink-0 items-center justify-center rounded-full text-[9px] ${answered ? 'bg-ok text-surface' : selected ? 'bg-fg text-surface' : 'bg-hover'}`}>
                    {answered ? <Icon name="check" size={9} /> : index + 1}
                  </span>
                  <span className="truncate">{q.header ?? `Question ${index + 1}`}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-xs text-fg-faint">
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

      <div role={count > 1 ? 'tabpanel' : undefined} className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <h3 className="m-0 text-[13px] leading-snug font-semibold text-fg">
          {question.question}
          {question.multiSelect ? <span className="ml-2 text-[11px] font-normal text-fg-faint">Choose any</span> : null}
        </h3>
        <div role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question} className="-mx-1.5 flex flex-col gap-px">
          {question.options.map((option) => {
            const checked = draft.selected.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={checked}
                disabled={submitting}
                onClick={() => choose(option.label)}
                title={option.description}
                className={`group flex w-full items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors disabled:opacity-50 ${checked ? 'bg-hover' : 'hover:bg-hover/50'}`}
              >
                <ChoiceMark multi={question.multiSelect === true} checked={checked} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] leading-[18px] ${checked ? 'font-medium text-fg' : 'text-fg'}`}>{option.label}</span>
                  {option.description !== undefined ? <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-fg-faint">{option.description}</span> : null}
                </span>
              </button>
            )
          })}
          <label className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-hover/50">
            <ChoiceMark multi={question.multiSelect === true} checked={draft.other.trim() !== ''} dashed />
            <input
              type="text"
              aria-label={`Other answer for: ${question.question}`}
              placeholder="Other…"
              className="h-[18px] min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-[18px] text-fg outline-none placeholder:text-fg-faint"
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

      <footer className="flex items-center gap-1 border-t border-line px-2 py-1.5">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void send({ decline: true })}
          className={`${FOOT_BTN} text-fg-faint hover:bg-hover hover:text-fg`}
        >
          {count > 1 ? 'Skip all' : 'Skip'}
        </button>
        <span className="min-w-0 flex-1" />
        {/* Early send stays available but quiet; the primary button is the next step. */}
        {!last && answeredCount > 0 ? (
          <button type="button" disabled={submitting} onClick={submit} className={`${FOOT_BTN} text-fg-muted hover:bg-hover hover:text-fg`}>
            Send {answeredCount}/{count}
          </button>
        ) : null}
        {active > 0 ? (
          <button type="button" disabled={submitting} onClick={() => goTo(active - 1)} aria-label="Previous question" className={`${FOOT_BTN} w-7 justify-center px-0 text-fg-muted hover:bg-hover hover:text-fg`}>
            <Icon name="chevron" size={14} className="rotate-90" />
          </button>
        ) : null}
        {last ? (
          <button ref={sendRef} type="button" disabled={submitting} onClick={submit} className={`${FOOT_BTN} bg-primary font-medium text-primary-fg hover:opacity-85`}>
            {submitting ? 'Sending…' : 'Send'}
          </button>
        ) : (
          <button type="button" disabled={submitting} onClick={() => goTo(active + 1)} className={`${FOOT_BTN} bg-primary pr-2 font-medium text-primary-fg hover:opacity-85`}>
            Next<Icon name="chevronRight" size={13} />
          </button>
        )}
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
