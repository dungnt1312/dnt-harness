/**
 * Dev-only gallery: every tool-row state rendered by the real components, so
 * a screenshot shows what ships rather than a drawing of it. Not part of the
 * app bundle — Vite builds only `index.html`.
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '../styles/app.css'
import '../styles/markdown.css'
import '../styles/motion.css'
import { ActivityBlock, DelegationCard, StatusLine, ToolCard } from '../components/chat/MessageParts.tsx'
import type { ViewItem } from '../lib/project.ts'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>

const NOW = Date.now()
let next = 0
function tool(name: string, args: Record<string, unknown>, result?: { ok: boolean; output: string }, ms = 12, extra: Partial<ToolItem> = {}): ToolItem {
  next += 1
  return {
    kind: 'tool',
    call: { id: `c${next}`, name, args },
    ts: result === undefined ? NOW - ms : NOW - 60_000,
    ...(result !== undefined ? { result, doneAt: NOW - 60_000 + ms } : {}),
    ...extra,
  }
}

const READ_OUT = Array.from({ length: 61 }, (_, i) => `${i === 0 ? "import { formatBytes, shortPath } from './format.ts'" : `  const line${i + 100} = compute(${i})`}`).join('\n')
const GREP_OUT = 'src/web/server.ts:412: const createProject = async (input) => {\nsrc/web/server.ts:980:   await createProject(body)\nsrc/harness/workspace/projects.ts:88: export function createProject(root: string) {'
/** What `Edit` returns: a receipt line, then the edited region numbered like Read. */
const EDIT_RECEIPT = [
  'edited web/lib/format.ts',
  '39\t/** Elapsed time, short. */',
  '40\texport function formatElapsed(ms: number): string {',
  '41\t  const a = 2',
  '42\t  const b = 3',
  "43\t  if (Number.isNaN(ms)) return ''",
  '44\t  const span = Math.max(0, ms)',
].join('\n')

/** The long one-liner from the screenshot that made the terminal panel unreadable. */
const LONG_COMMAND = String.raw`cd C:/Users/DungNguyen/workspace/mini-dsh && curl -s -o /dev/null -w "vite %{http_code}\n" --max-time 3 http://127.0.0.1:4176/dev/toolcard-gallery.html; rm -f /tmp/m4.log; (nohup sh -c 'node scripts/measure-toolcards.mjs http://127.0.0.1:4176 > /tmp/m4.log 2>&1; echo "exit $?" >> /tmp/m4.log' >/dev/null 2>&1 &); for i in $(seq 1 26); do grep -q "^exit" /tmp/m4.log && break; sleep 1; done`
const LONG_OUTPUT = ['vite 200', "  name: 'Error'", 'exit 1', '', '[exit code: 0]'].join('\n')

const rows: Array<{ label: string; item: ToolItem }> = [
  { label: 'Read — running', item: tool('Read', { path: 'src/harness/tools/service.ts', offset: 100, limit: 61 }, undefined, 3_200) },
  { label: 'Read — ok', item: tool('Read', { path: 'src/harness/tools/service.ts', offset: 100, limit: 61 }, { ok: true, output: READ_OUT }) },
  { label: 'Read — failed', item: tool('Read', { path: 'docs/missing.md' }, { ok: false, output: 'no such file: docs/missing.md\ncheck the path' }, 5) },
  { label: 'Write — created', item: tool('Write', { path: 'web/lib/new-helper.ts', content: 'export const a = 1\n' }, { ok: true, output: 'created web/lib/new-helper.ts' }, 5) },
  { label: 'Edit — ok', item: tool('Edit', { path: 'web/lib/format.ts', old: '  const a = 1', new: '  const a = 2\n  const b = 3' }, { ok: true, output: EDIT_RECEIPT }) },
  { label: 'Edit — denied', item: tool('Edit', { path: 'web/lib/format.ts', old: 'a', new: 'b' }, { ok: false, output: 'denied: you declined' }, 5) },
  { label: 'Glob — ok', item: tool('Glob', { pattern: '**/*.ts', path: 'src' }, { ok: true, output: 'src/a.ts\nsrc/b.ts\nsrc/c.ts' }, 8) },
  { label: 'Grep — ok', item: tool('Grep', { pattern: 'createProject', path: 'src' }, { ok: true, output: GREP_OUT }, 9) },
  { label: 'Grep — no matches', item: tool('Grep', { pattern: 'zzz' }, { ok: true, output: 'no matches' }, 9) },
  { label: 'Bash — exit 0', item: tool('Bash', { command: 'npm test -- tools' }, { ok: true, output: ' ✓ 35 passed\n[exit code: 0]' }, 1_200) },
  { label: 'Bash — exit 1', item: tool('Bash', { command: 'npm test -- tools' }, { ok: true, output: '1 failing\n  AssertionError: expected 2 to be 3\n[exit code: 1]' }, 1_200) },
  { label: 'Bash — denied', item: tool('Bash', { command: 'deploy prod' }, { ok: false, output: 'denied: blocked by Dangerous Commands: matched fsDestructive — matched FS Destructive' }, 2) },
  { label: 'Bash — long command', item: tool('Bash', { command: LONG_COMMAND }, { ok: true, output: LONG_OUTPUT }, 2_400) },
  { label: 'Bash — running', item: tool('Bash', { command: 'npm run build' }, undefined, 41_000) },
  { label: 'Skill — ok', item: tool('Skill', { name: 'ak-brainstorm' }, { ok: true, output: "skill 'ak-brainstorm' loaded (hash 2f48a941d7ec); its instructions are included in context" }, 3) },
  { label: 'Agent — spawn', item: tool('Agent', { action: 'spawn', definition: 'explorer', prompt: 'find x' }, { ok: true, output: '{"status":"running","childId":"c-1"}' }, 4) },
  { label: 'MemorySearch', item: tool('MemorySearch', { query: 'deploy notes' }, { ok: true, output: 'a [pinned] A\nb [loose] B' }, 11) },
  { label: 'MCP — ok', item: tool('mcp__linear__create_issue', { title: 'Fix the row', team: 'ENG' }, { ok: true, output: 'created ENG-42' }, 400, { server: 'linear' }) },
  { label: 'Bash — recovered', item: tool('Bash', { command: 'npm install' }, { ok: true, output: 'partial output' }, 0, { recovered: true }) },
  { label: 'MCP — indeterminate', item: tool('mcp__linear__create_issue', { title: 'Fix the row' }, { ok: true, output: 'timeout' }, 30_000, { server: 'linear', outcome: 'indeterminate', invocationId: 'inv-7' } as Partial<ToolItem>) },
]

const delegation: Extract<ViewItem, { kind: 'delegation' }> = { kind: 'delegation', childSessionId: 'child-1', definition: 'explorer', brief: 'Find where tool cards are rendered and report the file list.', status: 'running' }

const runOk = [rows[1]!.item, rows[6]!.item, rows[7]!.item, rows[9]!.item, rows[4]!.item]
const runDenied = [rows[1]!.item, rows[6]!.item, rows[11]!.item, rows[9]!.item]
const runFailed = [rows[1]!.item, rows[2]!.item, rows[7]!.item, rows[10]!.item]

function Block({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <section data-shot={id} className="flex flex-col gap-2 py-4">
      <h2 className="m-0 text-xs font-medium uppercase tracking-wide text-fg-faint">{title}</h2>
      {children}
    </section>
  )
}

function Gallery() {
  return (
    <main className="mx-auto w-full max-w-[768px] px-4 text-fg">
      <Block id="rows" title="Closed rows">
        <div className="flex flex-col gap-0.5">
          {rows.map(({ label, item }) => <div key={label} data-label={label}><ToolCard item={item} /></div>)}
          <DelegationCard item={delegation} />
        </div>
      </Block>
      <Block id="runs" title="Runs (4+ rows)">
        <ActivityBlock items={runOk}>{runOk.map((item) => <ToolCard key={item.call.id} item={item} />)}</ActivityBlock>
        <ActivityBlock items={runDenied}>{runDenied.map((item) => <ToolCard key={item.call.id} item={item} />)}</ActivityBlock>
        <ActivityBlock items={runFailed}>{runFailed.map((item) => <ToolCard key={item.call.id} item={item} />)}</ActivityBlock>
      </Block>
      <Block id="status" title="Status lines">
        <div className="flex flex-col gap-1">
          <StatusLine reason="interrupted" />
          <StatusLine reason="provider: zcode: gateway error: The operation was aborted due to timeout" onRetry={() => {}} />
          <StatusLine reason="provider: cliproxy: gateway error: upstream stream stayed inactive for 120s mid-reasoning; the harness recorded no content for this turn and the request was not billed" onRetry={() => {}} />
        </div>
      </Block>
      {(['Bash — exit 1', 'Bash — long command', 'Read — ok', 'Edit — ok', 'Grep — ok', 'Bash — running', 'Bash — recovered'] as const).map((label) => {
        const found = rows.find((row) => row.label === label)!
        return (
          <Block key={label} id={`open-${label}`} title={`Open: ${label}`}>
            <div data-expand><ToolCard item={found.item} /></div>
          </Block>
        )
      })}
    </main>
  )
}

const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
createRoot(document.getElementById('root')!).render(<StrictMode><Gallery /></StrictMode>)
