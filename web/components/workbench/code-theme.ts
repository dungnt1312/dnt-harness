import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * The editor wears the app's own tokens (`--bg`, `--line`, `--hl-*`, …) through
 * CSS variables, so the light/dark switch on `<html data-theme>` restyles an
 * open editor without reconfiguring it. `dark` only tells CodeMirror which of
 * its built-in `&light`/`&dark` rules apply; the few of those that carry a
 * colour are overridden below with `!important` because their selectors are
 * more specific than any theme rule can be.
 */
export function codeTheme(dark: boolean) {
  return EditorView.theme({
    '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg)', fontSize: '12.5px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px', overflow: 'auto' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--fg)' },
    '.cm-content:focus-visible': { outline: 'none' },
    '.cm-line': { padding: '0 24px 0 6px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-faint)', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '2.5em' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 45%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--hover) 45%, transparent)', color: 'var(--fg)' },
    '.cm-foldGutter span': { color: 'var(--fg-faint)', padding: '0 3px', cursor: 'pointer' },
    '.cm-foldGutter span:hover': { color: 'var(--fg)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--muted)', border: '1px solid var(--line)', color: 'var(--fg-muted)', borderRadius: '4px', padding: '0 4px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--link) 28%, transparent)',
    },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--link) 16%, transparent)' },
    '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--link) 22%, transparent)', outline: '1px solid color-mix(in srgb, var(--link) 45%, transparent)' },
    '.cm-nonmatchingBracket': { backgroundColor: 'var(--bad-soft)', outline: '1px solid var(--bad)' },
    // The lines a tool call read, which the caller opened this file for.
    '.cm-focus-band': { backgroundColor: 'var(--warn-soft)' },

    // Search panel: the app's own control look, not the browser's.
    '.cm-panels': { backgroundColor: 'var(--bg)', color: 'var(--fg)', borderColor: 'var(--line)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
    '.cm-panel.cm-search': { padding: '6px 28px 6px 10px', fontSize: '12px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { margin: '2px 6px 2px 0' },
    '.cm-panel.cm-search input[type=text]': {
      height: '28px', padding: '0 8px', border: '1px solid var(--line)', borderRadius: '8px',
      backgroundColor: 'var(--surface)', color: 'var(--fg)', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: '12px',
    },
    '.cm-panel.cm-search input[type=text]:focus': { borderColor: 'var(--fg-faint)' },
    '.cm-panel.cm-search button': {
      height: '28px', padding: '0 10px', border: '1px solid var(--line-strong)', borderRadius: '9999px',
      backgroundColor: 'transparent', backgroundImage: 'none', color: 'var(--fg)', cursor: 'pointer',
    },
    '.cm-panel.cm-search button:hover': { backgroundColor: 'var(--hover)' },
    '.cm-panel.cm-search button[name=close]': { border: 'none', color: 'var(--fg-muted)', height: 'auto', padding: '0 6px', fontSize: '16px' },
    '.cm-panel.cm-search label': { color: 'var(--fg-muted)', fontSize: '12px' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 22%, transparent) !important', outline: '1px solid color-mix(in srgb, var(--warn) 45%, transparent)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 45%, transparent) !important' },

    // Review changes (merge view): green for what the file gains, red for what it loses.
    '.cm-changedLine, .cm-insertedLine': { backgroundColor: 'var(--ok-soft) !important' },
    '.cm-deletedChunk': { backgroundColor: 'var(--bad-soft) !important', paddingLeft: '6px' },
    '.cm-deletedChunk .cm-deletedLine': { padding: '0 24px 0 0' },
    '.cm-changedText': { background: 'color-mix(in srgb, var(--ok) 28%, transparent) !important' },
    '.cm-deletedChunk .cm-deletedText': { background: 'color-mix(in srgb, var(--bad) 28%, transparent) !important' },
    '.cm-changedLineGutter': { background: 'var(--ok) !important' },
    '.cm-deletedLineGutter': { background: 'var(--bad) !important' },
    '.cm-changeGutter': { width: '3px', paddingLeft: '0' },
    '.cm-collapsedLines': {
      color: 'var(--fg-muted) !important', background: 'var(--muted) !important', padding: '2px 10px', fontSize: '12px',
      borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)',
    },
    '.cm-deletedChunk .cm-chunkButtons': { insetInlineEnd: '8px', top: '2px' },
    '.cm-deletedChunk button': {
      height: '22px', padding: '0 8px', margin: '0 0 0 4px', border: '1px solid var(--line-strong)', borderRadius: '9999px',
      backgroundColor: 'var(--surface) !important', color: 'var(--fg) !important', fontSize: '11px', cursor: 'pointer',
    },
    '.cm-deletedChunk button:hover': { backgroundColor: 'var(--hover) !important' },
  }, { dark })
}

/** Syntax colours: the same `--hl-*` variables the chat's code blocks use, so a snippet reads alike in both. */
export const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.bool, t.null, t.self, t.tagName], color: 'var(--hl-keyword)' },
  { tag: [t.string, t.regexp, t.special(t.string), t.character, t.docString], color: 'var(--hl-string)' },
  { tag: [t.number, t.integer, t.float, t.atom, t.unit, t.color], color: 'var(--hl-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.labelName, t.macroName], color: 'var(--hl-title)' },
  { tag: [t.typeName, t.namespace, t.standard(t.variableName), t.standard(t.name)], color: 'var(--hl-builtin)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: 'var(--hl-attr)' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.documentMeta], color: 'var(--hl-title)' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: 'var(--hl-title)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--link)', textDecoration: 'underline' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.inserted, color: 'var(--ok)' },
  { tag: t.deleted, color: 'var(--bad)' },
  { tag: t.invalid, color: 'var(--bad)' },
])
