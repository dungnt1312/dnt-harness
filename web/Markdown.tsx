import { createContext, memo, useContext, useEffect, useMemo, useState, type ComponentProps } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Icon from './components/common/Icon.tsx'
import { ensureLanguage, escapeHtml, highlight } from './lib/highlight.ts'
import { parseFileHref, type OpenPathResolver } from './lib/project-paths.ts'

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
  a: (props: ComponentProps<'a'>) => <MarkdownLink {...props} />,
}

/**
 * How a rendered link opens a file. The transcript provides the workbench
 * opener; without one (settings previews) file links stay plain anchors.
 */
export const MarkdownFileLinkContext = createContext<OpenPathResolver | null>(null)

/**
 * Web links open in a new tab. A path the agent wrote as a link opens in the
 * workbench instead: navigating to it would only load the app at a bogus
 * route. A path outside the project is inert rather than a broken page.
 */
function MarkdownLink(props: ComponentProps<'a'>) {
  const openPath = useContext(MarkdownFileLinkContext)
  const file = parseFileHref(props.href)
  if (file === null || openPath === null) return <a {...props} target="_blank" rel="noreferrer" />
  const open = openPath(file.path, file.focus)
  return (
    <a
      {...props}
      title={open !== null ? `Open ${file.path} in workbench` : file.path}
      onClick={(event) => {
        event.preventDefault()
        open?.()
      }}
    />
  )
}

/**
 * react-markdown blanks any href whose "protocol" it does not know, which
 * swallows `file:///…`, `C:/…` and bare `a.ts:12`. File references keep their
 * text so the link above can open them; everything else gets the default.
 */
function urlTransform(value: string): string {
  return parseFileHref(value) !== null ? value : defaultUrlTransform(value)
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
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} urlTransform={urlTransform}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
