/**
 * What the summarizer is asked to read. File bodies the agent already wrote to disk,
 * long scripts and long tool outputs are not conversation: they made a 2 MB session
 * fold through 13 sequential model calls. The projection keeps what identifies the
 * work (tool, path, command, the head and tail of an output) and replaces bulk with a
 * measured reference, never silently: the summarizer is told what was left out.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from 'dnt-harness'
import { projectForSummary, SUMMARY_ARG_CHARS, SUMMARY_RESULT_CHARS } from '../../src/harness/context/compaction.ts'

const log = (rows: Record<string, unknown>[]): SessionEvent[] => rows.map((row, i) => ({ ...row, seq: i + 1, timestamp: i + 1 }) as SessionEvent)

function turn(name: string, args: Record<string, unknown>, output: string): SessionEvent[] {
  return log([
    { type: 'turn/start', turnId: 't' },
    { type: 'user/message', turnId: 't', content: 'USER ASKED THIS' },
    { type: 'assistant/message', stepId: 's', content: 'I will do it', toolCalls: [{ id: 'c', name, args }] },
    { type: 'tool/call', stepId: 's', call: { id: 'c', name, args } },
    { type: 'tool/result', stepId: 's', callId: 'c', ok: true, output },
    { type: 'assistant/message', stepId: 's2', content: 'DONE: wrote the file' },
    { type: 'turn/end', turnId: 't', reason: 'completed' },
  ])
}

describe('projectForSummary: what the summarizer reads', () => {
  it('keeps the file path of a Write but not the file body, and says how much was left out', () => {
    const body = 'export const X = 1\n'.repeat(5_000)
    const text = projectForSummary(turn('Write', { path: 'src/big.ts', content: body }, 'wrote src/big.ts'), 7)
    expect(text).toContain('src/big.ts')
    expect(text).not.toContain(body)
    // The head stays so the reader can tell what the file was; the rest is a measured note.
    expect(text).toContain(`export const X = 1`)
    expect(text).toContain(`<${body.length} chars omitted>`)
    expect(text).toContain('USER ASKED THIS')
    expect(text).toContain('DONE: wrote the file')
  })

  it('keeps an Edit target and short strings, and replaces long old/new strings with their size', () => {
    const big = 'line\n'.repeat(2_000)
    const text = projectForSummary(turn('Edit', { path: 'a.ts', old_string: 'short old', new_string: big }, 'edited'), 7)
    expect(text).toContain('a.ts')
    expect(text).toContain('short old')
    expect(text).not.toContain(big)
    expect(text).toContain(`<${big.length} chars omitted>`)
  })

  it('keeps a short Bash command verbatim and a long script as its head plus a size note', () => {
    const short = projectForSummary(turn('Bash', { command: 'pnpm test tests/a.spec.ts' }, 'ok'), 7)
    expect(short).toContain('pnpm test tests/a.spec.ts')
    const script = `python3 - <<'EOF'\n${'print(1)\n'.repeat(3_000)}EOF`
    const long = projectForSummary(turn('Bash', { command: script }, 'ok'), 7)
    expect(long).toContain("python3 - <<'EOF'")
    expect(long).not.toContain(script)
    expect(long).toContain('chars omitted')
  })

  it('keeps the head and tail of a long tool result — the error at the end survives', () => {
    const output = `START OF OUTPUT\n${'noise line\n'.repeat(20_000)}FAIL tests/x.spec.ts > the real error`
    const text = projectForSummary(turn('Bash', { command: 'pnpm test' }, output), 7)
    expect(text).toContain('START OF OUTPUT')
    expect(text).toContain('FAIL tests/x.spec.ts > the real error')
    expect(text.length).toBeLessThan(SUMMARY_RESULT_CHARS + 2_000)
    expect(text).toMatch(/<\d+ chars omitted>/)
  })

  it('leaves short arguments and short results exactly as they were', () => {
    const text = projectForSummary(turn('Read', { path: 'src/a.ts', offset: 10 }, 'export const a = 1'), 7)
    expect(text).toContain('Read({"path":"src/a.ts","offset":10})')
    expect(text).toContain('export const a = 1')
    expect(text).not.toContain('omitted')
  })

  it('never shortens what the user typed or what the assistant answered', () => {
    const typed = `USER CONSTRAINT: ${'do not push '.repeat(2_000)}`
    const answer = `ANSWER: ${'reasoning '.repeat(3_000)}`
    const events = log([
      { type: 'turn/start', turnId: 't' },
      { type: 'user/message', turnId: 't', content: typed },
      { type: 'assistant/message', stepId: 's', content: answer },
      { type: 'turn/end', turnId: 't', reason: 'completed' },
    ])
    const text = projectForSummary(events, 4)
    expect(text).toContain(typed)
    expect(text).toContain(answer)
  })

  it('caps every argument value and every result by the published limits', () => {
    expect(SUMMARY_ARG_CHARS).toBeGreaterThan(0)
    expect(SUMMARY_RESULT_CHARS).toBeGreaterThan(SUMMARY_ARG_CHARS)
    const args = { a: 'x'.repeat(SUMMARY_ARG_CHARS), b: 'y'.repeat(SUMMARY_ARG_CHARS + 1) }
    const text = projectForSummary(turn('Custom', args, 'z'.repeat(SUMMARY_RESULT_CHARS)), 7)
    expect(text).toContain('x'.repeat(SUMMARY_ARG_CHARS))
    expect(text).not.toContain('y'.repeat(SUMMARY_ARG_CHARS + 1))
    expect(text).toContain('z'.repeat(SUMMARY_RESULT_CHARS))
  })
})
