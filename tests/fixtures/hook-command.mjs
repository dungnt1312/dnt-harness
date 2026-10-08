#!/usr/bin/env node
/** Claude Code hook fixture: stdin JSON; behavior chosen by argv[2]. */
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
const mode = process.argv[2] ?? 'allow'
const out = (value) => process.stdout.write(JSON.stringify(value))
switch (mode) {
  case 'block':
    process.stderr.write('blocked by fixture\n')
    process.exit(2)
  case 'deny':
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fixture denies' } })
    break
  case 'ask':
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })
    break
  case 'rewrite':
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, rewritten: true } } })
    break
  case 'context':
    out({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: 'fixture additional context' } })
    break
  case 'stdout':
    process.stdout.write('fixture plain stdout context')
    break
  case 'decision-block':
    out({ decision: 'block', reason: 'fixture says keep going' })
    break
  case 'stop-once':
    // Claude Stop-hook idiom: continue once, then let go.
    if (input.stop_hook_active !== true) out({ decision: 'block', reason: 'fixture says keep going' })
    break
  case 'stop':
    out({ continue: false, stopReason: 'fixture stopped' })
    break
  case 'echo':
    out({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: JSON.stringify({ input, env: { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null }, cwd: process.cwd() }) } })
    break
  case 'fail':
    process.stderr.write('fixture failed')
    process.exit(1)
  case 'hang':
    await new Promise(() => { setInterval(() => {}, 1_000) })
    break
  default:
    break
}
process.exit(0)
