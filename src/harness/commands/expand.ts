/**
 * Claude Code prompt-template expansion, ported from Claude Code 2.1.293 so a
 * command or skill body expands here exactly as it does there:
 *
 *   - argument substitution: named `arguments`, `$ARGUMENTS[n]`, `$n`
 *     (0-based), `$ARGUMENTS`; `\$` escapes a placeholder; with no
 *     placeholder and non-empty arguments, `\n\nARGUMENTS: <args>` is appended;
 *   - `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` / `${CLAUDE_PROJECT_DIR}`
 *     / `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`;
 *   - inline shell: `` !`cmd` `` (at line start or after whitespace, not
 *     inside an ordinary code span) and fenced ```` ```! ```` blocks.
 *
 * Pure string work; running the shell markers is the caller's job
 * ({@link findInlineShell} + {@link replaceInlineShell}).
 */

/** Placeholder sentinels (private-use code points, as Claude). */
const DOLLAR = '\uFFFF'
const GUARD = '\uFFFE'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Shell-style split of an argument string: whitespace separates, single and
 * double quotes group, backslash escapes outside single quotes. Falls back to
 * a plain whitespace split when quoting is unbalanced (as Claude does when its
 * parser gives up).
 */
export function splitArguments(raw: string): string[] {
  if (raw.trim() === '') return []
  const out: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] as string
    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && index + 1 < raw.length && /["\\$`]/.test(raw[index + 1] as string)) current += raw[++index]
      else current += char
      continue
    }
    if (/\s/.test(char)) {
      if (started) out.push(current)
      current = ''
      started = false
      continue
    }
    started = true
    if (char === "'" || char === '"') quote = char
    else if (char === '\\' && index + 1 < raw.length) current += raw[++index]
    else current += char
  }
  if (quote !== undefined) return raw.split(/\s+/).filter((part) => part !== '')
  if (started) out.push(current)
  return out
}

/** `arguments:` frontmatter → names (string split on whitespace or a list); numeric names are dropped. */
export function argumentNames(value: unknown): string[] {
  const keep = (name: unknown): name is string => typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name)
  if (Array.isArray(value)) return value.filter(keep)
  if (typeof value === 'string') return value.split(/\s+/).filter(keep)
  return []
}

/**
 * Claude's argument substitution. `appendWhenUnused` mirrors Claude's flag
 * (on for commands and skills): arguments a body never references still
 * reach the model on an `ARGUMENTS:` line.
 */
export function substituteArguments(
  body: string,
  args: string | undefined,
  names: readonly string[] = [],
  appendWhenUnused = true,
  transform?: (value: string) => string,
): string {
  if (args === undefined) return body
  let text = body.replaceAll(DOLLAR, '\uFFFD').replaceAll(GUARD, '\uFFFD')
  const wrap = (value: string | undefined): string => {
    const clean = (value ?? '').replaceAll(DOLLAR, '\uFFFD').replaceAll(GUARD, '\uFFFD')
    return GUARD + (transform !== undefined ? transform(clean) : clean).replaceAll('$', DOLLAR) + GUARD
  }
  const parts = splitArguments(args)
  const named = names
    .map((name, index) => ({ name, index }))
    .filter((entry) => entry.name !== '')
    .sort((a, b) => b.name.length - a.name.length)
  const escapable = ['\\d', 'ARGUMENTS', ...named.map(({ name }) => `${escapeRegExp(name)}(?![\\[\\w])`)].join('|')
  text = text.replace(new RegExp(`(?<!\\\\)\\\\\\$(?=${escapable})`, 'g'), DOLLAR)
  let used = false
  for (const { name, index } of named) {
    text = text.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'), () => { used = true; return wrap(parts[index]) })
  }
  text = text.replace(/\$ARGUMENTS\[(\d+)\]/g, (match: string, digits: string) => {
    const value = parts[Number.parseInt(digits, 10)]
    if (value === undefined) return DOLLAR + match.slice(1)
    used = true
    return wrap(value)
  })
  text = text.replace(/\$(\d+)(?!\w)/g, (match: string, digits: string) => {
    const value = parts[Number.parseInt(digits, 10)]
    if (value === undefined) return match
    used = true
    return wrap(value)
  })
  text = text.replaceAll('$ARGUMENTS', () => { used = true; return wrap(args) })
  if (!used && appendWhenUnused && args !== '') text = `${text}\n\nARGUMENTS: ${wrap(args)}`
  return text.replaceAll(DOLLAR, '$').replaceAll(GUARD, '')
}

export interface TemplateVariables {
  readonly pluginRoot?: string
  readonly pluginData?: string
  readonly projectDir?: string
  readonly skillDir?: string
  readonly sessionId?: string
}

/** `${CLAUDE_*}` variables; an unknown value leaves its placeholder as written. */
export function substituteVariables(text: string, vars: TemplateVariables): string {
  let out = text
  if (vars.pluginRoot !== undefined) out = out.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => vars.pluginRoot as string)
  if (vars.projectDir !== undefined) out = out.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => vars.projectDir as string)
  if (vars.pluginData !== undefined) out = out.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => vars.pluginData as string)
  if (vars.skillDir !== undefined) out = out.replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => vars.skillDir as string)
  if (vars.sessionId !== undefined) out = out.replace(/\$\{CLAUDE_SESSION_ID\}/g, () => vars.sessionId as string)
  return out
}

const FENCED_SHELL = /```!\s*\n?([\s\S]*?)\n?```/g
const INLINE_SHELL = /(?<=^|\s)!`([^`]+)`/gm

/** Blank ordinary code spans (`` `x` ``) so an example `` !`cmd` `` inside one is not run. */
function maskCodeSpans(text: string): string {
  return text.replace(/`[^`\n]+`/g, (span: string, offset: number) => {
    const before = text[offset - 1]
    return before === '!' || before === '`' ? span : `\`${' '.repeat(span.length - 2)}\``
  })
}

export interface InlineShell {
  /** The exact marker text to replace. */
  readonly raw: string
  readonly command: string
  readonly at: number
}

/** Every inline shell marker, fenced blocks first (Claude's order). */
export function findInlineShell(text: string): InlineShell[] {
  const found: InlineShell[] = []
  const inline = text.includes('!`') ? [...maskCodeSpans(text).matchAll(INLINE_SHELL)] : []
  for (const match of [...text.matchAll(FENCED_SHELL), ...inline]) {
    const command = (match[1] ?? '').trim().replaceAll('\r\n', '\n')
    // A masked match came from the masked copy: take the raw text from the
    // original at the same offset (masking never changes lengths).
    const raw = text.slice(match.index, match.index + match[0].length)
    if (command !== '') found.push({ raw, command, at: match.index })
  }
  return found
}

/**
 * Replace each marker with its output at the marker's own offset (`at`),
 * last first so earlier offsets stay valid. Never a text search: an example
 * inside a code span or one marker's output is never mistaken for another.
 */
export function replaceInlineShell(text: string, outputs: readonly { readonly at: number; readonly raw: string; readonly output: string }[]): string {
  let out = text
  for (const { at, raw, output } of [...outputs].sort((a, b) => b.at - a.at)) {
    if (out.slice(at, at + raw.length) !== raw) continue
    out = out.slice(0, at) + output + out.slice(at + raw.length)
  }
  return out
}

/**
 * Text substituted into a body (arguments) must not smuggle new inline-shell
 * markers. Claude neutralizes `!` next to backticks in argument values; this
 * is that function.
 */
export function neutralizeShellMarkers(value: string): string {
  // A leading backtick could complete a `!` written in the body just before
  // the placeholder (`!$ARGUMENTS` + `` `id` ``): escape it too.
  return value.replace(/`!/g, '` !').replace(/!`/g, '! `').replace(/(^|\s)!/gm, '$1\\!').replace(/^`/, '\\`')
}

/** First non-empty body line as a description (heading marks stripped, ≤ 100 chars), as Claude. */
export function descriptionFromBody(body: string, fallback: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const text = /^#+\s+(\S.*)$/.exec(trimmed)?.[1] ?? trimmed
    return text.length > 100 ? `${text.slice(0, 97)}...` : text
  }
  return fallback
}
