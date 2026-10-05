import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { precompressAssets, pwaServiceWorker } from './web/pwa/pwa-plugin.ts'

export default defineConfig(({ command }) => {
  // An inherited `NODE_ENV=development` silently produces a dev React bundle
  // whose `import.meta.env.PROD` guard makes `registerServiceWorker()` a no-op,
  // so the browser never sees a service worker and hides the install icon.
  if (command === 'build') process.env.NODE_ENV = 'production'
  return {
    root: 'web',
    base: '/',
    plugins: [react(), tailwindcss(), pwaServiceWorker(), precompressAssets()],
    build: {
      outDir: '../web-dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Framework and renderer libraries change far less often than the app
          // code: their chunks stay cached across releases, and the immutable
          // asset headers make that stick. Xterm is isolated so only terminal
          // users pay for it (the panel itself stays lazy).
          //
          // Match on the real package name (innermost node_modules segment),
          // never on raw substrings: pnpm virtual-store dir names embed peer
          // suffixes like `@radix-ui+react-switch@1.3.7_@types+react-dom@…`,
          // so `id.includes('react-dom')` routed radix modules into
          // react-vendor, created a react-vendor <-> radix-vendor import
          // cycle, and crashed the app at boot with
          // "Cannot read properties of undefined (reading 'useLayoutEffect')".
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            const nm = id.lastIndexOf('node_modules/')
            const rest = id.slice(nm + 'node_modules/'.length)
            const pkg = rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0]
            if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'react-vendor'
            if (pkg === 'xterm' || pkg.startsWith('@xterm/')) return 'xterm-vendor'
            if (pkg === 'radix-ui' || pkg.startsWith('@radix-ui/')) return 'radix-vendor'
            const markdownExact = ['react-markdown', 'unified', 'vfile', 'property-information', 'comma-separated-tokens', 'decode-named-character-reference', 'trim-lines', 'devlop']
            const markdownPrefixes = ['remark', 'micromark', 'mdast', 'hast', 'unist', 'character-entities']
            if (markdownExact.includes(pkg) || markdownPrefixes.some((p) => pkg.startsWith(p))) return 'markdown-vendor'
            return undefined
          },
        },
      },
    },
  }
})
