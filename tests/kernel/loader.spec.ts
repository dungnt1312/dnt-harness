/**
 * YAML composition loader: parse validation and booting a plugin tree from a
 * cordis.yml-style file through dynamic import.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Kernel, bootFromFile, parseConfig } from 'dnt-harness'

const fixturesUrl = new URL('../fixtures/', import.meta.url)

describe('parseConfig', () => {
  it('parses a list of entries', () => {
    const entries = parseConfig("- name: './hello.ts'\n- name: './x.ts'\n  disabled: true\n")
    expect(entries).toEqual([
      { name: './hello.ts' },
      { name: './x.ts', disabled: true },
    ])
  })

  it('rejects a non-array root', () => {
    expect(() => parseConfig('name: ./hello.ts')).toThrow(/list of plugin entries/)
  })

  it('rejects a row without a name', () => {
    expect(() => parseConfig('- config: {}')).toThrow(/needs a non-empty string name/)
  })

  it('rejects a non-boolean disabled field', () => {
    expect(() => parseConfig('- name: ./x.ts\n  disabled: maybe\n')).toThrow(/non-boolean disabled/)
  })
})

describe('bootFromFile', () => {
  it('mounts the tree from cordis.yml, skipping disabled rows', async () => {
    const kernel = new Kernel()

    const fibers = await bootFromFile(kernel, fileURLToPath(new URL('app.yml', fixturesUrl)))
    expect(fibers.length).toBe(3)

    // hello.ts provided its service
    expect(kernel.ctx.get('helloValue')).toBe('hello from fixture')

    // consumer (injects greeter) ran and published what it saw
    expect(kernel.ctx.get('consumerSaw')).toBe('Hello, world!')

    // the disabled entry never loaded
    expect(kernel.ctx.get('shouldNotExist')).toBeUndefined()

    await kernel.stop()
  })
})
