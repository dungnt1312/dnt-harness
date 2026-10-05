import { memo, useEffect, useMemo, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Icon from './components/common/Icon.tsx'
import { ensureLanguage, escapeHtml, highlight } from './lib/highlight.ts'

/** Fenced code block with a language chip and a copy button. */
function CodeBlock({ lang, code }: { readonly lang: string; readonly code: string }) {
  const [copied, setCopied] = useState(false)
  // The grammar loads after first paint: the block renders escaped plain text
  // immediately, then re-renders highlighted once the language arrives.
  const [ready, setReady] = useState(lang === '' || lang === 'text')
  useEffect(() => {
    if (ready) return
    let live = true
    void ensureLanguage(lang).then((ok) => {
      if (live && ok) setReady(true)
    })
    return () => { live = false }
  }, [lang, ready])
  const html = useMemo(
    () => (ready ? highlight(code, lang) : escapeHtml(code)),
    [code, lang, ready],
  )
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang === '' ? 'text' : lang}</span>
        <button
          type="button"
          className="codeblock-copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1_200)
            })
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy code'}
        </button>
      </div>
      <pre className="codeblock-pre"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  )
}

// Module-level so every render hands react-markdown the same plugin list and
// component types: fresh closures would remount each rendered element.
const REMARK_PLUGINS = [remarkGfm]
const COMPONENTS: Components = {
  pre: (props: ComponentProps<'pre'>) => <>{props.children}</>,
  code: (props: ComponentProps<'code'>) => {
    const { className, children } = props
    const text = String(children ?? '').replace(/\n$/, '')
    if (text.includes('\n')) {
      const lang = /language-([\w-]+)/.exec(className ?? '')?.[1] ?? ''
      return <CodeBlock lang={lang} code={text} />
    }
    return <code className="md-inline">{children}</code>
  },
  a: (props: ComponentProps<'a'>) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
}

/**
 * Markdown rendering for assistant messages: GFM tables/lists/links plus
 * fenced code blocks with syntax highlighting. Fenced blocks (with a
 * language class) and any multi-line code render as {@link CodeBlock};
 * everything else is an inline chip.
 *
 * Memoized on `content`: parsing and highlighting a long conversation is the
 * costliest render in the app, and unrelated state (composer keystrokes, a
 * streaming reply) must not redo it for messages that did not change.
 */
export const Markdown = memo(function Markdown({ content }: { readonly content: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
