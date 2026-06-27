import { useEffect, useState } from 'react'
import { highlightToHtml } from '../lib/shiki'

// react-markdown v9 把 ```lang ...``` 渲染成 <pre><code className="language-xxx">...</code></pre>。
// 我们覆盖 code 节点:inline code(无 className)保持原生 <code>;
// 块级 code 走 shiki,异步高亮完成前先用纯文本 <pre>,避免首屏抖动。
type Props = {
  className?: string
  children?: React.ReactNode
  // react-markdown 还会传 node 等其它 prop,这里允许透传
  [key: string]: unknown
}

const LANG_RE = /language-([\w+-]+)/

export function CodeBlock({ className, children, ...rest }: Props) {
  const isBlock = typeof className === 'string' && LANG_RE.test(className)
  // inline code:保持 react-markdown 默认行为(不调 hook,所以这个早返回安全)
  if (!isBlock) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  }
  const lang = className!.match(LANG_RE)![1]
  return <HighlightedBlock lang={lang} text={childrenToString(children)} />
}

function HighlightedBlock({ lang, text }: { lang: string; text: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    highlightToHtml(text, lang).then((out) => {
      if (!cancelled) setHtml(out)
    })
    return () => {
      cancelled = true
    }
  }, [text, lang])

  if (html) {
    return <div className="shiki-wrapper" data-lang={lang} dangerouslySetInnerHTML={{ __html: html }} />
  }
  return (
    <pre className="code-fallback" data-lang={lang}>
      <code>{text}</code>
    </pre>
  )
}

function childrenToString(children: React.ReactNode): string {
  if (children == null) return ''
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(childrenToString).join('')
  if (typeof children === 'object' && 'props' in (children as object)) {
    return childrenToString((children as { props: { children?: React.ReactNode } }).props.children)
  }
  return String(children)
}
