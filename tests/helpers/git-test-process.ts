import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { buildGitCommand, type GitResult } from '../../src/web/project-git.ts'

/** Fixture config only: never consult the developer's helpers or signing settings. */
export function isolatedGitEnvironment(base: NodeJS.ProcessEnv, globalConfig: string): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !/^GIT_(CONFIG(?:_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+))?|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(entry[0]))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  }
}

/** Git interprets helper/hook commands with a POSIX shell, including on Windows. */
export function gitShellPath(file: string): string {
  return `'${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function killProbeTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => {
        // Exit 128: part of the tree had already exited. That is the goal,
        // not a failure, as long as the root itself is gone.
        if (error === null || (error as { code?: unknown }).code === 128 && !isAlive(child.pid!)) resolve()
        else reject(error)
      })
    })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

/** A test timeout must not leave Git or its credential helpers waiting for UI. */
export async function credentialProbe(
  root: string,
  trusted: boolean,
  env: Readonly<Record<string, string>>,
  timeoutMs = 5000,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let failure: Error | undefined
    let cleanup: Promise<void> | undefined
    let closed = false
    let onClosed: (() => void) | undefined
    const close = new Promise<void>((resolve) => { onClosed = resolve })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const stop = (child: ChildProcessWithoutNullStreams, error: Error): void => {
      clearTimeout(timer)
      failure ??= error
      cleanup ??= (async () => {
        await killProbeTree(child)
        // taskkill can finish before Windows releases the working directory.
        if (closed) return
        await new Promise<void>((resolve, reject) => {
          const drainTimer = setTimeout(() => reject(new Error('credential probe pipes did not close after tree termination')), 2000)
          void close.then(() => { clearTimeout(drainTimer); resolve() })
        })
      })()
      // Do not rely on `close`: an escaped helper can keep Git's pipes open
      // even after Git has exited. taskkill has its own bounded deadline.
      void cleanup.then(() => reject(failure), (cleanupError: unknown) => {
        child.stdout.destroy()
        child.stderr.destroy()
        reject(new AggregateError([failure, cleanupError], `credential probe process-tree cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`))
      })
    }
    void buildGitCommand(root, ['credential', 'fill'], {
      trusted, env, detached: true,
      onSpawn(child) {
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.stdin.on('error', (error) => stop(child, error))
        child.on('close', () => {
          closed = true
          onClosed?.()
          clearTimeout(timer)
          void (async () => {
            await cleanup
            if (failure !== undefined) throw failure
            if (child.exitCode === null) throw new Error('credential probe exited without an exit code')
            resolve({ code: child.exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
          })().catch(reject)
        })
        timer = setTimeout(() => stop(child, new Error(`credential probe timed out after ${timeoutMs}ms`)), timeoutMs)
        child.stdin.end('protocol=https\nhost=example.invalid\n\n')
      },
    }).catch(reject)
  })
}
