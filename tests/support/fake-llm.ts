import type { LlmProvider, ModelRequest, StreamEvent, StreamOptions, ToolCall } from '../../src/harness/llm/types.ts'

/** One deterministic test turn: plain text, or a tool call with lead-in text. */
export type ScriptStep =
  | string
  | {
      readonly content?: string
      readonly thinking?: string
      readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[]
    }

function isToolStep(step: ScriptStep): step is Exclude<ScriptStep, string> {
  return typeof step === 'object'
}

/**
 * Test-only scripted LLM. It replaced the production MockLlmProvider: code
 * paths now either speak real OpenAI completions or receive this explicit
 * test double at their injection seam.
 */
export class FakeScriptedLlm implements LlmProvider {
  readonly name = 'scripted'
  readonly models: readonly string[] = ['scripted']
  private index = 0

  constructor(private readonly steps: readonly ScriptStep[]) {}

  async *stream(_request: ModelRequest, _options?: StreamOptions): AsyncIterable<StreamEvent> {
    const last = this.steps[this.steps.length - 1]
    const step = this.steps[this.index] ?? last
    if (step === undefined) throw new Error('fake llm: no scripted steps')
    this.index = Math.min(this.index + 1, Math.max(this.steps.length - 1, 0))

    const reply = typeof step === 'string' ? step : (step.content ?? '')
    if (!isToolStep(step)) {
      yield* words(reply)
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      return
    }
    if (step.thinking !== undefined && step.thinking !== '') {
      yield* words(step.thinking, true)
    }
    if (reply !== '') yield* words(reply)
    if (step.toolCalls !== undefined) {
      const calls: ToolCall[] = step.toolCalls.map((call, position) => ({
        id: `call-${this.index}-${position}`,
        name: call.name,
        args: call.args,
      }))
      yield { type: 'toolCalls', calls }
    }
    yield { type: 'completion', finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', transport: 'done', policy: 'strict', transportSettled: true }
  }
}

async function* words(text: string, thinking = false): AsyncIterable<StreamEvent> {
  if (text === '') return
  const parts = text.match(/\S+\s*/g) ?? [text]
  for (const word of parts) {
    if (thinking) yield { type: 'delta', delta: word, thinking: true }
    else yield { type: 'delta', delta: word }
  }
}
