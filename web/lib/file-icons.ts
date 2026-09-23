import type { IconName } from '../components/common/Icon.tsx'

/** Icon and quiet color tint for one file, from the app's semantic palette. */
export interface FileIconStyle {
  readonly name: IconName
  readonly className: string
}

/** Files whose full name, not extension, picks the icon. */
const NAMED: Readonly<Record<string, IconName>> = {
  dockerfile: 'fileCode',
  makefile: 'fileCode',
  gnumakefile: 'fileCode',
  '.gitignore': 'gitBranch',
  '.gitattributes': 'gitBranch',
  '.gitmodules': 'gitBranch',
  '.dockerignore': 'fileCog',
  '.eslintrc': 'fileCog',
  '.prettierrc': 'fileCog',
}

const BY_EXTENSION: Readonly<Record<string, IconName>> = {
  ts: 'fileCode', tsx: 'fileCode', mts: 'fileCode', cts: 'fileCode',
  js: 'fileCode', jsx: 'fileCode', mjs: 'fileCode', cjs: 'fileCode',
  py: 'fileCode', pyi: 'fileCode', pyw: 'fileCode',
  rb: 'fileCode', go: 'fileCode', rs: 'fileCode', java: 'fileCode', kt: 'fileCode', kts: 'fileCode',
  c: 'fileCode', h: 'fileCode', cpp: 'fileCode', hpp: 'fileCode', cc: 'fileCode', cxx: 'fileCode', hh: 'fileCode', hxx: 'fileCode', cs: 'fileCode',
  php: 'fileCode', phtml: 'fileCode', swift: 'fileCode', scala: 'fileCode', dart: 'fileCode',
  vue: 'fileCode', svelte: 'fileCode', astro: 'fileCode',
  html: 'fileCode', htm: 'fileCode', css: 'fileCode', scss: 'fileCode', sass: 'fileCode', less: 'fileCode', styl: 'fileCode', stylus: 'fileCode',
  sql: 'fileCode', pgsql: 'fileCode', psql: 'fileCode', graphql: 'fileCode', gql: 'fileCode', proto: 'fileCode',
  sh: 'fileCode', bash: 'fileCode', zsh: 'fileCode', fish: 'fileCode', ps1: 'fileCode', psm1: 'fileCode', bat: 'fileCode', cmd: 'fileCode',
  xml: 'fileCode', xhtml: 'fileCode',
  lua: 'fileCode', pl: 'fileCode', pm: 'fileCode', r: 'fileCode', ex: 'fileCode', exs: 'fileCode', erl: 'fileCode', hrl: 'fileCode', hs: 'fileCode', clj: 'fileCode', elm: 'fileCode',
  json: 'fileJson', jsonc: 'fileJson', json5: 'fileJson',
  toml: 'fileCog', yaml: 'fileCog', yml: 'fileCog', ini: 'fileCog', cfg: 'fileCog', conf: 'fileCog', lock: 'fileCog', properties: 'fileCog', env: 'fileCog',
  md: 'fileText', markdown: 'fileText', mdown: 'fileText', mkd: 'fileText', txt: 'fileText', rst: 'fileText', adoc: 'fileText',
  png: 'fileImage', jpg: 'fileImage', jpeg: 'fileImage', gif: 'fileImage', webp: 'fileImage',
  svg: 'fileImage', ico: 'fileImage', avif: 'fileImage', bmp: 'fileImage', heic: 'fileImage', heif: 'fileImage',
  mp3: 'fileAudio', wav: 'fileAudio', ogg: 'fileAudio', flac: 'fileAudio', m4a: 'fileAudio', aac: 'fileAudio', wma: 'fileAudio', opus: 'fileAudio',
  mp4: 'fileVideo', mov: 'fileVideo', webm: 'fileVideo', avi: 'fileVideo', mkv: 'fileVideo', m4v: 'fileVideo', flv: 'fileVideo',
  zip: 'fileArchive', tar: 'fileArchive', gz: 'fileArchive', tgz: 'fileArchive', bz2: 'fileArchive',
  xz: 'fileArchive', rar: 'fileArchive', '7z': 'fileArchive', jar: 'fileArchive', whl: 'fileArchive', deb: 'fileArchive',
  csv: 'fileSpreadsheet', tsv: 'fileSpreadsheet', xlsx: 'fileSpreadsheet', xls: 'fileSpreadsheet',
  xlsm: 'fileSpreadsheet', ods: 'fileSpreadsheet', parq: 'fileSpreadsheet', parquet: 'fileSpreadsheet',
  pdf: 'fileText', doc: 'fileText', docx: 'fileText',
}

const CLASS_BY_ICON: Readonly<Partial<Record<IconName, string>>> = {
  fileCode: 'text-link',
  fileJson: 'text-warn',
  fileCog: 'text-fg-muted',
  fileImage: 'text-ok',
  fileAudio: 'text-bad',
  fileVideo: 'text-bad',
  fileArchive: 'text-warn',
  fileSpreadsheet: 'text-ok',
  gitBranch: 'text-fg-muted',
}

/** Pick the file-type icon for a path; unknown extensions fall back to `fileText`. */
export function fileIcon(path: string): IconName {
  const raw = path.split(/[\\/]/).pop() ?? ''
  const name = raw.toLowerCase()
  if (name === '') return 'fileText'
  if (name.startsWith('.env')) return 'fileCog'
  const named = NAMED[name]
  if (named !== undefined) return named
  // handle compound extensions like .tar.gz, .test.ts — try longest suffix first
  const parts = name.split('.')
  if (parts.length > 2) {
    // e.g. foo.tar.gz -> try 'tar.gz' is not in map, fallback to 'gz'
    // but foo.spec.ts -> icon by 'ts'
    for (let i = 1; i < parts.length; i += 1) {
      const compound = parts.slice(i).join('.')
      const icon = BY_EXTENSION[compound]
      if (icon !== undefined) return icon
    }
  }
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    const ext = name.slice(dot + 1)
    const icon = BY_EXTENSION[ext]
    if (icon !== undefined) return icon
  }
  // dotfiles without extension like .editorconfig, .babelrc
  if (name.startsWith('.') && dot === 0) return 'fileCog'
  return 'fileText'
}

/** Icon plus its tint class; untinted types stay at `fg-faint`. */
export function fileStyle(path: string): FileIconStyle {
  const name = fileIcon(path)
  return { name, className: CLASS_BY_ICON[name] ?? 'text-fg-faint' }
}
