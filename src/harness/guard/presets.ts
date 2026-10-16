import type { PresetId } from './types.ts'

/**
 * `git` plus any global options before the subcommand (`git -C repo`,
 * `git --no-pager`, `git -c k=v`, `git --git-dir .git`). Case is spelled out
 * so the case-sensitive branch rule can use it; an option value never starts
 * with `-`, which keeps the repetition unambiguous (no backtracking blow-up).
 */
const GIT = String.raw`\b[Gg][Ii][Tt](?:\s+-[Cc]\s+[^\s-]\S*|\s+--(?:git-dir|work-tree|namespace)\s+[^\s-]\S*|\s+--?[a-zA-Z][\w-]*(?:=\S+)?)*\s+`
const git = (rest: string, flags = 'i'): RegExp => new RegExp(GIT + rest, flags)

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
    git(String.raw`reset\s+--hard\b`),
    git(String.raw`push\s+.*--force`),
    // Short force flag (alone or combined, e.g. `-uf`) and `+ref` force refspecs.
    git(String.raw`push\b[^|;&]*\s-[a-z]*f[a-z]*\b`),
    git(String.raw`push\b[^|;&]*\s(?:\S+:)?\+\S`),
    git(String.raw`clean\s+.*-f`),
    // `git rm` without --cached deletes working-tree files (the matcher
    // rewrites its verb to `gitrm`; `--cached` only untracks and is not matched).
    /\bgitrm\b/i,
    // Force delete only: `-D` (alone or combined) or `--delete --force`.
    // Case-sensitive on the flag: `-d` is the safe, merged-only delete.
    git(String.raw`branch\b[^|;&]*\s-[a-zA-Z]*D\b`, ''),
    git(String.raw`branch\b[^|;&]*\s(?:--delete\b[^|;&]*\s(?:--force|-f)\b|(?:--force|-f)\b[^|;&]*\s(?:--delete|-d)\b)`),
    git(String.raw`stash\s+(clear|drop)\b`),
    git(String.raw`restore\b(?![^|]*--staged)`),
    git(String.raw`checkout\s+--\s+\.`),
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
