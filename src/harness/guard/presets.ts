import type { PresetId } from './types.ts'

export const PRESET_REGEXES: Record<PresetId, RegExp[]> = {
  fsDestructive: [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
    /\brm\s+-[a-z]*r[a-z]*\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bshred\b/i,
    /chmod\s+.*777/i,
    />\s*\/dev\/sd/i,
    /\bmv\s+.*\/\*/i,
  ],
  gitDestructive: [
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\s+.*--force/i,
    /\bgit\s+clean\s+.*-f/i,
    /\bgit\s+branch\s+-D\b/i,
    /\bgit\s+stash\s+(clear|drop)\b/i,
    /\bgit\s+restore\b(?![^|]*--staged)/i,
    /\bgit\s+checkout\s+--\s+\./i,
  ],
  systemPriv: [
    /\bsudo\b/i,
    /\bsu\s/i,
    /\bsystemctl\b/i,
    /\breboot\b/i,
    /\bshutdown\b/i,
    /taskkill\s+\/F/i,
    /\bnet\s+stop\b/i,
  ],
  networkExfil: [
    /curl[^|]*\|\s*(sh|bash)/i,
    /wget[^|]*\|\s*(sh|bash)/i,
    /\bnc\s+-l\b/i,
    /\bssh\s+/i,
    /\bscp\s+/i,
    /Invoke-Expression/i,
    /\biex\s*\(/i,
    /certutil\s+.*-urlcache/i,
  ],
  dbDestructive: [
    /\bDROP\s+(TABLE|DATABASE)\b/i,
    /\bTRUNCATE\s+TABLE\b/i,
    /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i,
  ],
  resourceExhaust: [
    /: *\(\) *\{ *: *\| *: *& *\} *; *:/,
    /nohup.*while.*do/i,
  ],
}
