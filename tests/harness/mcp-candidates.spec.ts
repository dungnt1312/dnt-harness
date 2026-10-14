import { describe, expect, it } from 'vitest'
import {
  isMcpSelector, matchesMcpEntry, roleCandidates, isBundledExplorer, narrowCeiling, missingGrantedMcp,
} from '../../src/harness/agents/mcp-candidates.ts'
import type { AgentDefinition } from '../../src/harness/agents/definition-service.ts'

const def = (over: Partial<AgentDefinition>): AgentDefinition => ({
  name: 'r', description: 'd', instructions: 'i', tools: ['Read', 'Grep'], disallowedTools: [], ...over,
})

describe('mcp selectors', () => {
  it('recognizes server and global selectors only', () => {
    expect(isMcpSelector('mcp__*')).toBe(true)
    expect(isMcpSelector('mcp__s__*')).toBe(true)
    expect(isMcpSelector('mcp__s__get')).toBe(false)
    expect(isMcpSelector('Read')).toBe(false)
  })
  it('matches exact, server and global entries', () => {
    expect(matchesMcpEntry('mcp__s__get', 'mcp__s__get')).toBe(true)
    expect(matchesMcpEntry('mcp__s__*', 'mcp__s__get')).toBe(true)
    expect(matchesMcpEntry('mcp__s__*', 'mcp__sx__get')).toBe(false)
    expect(matchesMcpEntry('mcp__*', 'mcp__any__thing')).toBe(true)
    expect(matchesMcpEntry('mcp__*', 'Read')).toBe(false)
  })
  it('a server selector never matches a server whose name extends it with __ (tool names never contain __)', () => {
    expect(matchesMcpEntry('mcp__s__*', 'mcp__s__x__get')).toBe(false)
    expect(isMcpSelector('mcp__a__b__*')).toBe(true)
    expect(matchesMcpEntry('mcp__a__b__*', 'mcp__a__b__get')).toBe(true)
    expect(matchesMcpEntry('mcp__a__b__*', 'mcp__a__get')).toBe(false)
  })
})

describe('roleCandidates', () => {
  it('inherit role gets every MCP tool', () => {
    expect(roleCandidates(def({ inheritsTools: true }), 'workspace')).toEqual(['Read', 'Grep', 'mcp__*'])
  })
  it('inherit role with mcpServers gets only those servers', () => {
    expect(roleCandidates(def({ inheritsTools: true, mcpServers: ['a', 'b'] }), 'workspace'))
      .toEqual(['Read', 'Grep', 'mcp__a__*', 'mcp__b__*'])
  })
  it('inherit role that also lists MCP entries (tools: *, mcp__x__*) gets only those, plus mcpServers', () => {
    expect(roleCandidates(def({ inheritsTools: true, tools: ['Read', 'mcp__x__*'] }), 'workspace')).toEqual(['Read', 'mcp__x__*'])
    expect(roleCandidates(def({ inheritsTools: true, tools: ['Read', 'mcp__x__get'], mcpServers: ['y'] }), 'workspace'))
      .toEqual(['Read', 'mcp__x__get', 'mcp__y__*'])
  })
  it('explicit role keeps only what it lists', () => {
    expect(roleCandidates(def({ tools: ['Read', 'mcp__s__*', 'mcp__t__get'] }), 'project'))
      .toEqual(['Read', 'mcp__s__*', 'mcp__t__get'])
  })
  it('bundled explorer (or unknown source) drops every MCP entry; an override keeps them', () => {
    const explorer = def({ name: 'explorer', tools: ['Read', 'mcp__s__*'] })
    expect(roleCandidates(explorer, 'bundled')).toEqual(['Read'])
    expect(roleCandidates(explorer, undefined)).toEqual(['Read'])
    expect(roleCandidates(explorer, 'workspace')).toEqual(['Read', 'mcp__s__*'])
    expect(isBundledExplorer('explorer', 'project')).toBe(false)
  })
})

describe('narrowCeiling', () => {
  const admitted = ['Read', 'Write', 'mcp__s__get', 'mcp__s__list', 'mcp__t__q']
  it('no grant keeps everything', () => {
    expect(narrowCeiling(admitted, undefined, [])).toEqual(admitted)
  })
  it('built-in-only grant narrows built-ins and keeps all MCP', () => {
    expect(narrowCeiling(admitted, ['Read'], [])).toEqual(['Read', 'mcp__s__get', 'mcp__s__list', 'mcp__t__q'])
  })
  it('a grant naming MCP keeps only the granted MCP', () => {
    expect(narrowCeiling(admitted, ['Read', 'mcp__s__*'], [])).toEqual(['Read', 'mcp__s__get', 'mcp__s__list'])
    expect(narrowCeiling(admitted, ['mcp__t__q'], [])).toEqual(['mcp__t__q'])
  })
  it('disallowed accepts exact, server and global selectors', () => {
    expect(narrowCeiling(admitted, undefined, ['Write', 'mcp__s__*'])).toEqual(['Read', 'mcp__t__q'])
    expect(narrowCeiling(admitted, undefined, ['mcp__*'])).toEqual(['Read', 'Write'])
  })
})

describe('missingGrantedMcp', () => {
  it('lists granted MCP names absent from the ceiling and granted selectors that match nothing', () => {
    expect(missingGrantedMcp(['Read', 'mcp__s__get', 'mcp__x__y', 'mcp__z__*', 'mcp__s__*'], ['Read', 'mcp__s__get'])).toEqual(['mcp__x__y', 'mcp__z__*'])
    expect(missingGrantedMcp(['mcp__*'], ['Read'])).toEqual(['mcp__*'])
    expect(missingGrantedMcp(['mcp__*'], ['mcp__s__get'])).toEqual([])
    expect(missingGrantedMcp(undefined, [])).toEqual([])
  })
})
