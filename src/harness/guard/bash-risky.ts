/**
 * Risky-command detection for the Autonomous mode (ZCode "guarded"): a
 * structural match, on parsed words rather than regexes, for shell commands
 * that destroy data in bulk. A match turns an allowed Bash call into a
 * per-call approval; no match changes nothing. It complements, never
 * replaces, the workspace Dangerous Commands guard, which keeps applying.
 *
 * Wrappers (`env`, `sudo`, `time`, `nohup`, `nice`, `command`, `xargs`) are
 * unwrapped, and a `sh|bash|zsh -c '<literal>'` payload is analyzed as its
 * own command line. A line the parser cannot analyze still asks when it
 * mentions a bulk-delete program at all, since its real arguments are
 * unknowable here.
 */
import { parseShell, type ShellWord } from './shell-parse.ts'
import { maskDataText } from './data-text.ts'

export interface RiskyMatch {
  /** Stable rule id, e.g. `git-reset-hard`. */
  readonly ruleId: string
  /** Human label for the approval card. */
  readonly label: string
}

const LABELS: Readonly<Record<string, string>> = {
  'remove-bulk': 'recursive or bulk rm',
  'system-storage': 'disk or mount tool',
  'rsync-delete': 'rsync --delete',
  'find-delete': 'find -delete / -exec rm',
  'git-reset-hard': 'git reset --hard',
  'git-clean-force': 'git clean -f',
  'git-push-force': 'forced git push',
  'git-discard-tree': 'discarding working-tree changes',
  'git-stash-clear': 'git stash clear',
  'git-worktree-force-remove': 'git worktree remove --force',
  'git-branch-force-delete': 'git branch -D',
  'unanalyzable-delete': 'a delete command whose arguments cannot be analyzed',
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const MAX_DEPTH = 3

type Words = readonly ShellWord[]

/** Short flags as letters, long flags by name (`--force=x` → `--force`). */
function flagSet(args: Words): { letters: Set<string>; long: Set<string>; operands: ShellWord[] } {
  const letters = new Set<string>()
  const long = new Set<string>()
  const operands: ShellWord[] = []
  let ended = false
  for (const word of args) {
    const value = word.value
    if (ended || !value.startsWith('-') || value === '-') operands.push(word)
    else if (value === '--') ended = true
    else if (value.startsWith('--')) long.add(value.split('=')[0]!)
    else for (const letter of value.slice(1)) letters.add(letter)
  }
  return { letters, long, operands }
}

/** Options that take a value, per wrapper; unknown options stop unwrapping. */
const WRAPPER_VALUES: Readonly<Record<string, readonly string[]>> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-T', '--command-timeout'],
  time: ['-o', '--output', '-f', '--format'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  command: [],
  xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines'],
}

/** Strip wrappers; `undefined` when a wrapper's options cannot be followed. */
function unwrap(words: Words): { words: Words; viaXargs: boolean } | undefined {
  let rest = words
  let viaXargs = false
  for (let guard = 0; guard < 8; guard++) {
    const name = rest[0]
    if (name === undefined) return undefined
    const values = WRAPPER_VALUES[name.value]
    if (values === undefined) return { words: rest, viaXargs }
    if (name.value === 'xargs') viaXargs = true
    let i = 1
    while (i < rest.length) {
      const value = rest[i]!.value
      if (value === '--') { i++; break }
      if (!value.startsWith('-')) {
        if ((name.value === 'env' || name.value === 'sudo') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { i++; continue }
        break
      }
      if (values.includes(value)) { i += 2; continue }
      // Attached value (`-n10`, `--user=x`) or a flag that takes none.
      i++
    }
    rest = rest.slice(i)
  }
  return undefined
}

function gitMatch(args: Words): string | undefined {
  let i = 0
  // Global options: value-taking ones skip their value.
  while (i < args.length && args[i]!.value.startsWith('-')) {
    const value = args[i]!.value
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(value) ? 2 : 1
  }
  const sub = args[i]?.value
  const { letters, long, operands } = flagSet(args.slice(i + 1))
  const has = (short: string, ...names: string[]): boolean => (short !== '' && letters.has(short)) || names.some((name) => long.has(name))
  const help = has('h', '--help')
  if (help) return undefined
  const dryRun = has('n', '--dry-run')
  const tree = operands.some((word) => !word.expands && ['.', './', ':/', '*'].includes(word.value))
  switch (sub) {
    case 'reset':
      return long.has('--hard') ? 'git-reset-hard' : undefined
    case 'clean':
      return !dryRun && has('f', '--force') ? 'git-clean-force' : undefined
    case 'push':
      return !dryRun && (has('f', '--force', '--force-with-lease', '--mirror') || operands.slice(1).some((word) => word.value.startsWith('+')))
        ? 'git-push-force' : undefined
    case 'checkout':
      return has('f', '--force') || tree ? 'git-discard-tree' : undefined
    case 'restore': {
      const stagedOnly = has('S', '--staged') && !has('W', '--worktree')
      return !stagedOnly && tree ? 'git-discard-tree' : undefined
    }
    case 'stash':
      return operands[0]?.value === 'clear' ? 'git-stash-clear' : undefined
    case 'worktree':
      return operands[0]?.value === 'remove' && has('f', '--force') ? 'git-worktree-force-remove' : undefined
    case 'branch':
      return letters.has('D') || (has('d', '--delete') && has('f', '--force')) ? 'git-branch-force-delete' : undefined
    default:
      return undefined
  }
}

function invocationMatch(input: Words, depth: number): string | undefined {
  const unwrapped = unwrap(input)
  if (unwrapped === undefined) return undefined
  const [nameWord, ...args] = unwrapped.words
  if (nameWord === undefined) return undefined
  const name = nameWord.value.split('/').pop() ?? nameWord.value
  if (SHELLS.has(name)) {
    const c = args.findIndex((word) => word.value === '-c' || /^-[a-z]*c$/.test(word.value))
    const payload = c === -1 ? undefined : args[c + 1]
    if (payload === undefined || depth >= MAX_DEPTH) return undefined
    return lineMatch(payload.value, depth + 1)?.ruleId
  }
  const { letters, long, operands } = flagSet(args)
  switch (name) {
    case 'rm':
      // xargs supplies operands at run time: always a bulk delete.
      return unwrapped.viaXargs || letters.has('r') || letters.has('R') || long.has('--recursive')
        || operands.length >= 2 || operands.some((word) => word.glob || word.expands)
        ? 'remove-bulk' : undefined
    case 'dd': case 'mount': case 'umount': case 'diskutil': case 'shred': case 'wipefs': case 'fdisk': case 'parted':
      if (args.length === 1 && ['--help', '--version'].includes(args[0]!.value)) return undefined
      return name === 'mount' && args.length === 0 ? undefined : 'system-storage'
    case 'rsync':
      return !letters.has('n') && !long.has('--dry-run') && [...long].some((flag) => flag.startsWith('--del')) ? 'rsync-delete' : undefined
    case 'find': {
      if (args.some((word) => word.value === '-delete')) return 'find-delete'
      const exec = args.findIndex((word) => ['-exec', '-execdir', '-ok', '-okdir'].includes(word.value))
      return exec !== -1 && ['rm', 'shred', 'unlink'].includes(args[exec + 1]?.value ?? '') ? 'find-delete' : undefined
    }
    case 'git':
      return gitMatch(args)
    default:
      return /^mkfs(\.[A-Za-z0-9_-]+)?$/.test(name) ? 'system-storage' : undefined
  }
}

function lineMatch(rawCommand: string, depth: number): RiskyMatch | null {
  // Commit messages and data heredocs are not commands (see data-text.ts).
  const command = maskDataText(rawCommand)
  const parsed = parseShell(command)
  if (parsed.unsupported) {
    // Substitutions, subshells, heredocs: arguments unknowable. Ask only when
    // a bulk-delete program appears at all.
    return /(^|[\s;&|(`$])(rm|rmdir|dd|shred|mkfs(\.\w+)?|eval)(?=$|[\s;&|)`])/.test(command)
      ? { ruleId: 'unanalyzable-delete', label: LABELS['unanalyzable-delete']! }
      : null
  }
  for (const invocation of parsed.commands) {
    const ruleId = invocationMatch(invocation.words, depth)
    if (ruleId !== undefined) return { ruleId, label: LABELS[ruleId] ?? ruleId }
  }
  return null
}

/** The first risky invocation in a Bash command line, or null. */
export function matchRiskyCommand(command: string): RiskyMatch | null {
  return lineMatch(command, 0)
}
