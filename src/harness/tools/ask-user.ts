import type { ToolDefinition, ToolExecution } from './types.ts'

/**
 * AskUserQuestion: the model pauses its turn to ask the human one to four
 * multiple-choice questions. The tool owns the SHAPE (validation and the
 * model-facing receipt); routing the question to a human is the host's
 * `ask` callback — exactly like the approval policy's `askUser`, the tool
 * stays transport-agnostic. The durable `tool/call` carries the questions and
 * the `tool/result` carries the answers, so the log alone explains the turn.
 */
export const MAX_QUESTIONS = 4
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6
const MAX_TEXT = 1_000
const MAX_OTHER = 4_000

export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

export interface UserQuestion {
  readonly question: string
  /** Short chip label (e.g. "Database"); optional. */
  readonly header?: string
  readonly options: readonly QuestionOption[]
  readonly multiSelect: boolean
}

/** One answer per question, aligned by index. */
export interface QuestionAnswer {
  /** Labels of the chosen options (at most one unless multiSelect). */
  readonly selected: readonly string[]
  /** Free text the user typed instead of / beside the options. */
  readonly other?: string
}

/** What the host's asker settles with. */
export type QuestionOutcome =
  | { readonly kind: 'answered'; readonly answers: readonly QuestionAnswer[] }
  | { readonly kind: 'declined'; readonly reason?: string }

export type QuestionAsker = (questions: readonly UserQuestion[], exec: ToolExecution) => Promise<QuestionOutcome>

function text(value: unknown, field: string, limit = MAX_TEXT): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`'${field}' must be a non-empty string`)
  const trimmed = value.trim()
  if (trimmed.length > limit) throw new Error(`'${field}' is limited to ${limit} characters`)
  return trimmed
}

export function parseQuestions(args: Record<string, unknown>): readonly UserQuestion[] {
  const raw = args['questions']
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("argument 'questions' must be a non-empty array of { question, options, header?, multiSelect? }")
  }
  if (raw.length > MAX_QUESTIONS) throw new Error(`ask at most ${MAX_QUESTIONS} questions per call`)
  const seenQuestions = new Set<string>()
  return raw.map((entry, index) => {
    const item = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
    const question = text(item['question'], `questions[${index}].question`)
    if (seenQuestions.has(question)) throw new Error(`questions[${index}] repeats an earlier question`)
    seenQuestions.add(question)
    const header = item['header'] === undefined ? undefined : text(item['header'], `questions[${index}].header`, 40)
    const multi = item['multiSelect']
    if (multi !== undefined && typeof multi !== 'boolean') throw new Error(`questions[${index}].multiSelect must be a boolean`)
    const rawOptions = item['options']
    if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
      throw new Error(`questions[${index}].options needs ${MIN_OPTIONS}-${MAX_OPTIONS} items of { label, description? }`)
    }
    const labels = new Set<string>()
    const options = rawOptions.map((option, at) => {
      const o = typeof option === 'object' && option !== null ? (option as Record<string, unknown>) : {}
      const label = text(o['label'], `questions[${index}].options[${at}].label`, 200)
      if (labels.has(label)) throw new Error(`questions[${index}] has duplicate option '${label}'`)
      labels.add(label)
      const description = o['description'] === undefined ? undefined : text(o['description'], `questions[${index}].options[${at}].description`)
      return description === undefined ? { label } : { label, description }
    })
    return { question, ...(header !== undefined ? { header } : {}), options, multiSelect: multi === true }
  })
}

/**
 * Validate a human's answers against the exact questions asked. Shared by
 * every transport so a client can never smuggle a label the model never
 * offered. Throws a message suitable for a 400.
 */
export function validateAnswers(questions: readonly UserQuestion[], raw: unknown): readonly QuestionAnswer[] {
  if (!Array.isArray(raw) || raw.length !== questions.length) {
    throw new Error(`answers must be an array with one entry per question (${questions.length})`)
  }
  return raw.map((entry, index) => {
    const question = questions[index]!
    const item = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
    const selected = item['selected'] ?? []
    if (!Array.isArray(selected) || selected.some((label) => typeof label !== 'string')) {
      throw new Error(`answers[${index}].selected must be an array of option labels`)
    }
    const unique = [...new Set(selected as string[])]
    const known = new Set(question.options.map((option) => option.label))
    const unknown = unique.find((label) => !known.has(label))
    if (unknown !== undefined) throw new Error(`answers[${index}] selects '${unknown}', which is not an offered option`)
    if (!question.multiSelect && unique.length > 1) throw new Error(`answers[${index}] allows a single choice`)
    const otherRaw = item['other']
    if (otherRaw !== undefined && typeof otherRaw !== 'string') throw new Error(`answers[${index}].other must be a string`)
    const other = typeof otherRaw === 'string' ? otherRaw.trim() : ''
    if (other.length > MAX_OTHER) throw new Error(`answers[${index}].other is limited to ${MAX_OTHER} characters`)
    // An empty answer is allowed: the user may skip individual questions.
    // Keep the offered order, not the click order.
    const ordered = question.options.map((option) => option.label).filter((label) => unique.includes(label))
    return other === '' ? { selected: ordered } : { selected: ordered, other }
  })
}

export function formatOutcome(questions: readonly UserQuestion[], outcome: QuestionOutcome): string {
  if (outcome.kind === 'declined') {
    return `The user declined to answer${outcome.reason !== undefined ? ` (${outcome.reason})` : ''}. Do not ask the same question again unprompted; proceed with your best judgment or ask in plain text.`
  }
  const lines = questions.map((question, index) => {
    const answer = outcome.answers[index]
    const parts = [
      ...(answer?.selected.length ? [answer.selected.join(', ')] : []),
      ...(answer?.other !== undefined ? [`(typed) ${answer.other}`] : []),
    ]
    return `${index + 1}. ${JSON.stringify(question.question)} → ${parts.join('; ') || '(skipped — no answer)'}`
  })
  return `The user answered:\n${lines.join('\n')}`
}

export function askUserQuestionTool(options: { readonly ask: QuestionAsker }): ToolDefinition {
  return {
    name: 'AskUserQuestion',
    description: [
      'Ask the user one to four multiple-choice questions and wait for the answers.',
      'Use it when a decision genuinely belongs to the user and changes what you do next: ambiguous requirements, choosing between implementation approaches, confirming preferences. Do not use it for things you can find out yourself by reading the workspace, and do not use it to ask for permission to run a tool (the host already handles approvals).',
      `Each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} distinct options with short labels; put the recommended option first and say so in its description. The user can always type their own answer instead, so never add an "Other" option.`,
      'Set multiSelect when several options may apply together. The turn pauses until the user answers, declines, or the question expires.',
    ].join(' '),
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `1-${MAX_QUESTIONS} questions asked together.`,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The full question, ending with a question mark.' },
              header: { type: 'string', description: 'Very short label shown as a chip (max 40 chars), e.g. "Database".' },
              multiSelect: { type: 'boolean', description: 'Allow choosing several options. Default false.' },
              options: {
                type: 'array',
                description: `${MIN_OPTIONS}-${MAX_OPTIONS} distinct choices.`,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Concise choice text (1-5 words).' },
                    description: { type: 'string', description: 'What this choice means or implies.' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    async execute(args, exec) {
      const questions = parseQuestions(args)
      if (exec.signal?.aborted === true) throw new Error('cancelled: stop requested before the question was asked')
      const outcome = await options.ask(questions, exec)
      return formatOutcome(questions, outcome)
    },
  }
}
