/**
 * A typed `/name args` message → the command it invokes, and the expansion
 * that reaches the model. Mirrors Claude Code's dispatch: the first token
 * after `/` is the name (Claude's name rule), the rest of the line and every
 * following line are the arguments.
 */
import path from 'node:path'
import type { CommandDefinition } from './catalog.ts'
import { findInlineShell, neutralizeShellMarkers, replaceInlineShell, substituteArguments, substituteVariables, type InlineShell } from './expand.ts'

/** Claude Code's slash-command name rule. */
export const COMMAND_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/

export interface SlashInvocation {
  readonly name: string
  readonly args: string
}

/**
 * `/name args…` at the very start of a message, or undefined. A first token
 * that is not a command name (`/usr/bin/env`, `/ `) is plain text.
 */
export function parseSlashInvocation(content: string): SlashInvocation | undefined {
  if (!content.startsWith('/')) return undefined
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content)
  if (match === null) return undefined
  const name = match[1] ?? ''
  if (!COMMAND_NAME.test(name)) return undefined
  return { name, args: (match[2] ?? '').trim() }
}

export interface ExpansionContext {
  readonly projectDir?: string
  readonly sessionId?: string
  /**
   * Run one inline shell command through the conversation's Bash pipeline.
   * Resolves to the text that replaces the marker; throws (with Claude's
   * message) when the command was refused or failed.
   */
  readonly runShell?: (shell: InlineShell) => Promise<string>
}

/** Raised for a refused/failed inline shell or an unknown command: rejects the prompt. */
export class CommandExpansionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandExpansionError'
  }
}

/**
 * Expand one command for the given arguments, Claude's order: skill base
 * directory line, argument substitution, `${CLAUDE_*}` variables, inline
 * shell. Inline shell markers run one at a time in order, and the first
 * failure stops the rest: no marker is still running or waiting for approval
 * after the prompt was rejected. Each output replaces its own marker.
 */
export async function expandCommand(command: CommandDefinition, args: string, context: ExpansionContext): Promise<string> {
  let text = command.skillDir !== undefined ? `Base directory for this skill: ${command.skillDir}\n\n${command.body.trim()}` : command.body.trim()
  text = substituteArguments(text, args, command.argumentNames, true, neutralizeShellMarkers)
  text = substituteVariables(text, {
    ...(command.plugin !== undefined ? { pluginRoot: command.plugin.root } : {}),
    ...(command.plugin?.data !== undefined ? { pluginData: command.plugin.data } : {}),
    ...(context.projectDir !== undefined ? { projectDir: context.projectDir } : {}),
    ...(command.skillDir !== undefined ? { skillDir: command.skillDir } : {}),
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
  })
  const markers = findInlineShell(text)
  if (markers.length === 0) return text
  if (context.runShell === undefined) {
    throw new CommandExpansionError(`/${command.name} runs shell commands, which this conversation cannot run`)
  }
  const outputs: { readonly at: number; readonly raw: string; readonly output: string }[] = []
  for (const marker of [...markers].sort((a, b) => a.at - b.at)) {
    outputs.push({ at: marker.at, raw: marker.raw, output: await context.runShell(marker) })
  }
  return replaceInlineShell(text, outputs)
}

/** Display path of a command file relative to its layer (for listings). */
export function commandFileLabel(command: CommandDefinition, home: string): string {
  return command.path.startsWith(home) ? `~${command.path.slice(home.length)}` : path.normalize(command.path)
}
