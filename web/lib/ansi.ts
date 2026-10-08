/**
 * Tool output often arrives carrying ANSI escape codes - the Bash tool runs
 * commands with `FORCE_COLOR=1`, so a test runner's green check or a diff's
 * red can survive into the transcript. This renders those codes as HTML in the
 * terminal panel's own palette; every other byte is escaped, so raw tool text
 * can never become markup. Unrecognised escapes are dropped, not shown.
 *
 * One exported converter and the palette it names: `ansiToHtml` for the
 * transcript's dark well (`TerminalPanel`), `stripAnsi` for consumers that
 * must stay plain (copy text, length checks, the model-visible projection).
 */

import type { LineLinker, LinkRange } from './path-links.ts'

const ESC = '\u001b'

const FG: Readonly<Record<number, string>> = {
  30: '#666666', 31: '#f14c4c', 32: '#4ade9a', 33: '#f5b84a',
  34: '#7cb4ff', 35: '#f38fc0', 36: '#5fd4d4', 37: '#d6d6d6',
  90: '#8f8f8f', 91: '#ff7b7b', 92: '#7ee7b0', 93: '#ffd07a',
  94: '#9cc7ff', 95: '#ffb3da', 96: '#8fe3e3', 97: '#ffffff',
}
const BG: Readonly<Record<number, string>> = {
  40: '#2d2d2d', 41: '#5a2323', 42: '#1f4d38', 43: '#57431c',
  44: '#23364f', 45: '#4d2438', 46: '#1f4d4d', 47: '#3d3d3d',
}

const STYLES: Readonly<Record<number, string>> = { 1: 'font-weight:600', 2: 'opacity:.7', 3: 'font-style:italic', 4: 'text-decoration:underline', 9: 'text-decoration:line-through' }

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The style state one SGR sequence leaves behind. Each field stays undefined
 * until a code sets it; 39/49 fall back to the panel's own colour. The
 * fields are typed `string | undefined` rather than optional so an SGR reset
 * can assign `undefined` under `exactOptionalPropertyTypes`.
 */
interface SgrState {
  fg: string | undefined
  bg: string | undefined
  weight: string | undefined
  slant: string | undefined
  line: string | undefined
  opacity: string | undefined
}

const EMPTY_STATE: Readonly<SgrState> = { fg: undefined, bg: undefined, weight: undefined, slant: undefined, line: undefined, opacity: undefined }

function applyCodes(codes: readonly number[], state: SgrState): SgrState {
  let next = state
  const set = (patch: Partial<SgrState>): void => { next = { ...next, ...patch } }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!
    if (code === 0) { next = EMPTY_STATE; continue }
    if (code === 39) { set({ fg: undefined }); continue }
    if (code === 49) { set({ bg: undefined }); continue }
    if (code === 22) { set({ weight: undefined, opacity: undefined }); continue }
    if (code === 23) { set({ slant: undefined }); continue }
    if (code === 24) { set({ line: undefined }); continue }
    if (code === 29) { set({ line: undefined }); continue }
    const style = STYLES[code]
    if (style !== undefined) {
      const declarations: string[] = [style]
      // A 39 already cleared the colour, so re-applying the old one is wrong;
      // underline keeps whatever colour the run has.
      if (style.includes('underline') || style.includes('line-through')) set({ line: style })
      if (code === 1) set({ weight: style })
      if (code === 2) set({ opacity: style })
      if (code === 3) set({ slant: style })
      continue
    }
    const fg = FG[code]
    if (fg !== undefined) { set({ fg }); continue }
    const bg = BG[code]
    if (bg !== undefined) { set({ bg }); continue }
    // 256-colour (38;5;n) and truecolor (38;2;r;g;b) foregrounds.
    if ((code === 38 || code === 48) && i + 1 < codes.length) {
      const mode = codes[i + 1]!
      if (mode === 5 && i + 2 < codes.length) {
        const shade = codes[i + 2]!
        const color = FG[shade] ?? default256(shade)
        if (code === 38) set({ fg: color }); else set({ bg: color })
        i += 2
        continue
      }
      if (mode === 2 && i + 4 < codes.length) {
        const [r, g, b] = [codes[i + 2]!, codes[i + 3]!, codes[i + 4]!]
        const color = `rgb(${r},${g},${b})`
        if (code === 38) set({ fg: color }); else set({ bg: color })
        i += 4
        continue
      }
    }
  }
  return next
}

/** The xterm-256 palette's 6x6x6 cube and greys as CSS values. */
function default256(shade: number): string {
  if (shade < 16) {
    const base = ['#000000', '#7f0000', '#007f00', '#7f7f00', '#00007f', '#7f007f', '#007f7f', '#c0c0c0', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff']
    return base[shade] ?? '#d6d6d6'
  }
  if (shade < 232) {
    const steps = [0, 95, 135, 175, 215, 255]
    const n = shade - 16
    const r = steps[Math.floor(n / 36)] ?? 0
    const g = steps[Math.floor((n % 36) / 6)] ?? 0
    const b = steps[n % 6] ?? 0
    return `rgb(${r},${g},${b})`
  }
  const grey = 8 + (shade - 232) * 10
  return `rgb(${grey},${grey},${grey})`
}

const styleOf = (state: Readonly<SgrState>): string => {
  const parts = [
    state.fg !== undefined ? `color:${state.fg}` : undefined,
    state.bg !== undefined ? `background-color:${state.bg}` : undefined,
    state.weight,
    state.slant,
    state.opacity,
    state.line,
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? '' : ` style="${parts.join(';')}"`
}

interface Token {
  readonly text: string
  readonly state: Readonly<SgrState>
}

/** One ANSI run per line, so a `<span>` never crosses a newline in a `<pre>`. */
function tokenizeLine(line: string, start: Readonly<SgrState>): readonly Token[] {
  const tokens: Token[] = []
  let state: SgrState = { ...start }
  let text = ''
  let index = 0
  const flush = (): void => {
    if (text !== '') tokens.push({ text, state: EMPTY_STATE === state ? EMPTY_STATE : state })
    text = ''
  }
  while (index < line.length) {
    const char = line[index]!
    if (char === ESC && line[index + 1] === '[') {
      const terminator = line.indexOf('m', index + 2)
      if (terminator !== -1) {
        const body = line.slice(index + 2, terminator)
        if (/^[0-9;]*$/.test(body)) {
          flush()
          state = applyCodes(body === '' ? [0] : body.split(';').map(Number), state)
          index = terminator + 1
          continue
        }
      }
      // CSI with another final byte (cursor moves, colours a terminal owns):
      // swallow it whole rather than leak a partial sequence into the text.
      const finalMatch = /^[0-?]*[ -/]*[@-~]/.exec(line.slice(index + 2))
      if (finalMatch !== null) {
        index += 2 + finalMatch[0].length
        continue
      }
    }
    // OSC sequences (window title, hyperlinks) run to BEL or ST; without a
    // terminator they would smear the rest of the line.
    if (char === ESC && line[index + 1] === ']') {
      const bel = line.indexOf('\u0007', index + 2)
      const st = line.indexOf(`${ESC}\\`, index + 2)
      if (bel !== -1 && (st === -1 || bel < st)) { index = bel + 1; continue }
      if (st !== -1) { index = st + 2; continue }
    }
    text += char
    index += 1
  }
  flush()
  return tokens
}

/** Attribute marking a rendered file link; its value is the path, `data-line` the line. */
export const PATH_LINK_ATTR = 'data-open-path'

const escapeAttr = (text: string): string => escapeHtml(text).replaceAll('"', '&quot;')

function renderLine(tokens: readonly Token[], ranges: readonly LinkRange[]): string {
  if (ranges.length === 0) return tokens.map((token) => `<span${styleOf(token.state)}>${escapeHtml(token.text)}</span>`).join('')
  // Split every token at the link boundaries so an anchor only ever wraps
  // whole spans: `<button><span>…</span><span>…</span></button>`.
  const cuts = new Set<number>(ranges.flatMap((range) => [range.start, range.end]))
  const out: string[] = []
  let position = 0
  let open: LinkRange | undefined
  for (const token of tokens) {
    let rest = token.text
    while (rest !== '') {
      const range = ranges.find((candidate) => position >= candidate.start && position < candidate.end)
      if (open !== undefined && open !== range) { out.push('</button>'); open = undefined }
      if (range !== undefined && open === undefined) {
        const line = range.ref.line !== undefined ? ` data-line="${range.ref.line}"` : ''
        out.push(`<button type="button" class="path-link" ${PATH_LINK_ATTR}="${escapeAttr(range.ref.path)}"${line} title="Open ${escapeAttr(range.ref.path)} in workbench">`)
        open = range
      }
      let length = rest.length
      for (const cut of cuts) if (cut > position && cut - position < length) length = cut - position
      out.push(`<span${styleOf(token.state)}>${escapeHtml(rest.slice(0, length))}</span>`)
      rest = rest.slice(length)
      position += length
    }
  }
  if (open !== undefined) out.push('</button>')
  return out.join('')
}

/**
 * Tool output with ANSI codes rendered as safe HTML, colours as spans. With
 * `link`, the ranges it finds in each line's visible text (escapes already
 * removed) become `<button data-open-path>` elements the caller handles by
 * delegation.
 */
export function ansiToHtml(output: string, link?: LineLinker): string {
  const lines = output.split('\n')
  const state: SgrState = { ...EMPTY_STATE }
  const rendered: string[] = []
  for (const line of lines) {
    const tokens = tokenizeLine(line, state)
    // SGR state does not reset at a newline; carry it into the next line.
    const last = tokens.at(-1)
    const closing = last !== undefined ? last.state : state
    if (Object.keys(closing).length > 0) Object.assign(state, closing)
    else for (const key of Object.keys(state) as (keyof SgrState)[]) delete state[key]
    const ranges = link !== undefined ? link(tokens.map((token) => token.text).join('')) : []
    rendered.push(renderLine(tokens, ranges))
  }
  return rendered.join('\n')
}

/** Tool output without any escape sequence, for copy text and length counts. */
export function stripAnsi(output: string): string {
  return output
    // OSC first (they may contain ESC inside), then CSI runs.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
}
