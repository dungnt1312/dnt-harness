/**
 * Durable intent/commit log for multi-file MCP config and secret writes.
 * An intent without a commit is incomplete: startup restores the captured
 * previous bytes instead of leaving a half-applied file.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type MutationKind = 'config' | 'secrets'

interface MutationIntent {
  readonly kind: 'intent'
  readonly id: string
  readonly mutation: MutationKind
  readonly workspaceId: string
  readonly target: string
  /** Previous file bytes, or null when the file did not exist. */
  readonly backup: string | null
  readonly at: number
}

interface MutationCommit {
  readonly kind: 'commit' | 'abort'
  readonly id: string
  readonly at: number
}

type MutationLine = MutationIntent | MutationCommit

export class MutationStore {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly home: string) {}

  private file(): string {
    return path.join(this.home, 'mcp-mutations.jsonl')
  }

  async begin(input: { readonly mutation: MutationKind; readonly workspaceId: string; readonly target: string; readonly backup: Buffer | undefined }): Promise<string> {
    const id = randomUUID()
    const record: MutationIntent = {
      kind: 'intent',
      id,
      mutation: input.mutation,
      workspaceId: input.workspaceId,
      target: input.target,
      backup: input.backup === undefined ? null : input.backup.toString('base64'),
      at: Date.now(),
    }
    await this.append(record)
    return id
  }

  async commit(id: string): Promise<void> {
    await this.append({ kind: 'commit', id, at: Date.now() })
  }

  async abort(id: string): Promise<void> {
    const lines = await this.readLines()
    const intent = lines.find((line): line is MutationIntent => line.kind === 'intent' && line.id === id)
    if (intent !== undefined && !lines.some((line) => line.kind !== 'intent' && line.id === id)) {
      if (intent.backup === null) await fs.rm(intent.target, { force: true })
      else {
        await fs.mkdir(path.dirname(intent.target), { recursive: true })
        await fs.writeFile(intent.target, Buffer.from(intent.backup, 'base64'))
      }
    }
    await this.append({ kind: 'abort', id, at: Date.now() })
  }

  /**
   * Restore every intent that has no commit or abort. Returns the ids that
   * were rolled back.
   */
  async recover(): Promise<readonly string[]> {
    const lines = await this.readLines()
    const open = new Map<string, MutationIntent>()
    for (const line of lines) {
      if (line.kind === 'intent') open.set(line.id, line)
      else open.delete(line.id)
    }
    const restored: string[] = []
    for (const intent of open.values()) {
      if (intent.backup === null) await fs.rm(intent.target, { force: true })
      else {
        await fs.mkdir(path.dirname(intent.target), { recursive: true })
        await fs.writeFile(intent.target, Buffer.from(intent.backup, 'base64'))
      }
      await this.abort(intent.id)
      restored.push(intent.id)
    }
    return restored
  }

  private async append(record: MutationLine): Promise<void> {
    const run = this.chain.then(async () => {
      await fs.mkdir(this.home, { recursive: true })
      const handle = await fs.open(this.file(), 'a')
      try {
        await handle.appendFile(`${JSON.stringify(record)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    this.chain = run.then(() => undefined, () => undefined)
    await run
  }

  private async readLines(): Promise<MutationLine[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw.slice(0, raw.lastIndexOf('\n'))
    if (text.trim() === '') return []
    const out: MutationLine[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line) as MutationLine
      if (parsed.kind !== 'intent' && parsed.kind !== 'commit' && parsed.kind !== 'abort') {
        throw new Error('mcp mutation log is corrupt')
      }
      out.push(parsed)
    }
    return out
  }
}

export async function readFileIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
