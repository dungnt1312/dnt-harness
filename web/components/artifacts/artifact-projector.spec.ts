import { describe, expect, it } from 'vitest'
import { projectArtifacts } from './artifact-projector.ts'
import type { SseEvent } from '../../lib/types.ts'

describe('projectArtifacts', () => {
  it('maps a canonical Read path and its successful recorded output', () => {
    const events: SseEvent[] = [
      { type: 'tool/call', seq: 1, timestamp: 100, call: { id: 'read-1', name: 'Read', args: { path: 'C:/repo/README.md' } } },
      { type: 'tool/result', seq: 2, timestamp: 120, callId: 'read-1', ok: true, output: '# README', durationMs: 20 },
    ]
    expect(projectArtifacts(events)).toEqual([{
      id: 'read-1', kind: 'file-reference', toolName: 'Read', label: 'File reference', argumentKey: 'path',
      reference: 'C:/repo/README.md', output: '# README', state: 'succeeded', timestamp: 100, durationMs: 20,
    }])
  })

  it('maps a failed Bash command', () => {
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'bash-1', name: 'Bash', args: { command: 'npm test', cwd: 'C:/repo' } } },
      { type: 'tool/result', seq: 2, callId: 'bash-1', ok: false, output: 'failed' },
    ])).toEqual([{
      id: 'bash-1', kind: 'command', toolName: 'Bash', label: 'Command record', command: 'npm test',
      output: 'failed', state: 'failed',
    }])
  })

  it('marks indeterminate and audit_fault results unknown, never a clean failure', () => {
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'mcp-1', name: 'mcp__srv__write', args: { path: 'C:/repo/a.txt' } } },
      { type: 'tool/result', seq: 2, callId: 'mcp-1', ok: false, output: 'may have run', outcome: 'indeterminate', invocationId: 'inv-1' },
    ])[0]).toMatchObject({ id: 'mcp-1', state: 'unknown' })
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'mcp-2', name: 'mcp__srv__write', args: { path: 'C:/repo/b.txt' } } },
      { type: 'tool/result', seq: 2, callId: 'mcp-2', ok: false, output: 'evidence missing', outcome: 'audit_fault' },
    ])[0]).toMatchObject({ id: 'mcp-2', state: 'unknown' })
  })

  it('marks a recovered successful result unknown', () => {
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'read-1', name: 'Read', args: { file_path: 'C:/repo/a.ts' } } },
      { type: 'tool/result', seq: 2, callId: 'read-1', ok: true, output: 'partial', recovery: true },
    ])[0]).toMatchObject({ id: 'read-1', state: 'unknown' })
  })

  it('deduplicates duplicate result frames into one call row', () => {
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'bash-1', name: 'Shell', args: { command: 'pwd' } } },
      { type: 'tool/result', seq: 2, callId: 'bash-1', ok: true, output: 'C:/repo' },
      { type: 'tool/result', seq: 3, callId: 'bash-1', ok: true, output: 'C:/repo' },
    ])).toHaveLength(1)
  })

  it('uses output-only custom tools as tool-output rows', () => {
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'custom-1', name: 'custom_tool', args: { query: 'exact' } } },
      { type: 'tool/result', seq: 2, callId: 'custom-1', ok: true, output: 'recorded result' },
    ])).toEqual([{
      id: 'custom-1', kind: 'tool-output', toolName: 'custom_tool', label: 'Recorded tool output',
      output: 'recorded result', state: 'succeeded',
    }])
  })

  it('omits unknown object-only arguments with empty output', () => {
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'custom-1', name: 'custom_tool', args: { options: { deep: true }, count: 2 } } },
      { type: 'tool/result', seq: 2, callId: 'custom-1', ok: true, output: '' },
    ])).toEqual([])
  })

  it('returns empty when no events qualify', () => {
    expect(projectArtifacts([{ type: 'user/message', seq: 1, content: 'hello' }])).toEqual([])
  })

  it('preserves call order and does not mutate events', () => {
    const events: SseEvent[] = [
      { type: 'tool/result', seq: 0, callId: 'second', ok: true, output: 'second output' },
      { type: 'tool/call', seq: 1, call: { id: 'first', name: 'Read', args: { path: 'C:/first' } } },
      { type: 'tool/call', seq: 2, call: { id: 'second', name: 'custom', args: {} } },
      { type: 'tool/result', seq: 3, callId: 'first', ok: true, output: 'first output' },
    ]
    const before = structuredClone(events)
    expect(projectArtifacts(events).map(item => item.id)).toEqual(['first', 'second'])
    expect(events).toEqual(before)
  })

  it('maps a conservative non-canonical path-like string key as an exact resource reference', () => {
    expect(projectArtifacts([
      { type: 'tool/call', seq: 1, call: { id: 'resource-1', name: 'custom', args: { project_root: 'C:/repo', description: 'ignored' } } },
    ])[0]).toMatchObject({ kind: 'resource-reference', label: 'Resource reference', argumentKey: 'project_root', reference: 'C:/repo', state: 'pending' })
  })
})
