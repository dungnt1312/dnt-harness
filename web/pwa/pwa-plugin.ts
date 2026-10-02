import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

/** Build-output files worth precaching with the offline app shell. */
const SHELL_FILE = /\.(js|css)$/

/**
 * Emits `sw.js` at the build root from `service-worker.js`, filled with a
 * content-derived version and the shell file list. Build-only: the dev
 * server never registers a worker.
 */
export function pwaServiceWorker(): Plugin {
  return {
    name: 'dnt-harness-pwa-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')
      const hash = createHash('sha256').update(template)
      // index.html joins the bundle after this hook runs; its content follows the hashed entries below.
      const shell: string[] = ['/index.html']
      for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(fileName)
        hash.update(output.type === 'chunk' ? output.code : output.source)
        if (SHELL_FILE.test(fileName)) shell.push(`/${fileName}`)
      }
      const source = template
        .replace('__PWA_VERSION__', hash.digest('hex').slice(0, 16))
        .replace('__PWA_PRECACHE__', JSON.stringify(shell))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}
