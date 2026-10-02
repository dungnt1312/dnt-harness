import { describe, expect, it } from 'vitest'
import { OutboundPolicyError, SseParser, assertOutboundUrl } from 'dnt-harness'
import { acceptProtocolVersion } from '../../src/harness/mcp/boundaries.ts'
import { assertInitializeResult } from '../../src/harness/mcp/protocol.ts'

describe('mcp protocol and outbound policy', () => {
  it('accepts only the pinned protocol version', () => {
    expect(acceptProtocolVersion('2025-06-18').accepted).toBe(true)
    expect(acceptProtocolVersion('2024-11-05').accepted).toBe(false)
    expect(() => assertInitializeResult({ protocolVersion: '2099-01-01', capabilities: {} })).toThrow(/not accepted/)
    expect(() => assertInitializeResult({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })).not.toThrow()
  })

  it('parses CRLF SSE frames and rejects prohibited targets', () => {
    const parser = new SseParser()
    const events = parser.push('data: {"ok":1}\r\n\r\n')
    expect(events).toEqual([{ data: '{"ok":1}' }])
    expect(() => assertOutboundUrl('http://169.254.169.254/latest')).toThrow(OutboundPolicyError)
    expect(() => assertOutboundUrl('https://user:pass@example.test/mcp')).toThrow(/userinfo/)
    expect(assertOutboundUrl('http://127.0.0.1:9/mcp', { allowLoopbackHttp: true }).hostname).toBe('127.0.0.1')
  })
})

  it('rejects a repeated tools/list cursor and a prohibited redirect target', async () => {
    const { assertCursor, ProtocolError } = await import('../../src/harness/mcp/protocol.ts')
    const seen = new Set<string>(['page-1'])
    expect(() => assertCursor('page-1', seen, 2)).toThrow(ProtocolError)
    expect(() => assertOutboundUrl('https://10.0.0.5/mcp')).toThrow(/prohibited/)
    expect(() => assertOutboundUrl('http://example.test/mcp')).toThrow(/plain HTTP/)
  })
