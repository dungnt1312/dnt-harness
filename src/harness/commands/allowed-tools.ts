/**
 * Claude permission-rule matching for a command's `allowed-tools`.
 *
 * A rule is `Tool` (every call of that tool) or `Tool(specifier)`. For Bash
 * the specifier is the command: `git:*` / `git status:*` (legacy prefix, a
 * word boundary after it), a glob with `*` (`npm run *`), or an exact
 * command. A compound command (`a && b`, `a; b`, `a | b`) matches only when
 * every part matches, as in Claude. For file tools the specifier is a glob
 * over the path. Claude tool names are mapped to dnt-harness tools
 * (`MultiEdit` → `Edit`, …); names without an equivalent never match.
 *
 * Matching only ever lifts a policy `ask` for the turn a command started;
 * the caller keeps every deny, guard and path question.
 */
import { normalizeTool } from '../agents/definition-service.ts'

export interface AllowRule {
  readonly tool: string
  readonly specifier?: string
}

export function parseAllowRule(raw: string): AllowRule | undefined {
  const match = /^([^()]+?)(?:\((.*)\))?$/.exec(raw.trim())
  if (match === null) return undefined
  const base = (match[1] ?? '').trim()
  if (base === '*') return { tool: '*' }
  const { tool } = normalizeTool(base)
  if (tool === undefined) return undefined
  const specifier = match[2]?.trim()
  return specifier !== undefined && specifier !== '' && specifier !== '*' ? { tool, specifier } : { tool }
}

/** Split a shell command on `&&`, `||`, `;`, `|` and newlines outside quotes. */
export function splitCompound(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && index + 1 < command.length) current += command[++index]
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === '\\' && index + 1 < command.length) { current += char + command[++index]; continue }
    const two = command.slice(index, index + 2)
    if (two === '&&' || two === '||') { parts.push(current); current = ''; index += 1; continue }
    if (char === ';' || char === '|' || char === '\n') { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^]*').replace(/\u0000/g, '[^]*')
  return new RegExp(`^${escaped}$`)
}

/** Path glob: `*` stays inside one segment, `**` crosses segments. */
function pathGlobToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Shell syntax that can run or redirect something the prefix does not name:
 * command substitution (`$(…)`, backticks, `${…}`), process substitution,
 * a single `&` (background + next command) and redirects. A prefix/glob rule
 * never covers such a command — the call keeps its normal `ask`.
 */
export function hasUncoveredShellSyntax(command: string): boolean {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string
    const next = command[index + 1]
    if (quote === "'") { if (char === "'") quote = undefined; continue }
    if (char === '\\') { index += 1; continue }
    // Substitutions stay live inside double quotes.
    if (char === '`' || (char === '$' && (next === '(' || next === '{'))) return true
    if (quote === '"') { if (char === '"') quote = undefined; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    // Redirects and process substitution `<(…)` / `>(…)`.
    if (char === '<' || char === '>') return true
    if (char === '&' && next !== '&' && command[index - 1] !== '&') return true
  }
  return false
}

function bashPartMatches(part: string, specifier: string): boolean {
  const command = part.replace(/\s+/g, ' ').trim()
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2).trim()
    return command === prefix || command.startsWith(`${prefix} `)
  }
  if (specifier.includes('*')) {
    // `git *` also admits a bare `git`, as Claude's trailing-wildcard rule does.
    if (specifier.endsWith(' *') && command === specifier.slice(0, -2).trim()) return true
    return globToRegExp(specifier).test(command)
  }
  return command === specifier.trim()
}

/**
 * A file-tool target as a normalized project-relative path, or undefined
 * when it cannot be matched safely (`..` segments, outside `baseDir`).
 */
function relativeTarget(target: string, baseDir: string | undefined): string | undefined {
  const posix = target.replace(/\\/g, '/')
  if (posix.split('/').includes('..')) return undefined
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) {
    if (baseDir === undefined) return undefined
    const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!posix.startsWith(`${base}/`)) return undefined
    return posix.slice(base.length + 1)
  }
  return posix.replace(/^\.\//, '')
}

/**
 * Whether one call is covered by the rules. `args` uses dnt-harness argument
 * names; `baseDir` (the project folder) relativizes absolute file paths.
 */
export function allowedByRules(rules: readonly string[], call: { readonly name: string; readonly args: Readonly<Record<string, unknown>> }, baseDir?: string): boolean {
  for (const raw of rules) {
    const rule = parseAllowRule(raw)
    if (rule === undefined) continue
    if (rule.tool === '*') return true
    if (rule.tool !== call.name) continue
    if (rule.specifier === undefined) return true
    if (call.name === 'Bash') {
      const command = typeof call.args['command'] === 'string' ? call.args['command'] : ''
      if (hasUncoveredShellSyntax(command)) continue
      const parts = splitCompound(command)
      if (parts.length > 0 && parts.every((part) => bashPartMatches(part, rule.specifier as string))) return true
      continue
    }
    const target = ['path', 'file_path', 'pattern', 'url']
      .map((key) => call.args[key])
      .find((value): value is string => typeof value === 'string')
    if (target === undefined) continue
    const relative = relativeTarget(target, baseDir)
    if (relative !== undefined && pathGlobToRegExp(rule.specifier.replace(/^\.\//, '')).test(relative)) return true
  }
  return false
}
