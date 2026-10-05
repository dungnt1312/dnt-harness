/**
 * Agent roles read as what they do, not as rows of the same glyph: one icon
 * per bundled role, a neutral bot for any other role. The transcript's tool
 * rows and the Subagents panel share this mapping so a role keeps its face
 * in both places.
 */
import type { IconName } from '../components/common/Icon.tsx'

/** Icon of a bundled role by name; any other role reads as a bot. */
export function agentRoleIcon(role: string): IconName {
  switch (role) {
    case 'explorer': return 'telescope'
    case 'worker': return 'hammer'
    case 'reviewer': return 'searchCheck'
    case 'verifier': return 'shieldCheck'
    default: return 'bot'
  }
}

/** The same hue a tool row gives the family of work the role belongs to. */
export const AGENT_ROLE_TONE: Readonly<Record<string, string>> = {
  telescope: 'text-tool-search',
  hammer: 'text-tool-edit',
  searchCheck: 'text-tool-read',
  shieldCheck: 'text-tool-run',
  bot: 'text-tool-agent',
}
