import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileTypeIcon } from '../components/common/FileTypeIcon.tsx'
import { fileStyle, folderIconName, folderStyle, materialIconName } from './file-icons.ts'

describe('material file icons', () => {
  it('maps extensions and special names to material assets', () => {
    expect(materialIconName('main.ts')).toBe('typescript')
    expect(materialIconName('src/app/App.tsx')).toBe('react_ts')
    expect(materialIconName('widget.jsx')).toBe('react')
    expect(materialIconName('package.json')).toBe('json')
    expect(materialIconName('config/app.yaml')).toBe('yaml')
    expect(materialIconName('.env.local')).toBe('settings')
    expect(materialIconName('assets/logo.svg')).toBe('svg')
    expect(materialIconName('demo.mp4')).toBe('video')
    expect(materialIconName('data/table.csv')).toBe('table')
    expect(materialIconName('backup.tar.gz')).toBe('zip')
    expect(materialIconName('notes.md')).toBe('markdown')
    expect(materialIconName('Dockerfile')).toBe('docker')
    expect(materialIconName('.gitignore')).toBe('git')
    expect(materialIconName('vitest.config.ts')).toBe('vitest')
    expect(materialIconName('tsconfig.json')).toBe('tsconfig')
  })

  it('falls back to the document icon when nothing matches', () => {
    expect(materialIconName('no-extension')).toBe('document')
    expect(materialIconName('')).toBe('document')
  })

  it('points every file at its svg and keeps the asset name', () => {
    expect(fileStyle('main.ts')).toEqual({ name: 'typescript', src: '/material-icons/typescript.svg' })
    expect(fileStyle('notes.md').src).toBe('/material-icons/markdown.svg')
  })

  it('themes folders by name and switches to the open variant', () => {
    expect(folderIconName('src')).toBe('folder-src')
    expect(folderIconName('src', true)).toBe('folder-src-open')
    expect(folderIconName('node_modules')).toBe('folder-node')
    expect(folderIconName('tests')).toBe('folder-test')
    expect(folderIconName('misc')).toBe('folder')
    expect(folderStyle('src/components', true)).toEqual({ name: 'folder-components-open', src: '/material-icons/folder-components-open.svg' })
  })

  it('renders a file and a folder as images with a fallback-ready src', () => {
    const file = renderToStaticMarkup(<FileTypeIcon path="main.ts" size={16} />)
    expect(file).toContain('src="/material-icons/typescript.svg"')
    expect(file).toContain('width="16"')
    const folder = renderToStaticMarkup(<FileTypeIcon path="src" kind="folder" open size={16} />)
    expect(folder).toContain('src="/material-icons/folder-src-open.svg"')
  })
})
