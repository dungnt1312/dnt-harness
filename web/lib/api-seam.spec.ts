import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
/** The one module allowed to call the network directly: it owns credentials and CSRF. */
const SEAM = path.join(webRoot, 'lib', 'api.ts')

function sources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...sources(full))
    else if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) found.push(full)
  }
  return found
}

describe('control-plane client seam', () => {
  it('routes every REST call and event stream through web/lib/api.ts', () => {
    // A direct fetch/EventSource elsewhere would skip the CSRF header and the
    // actionable 401/403 handling that apiFetch() applies to every request.
    const offenders = sources(webRoot)
      .filter((file) => file !== SEAM)
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
        /\bfetch\(|new EventSource\(|XMLHttpRequest|navigator\.sendBeacon\(/.test(line)
          ? [`${path.relative(webRoot, file)}:${index + 1}: ${line.trim()}`]
          : []))
    expect(offenders).toEqual([])
  })
})
