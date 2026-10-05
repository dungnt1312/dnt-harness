import { describe, expect, it } from 'vitest'
import { resolvePermission } from '../../src/harness/approval/resolution.ts'
import { composeAuthority } from '../../src/harness/tools/authority.ts'

describe('pure permission resolution', () => {
  it.each([
    ['read', { Read: 'deny' }, 'ask', false, 'deny'],
    ['Read', { read: 'allow' }, 'ask', false, 'allow'],
    ['mcp__s__t', { 'mcp__s__t': 'deny', 'mcp__s__*': 'allow', '*': 'ask' }, 'ask', false, 'deny'],
    ['mcp__s__t', { 'mcp__s__*': 'allow', '*': 'deny' }, 'ask', false, 'allow'],
    ['Other', {}, 'ask', true, 'ask'],
    ['Other', {}, 'allow', false, 'allow'],
    ['Read', { Read: 'deny' }, 'ask', true, 'deny'],
    ['Read', { Read: 'ask' }, 'ask', true, 'allow'],
  ] as const)('%s respects precedence/default/yolo', (tool, policy, defaultMode, yolo, expected) => {
    expect(resolvePermission(policy, tool, { defaultMode, yolo })).toBe(expected)
  })
})

describe('authority composition', () => {
  it('forces interaction even under allow and preserves hard denies', () => {
    const requirements = [{ kind: 'interaction', subjectFingerprint: 'call-v1' }] as const
    expect(composeAuthority({ permission: 'allow', requirements })).toEqual({ kind: 'ask', requirements })
    expect(composeAuthority({ permission: 'allow', requirements, hardDenial: 'ceiling' })).toEqual({ kind: 'deny', reason: 'ceiling' })
  })
  it('requires explicit complete scope for host use, not standalone use', () => {
    expect(composeAuthority({ permission: 'allow', scopeMode: 'host' }).kind).toBe('deny')
    expect(composeAuthority({ permission: 'allow', scopeMode: 'standalone' })).toEqual({ kind: 'allow' })
  })
})
