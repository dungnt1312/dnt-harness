/**
 * The five memory capability tools: `MemorySearch`, `MemoryRead`,
 * `MemoryCreate`, `MemoryUpdate`, `MemoryForget`. Scope comes from the
 * ambient agent scope (never from model arguments — a workspace/project
 * argument the model supplies is ignored); agent writes default to ask via
 * the mode's permission defaults.
 */
import { agentScope } from '../agent/scope.ts'
import type { ToolDefinition, ToolExecution } from '../tools/types.ts'
import { MemoryError, MemoryService } from './service.ts'

/** Resolve the memory scope from the ambient run; fail closed outside one. */
function scopeOf(): { workspaceId: import('../../util/brand.ts').WorkspaceId; projectId?: import('../../util/brand.ts').ProjectId } {
  const store = agentScope.getStore()
  if (store?.workspaceId === undefined) {
    throw new MemoryError('scope', 'memory tools require a workspace-scoped execution')
  }
  return store.projectId !== undefined
    ? { workspaceId: store.workspaceId, projectId: store.projectId }
    : { workspaceId: store.workspaceId }
}

function memArgs(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`argument '${key}' must be a non-empty string`)
  }
  return value.trim()
}

function memoryHash(args: Record<string, unknown>): string {
  const hash = memArgs(args, 'expectedHash')
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("argument 'expectedHash' must be a SHA-256 hash from MemoryRead")
  return hash.toLowerCase()
}

export function memoryTools(memory: MemoryService): ToolDefinition[] {
  return [
    {
      name: 'MemorySearch',
      description: 'Bounded keyword search over memory entries scoped to the current workspace (and project, when bound).',
      requiresRoot: false,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'space-separated keywords' } },
        required: ['query'],
      },
      async execute(args) {
        const hits = await memory.search(scopeOf(), memArgs(args, 'query'))
        if (hits.length === 0) return 'no memory matches'
        return hits.map((entry) => `${entry.id} [${entry.pinned ? 'pinned' : 'loose'}] ${entry.title}`).join('\n')
      },
    },
    {
      name: 'MemoryRead',
      description: 'Read one memory entry by id within the current scope.',
      requiresRoot: false,
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'entry id' } },
        required: ['id'],
      },
      async execute(args) {
        const entry = await memory.read(scopeOf(), memArgs(args, 'id'))
        return `# ${entry.title}\n${entry.body}\n\n[updated ${new Date(entry.updatedAt).toISOString()}]\n[sha256 ${entry.hash}]`
      },
    },
    {
      name: 'MemoryCreate',
      description: 'Create a memory entry (workspace/project scoped, from the current run — arguments cannot choose another scope).',
      requiresRoot: false,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case entry id' },
          title: { type: 'string', description: 'short title' },
          body: { type: 'string', description: 'the fact/notes to remember' },
          pinned: { type: 'boolean', description: 'load automatically in future requests (default false)' },
        },
        required: ['id', 'title', 'body'],
      },
      async execute(args) {
        const entry = await memory.create(scopeOf(), {
          id: memArgs(args, 'id'),
          title: memArgs(args, 'title'),
          body: memArgs(args, 'body'),
          ...(args['pinned'] === true ? { pinned: true } : {}),
        })
        return `created memory '${entry.id}' (sha256 ${entry.hash})`
      },
    },
    {
      name: 'MemoryUpdate',
      description: 'Update one memory entry. Pass expectedHash from your last read; a mismatch means it changed externally.',
      requiresRoot: false,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          pinned: { type: 'boolean' },
          expectedHash: { type: 'string', description: 'sha256 from the last read' },
        },
        required: ['id', 'expectedHash'],
      },
      async execute(args) {
        const entry = await memory.update(scopeOf(), {
          id: memArgs(args, 'id'),
          expectedHash: memoryHash(args),
          ...(typeof args['title'] === 'string' ? { title: args['title'] } : {}),
          ...(typeof args['body'] === 'string' ? { body: args['body'] } : {}),
          ...(args['pinned'] === true ? { pinned: true } : args['pinned'] === false ? { pinned: false } : {}),
        })
        return `updated memory '${entry.id}' (sha256 ${entry.hash})`
      },
    },
    {
      name: 'MemoryForget',
      description: 'Forget one memory entry: future retrieval excludes it (history is never rewritten).',
      requiresRoot: false,
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async execute(args) {
        const id = memArgs(args, 'id')
        await memory.forget(scopeOf(), id)
        return `forgot '${id}'`
      },
    },
  ]
}

export type { ToolExecution }
