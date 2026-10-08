import type { DangerousCommandsConfig, PresetId } from './types.ts'
export const PRESET_IDS = ['fsDestructive','gitDestructive','systemPriv','networkExfil','dbDestructive','resourceExhaust'] as const satisfies readonly PresetId[]
export const PRESET_LABELS: Record<PresetId, { name: string; description: string; examples: string }> = {
  fsDestructive: { name: 'FS Destructive', description: 'Irreversible filesystem damage', examples: 'rm -rf, find -delete, mkfs, dd, shred' },
  gitDestructive: { name: 'Git Destructive', description: 'Irreversible git operations', examples: 'reset --hard, push --force/-f, stash clear/drop, restore' },
  systemPriv: { name: 'System / Privilege', description: 'Privilege escalation & host control', examples: 'sudo, systemctl, reboot' },
  networkExfil: { name: 'Network Exfil / Remote Exec', description: 'Remote execution & exfiltration', examples: 'curl | sh, wget | bash, nc -l' },
  dbDestructive: { name: 'DB Destructive', description: 'Database data loss', examples: 'DROP TABLE, TRUNCATE, DELETE w/o WHERE' },
  resourceExhaust: { name: 'Resource Exhaust', description: 'Fork bomb & host DoS', examples: ':(){ :|:& };:, nohup loop' },
}
export const PRESET_RULE_TEXTS: Record<PresetId, readonly string[]> = {
  fsDestructive: ['rm -rf / …  (recursive + force)', 'rm -r … / rm --recursive …', 'find … -delete / -exec rm', 'mkfs.*', 'dd if=…', 'shred …', 'chmod …777', '> /dev/sd*', 'mv … /*'],
  gitDestructive: ['git reset --hard', 'git push --force / -f / +ref (incl. --force-with-lease)', 'git clean -f…', 'git rm … (without --cached)', 'git branch -D …', 'git stash clear / drop', 'git restore … (without --staged)', 'git checkout -- .'],
  systemPriv: ['sudo …', 'su …', 'systemctl …', 'reboot', 'shutdown', 'taskkill /F', 'net stop …'],
  networkExfil: ['curl … | sh/bash', 'wget … | sh/bash', 'curl … && sh …', 'sh <(curl …) / eval "$(curl …)"', 'base64 -d … | sh', 'nc -l …', 'ssh …', 'scp …', 'Invoke-Expression', 'iex(…)', 'certutil … -urlcache …'],
  dbDestructive: ['DROP TABLE / DATABASE …', 'TRUNCATE TABLE …', 'DELETE FROM … (no WHERE)'],
  resourceExhaust: [':(){ :|:& };:  (fork bomb)', 'nohup … while … do …'],
}
export const DEFAULT_CONFIG: DangerousCommandsConfig = {
  v: 1,
  presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
  customRules: [],
}
