/**
 * The Modes editor must round-trip every server-valid mode byte-for-byte:
 * anything the form cannot represent would be silently dropped on save
 * (which is how a duplicated Full access lost BashOutput/KillShell/TodoWrite/
 * AskUserQuestion, and how a Plan copy would lose its MCP restriction).
 */
import { describe, expect, it } from 'vitest'
import { KNOWN_MODE_TOOLS, parseModeForm, permissionKeyError, serializeModeForm } from '../../web/lib/mode-form.ts'
import { BUNDLED_MODES, KNOWN_MODE_TOOLS as SERVER_KNOWN_MODE_TOOLS } from '../../src/harness/modes/bundled.ts'
import { parseModeFile, serializeModeFile } from '../../src/harness/modes/service.ts'

describe('mode form ⇄ server serializer', () => {
  it('round-trips every bundled mode byte-for-byte', () => {
    for (const mode of BUNDLED_MODES) {
      const raw = serializeModeFile(mode)
      expect(serializeModeForm(parseModeForm(raw)), mode.id).toBe(raw)
    }
  })

  it('round-trips a custom mode with description, MCP exposure, out-of-grant, and ordered MCP keys', () => {
    const raw = serializeModeFile(parseModeFile('custom', [
      '---',
      'name: "Custom"',
      'description: "Security review"',
      'history: compact',
      'toolExposure: ["Read","BashOutput","KillShell","TodoWrite","AskUserQuestion"]',
      'permissionDefaults: {"mcp__zeta__*":"ask","Read":"allow","mcp__alpha__get":"allow","*":"deny"}',
      'outOfGrant: allow',
      'mcpExposure: all',
      '---',
      '',
      '   padded body   ',
    ].join('\n')))
    const form = parseModeForm(raw)
    expect(form.description).toBe('Security review')
    expect(form.mcpExposure).toBe('all')
    expect(form.exposure).toEqual(['Read', 'BashOutput', 'KillShell', 'TodoWrite', 'AskUserQuestion'])
    expect(serializeModeForm(form)).toBe(raw)
  })

  it('offers exactly the server tool list', () => {
    expect(KNOWN_MODE_TOOLS).toEqual(SERVER_KNOWN_MODE_TOOLS)
    expect(permissionKeyError('BashOutput')).toBeNull()
    expect(permissionKeyError('MemorySearch')).not.toBeNull()
  })
})
