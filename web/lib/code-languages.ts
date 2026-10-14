import type { Extension } from '@codemirror/state'
import type { StreamParser } from '@codemirror/language'
import { languageOfFile } from './highlight.ts'

/**
 * CodeMirror language support for the workbench editor. Every pack is a
 * dynamic import, so Vite splits each into its own chunk and a file only pays
 * for the grammar it opens. The language *name* comes from `languageOfFile`
 * (the same table the chat code blocks use), so both surfaces agree on what a
 * file is; the extension only refines it (`.tsx` needs JSX, `.mts` does not).
 */
type Loader = (fileName: string) => Promise<Extension>

const extensionOf = (fileName: string): string => fileName.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''

const legacy = async (load: () => Promise<StreamParser<unknown>>): Promise<Extension> => {
  const { StreamLanguage } = await import('@codemirror/language')
  return StreamLanguage.define(await load())
}

const LOADERS: Readonly<Record<string, Loader>> = {
  typescript: async (name) => {
    const ext = extensionOf(name)
    return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: ext === 'tsx' })
  },
  javascript: async (name) => {
    const ext = extensionOf(name)
    return (await import('@codemirror/lang-javascript')).javascript({ jsx: ext === 'jsx' || ext === 'js' || ext === 'mjs' || ext === 'cjs' })
  },
  json: async () => (await import('@codemirror/lang-json')).json(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  css: async (name) => {
    const ext = extensionOf(name)
    if (ext === 'scss' || ext === 'sass') return legacy(async () => (await import('@codemirror/legacy-modes/mode/css')).sCSS)
    if (ext === 'less') return legacy(async () => (await import('@codemirror/legacy-modes/mode/css')).less)
    return (await import('@codemirror/lang-css')).css()
  },
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  xml: async (name) => {
    const ext = extensionOf(name)
    if (ext === 'xml' || ext === 'svg') return (await import('@codemirror/lang-xml')).xml()
    return (await import('@codemirror/lang-html')).html()
  },
  python: async () => (await import('@codemirror/lang-python')).python(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  bash: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  kotlin: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  csharp: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp),
  swift: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift),
  ruby: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  dockerfile: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
  ini: async (name) => {
    const ext = extensionOf(name)
    if (ext === 'toml') return legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml)
    return legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties)
  },
  diff: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
  powershell: async () => legacy(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
}

const cache = new Map<string, Promise<Extension | null>>()

/** The language extension for `fileName`, or null when it has none (plain text, unknown formats). */
export function loadCodeLanguage(fileName: string): Promise<Extension | null> {
  const language = languageOfFile(fileName)
  const loader = LOADERS[language]
  if (loader === undefined) return Promise.resolve(null)
  // Same grammar, different dialect (`.tsx` vs `.ts`): the key keeps both.
  const key = `${language}:${extensionOf(fileName)}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const pending = loader(fileName).then((extension): Extension | null => extension, () => null)
  cache.set(key, pending)
  return pending
}
