import type { PresetId } from './types.ts'

export const PRESET_REGEXES: Record<PresetId, RegExp[]> = {
  fsDestructive: [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
    // Recursive rm in any flag position or spelling: `rm -f -r`, `rm x -rf`,
    // `rm --recursive`. Stops at a command separator.
    /\brm\b[^|;&]*\s-(?:[a-z]*r[a-z]*|-recursive)\b/i,
    // Mass deletion via find.
    /\bfind\b[^|;&]*\s-delete\b/i,
    /\bfind\b[^|;&]*\s-exec(?:dir)?\s+rm\b/i,
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
    // Short force flag (alone or combined, e.g. `-uf`) and `+ref` force refspecs.
    /\bgit\s+push\b[^|;&]*\s-[a-z]*f[a-z]*\b/i,
    /\bgit\s+push\b[^|;&]*\s(?:\S+:)?\+\S/i,
    /\bgit\s+clean\s+.*-f/i,
    // `git rm` without --cached deletes working-tree files (the matcher
    // rewrites its verb to `gitrm`; `--cached` only untracks and is not matched).
    /\bgitrm\b/i,
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
    // Download piped into a shell (word-bounded: `| shasum` is not a shell).
    /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
    // Download, then execute it as a following command.
    /\b(?:curl|wget)\b[^;|&]*(?:&&|;|\|\|)\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\s/i,
    // Shell fed by a download through process/command substitution or eval.
    /\b(?:ba|z|da|k)?sh\b[^;|&]*(?:<\(|\$\()\s*(?:curl|wget)\b/i,
    /\beval\b[^;|&]*\$\(\s*(?:curl|wget)\b/i,
    // Decoded payload piped into a shell.
    /\bbase64\s+(?:-d|-D|--decode)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
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
