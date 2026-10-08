/**
 * The full exposure ceiling any mode can grant. Dependency-free on purpose:
 * the web Modes editor imports this exact list (a copy drifted once and
 * silently dropped tools from every edited mode).
 */
export const KNOWN_MODE_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent',
  'TodoWrite', 'AskUserQuestion',
]
