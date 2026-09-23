import type { ProjectId, WorkspaceId } from '../../util/brand.ts'

/** Schema-versioned `workspace.json`. */
export interface WorkspaceRecord {
  readonly v: 1
  readonly id: WorkspaceId
  /** Display name; renames never move the data tree. */
  name: string
  /** Archived workspaces keep their history but leave pickers and searches. */
  archived: boolean
  readonly createdAt: number
}

/** Schema-versioned `project.json`. */
export interface ProjectRecord {
  readonly v: 1
  readonly id: ProjectId
  name: string
  /** The workspace this project belongs to — fixed for its lifetime. */
  readonly workspaceId: WorkspaceId
  /** Absolute path of the external working folder. */
  path: string
  /** Sidebar position; lower sorts first. Absent on records never reordered. */
  order?: number
  /**
   * Folders beyond `path` that file tools in this project's sessions may use.
   * Absent on records that never granted any.
   */
  additionalDirectories?: readonly AdditionalDirectory[]
  readonly createdAt: number
}

/**
 * One extra folder a project grants its sessions: another project of the
 * same workspace (followed by id, so retargeting it moves the grant) or an
 * absolute folder.
 */
export type AdditionalDirectory =
  | { readonly kind: 'project'; readonly projectId: ProjectId; readonly access: 'read' | 'write' }
  | { readonly kind: 'path'; readonly path: string; readonly access: 'read' | 'write' }

/** Schema-versioned `app.json`. */
export interface AppRecord {
  readonly v: 1
  /** Boot-time default workspace (the tab default, not an execution pointer). */
  readonly defaultWorkspace: WorkspaceId
}

/** Why a workspace/project operation was refused. */
export class ScopeError extends Error {
  constructor(
    readonly code:
      | 'workspace-not-found'
      | 'project-not-found'
      | 'workspace-archived'
      | 'workspace-not-empty'
      | 'project-active'
      | 'root-overlap'
      | 'root-invalid'
      | 'scope-mismatch'
      | 'last-workspace',
    message: string,
  ) {
    super(message)
    this.name = 'ScopeError'
  }
}
