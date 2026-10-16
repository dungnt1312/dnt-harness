/**
 * Read-only Bash classification (ZCode-style): a command is read-only when
 * EVERY simple command in it is an allowlisted inspection program used with
 * allowlisted options, writes nothing, and names no path outside the
 * project folder. Anything the parser cannot analyze, any `$` expansion, any
 * write redirect, and any unknown program or option is "not read-only" —
 * the caller then asks as before. This is approval UX, not a sandbox.
 *
 * Path containment: arguments may not expand (`$`, unquoted glob or brace
 * characters), be absolute (except `/dev/null`),
 * start with `~`, contain a `..` segment, a backslash, or a Windows drive
 * prefix (`C:`), so an auto-allowed command
 * cannot read outside the folder Bash starts in. Symlinks inside the project
 * are not resolved (Bash never was confined by folder grants).
 */
import { parseShell, type ShellCommand, type ShellWord } from './shell-parse.ts'

/** Programs whose every option is read-only. */
const ANY_ARGS = new Set([
  'basename', 'cat', 'cmp', 'column', 'comm', 'cut', 'df', 'diff', 'dirname', 'du', 'echo', 'false',
  'grep', 'egrep', 'fgrep', 'head', 'hexdump', 'id', 'ls', 'md5', 'md5sum', 'nl', 'od', 'printf',
  'pwd', 'readlink', 'realpath', 'rev', 'sha1sum', 'sha256sum', 'sha512sum', 'shasum', 'stat', 'strings',
  'tail', 'tr', 'true', 'type', 'uname', 'wc', 'which', 'whoami',
])

/**
 * Programs that are read-only except for some options: `exact` names (also
 * as `--name=value`) and `letters`, short-option letters refused anywhere in
 * a combined short flag (`sort -uo out` writes `out`).
 */
const RESTRICTED: Readonly<Record<string, { readonly exact: readonly string[]; readonly letters?: string }>> = {
  sort: { exact: ['--output', '--compress-program'], letters: 'o' },
  tree: { exact: ['--fromfile'], letters: 'o' },
  file: { exact: ['--compile'], letters: 'C' },
  date: { exact: ['--set'], letters: 's' },
  rg: { exact: ['--pre', '--pre-glob', '--hostname-bin'] },
  find: { exact: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'] },
}

/** Read-only git subcommands (global options are refused separately). */
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog',
  'grep', 'cat-file', 'count-objects', 'merge-base', 'name-rev', 'rev-list', 'whatchanged', 'reflog',
])
/** Git options that write a file or run a configured program. */
const GIT_FORBIDDEN = ['--output', '--ext-diff', '--textconv', '--exec', '--open-files-in-pager']
/** Short letters with the same effect (`git grep -O` opens a pager program). */
const GIT_FORBIDDEN_LETTERS = 'O'

function isContainedPath(word: ShellWord): boolean {
  // A glob or brace word's real value is unknown (`[/]etc/passwd`, `{/etc/x,a}`).
  if (word.expands || word.glob) return false
  // Windows forms Git Bash resolves outside the project: a backslash
  // separator (`..\x`, `C:\x`, `\\server\share`) or a drive prefix (`C:x`).
  if (word.value.includes('\\')) return false
  if (word.value.split(/[=,]/).some((part) => /^[A-Za-z]:/.test(part))) return false
  for (const part of word.value.split(/[=:,]/)) {
    if (part === '/dev/null') continue
    if (part.startsWith('/') || part.startsWith('~')) return false
    if (/(^|\/)\.\.(\/|$)/.test(part)) return false
  }
  return true
}

function optionName(value: string): string {
  const eq = value.indexOf('=')
  return eq === -1 ? value : value.slice(0, eq)
}

function hasForbidden(args: readonly ShellWord[], exact: readonly string[], letters = ''): boolean {
  return args.some((word) => {
    const value = word.value
    if (exact.includes(optionName(value))) return true
    // A combined short flag (`-uo`, `-ofile`) carries every letter after `-`.
    return letters !== '' && /^-[^-]/.test(value) && [...value.slice(1)].some((letter) => letters.includes(letter))
  })
}

function gitReadOnly(args: readonly ShellWord[]): boolean {
  const [sub, ...rest] = args
  // No global options at all: `-c`, `-C`, `--git-dir`, `--exec-path` and
  // friends change which repo or which program runs.
  if (sub === undefined || sub.value.startsWith('-')) return false
  if (hasForbidden(rest, GIT_FORBIDDEN, GIT_FORBIDDEN_LETTERS)) return false
  const only = (allowed: readonly string[], prefixes: readonly string[] = []): boolean =>
    rest.every((word) => allowed.includes(word.value) || prefixes.some((prefix) => word.value.startsWith(prefix)))
  switch (sub.value) {
    // Listing forms only: a bare name would create a branch/tag.
    case 'branch':
      return only(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '--show-current', '--no-color', '--color'], ['--contains', '--merged', '--no-merged', '--sort=', '--format='])
    case 'tag':
      return only(['-l', '--list', '-n'], ['--sort=', '--contains', '--format='])
    case 'remote':
      return only(['-v', '--verbose'])
    case 'stash':
      return rest[0]?.value === 'list' || rest[0]?.value === 'show'
    case 'reflog':
      // `reflog expire|delete` rewrites history; `show` and plain listing do not.
      return rest[0] === undefined || rest[0].value === 'show' || rest[0].value.startsWith('-')
    default:
      return GIT_READ.has(sub.value)
  }
}

function commandReadOnly(command: ShellCommand): boolean {
  if (command.assignments.length > 0) return false
  for (const redirect of command.redirects) {
    // Input from a contained file, or output discarded / merged.
    if (/^\d*<$/.test(redirect.op)) {
      if (!isContainedPath(redirect.target)) return false
      continue
    }
    if (/^\d*>&$/.test(redirect.op) && /^\d+$/.test(redirect.target.value)) continue
    if (/^(\d*>|&>|\d*>>|&>>)$/.test(redirect.op) && redirect.target.value === '/dev/null' && !redirect.target.expands) continue
    return false
  }
  const [name, ...args] = command.words
  if (name === undefined) return command.redirects.length === 0
  if (name.expands || name.glob || name.value.includes('/')) return false
  if (!args.every(isContainedPath)) return false
  const program = name.value
  if (program === 'git') return gitReadOnly(args)
  const restricted = RESTRICTED[program]
  if (restricted !== undefined) return !hasForbidden(args, restricted.exact, restricted.letters)
  return ANY_ARGS.has(program)
}

/**
 * True only when the whole command line is provably read-only and contained
 * (see the module comment). Unknown is false.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const parsed = parseShell(command)
  if (parsed.unsupported || parsed.commands.length === 0) return false
  return parsed.commands.every(commandReadOnly)
}
