/**
 * Layered custom slash commands for one workspace (and its bound project):
 * bundled < `~/.claude/commands` < plugin command folders < `<ws>/commands` <
 * `<project>/.claude/commands` (ancestors first, nearest wins). Read fresh on
 * every call — command files are user-edited and small; the catalog is the
 * source of truth for the `/` menu, invocation and the model's catalog.
 */
import path from 'node:path'
import { commandKey, loadCommandLayers, projectCommandDirs, type CommandDefinition, type CommandLayer } from './catalog.ts'

export interface CommandsServiceOptions {
  /** Read-only commands shipped with the app; the lowest layer, so every other layer overrides it by name. */
  readonly bundledDir?: string
  /** `~/.claude`; omitted skips the user layer. */
  readonly userClaudeDir?: string
  readonly projectRootOf?: (workspaceId: string, projectId: string) => string | undefined
  /** Plugin command folders for this workspace/project (enabled plugins only). */
  readonly pluginLayers?: (workspaceId: string, projectId: string | undefined) => Promise<readonly CommandLayer[]>
  /** Home folder bounding the project ancestor walk (tests override). */
  readonly homeDir?: string
  /** Layers the workspace's Sources policy switched off (`bundled`, `user`, `plugin`, `workspace`, `project`). */
  readonly disabledLayers?: (workspaceId: string) => Promise<ReadonlySet<string>>
}

export class CommandsService {
  constructor(private readonly home: string, private readonly options: CommandsServiceOptions = {}) {}

  /** The workspace layer folder. */
  workspaceCommandsDir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'commands')
  }

  async layers(workspaceId: string, projectId?: string): Promise<CommandLayer[]> {
    const off = await this.options.disabledLayers?.(workspaceId).catch(() => undefined) ?? new Set<string>()
    const projectRoot = projectId !== undefined ? this.options.projectRootOf?.(workspaceId, projectId) : undefined
    const plugins = off.has('plugin') ? [] : await this.options.pluginLayers?.(workspaceId, projectId).catch(() => []) ?? []
    return [
      ...(this.options.bundledDir !== undefined && !off.has('bundled') ? [{ source: 'bundled' as const, dir: this.options.bundledDir }] : []),
      ...(this.options.userClaudeDir !== undefined && !off.has('user') ? [{ source: 'user' as const, dir: path.join(this.options.userClaudeDir, 'commands') }] : []),
      ...plugins,
      ...(off.has('workspace') ? [] : [{ source: 'workspace' as const, dir: this.workspaceCommandsDir(workspaceId) }]),
      ...(projectRoot !== undefined && !off.has('project')
        ? projectCommandDirs(projectRoot, this.options.homeDir).map((dir) => ({ source: 'project' as const, dir }))
        : []),
    ]
  }

  async catalog(workspaceId: string, projectId?: string): Promise<{ rows: CommandDefinition[]; errors: { path: string; message: string }[] }> {
    return loadCommandLayers(await this.layers(workspaceId, projectId))
  }

  /** One command by name (case-insensitive), or undefined. */
  async find(workspaceId: string, projectId: string | undefined, name: string): Promise<CommandDefinition | undefined> {
    const key = commandKey(name)
    const { rows } = await this.catalog(workspaceId, projectId)
    return rows.find((row) => commandKey(row.name) === key)
  }
}
