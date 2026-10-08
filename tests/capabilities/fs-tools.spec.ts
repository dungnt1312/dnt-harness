/**
 * Filesystem capability tools against a temp workspace: read/write/edit
 * round-trips (canonical names), read windows, observed-state conflict
 * detection, ambiguous-edit rejection, glob/grep discovery, and the full
 * containment contract — lexical escapes, symlink/junction escapes,
 * creation-path checks, and denied application storage.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fsTools, type ToolDefinition, type ToolExecution } from 'dnt-harness'
import { defaultSecretRoots } from '../../src/capabilities/fs/secret-roots.ts'

let root = ''
let outside = ''
let tools: Map<string, ToolDefinition>

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-fs-'))
  outside = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-fs-out-'))
  tools = new Map(fsTools().map((tool) => [tool.name, tool]))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

function tool(name: string): ToolDefinition {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`test setup: missing tool '${name}'`)
  return definition
}

function exec(extra: Partial<ToolExecution> = {}): ToolExecution {
  return { root, ...extra }
}

function shaOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

describe('fs tools', () => {
  it('Write creates parent directories and Read returns the content', async () => {
    const result = await tool('Write').execute({ path: 'src/app.ts', content: 'export const x = 1\n' }, exec())
    expect(result).toBe('created src/app.ts (1 lines)')
    const content = await tool('Read').execute({ path: 'src/app.ts' }, exec())
    expect(content).toBe('1\texport const x = 1')
  })

  it('Write distinguishes overwrite from creation and honors a fresh expectedSha256', async () => {
    const overwritten = await tool('Write').execute({ path: 'src/app.ts', content: 'v2\n', expectedSha256: shaOf('export const x = 1\n') }, exec())
    expect(overwritten).toContain('overwrote src/app.ts')
  })

  it('Write with a stale expectedSha256 refuses to clobber external edits', async () => {
    await fs.writeFile(path.join(root, 'conflict.txt'), 'current bytes', 'utf8')
    await expect(
      tool('Write').execute({ path: 'conflict.txt', content: 'mine', expectedSha256: shaOf('older bytes') }, exec()),
    ).rejects.toThrow(/conflict/)
    expect(await fs.readFile(path.join(root, 'conflict.txt'), 'utf8')).toBe('current bytes')
  })

  it('Edit replaces the single occurrence and fails loud when absent', async () => {
    await tool('Write').execute({ path: 'notes.md', content: 'alpha beta gamma\n' }, exec())
    await tool('Edit').execute({ path: 'notes.md', old: 'beta', new: 'BETA', expectedSha256: shaOf('alpha beta gamma\n') }, exec())

    const updated = await tool('Read').execute({ path: 'notes.md' }, exec())
    expect(updated).toBe('1\talpha BETA gamma')

    await expect(tool('Edit').execute({ path: 'notes.md', old: 'missing', new: 'x', expectedSha256: shaOf('alpha BETA gamma\n') }, exec())).rejects.toThrow(/not found/)
  })

  it('Edit rejects ambiguous matches instead of replacing the first', async () => {
    await tool('Write').execute({ path: 'dup.txt', content: 'same same\n' }, exec())
    await expect(tool('Edit').execute({ path: 'dup.txt', old: 'same', new: 'x', expectedSha256: shaOf('same same\n') }, exec())).rejects.toThrow(/ambiguous/)
    expect(await fs.readFile(path.join(root, 'dup.txt'), 'utf8')).toBe('same same\n')
  })

  it('Edit with a stale expectedSha256 leaves the target unchanged', async () => {
    await fs.writeFile(path.join(root, 'edit-conflict.txt'), 'live content', 'utf8')
    await expect(
      tool('Edit').execute(
        { path: 'edit-conflict.txt', old: 'live', new: 'dead', expectedSha256: shaOf('stale') },
        exec(),
      ),
    ).rejects.toThrow(/conflict/)
    expect(await fs.readFile(path.join(root, 'edit-conflict.txt'), 'utf8')).toBe('live content')
  })

  it('Read supports a 1-based line window and reports missing files clearly', async () => {
    await tool('Write').execute({ path: 'lines.txt', content: 'one\ntwo\nthree\nfour\n' }, exec())
    const window = await tool('Read').execute({ path: 'lines.txt', offset: 2, limit: 2 }, exec())
    expect(window).toBe('2\ttwo\n3\tthree\n… [showing lines 2-3 of 4; continue with offset 4]')

    await expect(tool('Read').execute({ path: 'nope.ts' }, exec())).rejects.toThrow(/no such file/)
  })

  it('Glob matches * within a segment and ** across segments', async () => {
    await tool('Write').execute({ path: 'src/deep/util.ts', content: 'x' }, exec())
    await tool('Write').execute({ path: 'docs/guide.md', content: 'x' }, exec())

    const ts = await tool('Glob').execute({ pattern: '**/*.ts' }, exec())
    expect(ts.split('\n').sort()).toEqual(['src/app.ts', 'src/deep/util.ts'])

    const shallow = await tool('Glob').execute({ pattern: 'src/*' }, exec())
    expect(shallow.split('\n').sort()).toEqual(['src/app.ts'])
  })

  it('Grep returns path:line: text matches across the workspace', async () => {
    await tool('Write').execute({ path: 'src/findme.ts', content: 'const target = 1\nconst other = 2\n' }, exec())
    const hits = await tool('Grep').execute({ pattern: 'target' }, exec())
    expect(hits).toContain('src/findme.ts:1: const target = 1')
    expect(hits).not.toContain('other')

    const none = await tool('Grep').execute({ pattern: 'no-such-token-anywhere' }, exec())
    expect(none).toBe('no matches')
  })

  it('Grep stops a catastrophically backtracking pattern instead of freezing the host', async () => {
    await fs.mkdir(path.join(root, 'redos'), { recursive: true })
    await fs.writeFile(path.join(root, 'redos', 'evil.txt'), `${'a'.repeat(40)}!\n`, 'utf8')
    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 50)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    try {
      await expect(tool('Grep').execute({ pattern: '^(a+)+$', path: 'redos' }, exec({ signal: controller.signal }))).rejects.toThrow(/cancelled/)
    } finally {
      clearInterval(ticker)
    }
    // The event loop kept running while the worker backtracked.
    expect(ticks).toBeGreaterThan(3)
  }, 15_000)

  it('Grep rejects an invalid pattern and does not search binary files', async () => {
    await expect(tool('Grep').execute({ pattern: '(' }, exec())).rejects.toThrow(/Invalid regular expression/)
    await fs.mkdir(path.join(root, 'bin'), { recursive: true })
    await fs.writeFile(path.join(root, 'bin', 'blob.dat'), Buffer.from([0x62, 0x69, 0x6e, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]))
    expect(await tool('Grep').execute({ pattern: 'binneedle', path: 'bin' }, exec())).toBe('no matches')
  })

  it('Read refuses a file over the size limit before loading it', async () => {
    const big = path.join(root, 'huge.log')
    const handle = await fs.open(big, 'w')
    await handle.truncate(33 * 1024 * 1024)
    await handle.close()
    await expect(tool('Read').execute({ path: 'huge.log' }, exec())).rejects.toThrow(/MiB file-tool limit/)
    await fs.rm(big)
  })

  it('Glob skips default-ignored folders, and still searches them on demand', async () => {
    await tool('Write').execute({ path: 'node_modules/pkg/index.js', content: 'x' }, exec())
    await tool('Write').execute({ path: 'dist/bundle.js', content: 'x' }, exec())
    await tool('Write').execute({ path: '.git/hooks/pre-commit', content: 'x' }, exec())
    await tool('Write').execute({ path: 'src/keep.ts', content: 'x' }, exec())

    expect(await tool('Glob').execute({ pattern: '**/*.js' }, exec())).toBe('no matches')

    const tree = await tool('Glob').execute({ pattern: '**/*' }, exec())
    expect(tree).toContain('src/keep.ts')
    expect(tree).not.toContain('node_modules')
    expect(tree).not.toContain('dist/')
    expect(tree).not.toContain('.git/')

    const flagged = await tool('Glob').execute({ pattern: '**/*.js', includeIgnored: true }, exec())
    expect(flagged.split('\n').sort()).toEqual(['dist/bundle.js', 'node_modules/pkg/index.js'])

    // A pattern naming an ignored folder explicitly searches inside it.
    const named = await tool('Glob').execute({ pattern: '**/node_modules/**/*.js' }, exec())
    expect(named).toContain('node_modules/pkg/index.js')

    // So does pointing the search itself at the folder.
    const targeted = await tool('Glob').execute({ pattern: 'pkg/*.js', path: 'node_modules' }, exec())
    expect(targeted).toBe('node_modules/pkg/index.js')

    await expect(tool('Glob').execute({ pattern: '*', includeIgnored: 'yes' }, exec())).rejects.toThrow(/boolean/)
  })

  it('Grep skips default-ignored folders unless includeIgnored or a targeted path', async () => {
    await tool('Write').execute({ path: 'node_modules/pkg/hint.js', content: 'const needle = 7\n' }, exec())

    expect(await tool('Grep').execute({ pattern: 'needle' }, exec())).toBe('no matches')

    const flagged = await tool('Grep').execute({ pattern: 'needle', includeIgnored: true }, exec())
    expect(flagged).toContain('node_modules/pkg/hint.js:1')

    const targeted = await tool('Grep').execute({ pattern: 'needle', path: 'node_modules' }, exec())
    expect(targeted).toContain('node_modules/pkg/hint.js:1')
  })

  it('Glob marks truncation beyond the result cap', async () => {
    for (let i = 0; i < 105; i++) {
      await tool('Write').execute({ path: `bulk/file-${String(i).padStart(3, '0')}.txt`, content: 'x' }, exec())
    }
    const lines = (await tool('Glob').execute({ pattern: 'bulk/*.txt' }, exec())).split('\n')
    expect(lines).toHaveLength(101)
    expect(lines[100]).toMatch(/\[\+5 more/)
  })

  it('lexical escapes of the root are rejected', async () => {
    await expect(tool('Read').execute({ path: '../../etc/hostname' }, exec())).rejects.toThrow(/escapes the workspace root/)
    await expect(tool('Write').execute({ path: '/etc/passwd', content: 'x' }, exec())).rejects.toThrow(/escapes the workspace root/)
  })

  it('a symlink/junction pointing outside the root is rejected, including as a creation path', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8')
    await fs.symlink(outside, path.join(root, 'leak'), 'junction')
    await expect(tool('Read').execute({ path: 'leak/secret.txt' }, exec())).rejects.toThrow(/escapes the workspace root/)
    // Creation through the link would land outside: refused too.
    await expect(tool('Write').execute({ path: 'leak/planted.txt', content: 'x' }, exec())).rejects.toThrow(/escapes the workspace root/)
  })

  it('Read output honors the execution output limit with an explicit marker', async () => {
    await tool('Write').execute({ path: 'big.txt', content: 'x'.repeat(50_000) }, exec())
    const output = await tool('Read').execute({ path: 'big.txt' }, exec({ outputLimit: 1_000 }))
    expect(output.length).toBeLessThan(2_000)
    expect(output).toMatch(/truncated/)
  })

  it('denied roots (application-internal storage) are refused even under the workspace', async () => {
    const dataDir = path.join(root, '.internal')
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'events.jsonl'), 'secret records', 'utf8')
    const guarded = exec({ deniedRoots: [dataDir] })
    await expect(tool('Read').execute({ path: '.internal/events.jsonl' }, guarded)).rejects.toThrow(/application-internal storage/)
    await expect(tool('Write').execute({ path: '.internal/events.jsonl', content: 'x' }, guarded)).rejects.toThrow(/application-internal storage/)
    await expect(tool('Grep').execute({ pattern: 'secret' }, guarded)).resolves.toBe('no matches')
    // Outside the denied root everything still works.
    await expect(tool('Read').execute({ path: 'src/app.ts' }, guarded)).resolves.toBe('1\tv2')
  })

  it('default secret roots refuse credential files even when the out-of-grant path was approved', async () => {
    const fakeHome = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-home-'))
    try {
      await fs.mkdir(path.join(fakeHome, '.ssh'), { recursive: true })
      const key = path.join(fakeHome, '.ssh', 'id_ed25519')
      await fs.writeFile(key, 'PRIVATE KEY', 'utf8')
      const netrc = path.join(fakeHome, '.netrc')
      await fs.writeFile(netrc, 'machine x password y', 'utf8')
      const secretRoots = defaultSecretRoots(fakeHome)
      // Full access (`outOfGrant: allow`) or an approval lands as an approved path.
      const approved = exec({ deniedRoots: secretRoots, approvedPaths: [{ path: key, intent: 'write' }, { path: netrc, intent: 'write' }] })
      await expect(tool('Read').execute({ path: key }, approved)).rejects.toThrow(/protected credential folder/)
      await expect(tool('Write').execute({ path: key, content: 'x' }, approved)).rejects.toThrow(/protected credential folder/)
      await expect(tool('Read').execute({ path: netrc }, approved)).rejects.toThrow(/protected credential folder/)
      expect(await fs.readFile(key, 'utf8')).toBe('PRIVATE KEY')
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })
})
