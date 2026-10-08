// @vitest-environment jsdom
/**
 * How tool calls read once rendered: the digest each tool earns, which runs
 * collapse and which stay open, and what an approval shows the person deciding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ActivityBlock, ToolCard, summarizeActivity } from '../components/chat/MessageParts.tsx'
import { finalProgram } from './tool-facts.ts'
import { ApprovalBar } from '../components/chat/ApprovalBar.tsx'
import { formatElapsed } from './format.ts'
import { isDenied, toolFacts } from './tool-facts.ts'
import type { ViewItem } from './project.ts'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>

let root: Root | undefined
let host: HTMLDivElement
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
async function mount(view: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(view))
}
async function rerender(view: ReactNode) { await act(async () => root!.render(view)) }
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined })

const row = (id: string, name: string, args: Record<string, unknown>, result?: { ok: boolean; output: string }): ToolItem => ({
  kind: 'tool', call: { id, name, args }, ts: 0, doneAt: 5, ...(result !== undefined ? { result } : {}),
})
const read = (id: string): ToolItem => row(id, 'Read', { path: `src/${id}.ts` }, { ok: true, output: 'x' })
const facts = (name: string, args: Record<string, unknown>, output: string, ok = true) =>
  toolFacts({ id: 'c', name, args }, { ok, output })

describe('elapsed time', () => {
  it('never rounds seconds up to 60 inside a minute', () => {
    expect(formatElapsed(119_600)).toBe('2m 0s')
    expect(formatElapsed(59_960)).toBe('1m 0s')
    expect(formatElapsed(59_940)).toBe('59.9s')
    expect(formatElapsed(61_000)).toBe('1m 1s')
  })
  it('keeps short spans exact and treats a negative span as zero', () => {
    expect(formatElapsed(850)).toBe('850ms')
    expect(formatElapsed(4_200)).toBe('4.2s')
    expect(formatElapsed(-5)).toBe('0ms')
    expect(formatElapsed(Number.NaN)).toBe('')
  })
})

describe('digest per tool', () => {
  it('treats a Glob scope as scope, like Grep: no file to open, and the scope on the row', () => {
    const glob = facts('Glob', { pattern: '**/*.ts', path: 'src' }, 'a.ts\nb.ts')
    expect(glob.path).toBeUndefined()
    expect(glob.target).toBe('**/*.ts in src')
    expect(glob.fullTarget).toBe('**/*.ts in src')
    expect(glob.digest).toBe('2 files')
  })
  it('reports the real total when Glob stopped at its cap, not the note as a file', () => {
    const listed = Array.from({ length: 100 }, (_, index) => `f${index}.ts`).join('\n')
    expect(facts('Glob', { pattern: '**/*.ts' }, `${listed}\n… [+523 more matches]`).digest).toBe('100 of 623 files')
  })
  it('keeps incomplete searches visible and never counts warnings as files or matches', () => {
    const note = '… [search incomplete: walk budget exhausted; narrow the search path]'
    for (const name of ['Glob', 'Grep']) {
      expect(facts(name, { pattern: 'x' }, note).digest).toBe('search incomplete')
      expect(facts(name, { pattern: 'x' }, `no matches\n${note}`).digest).toBe('search incomplete')
    }
    expect(facts('Glob', { pattern: '*' }, `a.ts\n${note}`).digest).toBe('1 file · search incomplete')
    expect(facts('Glob', { pattern: '*' }, `a.ts\n… [+5 more matches]\n${note}`).digest).toBe('1 of 6 files · search incomplete')
    expect(facts('Grep', { pattern: 'x' }, `a.ts:1: x\n${note}`).digest).toBe('1 match · search incomplete')
  })
  it('counts only whole displayed rows with recomputed omission counts and compact completeness notes', () => {
    expect(facts('Glob', { pattern: '*' }, 'file-000.ts\n… [+104 more matches]').digest).toBe('1 of 105 files')
    expect(facts('Glob', { pattern: '*' }, '… [+105 more matches]\n… [search incomplete: partial]').digest).toBe('search incomplete')
    expect(facts('Grep', { pattern: 'x' }, '… [output truncated]\n… [search incomplete: partial]').digest).toBe('search incomplete')
  })
  it('recognizes output truncation notes without counting them as hits', () => {
    expect(facts('Glob', { pattern: '*' }, 'a.ts\n… [output truncated]').digest).toBe('1 file · truncated')
    expect(facts('Grep', { pattern: 'x' }, 'a.ts:1: x\n… [output truncated]').digest).toBe('1 match · truncated')
  })
  it('shows the incomplete warning on a settled search row, without opening details', async () => {
    await mount(<ToolCard item={row('incomplete', 'Glob', { pattern: '**/*.ts' }, { ok: true, output: 'a.ts\n… [search incomplete: walk budget exhausted; narrow the search path]' })} />)
    expect(host.querySelector('button')?.textContent).toContain('Search incomplete')
  })
  it('does not count the Grep truncation note as a match', () => {
    const hits = Array.from({ length: 250 }, (_, index) => `a.ts:${index + 1}: x`).join('\n')
    expect(facts('Grep', { pattern: 'x' }, `${hits}\n… [more matches truncated]`).digest).toBe('250 matches · truncated')
    expect(facts('Grep', { pattern: 'x' }, 'a.ts:1: x\nb.ts:2: x').digest).toBe('2 matches · 2 files')
  })
  it('says when Bash output was cut, and still reads the exit code', () => {
    expect(facts('Bash', { command: 'cat big' }, 'x\n… [truncated 5000 chars]\n[exit code: 0]').digest).toBe('exit 0 · truncated')
    expect(facts('Bash', { command: 'cat big' }, 'x\n[exit code: 0]').digest).toBe('exit 0')
  })
  it('names what an Agent call asked for and what came back instead of echoing JSON', () => {
    const spawn = facts('Agent', { action: 'spawn', definition: 'explorer', prompt: 'map it' }, JSON.stringify({ childSessionId: 'c1', status: 'running' }))
    expect(spawn.target).toBe('spawn · explorer')
    expect(spawn.digest).toBe('running')
    const wait = facts('Agent', { action: 'wait' }, JSON.stringify({ children: [{ status: 'completed' }, { status: 'completed' }, { status: 'failed' }] }))
    expect(wait.target).toBe('wait')
    expect(wait.digest).toBe('2 completed · 1 failed')
    expect(facts('Agent', { action: 'wait' }, JSON.stringify({ children: [] })).digest).toBe('no children')
    expect(facts('Agent', { action: 'catalog' }, JSON.stringify({ roles: [{}, {}] })).digest).toBe('2 roles')
  })
  it('reads a memory receipt as what happened to the entry', () => {
    expect(facts('MemoryCreate', { id: 'x-y', title: 't', body: 'b' }, "created memory 'x-y' (sha256 abc)").digest).toBe('created')
    expect(facts('MemoryUpdate', { id: 'x-y' }, "updated memory 'x-y' (sha256 abc)").digest).toBe('updated')
    expect(facts('MemoryForget', { id: 'x-y' }, "forgot 'x-y'").digest).toBe('forgot')
    expect(facts('MemorySearch', { query: 'a b' }, 'one [pinned] One\ntwo [loose] Two').digest).toBe('2 entries')
    expect(facts('MemorySearch', { query: 'a b' }, 'no memory matches').digest).toBe('no matches')
    expect(facts('MemoryRead', { id: 'x-y' }, '# The title\nbody\n\n[sha256 abc]').digest).toBe('The title')
    expect(facts('MemoryCreate', { id: 'x-y' }, "created memory 'x-y' (sha256 abc)").target).toBe('x-y')
  })
  it('leads a Skill load with the skill name, and reads its receipt as the digest', () => {
    const load = facts('Skill', { action: 'load', name: 'systematic-debugging' }, "skill 'systematic-debugging' loaded (hash 808fc5717aa8); its instructions are included in context")
    expect(load.target).toBe('systematic-debugging')
    expect(load.fullTarget).toBe('load systematic-debugging')
    expect(load.digest).toBe('loaded')
    expect(facts('Skill', { action: 'load', name: 'nope' }, "skill 'nope' not found; use Skill action:\"catalog\"").digest).toBe('not found')
    const catalog = facts('Skill', { action: 'catalog', query: 'rev' }, 'review [project] Review a diff\nreplay [user] Replay a run\n… 3 more; refine query or raise limit')
    expect(catalog.target).toBe('catalog rev')
    expect(catalog.digest).toBe('2 skills')
    expect(facts('Skill', { action: 'catalog' }, 'no skills available').digest).toBe('no matches')
  })
  it('keeps a refusal quiet: it shows its reason but is not a failure digest', () => {
    const denied = facts('Bash', { command: 'rm -rf build' }, 'denied: blocked by the dangerous-command guard', false)
    expect(isDenied({ ok: false, output: 'denied: nope' })).toBe(true)
    expect(isDenied({ ok: false, output: 'error: boom' })).toBe(false)
    expect(denied.digest).toBe('denied: blocked by the dangerous-command guard')
    expect(denied.digestFailed).toBe(false)
    expect(facts('Read', { path: 'a.ts' }, 'error: boom', false).digestFailed).toBe(true)
  })
})

describe('run summary', () => {
  const run = (middle: ToolItem): ToolItem[] => [read('a'), read('b'), middle, read('d')]
  it('counts a Bash command that exited non-zero, though the tool itself settled as recorded', () => {
    const summary = summarizeActivity(run(row('c', 'Bash', { command: 'npm test' }, { ok: true, output: '1 failing\n[exit code: 1]' })))
    expect(summary.problems).toBe(1)
    expect(summary.state).toBe('failed')
  })
  it('counts a killed command too', () => {
    const summary = summarizeActivity(run(row('c', 'Bash', { command: 'sleep 99' }, { ok: true, output: 'partial\n[terminated by timeout; killed]' })))
    expect(summary.problems).toBe(1)
  })
  it('leaves a clean command and a refusal out of "to inspect"', () => {
    expect(summarizeActivity(run(row('c', 'Bash', { command: 'ls' }, { ok: true, output: 'a\n[exit code: 0]' }))).problems).toBe(0)
    const denied = summarizeActivity(run(row('c', 'Bash', { command: 'rm -rf /' }, { ok: false, output: 'denied: guard' })))
    expect(denied.problems).toBe(0)
    expect(denied.state).toBe('denied')
  })
  it('does not count an exit 1 that answers: grep found nothing, diff found a difference', () => {
    const grepNone = summarizeActivity(run(row('c', 'Bash', { command: 'ls tests | grep -i "g4\\|agent\\|child"' }, { ok: true, output: '[exit code: 1]' })))
    expect(grepNone.problems).toBe(0)
    expect(grepNone.state).toBe('ok')
    expect(summarizeActivity(run(row('c', 'Bash', { command: 'git diff --no-index a b 2>&1 | diff - c' }, { ok: true, output: '< x\n[exit code: 1]' }))).problems).toBe(0)
    // Exit 2 from grep is a real error; exit 1 from anything else still fails.
    expect(summarizeActivity(run(row('c', 'Bash', { command: 'grep x missing.txt' }, { ok: true, output: 'no such file\n[exit code: 2]' }))).problems).toBe(1)
    expect(summarizeActivity(run(row('c', 'Bash', { command: 'grep x a | npm test' }, { ok: true, output: '[exit code: 1]' }))).problems).toBe(1)
  })
  it('reads the program that decides the exit', () => {
    expect(finalProgram('cd x && grep -n "a\\|b" f | head; ls t | grep -i "g4|agent"')).toBe('grep')
    expect(finalProgram('npm test 2>&1')).toBe('npm')
    expect(finalProgram('FOO=1 sudo /usr/bin/diff a b')).toBe('diff')
    expect(finalProgram('grep x a; npm test')).toBe('npm')
  })
  it('still counts a tool that really failed', () => {
    expect(summarizeActivity(run(row('c', 'Read', { path: 'zz.ts' }, { ok: false, output: 'no such file' }))).problems).toBe(1)
  })
})

describe('a run keeps what the reader opened', () => {
  const Run = ({ items }: { items: ToolItem[] }) => (
    <ActivityBlock items={items}>{items.map((item) => <ToolCard key={item.call.id} item={item} />)}</ActivityBlock>
  )
  const live = (): ToolItem[] => [read('a'), read('b'), read('c'), { kind: 'tool', call: { id: 'd', name: 'Bash', args: { command: 'npm test' } }, ts: 0 }]
  const settled = (): ToolItem[] => [read('a'), read('b'), read('c'), row('d', 'Bash', { command: 'npm test' }, { ok: true, output: 'ok\n[exit code: 0]' })]

  it('stays open after the last step settles once a row inside it was opened', async () => {
    await mount(<Run items={live()} />)
    const header = host.querySelector('button')!
    expect(header.getAttribute('aria-expanded')).toBe('true')
    const first = host.querySelectorAll('button')[1] as HTMLButtonElement
    await act(async () => first.click())
    expect(first.getAttribute('aria-expanded')).toBe('true')
    await rerender(<Run items={settled()} />)
    expect(host.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[role="group"][aria-labelledby]')).not.toBeNull()
  })
  it('still folds a settled run nobody touched, and a deliberate fold wins', async () => {
    await mount(<Run items={live()} />)
    await rerender(<Run items={settled()} />)
    expect(host.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
    await rerender(<Run items={live()} />)
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(host.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('approval card', () => {
  const approval = (call: { name: string; args: Record<string, unknown> }) => [{ approvalId: 'a', call: { id: 'c', ...call } }]
  it('opens a multi-line command already showing it, so the decision is made on the text', async () => {
    await mount(<ApprovalBar approvals={approval({ name: 'Bash', args: { command: 'cd build\nrm -rf *\necho done' } })} onAnswer={() => {}} />)
    expect(host.querySelector('details')!.hasAttribute('open')).toBe(true)
    const command = host.querySelector('pre[aria-label="Command"]')!
    expect(command.textContent).toBe('cd build\nrm -rf *\necho done')
  })
  it('shows an edit as replaced and replacement text', async () => {
    await mount(<ApprovalBar approvals={approval({ name: 'Edit', args: { path: 'web/a.ts', old: 'const a = 1', new: 'const a = 2' } })} onAnswer={() => {}} />)
    expect(host.querySelector('pre[aria-label="Replaced"]')?.textContent).toBe('const a = 1')
    expect(host.querySelector('pre[aria-label="With"]')?.textContent).toBe('const a = 2')
  })
  it('keeps a short call folded, as before', async () => {
    await mount(<ApprovalBar approvals={approval({ name: 'Read', args: { path: 'src/a.ts' } })} onAnswer={() => {}} />)
    expect(host.querySelector('details')!.hasAttribute('open')).toBe(false)
    expect(host.textContent).toContain('Exact arguments')
  })
  it('clips only what it draws; copy still takes the whole payload', async () => {
    const huge = 'x'.repeat(5_000)
    await mount(<ApprovalBar approvals={approval({ name: 'Write', args: { path: 'a.txt', content: huge } })} onAnswer={() => {}} />)
    expect(host.querySelector('pre[aria-label="Content"]')!.textContent!.length).toBeLessThan(huge.length)
    expect(host.textContent).toContain('Arguments truncated for display')
    expect(host.querySelector('button[aria-label="Copy Content"]')).not.toBeNull()
  })
})

describe('a tool row is a line of text', () => {
  /** The row line: the toggle when the row opens, the bare line when it does not. */
  const lineOf = () => (host.querySelector('button[aria-expanded]') ?? host.firstElementChild!) as HTMLElement
  const words = () => lineOf().textContent!.replace(/\s+/g, ' ').trim()
  const spanWith = (text: string) => [...lineOf().querySelectorAll('span')].find((span) => span.textContent === text)

  it('names what it did and the file, and adds nothing for a clean success', async () => {
    await mount(<ToolCard item={read('a')} />)
    expect(words()).toBe('Reada.tssrc')
    expect(words()).not.toMatch(/Succeeded|lines|ms/)
  })
  it('says -ing while it runs, in a shimmer, without a spinner', async () => {
    await mount(<ToolCard item={row('c', 'Edit', { path: 'web/a.ts', old: 'a', new: 'b' })} />)
    expect(spanWith('Editing')?.className).toContain('text-shimmer')
    expect(host.querySelector('.animate-spin-slow')).toBeNull()
  })
  it('keeps the past tense for a change known to have landed, and the plain verb otherwise', async () => {
    const edit = (result: { ok: boolean; output: string }) => row('c', 'Edit', { path: 'web/a.ts', old: 'a', new: 'b' }, result)
    await mount(<ToolCard item={edit({ ok: true, output: 'edited web/a.ts' })} />)
    expect(words()).toMatch(/^Edited/)
    for (const item of [edit({ ok: false, output: 'error: old text not found' }), edit({ ok: false, output: 'denied: you declined' }), { ...edit({ ok: true, output: 'edited web/a.ts' }), recovered: true }]) {
      await rerender(<ToolCard item={item} />)
      expect(words()).toMatch(/^Edit(?!ed)/)
    }
  })
  it('shows a Skill load as the skill name, not the action', async () => {
    await mount(<ToolCard item={row('c', 'Skill', { action: 'load', name: 'systematic-debugging' }, { ok: true, output: "skill 'systematic-debugging' loaded (hash 808fc5717aa8); its instructions are included in context" })} />)
    expect(words()).toMatch(/systematic-debugging/)
    expect(words()).not.toMatch(/load/)
  })
  it('ends with a status word only when the outcome is worth a look, its reason on hover', async () => {
    await mount(<ToolCard item={row('c', 'Read', { path: 'docs/missing.md' }, { ok: false, output: 'no such file: docs/missing.md' })} />)
    expect(spanWith('Failed')?.className).toContain('text-bad')
    expect(spanWith('Failed')?.getAttribute('title')).toBe('no such file: docs/missing.md')
    await rerender(<ToolCard item={row('c', 'Bash', { command: 'npm test' }, { ok: true, output: '1 failing\n[exit code: 1]' })} />)
    expect(spanWith('Exit 1')?.className).toContain('text-bad')
    await rerender(<ToolCard item={row('c', 'Bash', { command: 'ls' }, { ok: true, output: 'a\n[exit code: 0]' })} />)
    expect(words()).toBe('Terminalls')
  })
  it('reads a refusal as denied, quiet, and never as a failure or a landed change', async () => {
    await mount(<ToolCard item={row('c', 'Edit', { path: 'web/a.ts', old: 'a', new: 'b' }, { ok: false, output: 'denied: you declined' })} />)
    expect(spanWith('Denied')?.className).not.toContain('text-bad')
    expect(spanWith('Denied')?.getAttribute('title')).toBe('you declined')
    expect(words()).not.toContain('Failed')
    expect(words()).not.toContain('+1')
  })
  it('says an outcome nobody can vouch for in words, at every width', async () => {
    await mount(<ToolCard item={{ ...row('c', 'Write', { path: 'web/a.ts', content: 'x' }, { ok: true, output: 'created web/a.ts' }), recovered: true }} />)
    expect(spanWith('Unknown')?.className).toContain('text-warn')
    expect(spanWith('Unknown')?.closest('.hidden')).toBeNull()
  })
  it('counts the lines of a change only once it landed', async () => {
    const edit = (result?: { ok: boolean; output: string }) => row('c', 'Edit', { path: 'web/a.ts', old: 'a', new: 'b\nc' }, result)
    await mount(<ToolCard item={edit()} />)
    expect(words()).not.toContain('+2')
    await rerender(<ToolCard item={edit({ ok: true, output: 'edited web/a.ts' })} />)
    expect(words()).toContain('+2')
    expect(words()).toContain('−1')
    await rerender(<ToolCard item={{ ...edit({ ok: true, output: 'edited web/a.ts' }), recovered: true }} />)
    expect(words()).not.toContain('+2')
  })
  it('hides the chevron until hover, and keeps it once open', async () => {
    await mount(<ToolCard item={row('c', 'Bash', { command: 'ls' }, { ok: true, output: 'a\n[exit code: 0]' })} />)
    const chevron = () => lineOf().lastElementChild!
    expect(chevron().getAttribute('class')).toContain('opacity-0')
    await act(async () => lineOf().click())
    expect(chevron().getAttribute('class')).toContain('rotate-90')
  })
  it('draws no box around a row: no padding, no fill, no hover background', async () => {
    await mount(<ToolCard item={row('c', 'Bash', { command: 'ls' }, { ok: true, output: 'a\n[exit code: 0]' })} />)
    expect(lineOf().className).not.toMatch(/(^|\s)(bg-|hover:bg-|px-|py-|border)/)
  })
})

describe('what an opened row shows', () => {
  const open = async () => { await act(async () => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click()) }

  it('shows a command the way a terminal does: the prompt, then what came back', async () => {
    await mount(<ToolCard item={row('c', 'Bash', { command: 'npm test' }, { ok: true, output: '1 failing\n[exit code: 1]' })} />)
    await open()
    expect(host.querySelector('pre[aria-label="Command"]')?.lastChild?.textContent).toBe('npm test')
    // The trailer is lifted out of the output into one short footer.
    expect(host.querySelector('pre[aria-label="Tool output"]')?.textContent).toBe('1 failing')
    expect(host.textContent).toContain('exit 1')
    expect(host.textContent).not.toContain('[exit code')
    // The command is the content; it is not repeated as a JSON dump.
    expect(host.querySelector('pre[aria-label="Arguments"]')).toBeNull()
  })
  it('does not repeat a clean exit, and names how a killed command ended', async () => {
    await mount(<ToolCard item={row('c', 'Bash', { command: 'ls' }, { ok: true, output: 'a\nb\n[exit code: 0]' })} />)
    await open()
    expect(host.querySelector('pre[aria-label="Tool output"]')?.textContent).toBe('a\nb')
    expect(host.textContent).not.toMatch(/exit 0|exit code/)
    await rerender(<ToolCard item={row('c', 'Bash', { command: 'sleep 99' }, { ok: true, output: 'partial\n[terminated by timeout; killed]' })} />)
    expect(host.textContent).toContain('terminated by timeout')
    expect(host.textContent).not.toContain('killed]')
  })
  it('folds a long command to three lines, the full text one click away', async () => {
    const command = `cd a && ${'echo x; '.repeat(60)}`
    await mount(<ToolCard item={row('c', 'Bash', { command }, { ok: true, output: '[exit code: 0]' })} />)
    await open()
    expect(host.querySelector('pre[aria-label="Command"]')?.className).toContain('line-clamp-3')
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show full command')!.click())
    expect(host.querySelector('pre[aria-label="Command"]')?.className).not.toContain('line-clamp-3')
    expect(host.querySelector('button[aria-label="Copy command"]')).not.toBeNull()
  })
  it('says so when a command printed nothing', async () => {
    await mount(<ToolCard item={row('c', 'Bash', { command: 'true' }, { ok: true, output: '' })} />)
    await open()
    expect(host.textContent).toContain('No output.')
  })
  /** Each diff row as `old|new|text`, the way the Git panel's gutters read it. */
  const diffRows = () => [...host.querySelectorAll('[role="group"][aria-label^="Diff of"] [data-kind]')].map((line) => {
    const [oldNo, newNo] = [...line.querySelectorAll('span[aria-hidden="true"]')].map((gutter) => gutter.textContent)
    return `${oldNo}|${newNo}|${line.lastChild?.textContent ?? ''}`
  })

  it('shows an edit the way the Git panel shows a change: numbered, in context', async () => {
    const receipt = 'edited web/lib/format.ts\n 9\texport function f() {\n10\t  const a = 2\n11\t}'
    await mount(<ToolCard item={row('c', 'Edit', { path: 'web/lib/format.ts', old: 'const a = 1', new: '  const a = 2' }, { ok: true, output: receipt })} />)
    await open()
    expect(diffRows()).toEqual(['9|9|export function f() {', '10||const a = 1', '|10|  const a = 2', '11|11|}'])
    const lines = [...host.querySelectorAll('[data-kind]')]
    expect(lines[1]!.className).toContain('bg-bad-soft text-bad')
    expect(lines[2]!.className).toContain('bg-ok-soft text-ok')
    // Same frame as the Git panel; nothing on top of the lines.
    const frame = host.querySelector('[role="group"][aria-label^="Diff of"]')!
    expect(frame.className).toContain('border-y')
    expect(frame.className).toContain('bg-muted/40')
    expect(frame.textContent).not.toContain('web/lib/format.ts')
    expect(frame.querySelector('button')).toBeNull()
  })
  it('still shows the change when the receipt cannot be lined up, with empty gutters', async () => {
    await mount(<ToolCard item={row('c', 'Edit', { path: 'web/lib/format.ts', old: 'const a = 1', new: 'const a = 2' }, { ok: true, output: 'edited web/lib/format.ts' })} />)
    await open()
    expect(diffRows()).toEqual(['||const a = 1', '||const a = 2'])
  })
  it('shows what a write wrote, all as added and numbered from the top', async () => {
    await mount(<ToolCard item={row('c', 'Write', { path: 'web/a.ts', content: 'a\nb' }, { ok: true, output: 'created web/a.ts' })} />)
    await open()
    expect(diffRows()).toEqual(['|1|a', '|2|b'])
  })
  it('does not draw a refused change as if it landed', async () => {
    await mount(<ToolCard item={row('c', 'Edit', { path: 'web/a.ts', old: 'a', new: 'b' }, { ok: false, output: 'denied: you declined' })} />)
    await open()
    expect(diffRows()).toEqual([])
    expect(host.querySelector('pre[aria-label="Tool output"]')?.textContent).toBe('denied: you declined')
  })
  it('keeps the exact arguments one click away for a generic tool', async () => {
    await mount(<ToolCard item={{ ...row('c', 'mcp__docs__search', { q: 'createProject' }, { ok: true, output: 'hit' }), server: 'docs' }} />)
    await open()
    expect(host.querySelector('pre[aria-label="Tool output"]')?.textContent).toBe('hit')
    expect(host.querySelector('pre[aria-label="Arguments"]')).toBeNull()
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'View call details')!.click())
    expect(host.querySelector('pre[aria-label="Arguments"]')?.textContent).toContain('createProject')
  })
  it('puts a warning above the output, before anything a reader might trust', async () => {
    await mount(<ToolCard item={{ ...row('c', 'Bash', { command: 'npm install' }, { ok: true, output: 'partial output' }), recovered: true }} />)
    await open()
    const body = host.querySelector('[role="group"][aria-labelledby]')!
    expect(body.innerHTML.indexOf('role="note"')).toBeGreaterThan(-1)
    expect(body.innerHTML.indexOf('role="note"')).toBeLessThan(body.innerHTML.indexOf('Tool output'))
  })
  it('opens a read in the workbench instead of the transcript, unless it failed', async () => {
    const opened = vi.fn()
    await mount(<ToolCard item={read('a')} openPath={() => opened} />)
    expect(host.querySelector('button[aria-expanded]')).toBeNull()
    await act(async () => (host.querySelector('button[title^="Open"]') as HTMLButtonElement).click())
    expect(opened).toHaveBeenCalledTimes(1)
    await rerender(<ToolCard item={row('c', 'Read', { path: 'zz.ts' }, { ok: false, output: 'no such file' })} />)
    await open()
    expect(host.querySelector('pre[aria-label="Tool output"]')?.textContent).toBe('no such file')
  })
  it('names the opened body by its own row, as a group rather than a landmark', async () => {
    await mount(<ToolCard item={row('c', 'Bash', { command: 'ls' }, { ok: true, output: 'a' })} />)
    await open()
    const head = host.querySelector('button[aria-expanded]')!
    expect(host.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBe(head.id)
    expect(host.querySelector('[role="region"]')).toBeNull()
  })
})

describe('a run reads as one line of work', () => {
  const block = (rows: ToolItem[]) => <ActivityBlock items={rows}>{rows.map((r) => <ToolCard key={r.call.id} item={r} />)}</ActivityBlock>
  const header = () => host.querySelector('button')!
  const grep = (id: string): ToolItem => row(id, 'Grep', { pattern: 'x' }, { ok: true, output: 'a.ts:1: x' })
  const bash = (id: string, output = 'ok\n[exit code: 0]'): ToolItem => row(id, 'Bash', { command: 'npm test' }, { ok: true, output })

  it('calls reading and searching Explore, counted', async () => {
    await mount(block([read('a'), grep('b'), read('c'), grep('d'), read('e')]))
    expect(header().textContent).toContain('Explore')
    expect(header().textContent).toContain('3 files, 2 searches')
  })
  it('calls a run of commands Terminal', async () => {
    await mount(block([bash('a'), bash('b'), bash('c'), bash('d')]))
    expect(header().textContent).toContain('Terminal')
    expect(header().textContent).toContain('4 commands')
  })
  it('calls a run of edits Changes, counting files and the lines they changed', async () => {
    const edit = (id: string, path: string): ToolItem => row(id, 'Edit', { path, old: 'a', new: 'b\nc' }, { ok: true, output: `edited ${path}` })
    await mount(block([edit('a', 'x.ts'), edit('b', 'x.ts'), edit('c', 'y.ts'), edit('d', 'y.ts')]))
    expect(header().textContent).toContain('Changes')
    expect(header().textContent).toContain('2 files')
    expect(header().textContent).toContain('+8')
  })
  it('folds a settled failure but says how many failed, while a refusal is only "not run"', async () => {
    await mount(block([read('a'), read('b'), bash('c', '1 failing\n[exit code: 1]'), read('d')]))
    // Settled: folded, the red count is what admits it.
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().textContent).toContain('1 failed')
    await act(async () => root!.unmount())
    host.remove()
    root = undefined
    await mount(block([read('a'), read('b'), row('c', 'Bash', { command: 'deploy' }, { ok: false, output: 'denied: guard' }), read('d')]))
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().textContent).toContain('1 not run')
    expect(header().textContent).not.toContain('failed')
  })
  it('keeps the row icons inside: every row reads on its own, rail or not', async () => {
    await mount(block([grep('a'), grep('b'), bash('c', '1 failing\n[exit code: 1]'), grep('d')]))
    await act(async () => header().click())
    const body = document.getElementById(header().getAttribute('aria-controls')!)!
    expect(body.className).toContain('border-l')
    const rows = [...body.querySelectorAll('button[aria-expanded]')]
    expect(rows.length).toBe(4)
    for (const line of rows) expect(line.firstElementChild?.tagName.toLowerCase()).toBe('svg')
  })
})

describe('a run that keeps working, counted honestly', () => {
  const Run = ({ items, turnOpen }: { items: ToolItem[]; turnOpen?: boolean }) => (
    <ActivityBlock items={items} {...(turnOpen !== undefined ? { turnOpen } : {})}>{items.map((item) => <ToolCard key={item.call.id} item={item} />)}</ActivityBlock>
  )
  const header = () => host.querySelector('button')!
  const settled = (): ToolItem[] => [read('a'), read('b'), read('c'), row('d', 'Bash', { command: 'ls' }, { ok: true, output: 'x\n[exit code: 0]' })]
  it('reads as Working and stays open between steps while its turn is open', async () => {
    await mount(<Run items={settled()} turnOpen />)
    expect(header().textContent).toContain('Working')
    expect(header().getAttribute('aria-expanded')).toBe('true')
  })
  it('folds once the turn closes', async () => {
    await mount(<Run items={settled()} turnOpen />)
    await rerender(<Run items={settled()} turnOpen={false} />)
    expect(header().textContent).toContain('Activity')
    expect(header().getAttribute('aria-expanded')).toBe('false')
  })
  it('counts files once however many windows were read', () => {
    const window = (id: string, offset: number): ToolItem => row(id, 'Read', { path: 'src/x.ts', offset, limit: 10 }, { ok: true, output: 'a' })
    const summary = summarizeActivity([window('a', 1), window('b', 20), window('c', 40), read('d')])
    expect(summary.text).toBe('2 files')
    expect(summary.steps).toBe(4)
  })
  it('counts a retrieval MCP tool as a search, an opaque one as a tool', () => {
    const mcp = (id: string, name: string): ToolItem => row(id, name, { q: 'x' }, { ok: true, output: 'a' })
    expect(summarizeActivity([mcp('a', 'mcp__codebase-retrieval__codebase-retrieval')]).text).toBe('1 search')
    expect(summarizeActivity([mcp('a', 'mcp__github__create_issue')]).text).toBe('1 tool')
  })
  it('does not fold three steps behind a summary because an audit note rode along', async () => {
    const items = [read('a'), read('b'), read('c'), { kind: 'audit' as const, icon: 'allow' as const, text: 'Allowed · Read' }]
    await mount(<ActivityBlock items={items}>{items.map((item, index) => <span key={index}>row</span>)}</ActivityBlock>)
    expect(host.querySelector('button[aria-expanded]')).toBeNull()
  })
})

describe('todowrite rows', () => {
  const todos = [
    { content: 'A', status: 'completed', activeForm: 'Doing a' },
    { content: 'B', status: 'completed', activeForm: 'Doing b' },
    { content: 'C', status: 'in_progress', activeForm: 'Doing c' },
    { content: 'D', status: 'pending', activeForm: 'Doing d' },
  ]

  it('targets the task count and digests progress', () => {
    const running = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, undefined)
    expect(running.target).toBe('4 tasks')
    expect(running.digest).toBeUndefined()

    const done = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, { ok: true, output: 'Todo list updated: 4 tasks (2 completed, 1 in progress, 1 pending)' })
    expect(done.target).toBe('4 tasks')
    expect(done.digest).toBe('2 done · 1 in progress')
  })

  it('keeps the failure excerpt on a failed call', () => {
    const failed = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, { ok: false, output: 'error: every todo needs non-empty …' })
    expect(failed.digestFailed).toBe(true)
  })
})

describe('agent wait rows', () => {
  it('says how many waits a folded row stands for and what the newest one came back with', async () => {
    const output = JSON.stringify({ children: [{ status: 'running' }], note: 'still running after the timeout; call wait again' })
    await mount(<ToolCard item={row('w', 'Agent', { action: 'wait' }, { ok: true, output })} repeats={9} />)
    const text = host.querySelector('button')?.textContent ?? ''
    expect(text).toContain('wait · 9 times')
    expect(text).toContain('1 running')
  })
  it('counts a spawn as an agent and waits as waits in a run summary', () => {
    const summary = summarizeActivity([
      row('s', 'Agent', { action: 'spawn', definition: 'reviewer' }, { ok: true, output: '{"status":"running"}' }),
      row('w1', 'Agent', { action: 'wait' }, { ok: true, output: '{"children":[]}' }),
      row('w2', 'Agent', { action: 'wait' }, { ok: true, output: '{"children":[]}' }),
      row('l', 'Agent', { action: 'list' }, { ok: true, output: '{"children":[]}' }),
    ])
    expect(summary.text).toBe('1 agent, 2 waits, 1 tool')
  })
})
