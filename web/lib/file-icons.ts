/**
 * File and folder icons from the Material Icon Theme set
 * (vscode-material-icon-theme, MIT), served from `/material-icons`.
 *
 * The name tables follow dntspace-app's `fileIcons.tsx`: a file name or stem
 * wins over its extension, and an extension that names no asset falls through
 * to `document.svg`. Folders pick a themed icon by their own name
 * (`src` → `folder-src`), open or closed.
 */

const ICON_BASE = '/material-icons'
const DEFAULT_FILE = 'document'
const DEFAULT_FOLDER = 'folder'

/** Full filenames and extension-less stems → asset name. */
const FILE_NAME_ALIASES: Readonly<Record<string, string>> = {
  '.editorconfig': 'editorconfig',
  '.env': 'settings',
  '.gitattributes': 'git',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.npmrc': 'npm',
  '.nvmrc': 'nodejs_alt',
  '.php_cs': 'php',
  '.php_cs.dist': 'php',
  '.prettierrc': 'prettier',
  '.yarnrc': 'yarn',
  'babel.config': 'babel',
  bun: 'lock',
  'bun.lock': 'lock',
  cargo: 'rust',
  'cargo.lock': 'lock',
  dockerfile: 'docker',
  earthfile: 'settings',
  eslint: 'eslint',
  'eslint.config': 'eslint',
  gemfile: 'gemfile',
  'go.mod': 'go',
  'go.sum': 'lock',
  jest: 'jest',
  'jest.config': 'jest',
  justfile: 'settings',
  makefile: 'makefile',
  'package-lock': 'lock',
  'pnpm-lock': 'lock',
  procfile: 'settings',
  rakefile: 'ruby',
  readme: 'readme',
  tsconfig: 'tsconfig',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  vitest: 'vitest',
  'vitest.config': 'vitest',
  yarn: 'yarn',
}

/**
 * Extension → asset name where the two differ (`tsx` → `react_ts`).
 * Anything absent here is asked for as `<ext>.svg` and falls back to the
 * document icon if that asset does not exist.
 */
const EXT_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript', cjs: 'javascript', mjs: 'javascript',
  ts: 'typescript', cts: 'typescript', mts: 'typescript',
  jsx: 'react', tsx: 'react_ts',
  json: 'json', jsonl: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  htm: 'html',
  sass: 'css', scss: 'css', less: 'css', styl: 'css', pcss: 'css', postcss: 'css',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', ico: 'image',
  bmp: 'image', avif: 'image', heic: 'image', heif: 'image',
  m4a: 'audio', flac: 'audio', mp3: 'audio', ogg: 'audio', opus: 'audio', wav: 'audio', weba: 'audio', aac: 'audio', wma: 'audio',
  m4v: 'video', mov: 'video', mp4: 'video', webm: 'video', avi: 'video', mkv: 'video', flv: 'video',
  rs: 'rust', py: 'python', pyi: 'python', pyw: 'python',
  rb: 'ruby', rake: 'ruby', rbs: 'ruby', gemspec: 'ruby',
  kt: 'kotlin', kts: 'kotlin', ktm: 'kotlin',
  cs: 'csharp', csproj: 'csharp',
  fs: 'fsharp', fsx: 'fsharp',
  pl: 'perl', pm: 'perl',
  hs: 'haskell', lhs: 'haskell',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hrl: 'erlang',
  sol: 'solidity', sc: 'scala', zon: 'zig',
  mm: 'objective-c',
  groovy: 'groovy', gradle: 'gradle',
  cc: 'cpp', cxx: 'cpp', cppm: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp', 'c++': 'cpp', 'h++': 'cpp',
  i: 'c', m: 'c',
  rmd: 'r', rnw: 'r',
  bash: 'console', bat: 'console', cmd: 'console', fish: 'console', sh: 'console', zsh: 'console', shell: 'console',
  ps1: 'powershell', psm1: 'powershell',
  asm: 'assembly',
  conf: 'settings', cfg: 'settings', config: 'settings', editorconfig: 'editorconfig',
  env: 'settings', inf: 'settings', ini: 'settings', prop: 'settings', properties: 'settings',
  rest: 'http', text: 'document', txt: 'document',
  yml: 'yaml',
  hcl: 'terraform', tf: 'terraform', tfvars: 'terraform',
  gql: 'graphql',
  sql: 'database', pgsql: 'database', psql: 'database',
  dll: 'exe',
  sb: 'storybook', snap: 'snapcraft', responses: 'json',
  doc: 'word', docx: 'word', pptx: 'powerpoint',
  xlsx: 'table', xls: 'table', xlsm: 'table', csv: 'table', tsv: 'table', ods: 'table',
  php3: 'php', php4: 'php', php5: 'php', phps: 'php', phtml: 'php',
  blade: 'laravel', jade: 'pug', hbs: 'handlebars', mustache: 'handlebars',
  jinja2: 'jinja', j2: 'jinja', njk: 'nunjucks',
  eex: 'elixir', heex: 'elixir', leex: 'elixir',
  gz: 'zip', tgz: 'zip', bz2: 'zip', xz: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip',
  jar: 'zip', whl: 'zip', deb: 'zip',
  lock: 'lock',
}

/** Folder names that have their own `folder-<name>` asset. */
const FOLDER_NAMES: ReadonlySet<string> = new Set([
  'admin', 'api', 'app', 'audio', 'base', 'ci', 'client', 'components', 'config', 'context', 'core',
  'coverage', 'css', 'cypress', 'database', 'dist', 'docker', 'docs', 'features', 'git', 'github',
  'graphql', 'home', 'i18n', 'images', 'kubernetes', 'layout', 'lib', 'log', 'middleware',
  'migrations', 'mock', 'node', 'packages', 'proto', 'public', 'routes', 'scripts', 'server',
  'shared', 'src', 'store', 'storybook', 'svg', 'tasks', 'temp', 'test', 'theme', 'tools', 'utils',
  'video', 'views', 'vscode',
])

/** Names that mean the same folder but are spelled differently. */
const FOLDER_ALIASES: Readonly<Record<string, string>> = {
  node_modules: 'node',
  tests: 'test', testing: 'test', __tests__: 'test', spec: 'test', specs: 'test', e2e: 'test',
  configs: 'config', settings: 'config',
  assets: 'images', static: 'public',
  styles: 'css', style: 'css',
  hooks: 'lib', common: 'shared', helpers: 'utils', util: 'utils',
  build: 'dist', out: 'dist',
  db: 'database', data: 'database',
  tmp: 'temp', logs: 'log',
  '.github': 'github', '.git': 'git', '.vscode': 'vscode',
}

export interface FileIconStyle {
  /** Asset name under `/material-icons`, without `.svg`. */
  readonly name: string
  /** URL of the SVG. The icon carries its own color, so no tint class. */
  readonly src: string
}

/** The SVG URL for one asset name. */
export function materialIconSrc(name: string): string {
  return `${ICON_BASE}/${name}.svg`
}

/** Asset name for a file path. A directory part is ignored; only the leaf counts. */
export function materialIconName(fileName: string): string {
  const leaf = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase()
  if (leaf === '') return DEFAULT_FILE
  const dot = leaf.lastIndexOf('.')
  const stem = dot <= 0 ? leaf : leaf.slice(0, dot)
  // Walk back through dotted stems so `vitest.config.ts` and `.env.local`
  // match their filename alias before the bare extension does.
  const candidates = [leaf, stem]
  let walk = stem
  while (walk.includes('.')) {
    walk = walk.slice(0, walk.lastIndexOf('.'))
    if (walk !== '') candidates.push(walk)
  }
  for (const candidate of candidates) {
    const aliased = FILE_NAME_ALIASES[candidate]
    if (aliased !== undefined) return aliased
  }
  if (dot <= 0) return DEFAULT_FILE
  const ext = leaf.slice(dot + 1)
  return EXT_ALIASES[ext] ?? ext
}

/** Asset name for a folder, open or closed. Unknown names use the plain folder. */
export function folderIconName(folderName: string, open = false): string {
  const leaf = (folderName.split(/[\\/]/).pop() ?? folderName).toLowerCase()
  const named = FOLDER_ALIASES[leaf] ?? (FOLDER_NAMES.has(leaf) ? leaf : undefined)
  const base = named === undefined ? DEFAULT_FOLDER : `folder-${named}`
  return open ? `${base}-open` : base
}

/** Icon for a file path. */
export function fileStyle(path: string): FileIconStyle {
  const name = materialIconName(path)
  return { name, src: materialIconSrc(name) }
}

/** Icon for a folder path; `open` selects the opened variant. */
export function folderStyle(path: string, open = false): FileIconStyle {
  const name = folderIconName(path, open)
  return { name, src: materialIconSrc(name) }
}
