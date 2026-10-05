/**
 * Shell resolution, shared by every consumer that needs a real shell: the
 * `Bash` tool (captured output, agent-facing) and the web host's interactive
 * terminals (PTY, user-facing).
 *
 * It lives in one module on purpose. The hard cases here are portable Git
 * installs — Laragon, scoop, a relocated Program Files — and those are exactly
 * the machines where two independent copies of this logic would quietly
 * disagree about which shell the user is talking to.
 *
 * Bash means Bash: WSL launchers are deliberately skipped, and when nothing
 * resolves the caller receives `undefined` plus an actionable hint rather than
 * a silent substitution of some other shell.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** A resolved shell executable, or the reason none was found. */
export interface ShellDetection {
  readonly executable: string | undefined
  readonly hint: string
}

/** One shell the host can actually launch, as offered to a terminal client. */
export interface ShellOption {
  readonly id: ShellId
  readonly label: string
  readonly executable: string
  /** Arguments that put the shell in interactive mode under a PTY. */
  readonly args: readonly string[]
}

/** The shells this host knows how to launch. */
export type ShellId = 'zsh' | 'bash' | 'powershell' | 'cmd'

/** Locate a real bash. Checked in order: explicit option, env, known paths. */
export function detectShell(explicit?: string): ShellDetection {
  // An explicit executable is authoritative: if it is missing, the caller
  // learns that fact — silently falling back would run somewhere the operator
  // did not choose.
  if (explicit !== undefined && explicit !== '') {
    return existsSync(explicit)
      ? { executable: explicit, hint: explicit }
      : { executable: undefined, hint: `the configured bash '${explicit}' does not exist; fix it or set DNT_HARNESS_BASH` }
  }
  const candidates: string[] = []
  const fromEnv = process.env['DNT_HARNESS_BASH']?.trim()
  if (fromEnv !== undefined && fromEnv !== '') candidates.push(fromEnv)
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      `${process.env['LOCALAPPDATA'] ?? ''}\\Programs\\Git\\bin\\bash.exe`,
    )
  } else {
    candidates.push('/bin/bash', '/usr/bin/bash')
  }
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return { executable: candidate, hint: candidate }
  }
  if (process.platform === 'win32') {
    // Portable/odd Git installs (Laragon, scoop, ...): resolve bash relative
    // to the git.exe on PATH. WSL launchers (System32, WindowsApps) are
    // deliberately skipped — Bash means Git Bash here, not a remote VM.
    for (const locator of [['where', 'git'], ['where', 'bash']]) {
      const lookup = spawnSync(locator[0] as string, locator.slice(1) as string[], { encoding: 'utf8' })
      if (lookup.status !== 0) continue
      for (const raw of lookup.stdout.split('\n')) {
        const found = raw.trim()
        if (found === '' || !existsSync(found)) continue
        if (/system32|windowsapps/i.test(found)) continue
        if (locator[1] === 'bash') return { executable: found, hint: found }
        for (const rel of ['../bin/bash.exe', '../usr/bin/bash.exe']) {
          const bashPath = path.resolve(found, rel)
          if (existsSync(bashPath)) return { executable: bashPath, hint: bashPath }
        }
      }
    }
    return {
      executable: undefined,
      hint: 'install Git Bash (https://git-scm.com) or point DNT_HARNESS_BASH at a bash.exe',
    }
  }
  // Last resort on PATH (POSIX `bash`).
  return { executable: 'bash', hint: 'bash on PATH' }
}

/**
 * Locate the macOS zsh — the platform's default login shell, so a web
 * terminal should lead with it there. Checked in order: the account's login
 * shell from `dscl` when it is a zsh (respects `chsh`, and picks up a
 * Homebrew zsh's exact path), then the well-known path, then `zsh` on PATH.
 */
function detectZsh(): ShellDetection {
  const lookup = spawnSync('dscl', ['.', '-read', `/Users/${process.env['USER'] ?? ''}`, 'UserShell'], { encoding: 'utf8' })
  if (lookup.status === 0) {
    const match = /UserShell:\s*(\S+)/.exec(lookup.stdout)
    const login = match?.[1]
    if (login !== undefined && login.endsWith('/zsh') && existsSync(login)) return { executable: login, hint: login }
  }
  if (existsSync('/bin/zsh')) return { executable: '/bin/zsh', hint: '/bin/zsh' }
  return { executable: 'zsh', hint: 'zsh on PATH' }
}

/**
 * The shells that exist on this host, for a terminal client's picker.
 *
 * Only resolvable shells are listed: a picker that offers `powershell` on
 * Linux, or `bash` on a Windows box without Git, would be offering a failure.
 * The client renders whatever this returns and never hardcodes a list.
 */
export function shellCatalog(): ShellOption[] {
  // Memoized: resolution can fall back to two synchronous `where` probes, and
  // this is called on every terminal list and create. Blocking the event loop
  // per request to re-discover shells that do not move is not a trade worth
  // making; the Bash tool likewise resolves once, at registration.
  if (catalogCache === undefined) catalogCache = buildShellCatalog()
  return [...catalogCache]
}

let catalogCache: ShellOption[] | undefined

function buildShellCatalog(): ShellOption[] {
  const options: ShellOption[] = []
  // The user's login shell leads the picker: a web terminal that opens
  // something other than what Terminal.app opens answers a question the user
  // did not ask. The Bash tool keeps its own bash resolution.
  if (process.platform === 'darwin') {
    const zsh = detectZsh()
    if (zsh.executable !== undefined) {
      options.push({ id: 'zsh', label: 'zsh', executable: zsh.executable, args: ['-i'] })
    }
  }
  const bash = detectShell()
  if (bash.executable !== undefined) {
    // `-i` gives the interactive prompt and job control a PTY user expects;
    // the Bash tool's `-lc` form is for one captured command, not a session.
    // "Git Bash" is the Windows distribution; POSIX machines run system bash
    // (or whatever DNT_HARNESS_BASH pins), so the label says only Bash.
    const label = process.platform === 'win32' ? 'Git Bash' : 'Bash'
    options.push({ id: 'bash', label, executable: bash.executable, args: ['-i'] })
  }
  if (process.platform === 'win32') {
    const system = process.env['SystemRoot'] ?? 'C:\\Windows'
    const powershell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(powershell)) {
      options.push({ id: 'powershell', label: 'PowerShell', executable: powershell, args: [] })
    }
    const cmd = path.join(system, 'System32', 'cmd.exe')
    if (existsSync(cmd)) {
      options.push({ id: 'cmd', label: 'Command Prompt', executable: cmd, args: [] })
    }
  }
  return options
}
