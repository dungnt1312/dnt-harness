import { describe, expect, it } from 'vitest'
import { csvDelimiterOf, csvRows, previewKindOf } from './preview.ts'

describe('previewKindOf', () => {
  it('maps markdown extensions to markdown', () => {
    expect(previewKindOf('README.md')).toBe('markdown')
    expect(previewKindOf('docs/guide.markdown')).toBe('markdown')
    expect(previewKindOf('skill://a/SKILL.md')).toBe('markdown')
  })

  it('maps html extensions to html', () => {
    expect(previewKindOf('index.html')).toBe('html')
    expect(previewKindOf('docs/report.HTM')).toBe('html')
    expect(previewKindOf('page.htm')).toBe('html')
  })

  it('maps csv and tsv to csv', () => {
    expect(previewKindOf('data.csv')).toBe('csv')
    expect(previewKindOf('data.tsv')).toBe('csv')
    expect(previewKindOf('DATA.CSV')).toBe('csv')
  })

  it('returns null for code, config, images and unknown extensions', () => {
    expect(previewKindOf('main.ts')).toBe(null)
    expect(previewKindOf('.gitignore')).toBe(null)
    expect(previewKindOf('photo.png')).toBe(null)
    expect(previewKindOf('song.mp3')).toBe(null)
    expect(previewKindOf('clip.mp4')).toBe(null)
    expect(previewKindOf('archive.tar.gz')).toBe(null)
    expect(previewKindOf('noext')).toBe(null)
  })
})

describe('csvDelimiterOf', () => {
  it('chooses tab for tsv and comma for csv', () => {
    expect(csvDelimiterOf('data.tsv')).toBe('\t')
    expect(csvDelimiterOf('data.csv')).toBe(',')
  })
})

describe('csvRows', () => {
  it('parses simple rows', () => {
    expect(csvRows('a,b\nc,d', ',')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('keeps quoted commas, escaped quotes and newlines inside quotes', () => {
    expect(csvRows('"x,1","say ""hi""","line\nbreak"', ',')).toEqual([['x,1', 'say "hi"', 'line\nbreak']])
  })

  it('treats the final line without newline as a row and drops trailing empty lines', () => {
    expect(csvRows('a,b\nc,d\n', ',')).toEqual([['a', 'b'], ['c', 'd']])
    expect(csvRows('a\n', ',')).toEqual([['a']])
    expect(csvRows('', ',')).toEqual([])
  })
})
