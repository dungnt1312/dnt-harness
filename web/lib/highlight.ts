import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'
import xml from 'highlight.js/lib/languages/xml'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import sql from 'highlight.js/lib/languages/sql'
import graphql from 'highlight.js/lib/languages/graphql'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import ini from 'highlight.js/lib/languages/ini'
import diff from 'highlight.js/lib/languages/diff'
import shell from 'highlight.js/lib/languages/shell'
import powershell from 'highlight.js/lib/languages/powershell'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('python', python)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('php', php)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('graphql', graphql)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('powershell', powershell)

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
