import type { DangerousCommandsConfig, PresetId } from './types.ts'
export const PRESET_IDS = ['fsDestructive','gitDestructive','systemPriv','networkExfil','dbDestructive','resourceExhaust'] as const satisfies readonly PresetId[]
export const PRESET_LABELS: Record<PresetId, { name: string; description: string; examples: string }> = {
  fsDestructive: { name: 'FS Destructive', description: 'Irreversible filesystem damage', examples: 'rm -rf, mkfs, dd, shred' },
  gitDestructive: { name: 'Git Destructive', description: 'Irreversible git operations', examples: 'reset --hard, push --force, stash clear/drop, restore' },
  systemPriv: { name: 'System / Privilege', description: 'Privilege escalation & host control', examples: 'sudo, systemctl, reboot' },
  networkExfil: { name: 'Network Exfil / Remote Exec', description: 'Remote execution & exfiltration', examples: 'curl | sh, wget | bash, nc -l' },
  dbDestructive: { name: 'DB Destructive', description: 'Database data loss', examples: 'DROP TABLE, TRUNCATE, DELETE w/o WHERE' },
  resourceExhaust: { name: 'Resource Exhaust', description: 'Fork bomb & host DoS', examples: ':(){ :|:& };:, nohup loop' },
}
export const DEFAULT_CONFIG: DangerousCommandsConfig = {
  v: 1,
  presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
  customRules: [],
}
