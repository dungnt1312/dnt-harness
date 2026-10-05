import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Plugin } from 'vite'

/** Build-output files worth precaching with the offline app shell. */
const SHELL_FILE = /\.(js|css)$/

/** Text assets worth precompressing; below this the overhead wins. */
const COMPRESSIBLE = /\.(js|css|svg|json|webmanifest|txt|html)$/
const MIN_COMPRESS_BYTES = 1_024

/**
 * Emits `.gz` and `.br` twins for compressible build output. The web server
 * streams these precompressed bytes directly when the request's
 * `Accept-Encoding` allows — no per-request compression on the hot path.
 * Build-only: dev serves uncompressed in memory.
 */
export function precompressAssets(): Plugin {
  // Captured from the output options: `closeBundle` runs after the files are
  // written but receives no options of its own.
  let outDir: string | undefined
  return {
    name: 'dnt-harness-precompress-assets',
    apply: 'build',
    generateBundle(options) {
      outDir = options.dir
    },
    closeBundle() {
      if (outDir === undefined) return
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
            continue
          }
          if (!COMPRESSIBLE.test(entry.name) || statSync(full).size < MIN_COMPRESS_BYTES) continue
          const source = readFileSync(full)
          writeFileSync(`${full}.gz`, gzipSync(source, { level: 9 }))
          writeFileSync(`${full}.br`, brotliCompressSync(source, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY } }))
        }
      }
      walk(outDir)
    },
  }
}

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
