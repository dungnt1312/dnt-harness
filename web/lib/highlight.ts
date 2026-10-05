import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

/**
 * Grammar loaders stay out of the main bundle: each language is a dynamic
 * import Vite code-splits into its own chunk, fetched the first time a code
 * block of that language renders. Until a grammar arrives (or when the
 * language is unknown) `highlight()` falls back to escaped plain text, so
 * rendering never waits on the network.
 */
const LOADERS: Readonly<Record<string, () => Promise<{ default: LanguageFn }>>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  bash: () => import('highlight.js/lib/languages/bash'),
  shell: () => import('highlight.js/lib/languages/shell'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  css: () => import('highlight.js/lib/languages/css'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  xml: () => import('highlight.js/lib/languages/xml'),
  python: () => import('highlight.js/lib/languages/python'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  swift: () => import('highlight.js/lib/languages/swift'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  php: () => import('highlight.js/lib/languages/php'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  sql: () => import('highlight.js/lib/languages/sql'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  ini: () => import('highlight.js/lib/languages/ini'),
  diff: () => import('highlight.js/lib/languages/diff'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
}

const pending = new Map<string, Promise<boolean>>()

/**
 * Fetch and register one grammar. Resolves `true` once `highlight()` can use
 * the language, `false` when it is not loadable. Concurrent callers share one
 * request; a registered language resolves immediately.
 */
export function ensureLanguage(language: string): Promise<boolean> {
  if (hljs.getLanguage(language) !== undefined) return Promise.resolve(true)
  const load = LOADERS[language]
  if (load === undefined) return Promise.resolve(false)
  const inFlight = pending.get(language)
  if (inFlight !== undefined) return inFlight
  const registered = load()
    .then((mod) => {
      hljs.registerLanguage(language, mod.default)
      return true
    })
    .catch(() => false)
  pending.set(language, registered)
  return registered
}

/** Escape text that survives a language miss; never inject raw HTML. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Highlight when the language is registered; fall back to escaped plain text. */
export function highlight(code: string, language: string): string {
  if (language === 'text' || hljs.getLanguage(language) === undefined) return escapeHtml(code)
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
}

const NAMED_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'bash',
  gnumakefile: 'bash',
}

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml',
  css: 'css', scss: 'css', sass: 'css', less: 'css', stylus: 'css', styl: 'css',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  py: 'python', pyi: 'python', pyw: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp',
  php: 'php', phtml: 'php',
  rb: 'ruby',
  sql: 'sql', pgsql: 'sql', psql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  proto: 'graphql',
  vue: 'xml', svelte: 'xml', astro: 'xml',
  yml2: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  ps1: 'powershell', psm1: 'powershell',
  bat: 'bash', cmd: 'bash',
  diff: 'diff', patch: 'diff',
  dockerignore: 'text', gitignore: 'text',
}

/** Display + highlight language for a file name ('text' when unknown). */
export function languageOfFile(name: string): string {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (base === '') return 'text'
  const named = NAMED_LANGUAGES[base]
  if (named !== undefined) return named
  // dotfiles like .eslintrc, .prettierrc have no real extension — treat as text/json/yaml by suffix
  const dot = base.lastIndexOf('.')
  if (dot <= 0) {
    // files like Dockerfile already handled; Makefile handled; otherwise check extension-like suffix after dot in dotfile
    // e.g. .eslintrc.json -> already has dot > 0 branch, but bare .gitignore handled elsewhere
    return 'text'
  }
  const ext = base.slice(dot + 1).toLowerCase()
  // handle double extensions like .test.ts, .spec.tsx, .d.ts -> use last ext
  return EXTENSION_LANGUAGES[ext] ?? 'text'
}
