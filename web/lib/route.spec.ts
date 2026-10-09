import { describe, expect, it } from 'vitest'
import { automationsRoute, parseRoute, routePath, sessionRoute, workspaceRoute } from './route.ts'

describe('browser routes', () => {
  it('parses the canonical root, workspace, and conversation routes', () => {
    expect(parseRoute('/')).toEqual({ kind: 'root' })
    expect(parseRoute('/workspaces/work')).toEqual(workspaceRoute('work'))
    expect(parseRoute('/workspaces/work/sessions/session')).toEqual(sessionRoute('work', 'session'))
    expect(parseRoute('/workspaces/a%20b/sessions/c%2Bd')).toEqual(sessionRoute('a b', 'c+d'))
  })

  it('fails closed for malformed, unknown, and unsafe routes', () => {
    for (const pathname of [
      '/workspaces',
      '/workspaces/',
      '/workspaces/work/sessions',
      '/workspaces/work/sessions/session/extra',
      '/workspaces/%2F/sessions/session',
      '/workspaces/%E0%A4%A/sessions/session',
      '/settings',
    ]) expect(parseRoute(pathname)).toBeNull()
  })

  it('parses and serializes the Automations routes', () => {
    expect(parseRoute('/workspaces/work/automations')).toEqual(automationsRoute('work'))
    expect(parseRoute('/workspaces/work/automations/new')).toEqual(automationsRoute('work', 'new'))
    expect(parseRoute('/workspaces/work/automations/a/extra')).toBeNull()
    expect(routePath(automationsRoute('a b', 'auto-1'))).toBe('/workspaces/a%20b/automations/auto-1')
  })

  it('serializes routes as root-relative encoded canonical paths', () => {
    expect(routePath({ kind: 'root' })).toBe('/')
    expect(routePath(workspaceRoute('a b'))).toBe('/workspaces/a%20b')
    expect(routePath(sessionRoute('a b', 'c+d'))).toBe('/workspaces/a%20b/sessions/c%2Bd')
  })
})
