import { useEffect, useRef, useState } from 'react'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  Decoration, EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { unifiedMergeView } from '@codemirror/merge'
import { loadCodeLanguage } from '../../lib/code-languages.ts'
import { indentUnitOf, type IndentStyle } from '../../lib/code-text.ts'
import { codeHighlight, codeTheme } from './code-theme.ts'

/** Marks a transaction the pane made to follow its `value` prop, so it is not reported as typing. */
const FromProps = Annotation.define<boolean>()

export interface CodePaneCompare {
  /** The text the editor is compared against (LF, no BOM). */
  readonly original: string
  /** Button on a changed chunk: puts this chunk back to the compared text. */
  readonly revertLabel: string
}

export interface CodePaneProps {
  /** File name for the language; only its extension and base name matter. */
  readonly fileName: string
  /** The document. The pane follows it when it differs from what the editor holds. */
  readonly value: string
  readonly editable: boolean
  readonly indent: IndentStyle
  /** The lines a tool call read; highlighted and scrolled to unless a comparison is showing. The caller drops it once the text is edited. */
  readonly focus?: { readonly line: number; readonly lines?: number; readonly seq: number } | null
  readonly compare?: CodePaneCompare | null
  readonly ariaLabel: string
  /** Facts the status bar states on the right (language, encoding, line endings, size, …). */
  readonly facts?: readonly string[]
  /** Soft-wrap long lines; the caller owns the choice (it lives in the viewer's ⋯ menu). */
  readonly wrap?: boolean
  readonly onChange?: (text: string) => void
  readonly onSave?: () => void
}

const isDark = (): boolean => document.documentElement.dataset['theme'] === 'dark'

/** Common prefix/suffix trimmed, so following a reload keeps the cursor, scroll and undo history. */
function minimalChange(from: string, to: string): { from: number; to: number; insert: string } {
  const limit = Math.min(from.length, to.length)
  let head = 0
  while (head < limit && from.charCodeAt(head) === to.charCodeAt(head)) head += 1
  let tail = 0
  while (tail < limit - head && from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)) tail += 1
  return { from: head, to: from.length - tail, insert: to.slice(head, to.length - tail) }
}

function bandExtension(state: EditorState, focus: NonNullable<CodePaneProps['focus']>): Extension {
  const total = state.doc.lines
  const first = Math.min(Math.max(focus.line, 1), total)
  const last = Math.min(Math.max(first + Math.max(focus.lines ?? 1, 1) - 1, first), total)
  const mark = Decoration.line({ class: 'cm-focus-band' })
  const ranges = []
  for (let number = first; number <= last; number += 1) ranges.push(mark.range(state.doc.line(number).from))
  return EditorView.decorations.of(Decoration.set(ranges))
}

function compareExtension(compare: CodePaneCompare): Extension {
  return unifiedMergeView({
    original: compare.original,
    gutter: true,
    highlightChanges: true,
    allowInlineDiffs: true,
    collapseUnchanged: { margin: 3, minSize: 8 },
    mergeControls: (type, action) => {
      // "Accept" would only rewrite the compared text inside this view, which
      // nothing reads. Only reverting a chunk has an effect, so only it is drawn.
      if (type === 'accept') {
        const none = document.createElement('span')
        none.hidden = true
        return none
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.name = 'reject'
      button.textContent = compare.revertLabel
      button.addEventListener('mousedown', action)
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') action(event as unknown as MouseEvent)
      })
      return button
    },
  })
}

/**
 * The workbench's one code surface: reading and editing share this component,
 * so pressing Edit changes what you can do, not what you see. CodeMirror owns
 * the document; React only hands it text (`value`) and hears about typing
 * (`onChange`). Imported lazily by the viewer, so none of this is in the main bundle.
 */
export default function CodePane({ fileName, value, editable, indent, focus = null, compare = null, ariaLabel, facts = [], wrap = false, onChange, onSave }: CodePaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** What the editor holds, as a string, so a prop that merely echoes typing costs no document scan. */
  const docRef = useRef(value)
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }
  const [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0 })
  // One compartment per concern that changes while the view lives.
  const parts = useRef({
    editing: new Compartment(), language: new Compartment(), indent: new Compartment(),
    compare: new Compartment(), band: new Compartment(), wrap: new Compartment(), theme: new Compartment(),
  })

  const editingExtension = (on: boolean, label: string): Extension => {
    if (!on) {
      return [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        // Not editable means not focusable by default; a reader still needs the keyboard to scroll, select and search.
        EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': 'true', tabindex: '0' }),
      ]
    }
    const inIme = (view: EditorView): boolean => view.composing || view.compositionStarted
    return [
      EditorView.editable.of(true),
      EditorState.readOnly.of(false),
      EditorView.contentAttributes.of({ 'aria-label': label }),
      closeBrackets(),
      Prec.high(keymap.of([
        { key: 'Mod-s', preventDefault: true, run: (view) => { if (inIme(view)) return false; handlers.current.onSave?.(); return true } },
        // Escape is left to the search panel: with editing in place, a stray Escape must never throw work away.
        {
          key: 'Tab',
          run: (view) => {
            if (inIme(view)) return false
            // Lines selected: indent them all. A selection inside one line is replaced by the unit, as typing would.
            const { doc } = view.state
            if (view.state.selection.ranges.some((range) => doc.lineAt(range.from).number !== doc.lineAt(range.to).number)) return indentMore(view)
            view.dispatch(view.state.update(view.state.replaceSelection(view.state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input' }))
            return true
          },
        },
        { key: 'Shift-Tab', run: indentLess },
      ])),
      keymap.of(closeBracketsKeymap),
    ]
  }

  // Create once; every later change is a reconfigure, never a rebuild.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const c = parts.current
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(codeHighlight),
          search({ top: true }),
          keymap.of([...searchKeymap, ...foldKeymap, ...historyKeymap, ...defaultKeymap]),
          c.editing.of(editingExtension(editable, ariaLabel)),
          c.language.of([]),
          c.indent.of([indentUnit.of(indentUnitOf(indent)), EditorState.tabSize.of(indent.kind === 'tab' ? 4 : indent.width)]),
          c.compare.of(compare !== null ? compareExtension(compare) : []),
          c.band.of([]),
          c.wrap.of(wrap ? EditorView.lineWrapping : []),
          c.theme.of(codeTheme(isDark())),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const fromProps = update.transactions.some((transaction) => transaction.annotation(FromProps) === true)
              docRef.current = update.state.doc.toString()
              if (!fromProps) handlers.current.onChange?.(docRef.current)
            }
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main
              const line = update.state.doc.lineAt(head.head)
              const next = { line: line.number, column: head.head - line.from + 1, selected: head.to - head.from }
              setCursor((previous) => previous.line === next.line && previous.column === next.column && previous.selected === next.selected ? previous : next)
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    docRef.current = value
    // No focus on mount: opening a file must not pull the keyboard away from the chat composer.
    // The theme follows <html data-theme>; the colours are variables, only the light/dark hint needs telling.
    const observer = new MutationObserver(() => view.dispatch({ effects: c.theme.reconfigure(codeTheme(isDark())) }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      observer.disconnect()
      view.destroy()
      viewRef.current = null
    }
    // Created once. Everything else flows through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the prop when it moved without us: a reload, a discard, a save settling.
  useEffect(() => {
    const view = viewRef.current
    if (view === null || value === docRef.current) return
    view.dispatch({ changes: minimalChange(docRef.current, value), annotations: FromProps.of(true) })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch({ effects: parts.current.editing.reconfigure(editingExtension(editable, ariaLabel)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, ariaLabel])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: parts.current.indent.reconfigure([indentUnit.of(indentUnitOf(indent)), EditorState.tabSize.of(indent.kind === 'tab' ? 4 : indent.width)]),
    })
  }, [indent.kind, indent.kind === 'spaces' ? indent.width : 0])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: parts.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: parts.current.compare.reconfigure(compare !== null ? compareExtension(compare) : []) })
  }, [compare?.original, compare?.revertLabel])

  // The grammar arrives after first paint; the text is already correct and readable before it does.
  useEffect(() => {
    let live = true
    void loadCodeLanguage(fileName).then((extension) => {
      if (live) viewRef.current?.dispatch({ effects: parts.current.language.reconfigure(extension ?? []) })
    })
    return () => { live = false }
  }, [fileName])

  const banded = compare === null && focus !== null
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch({ effects: parts.current.band.reconfigure(banded && focus !== null ? bandExtension(view.state, focus) : []) })
  }, [banded, focus?.line, focus?.lines, focus?.seq, value])

  // Landing on the lines a tool read, rather than the top of a 2000-line file.
  useEffect(() => {
    const view = viewRef.current
    if (view === null || !banded || focus === null) return
    const line = view.state.doc.line(Math.min(Math.max(focus.line, 1), view.state.doc.lines))
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: Math.round(view.dom.clientHeight / 3) }) })
    // The window moves only when the caller asks again (seq), not when the text reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banded, focus?.seq, focus?.line])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
      <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-line px-3 text-xs tabular-nums text-fg-muted">
        <span className="shrink-0" aria-label="Cursor position">
          Ln {cursor.line}, Col {cursor.column}{cursor.selected > 0 ? ` · ${cursor.selected} selected` : ''}
        </span>
        {facts.length > 0 ? <span className="min-w-0 truncate">{facts.join(' · ')}</span> : null}
      </div>
    </div>
  )
}
