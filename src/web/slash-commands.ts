/**
 * Host side of Claude Code slash commands: a root message that starts with
 * `/name` resolves to a file command or a skill, expands (arguments,
 * `${CLAUDE_*}`, inline shell through the Bash pipeline), and the expansion
 * reaches the model as an `origin: 'command'` message right after the typed
 * text. The command's `allowed-tools` and `model` apply to that turn.
 *
 * Also the shared resolver the `Skill` tool uses for `name` + `args`.
 */
import type { CommandDefinition } from '../harness/commands/catalog.ts'
import { commandKey } from '../harness/commands/catalog.ts'
import { allowedByRules } from '../harness/commands/allowed-tools.ts'
import { CommandExpansionError, expandCommand, parseSlashInvocation } from '../harness/commands/invoke.ts'
import type { InlineShell } from '../harness/commands/expand.ts'
import type { ToolCall } from '../harness/llm/types.ts'

/** Host-owned commands handled by the client; they never resolve here. */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(['compact'])

export interface CommandResolverDeps {
  /** File commands (user < plugin < workspace < project). */
  readonly commands: (workspaceId: string, projectId: string | undefined) => Promise<readonly CommandDefinition[]>
  /** A skill as a command, through the workspace's skill layers. */
  readonly skill: (workspaceId: string, projectId: string | undefined, name: string) => Promise<CommandDefinition | undefined>
}

/**
 * Skill first, then file command — Claude Code 2.1.293 loads skills ahead of
 * legacy `commands/` files and takes the first name match, so a skill shadows
 * a command of the same name.
 */
export async function resolveCommand(deps: CommandResolverDeps, workspaceId: string, projectId: string | undefined, name: string): Promise<CommandDefinition | undefined> {
  const skill = await deps.skill(workspaceId, projectId, name.trim())
  if (skill !== undefined) return skill
  const key = commandKey(name)
  return (await deps.commands(workspaceId, projectId)).find((row) => commandKey(row.name) === key)
}

/** What one turn's slash command granted: lifted asks and an optional model. */
export interface TurnCommandGrant {
  readonly command: string
  readonly allowedTools: readonly string[]
  readonly model?: string
}

/**
 * Per-turn grants keyed by root session. A grant lives from the pre-step that
 * expanded the command until that turn settles.
 */
export class TurnCommandGrants {
  private readonly bySession = new Map<string, TurnCommandGrant[]>()

  add(sessionId: string, grant: TurnCommandGrant): () => void {
    const list = this.bySession.get(sessionId) ?? []
    list.push(grant)
    this.bySession.set(sessionId, list)
    return () => {
      const current = this.bySession.get(sessionId)
      if (current === undefined) return
      const index = current.lastIndexOf(grant)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.bySession.delete(sessionId)
    }
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /** Whether an `ask` for this call is lifted by a command of the running turn. */
  allows(sessionId: string | undefined, call: ToolCall, baseDir?: string): boolean {
    if (sessionId === undefined) return false
    return (this.bySession.get(sessionId) ?? []).some((grant) => allowedByRules(grant.allowedTools, call, baseDir))
  }

  /** The model the turn's (last) command asked for. */
  model(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return (this.bySession.get(sessionId) ?? []).findLast((grant) => grant.model !== undefined)?.model
  }
}

export interface ExpandMessagesDeps extends CommandResolverDeps {
  readonly workspaceId: string
  readonly projectId: string | undefined
  readonly projectDir?: string
  readonly sessionId: string
  readonly runShell: (shell: InlineShell, command: CommandDefinition) => Promise<string>
  /** Called before a command expands, so its grant covers its own inline shell. */
  readonly onGrant?: (grant: TurnCommandGrant) => void
}

export interface ExpandedMessages {
  readonly expansions: readonly (string | undefined)[]
  readonly grants: readonly TurnCommandGrant[]
}

/**
 * Expand every claimed message that invokes a command. Unknown names are an
 * error (Claude: `Unknown command: /x`), except built-ins, which the client
 * owns and which never reach the model as commands.
 */
export async function expandMessages(contents: readonly string[], deps: ExpandMessagesDeps): Promise<ExpandedMessages> {
  const expansions: (string | undefined)[] = []
  const grants: TurnCommandGrant[] = []
  for (const content of contents) {
    const invocation = parseSlashInvocation(content)
    if (invocation === undefined || BUILTIN_COMMAND_NAMES.has(invocation.name.toLowerCase())) {
      expansions.push(undefined)
      continue
    }
    const command = await resolveCommand(deps, deps.workspaceId, deps.projectId, invocation.name)
    if (command === undefined) throw new CommandExpansionError(`Unknown command: /${invocation.name}`)
    if (!command.userInvocable) throw new CommandExpansionError(`/${command.name} can only be used by the model`)
    // The grant applies while the expansion's own inline shell runs, too:
    // Claude evaluates `!` commands with the command's allowed-tools.
    const grant: TurnCommandGrant = { command: command.name, allowedTools: command.allowedTools, ...(command.model !== undefined ? { model: command.model } : {}) }
    grants.push(grant)
    deps.onGrant?.(grant)
    expansions.push(await expandCommand(command, invocation.args, {
      ...(deps.projectDir !== undefined ? { projectDir: deps.projectDir } : {}),
      sessionId: deps.sessionId,
      runShell: (shell) => deps.runShell(shell, command),
    }))
  }
  return { expansions, grants }
}

/**
 * The text an inline shell marker becomes. Mirrors Claude: the command's
 * output; a refusal or failure rejects the prompt with Claude's wording.
 */
export function inlineShellOutput(shell: InlineShell, result: { readonly ok: boolean; readonly output: string }): string {
  // The Bash tool reports its exit as a trailing marker; Claude fails the
  // expansion on a non-zero exit, a timeout or a stop.
  const exit = /\n?\[(exit code: (-?\d+)|terminated[^\]]*|status: [^\]]*)\]$/.exec(result.output)
  const output = (exit !== null ? result.output.slice(0, exit.index) : result.output).trimEnd()
  // Success needs a real `exit code: 0`. A missing marker means the command
  // did not finish here (auto-backgrounded after its timeout, cancelled by a
  // stop): its partial text must not become part of the prompt.
  if (result.ok && exit !== null && exit[2] === '0') return output
  if (result.output.startsWith('denied: ')) {
    throw new CommandExpansionError(`Shell command permission check failed for pattern "${shell.raw}": ${result.output.slice('denied: '.length)}`)
  }
  throw new CommandExpansionError(`Shell command failed for pattern "${shell.raw}": ${output}`)
}
