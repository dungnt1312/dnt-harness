/**
 * Claude Code custom slash commands: `*.md` files under a `commands/` folder
 * (and Claude's legacy skill-in-commands layout, a folder holding SKILL.md).
 * Subfolders namespace the name with `:` (`git/commit.md` → `git:commit`),
 * plugin commands carry their plugin's prefix (`plugin:cmd`).
 *
 * Layers, later wins by name: user (`~/.claude/commands`) < plugin <
 * workspace (`<data>/workspaces/<ws>/commands`) < project
 * (`<project>/.claude/commands`, then each ancestor's, nearest wins).
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { argumentNames, descriptionFromBody } from './expand.ts'

export type CommandSource = 'user' | 'plugin' | 'workspace' | 'project' | 'bundled'

/** Claude caps one command file at 1 MiB. */
export const MAX_COMMAND_BYTES = 1_048_576

/** Frontmatter keys dnt-harness enforces. */
const ENFORCED = new Set([
  'name', 'description', 'argument-hint', 'arguments', 'allowed-tools', 'model',
  'disable-model-invocation', 'user-invocable',
])
/** Claude keys recognized but not enforced: reported as notes. */
const RECOGNIZED = new Set([
  'context', 'agent', 'effort', 'hooks', 'shell', 'version', 'when_to_use', 'when-to-use',
  'disallowed-tools', 'disallowedTools', 'background', 'metadata', 'paths', 'license', 'title',
])

export interface CommandDefinition {
  /** Full invocation name, without the slash (`git:commit`, `plugin:cmd`). */
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly argumentNames: readonly string[]
  /** Claude permission rules (`Read`, `Bash(git:*)`), as written. */
  readonly allowedTools: readonly string[]
  readonly model?: string
  readonly disableModelInvocation: boolean
  readonly userInvocable: boolean
  readonly body: string
  readonly source: CommandSource
  readonly path: string
  readonly hash: string
  /** Set for a SKILL.md command: the "Base directory for this skill" line. */
  readonly skillDir?: string
  /** Plugin identity and roots, for plugin commands. */
  readonly plugin?: { readonly id: string; readonly name: string; readonly root: string; readonly data?: string }
  readonly notes?: readonly string[]
}

export interface ParsedFrontmatter {
  readonly frontmatter: Record<string, unknown>
  readonly body: string
  readonly error?: string
}

/** YAML frontmatter, leniently: an unparsable block is ignored with an error note (as Claude). */
export function splitFrontmatter(raw: string): ParsedFrontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (match === null) return { frontmatter: {}, body: raw.replace(/^\uFEFF/, '') }
  const body = raw.slice(match[0].length)
  const block = match[1] ?? ''
  const attempt = (text: string): Record<string, unknown> | string => {
    try {
      const parsed = loadYaml(text) as unknown
      if (parsed === null || parsed === undefined) return {}
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return 'frontmatter must be a YAML mapping; ignored'
      return parsed as Record<string, unknown>
    } catch (error) {
      return `frontmatter is not valid YAML; ignored (${String(error instanceof Error ? error.message.split('\n')[0] : error)})`
    }
  }
  const first = attempt(block)
  if (typeof first !== 'string') return { frontmatter: first, body }
  // Command files routinely carry `argument-hint: [a] [b]` or `<x>: y`
  // values that are not valid YAML scalars. Like Claude, retry with every
  // top-level scalar value quoted before giving up on the block.
  const retried = attempt(quoteScalarValues(block))
  return typeof retried !== 'string' ? { frontmatter: retried, body } : { frontmatter: {}, body, error: first }
}

/** Quote top-level `key: value` scalars that YAML would misread (`[x] [y]`, `a: b`, `@x`). */
function quoteScalarValues(block: string): string {
  return block.split(/\r?\n/).map((line) => {
    const kv = /^([A-Za-z_][\w-]*):[ \t]+(.+?)[ \t]*$/.exec(line)
    if (kv === null) return line
    const value = kv[2] ?? ''
    if (/^(["'|>]|[-+]?\d+(\.\d+)?$|true$|false$|null$)/i.test(value)) return line
    return `${kv[1]}: ${JSON.stringify(value)}`
  }).join('\n')
}

/** `argument-hint` as written: YAML may have turned `[x]` into a list. */
export function hintText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return `[${value.map(String).join(', ')}]`
  return String(value)
}

/** Claude's boolean coercion: booleans, and the strings/numbers it treats as true/false. */
export function frontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return undefined
}

/**
 * Claude's `allowed-tools` list: a string or a list; within a string, commas
 * and spaces separate rules except inside parentheses (`Bash(git add:*)`).
 */
export function parseAllowedTools(value: unknown): string[] {
  const inputs = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const out: string[] = []
  for (const input of inputs) {
    let current = ''
    let depth = 0
    for (const char of input) {
      if (char === '(') { depth += 1; current += char; continue }
      if (char === ')') { depth = Math.max(0, depth - 1); current += char; continue }
      if ((char === ',' || char === ' ') && depth === 0) {
        if (current.trim() !== '') out.push(current.trim())
        current = ''
        continue
      }
      if (current !== '' || char.trim() !== '') current += char
    }
    if (current.trim() !== '') out.push(current.trim())
  }
  return [...new Set(out)]
}

export interface CommandMeta {
  readonly source: CommandSource
  readonly path: string
  readonly skillDir?: string
  readonly plugin?: CommandDefinition['plugin']
}

/** One command document → definition. Never throws: a bad frontmatter is a note. */
export function parseCommand(name: string, raw: string, meta: CommandMeta): CommandDefinition {
  const { frontmatter, body, error } = splitFrontmatter(raw)
  const notes: string[] = error !== undefined ? [error] : []
  const unenforced: string[] = []
  for (const key of Object.keys(frontmatter)) {
    if (ENFORCED.has(key)) continue
    if (RECOGNIZED.has(key)) unenforced.push(key)
  }
  if (unenforced.length > 0) notes.push(`not enforced by dnt-harness: ${unenforced.join(', ')}`)
  const rawDescription = frontmatter['description']
  const declared = typeof rawDescription === 'string' ? rawDescription.trim() : typeof rawDescription === 'number' || typeof rawDescription === 'boolean' ? String(rawDescription) : ''
  const description = declared !== '' ? declared : descriptionFromBody(body, meta.skillDir !== undefined ? 'Skill' : 'Custom command')
  const hint = hintText(frontmatter['argument-hint'])
  const model = frontmatter['model']
  const modelText = typeof model === 'string' && model.trim() !== '' && model.trim().toLowerCase() !== 'inherit' ? model.trim() : undefined
  return {
    name,
    description,
    ...(hint !== undefined ? { argumentHint: hint } : {}),
    argumentNames: argumentNames(frontmatter['arguments']),
    allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
    ...(modelText !== undefined ? { model: modelText } : {}),
    disableModelInvocation: frontmatterBoolean(frontmatter['disable-model-invocation']) ?? false,
    userInvocable: frontmatterBoolean(frontmatter['user-invocable']) ?? true,
    body,
    source: meta.source,
    path: meta.path,
    hash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    ...(meta.skillDir !== undefined ? { skillDir: meta.skillDir } : {}),
    ...(meta.plugin !== undefined ? { plugin: meta.plugin } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  }
}

/** One name segment: what a file or folder name may contribute. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export interface ScanOptions {
  readonly source: CommandSource
  /** Name prefix (`plugin` → `plugin:<cmd>`). */
  readonly prefix?: string
  readonly plugin?: CommandDefinition['plugin']
}

/**
 * Every command under `dir`. Directories nest the name with `:`; a directory
 * holding `SKILL.md` is one command named after the directory. Symlinks are
 * followed once (a cycle is skipped); files over 1 MiB are skipped.
 */
export async function scanCommandsDir(dir: string, options: ScanOptions): Promise<{ rows: CommandDefinition[]; errors: { path: string; message: string }[] }> {
  const rows: CommandDefinition[] = []
  const errors: { path: string; message: string }[] = []
  const visited = new Set<string>()
  const walk = async (current: string, segments: readonly string[]): Promise<void> => {
    const real = await fs.realpath(current).catch(() => undefined)
    if (real === undefined || visited.has(real)) return
    visited.add(real)
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    const skillFile = entries.find((entry) => /^skill\.md$/i.test(entry.name))
    if (skillFile !== undefined && segments.length > 0) {
      await readOne(path.join(current, skillFile.name), segments, current)
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      const stat = entry.isSymbolicLink() ? await fs.stat(full).catch(() => undefined) : entry
      if (stat === undefined) continue
      if (stat.isDirectory()) {
        if (SEGMENT.test(entry.name)) await walk(full, [...segments, entry.name])
        continue
      }
      if (!stat.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const stem = entry.name.slice(0, -3)
      if (!SEGMENT.test(stem)) continue
      await readOne(full, [...segments, stem])
    }
  }
  const readOne = async (file: string, segments: readonly string[], skillDir?: string): Promise<void> => {
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) return
      if (stat.size > MAX_COMMAND_BYTES) {
        errors.push({ path: file, message: `skipped: exceeds ${MAX_COMMAND_BYTES} bytes` })
        return
      }
      const raw = await fs.readFile(file, 'utf8')
      const name = [...(options.prefix !== undefined ? [options.prefix] : []), ...segments].join(':')
      rows.push(parseCommand(name, raw, {
        source: options.source,
        path: file,
        ...(skillDir !== undefined ? { skillDir } : {}),
        ...(options.plugin !== undefined ? { plugin: options.plugin } : {}),
      }))
    } catch (error) {
      errors.push({ path: file, message: String(error instanceof Error ? error.message : error) })
    }
  }
  await walk(dir, [])
  return { rows, errors }
}

/** Command names compare case-insensitively (Claude matches names that way on lookup). */
export function commandKey(name: string): string {
  return name.trim().toLowerCase()
}

export interface CommandLayer {
  readonly source: CommandSource
  /** A commands folder, or (with `file`) one command file. */
  readonly dir: string
  readonly file?: true
  readonly prefix?: string
  readonly plugin?: CommandDefinition['plugin']
}

/** One listed command file (a plugin manifest's `commands: "./x.md"`). */
async function readCommandFile(layer: CommandLayer): Promise<{ rows: CommandDefinition[]; errors: { path: string; message: string }[] }> {
  const stem = path.basename(layer.dir).replace(/\.md$/i, '')
  try {
    const stat = await fs.stat(layer.dir)
    if (!stat.isFile() || stat.size > MAX_COMMAND_BYTES || !SEGMENT.test(stem)) return { rows: [], errors: [] }
    const raw = await fs.readFile(layer.dir, 'utf8')
    const name = layer.prefix !== undefined ? `${layer.prefix}:${stem}` : stem
    return { rows: [parseCommand(name, raw, { source: layer.source, path: layer.dir, ...(layer.plugin !== undefined ? { plugin: layer.plugin } : {}) })], errors: [] }
  } catch (error) {
    return { rows: [], errors: [{ path: layer.dir, message: String(error instanceof Error ? error.message : error) }] }
  }
}

/**
 * Project command folders: the project's `.claude/commands`, then each
 * ancestor's up to (not including) the home folder — Claude walks the same
 * chain. Returned outermost first so the nearest folder wins by name.
 */
export function projectCommandDirs(projectRoot: string, home: string = homedir()): string[] {
  const dirs: string[] = []
  const stop = path.resolve(home)
  let current = path.resolve(projectRoot)
  for (;;) {
    if (current === stop) break
    dirs.push(path.join(current, '.claude', 'commands'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs.reverse()
}

/** Merge layers in order; a later layer replaces an earlier row with the same name. */
export async function loadCommandLayers(layers: readonly CommandLayer[]): Promise<{ rows: CommandDefinition[]; errors: { path: string; message: string }[] }> {
  const scans = await Promise.all(layers.map((layer) => layer.file === true
    ? readCommandFile(layer)
    : scanCommandsDir(layer.dir, {
        source: layer.source,
        ...(layer.prefix !== undefined ? { prefix: layer.prefix } : {}),
        ...(layer.plugin !== undefined ? { plugin: layer.plugin } : {}),
      })))
  const byKey = new Map<string, CommandDefinition>()
  const errors: { path: string; message: string }[] = []
  for (const scan of scans) {
    errors.push(...scan.errors)
    for (const row of scan.rows) byKey.set(commandKey(row.name), row)
  }
  return { rows: [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)), errors }
}
