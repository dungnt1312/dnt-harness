import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSessionStore, Kernel, SessionsService, fileSessions } from 'dnt-harness'
import { deriveSessionModel, sessionModelOf } from '../../src/harness/session/events.ts'
import { Session } from '../../src/harness/session/session.ts'

function boot(): Kernel {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  return kernel
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-session-model-'))
  temporaryDirectories.push(dir)
  return dir
}

describe('session/model durable vocabulary', () => {
  it('reports no event for a legacy log so callers can use the workspace default', async () => {
    const kernel = boot()
    try {
      const session = kernel.ctx.sessions.create()
      session.append({ type: 'user/message', turnId: 't1' as never, content: 'hi' })

      expect(deriveSessionModel(session.events)).toEqual({ hasEvent: false })
      expect(sessionModelOf(session.events)).toEqual({ hasEvent: false })
    } finally {
      await kernel.stop()
    }
  })

  it('preserves explicit null clears while omitted fields remain unchanged', async () => {
    const kernel = boot()
    try {
      const session = kernel.ctx.sessions.create()
      session.append({ type: 'session/model', provider: 'openai', model: 'gpt-4o', thinkingLevel: 'high' })
      session.append({ type: 'session/model', model: 'gpt-4o-mini' })
      session.append({ type: 'session/model', provider: null, thinkingLevel: null })

      expect(deriveSessionModel(session.events)).toEqual({
        hasEvent: true,
        provider: null,
        model: 'gpt-4o-mini',
        thinkingLevel: null,
      })
      expect(sessionModelOf(session.events)).toEqual(deriveSessionModel(session.events))
    } finally {
      await kernel.stop()
    }
  })

  it('returns an independent projection snapshot rather than mutable event state', async () => {
    const kernel = boot()
    try {
      const session = kernel.ctx.sessions.create()
      session.append({ type: 'session/model', model: 'first' })
      const snapshot = deriveSessionModel(session.events)
      session.append({ type: 'session/model', model: null })

      expect(snapshot).toEqual({ hasEvent: true, model: 'first' })
      expect(deriveSessionModel(session.events)).toEqual({ hasEvent: true, model: null })
    } finally {
      await kernel.stop()
    }
  })

  it('deriveMessages ignores session/model events', async () => {
    const kernel = boot()
    try {
      const session = kernel.ctx.sessions.create()
      session.append({ type: 'user/message', turnId: 't1' as never, content: 'hello' })
      session.append({ type: 'session/model', model: 'x' })
      session.append({ type: 'assistant/message', stepId: 's1' as never, content: 'hi' })

      expect(session.deriveMessages()).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ])
    } finally {
      await kernel.stop()
    }
  })

  it('adoptHistory replay preserves model updates and explicit clears', async () => {
    const kernel = boot()
    try {
      const source = kernel.ctx.sessions.create()
      source.append({ type: 'session/model', provider: 'a', model: 'm1' })
      source.append({ type: 'session/model', model: null })
      const replayed = new Session(kernel.ctx)
      replayed.adoptHistory(source.events)

      expect(deriveSessionModel(replayed.events)).toEqual({ hasEvent: true, provider: 'a', model: null })
    } finally {
      await kernel.stop()
    }
  })

  it('persists nullable model projection through FileSessionStore and fileSessions restart', async () => {
    const dir = await temporaryDirectory()
    const workspaceId = 'ws-model-restart' as never
    let sessionId: string

    {
      const kernel = new Kernel()
      kernel.ctx.plugin(fileSessions(dir))
      try {
        const session = kernel.ctx.sessions.create(workspaceId)
        session.append({ type: 'session/model', provider: 'anthropic', model: 'claude-sonnet', thinkingLevel: 'high' })
        session.append({ type: 'session/model', provider: null, thinkingLevel: null })
        await session.durable()
        sessionId = session.id

        const store = new FileSessionStore({ dir, workspaceId })
        const persisted = await store.read(session.id)
        expect(deriveSessionModel(persisted.events)).toEqual({
          hasEvent: true,
          provider: null,
          model: 'claude-sonnet',
          thinkingLevel: null,
        })
      } finally {
        await kernel.stop()
      }
    }

    const restarted = new Kernel()
    restarted.ctx.plugin(fileSessions(dir))
    try {
      await restarted.ctx.sessions.boot()
      const resumed = await restarted.ctx.sessions.load(sessionId as never)
      expect(deriveSessionModel(resumed.events)).toEqual({
        hasEvent: true,
        provider: null,
        model: 'claude-sonnet',
        thinkingLevel: null,
      })
    } finally {
      await restarted.stop()
    }
  })
})
