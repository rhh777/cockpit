import { useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'

// react-markdown 把 ```lang...``` 渲染成 <pre><code className="language-xxx">,
// 用 components.code 覆盖即可。inline code 走同一个组件,内部自行分支。
const MD_COMPONENTS: Components = {
  code: CodeBlock as Components['code'],
}

// 默认折叠阈值:超过 N 字符的内容先收起,避免一次性渲染数 MB tool_result 把 UI 卡住。
// 调用方可以传 collapseAt={0} 或 Infinity 关闭这个能力(例如 assistant_text 一般不需要折叠)。
const DEFAULT_COLLAPSE_AT = 4000
const PREVIEW_CHARS = 1200

// 轻量 markdown 渲染。
// - remark-gfm 支持表格 / 删除线 / 任务列表 / 自动链接(修复历史上表格被渲染成 |---|---| 文本的问题)。
// - 超长文本默认折叠出一个预览,点击展开后渲染完整内容。
// - shiki 高亮通过 components.code → CodeBlock 注入,异步加载语言,未命中退回 <pre>。
export function Markdown({
  text,
  collapseAt = DEFAULT_COLLAPSE_AT,
}: {
  text: string
  collapseAt?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const long = collapseAt > 0 && text.length > collapseAt
  // 折叠时取一个语义友好的截断点:优先在段落 / 行边界切,避免把代码围栏 / 表格断在一半。
  const preview = useMemo(() => (long ? safeTruncate(text, PREVIEW_CHARS) : text), [text, long])

  if (!long || expanded) {
    return (
      <div className="markdown selectable">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
        {long && expanded && (
          <button
            type="button"
            className="markdown-toggle"
            onClick={() => setExpanded(false)}
          >
            收起
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="markdown selectable">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{preview}</ReactMarkdown>
      <button
        type="button"
        className="markdown-toggle"
        onClick={() => setExpanded(true)}
        title={`完整 ${text.length.toLocaleString()} 字符`}
      >
        展开剩余 {(text.length - preview.length).toLocaleString()} 字符
      </button>
    </div>
  )
}

// 在预览上限附近找一个合理的断点:优先双换行 → 单换行 → 句号 / 空格;都没有就硬切。
// 同时把未闭合的 ``` 围栏补一个,避免预览段把代码块语法吃掉。
function safeTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const window = text.slice(0, max)
  const cuts = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('。 '), window.lastIndexOf(' ')]
  const cut = cuts.find((i) => i > max * 0.6) ?? -1
  let head = cut > 0 ? window.slice(0, cut) : window
  // 围栏代码块奇数次出现 → 自动闭合一次
  const fenceCount = (head.match(/^```/gm) || []).length
  if (fenceCount % 2 === 1) head += '\n```'
  return head + '\n\n…'
}
