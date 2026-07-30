import { useState } from 'react'
import type { ToolPair } from '../lib/timeline'
import { parseApplyPatch, shortPath } from '../lib/apply-patch'
import { prettyToolName } from '../lib/timeline'
import { PatchDiffView } from './PatchDiffView'
import { useI18n } from '../lib/i18n'

// tool_result output 里如果带 markdown 图片(stringifyToolResult 给 Claude image 片段生成的
// `![image](data:...)`),把图片单独抽出来渲染,文字部分仍用 <pre>(shell stdout 等等需要等宽)。
const IMG_RE = /!\[([^\]]*)\]\((data:[^)]+|https?:\/\/[^)]+)\)/g
function ToolResultBody({ output }: { output: string }) {
  const { t } = useI18n()
  if (!output) return <pre>{t('tool.emptyOutput')}</pre>
  if (!IMG_RE.test(output)) return <pre>{output}</pre>
  IMG_RE.lastIndex = 0
  const parts: Array<{ kind: 'text' | 'img'; value: string; alt?: string }> = []
  let last = 0
  for (let m = IMG_RE.exec(output); m; m = IMG_RE.exec(output)) {
    if (m.index > last) parts.push({ kind: 'text', value: output.slice(last, m.index) })
    parts.push({ kind: 'img', alt: m[1], value: m[2] })
    last = m.index + m[0].length
  }
  if (last < output.length) parts.push({ kind: 'text', value: output.slice(last) })
  return (
    <div className="tool-result-mixed">
      {parts.map((p, i) =>
        p.kind === 'text'
          ? p.value.trim() && <pre key={i}>{p.value}</pre>
          : <img key={i} className="tool-result-image" src={p.value} alt={p.alt || 'image'} />,
      )}
    </div>
  )
}

function mainArg(use: { name: string; input: unknown }): string {
  const input = use.input
  // apply_patch: 用「N 个文件 +X/−Y」做单行摘要,比拿整段 patch 字符串当 arg 干净。
  if (use.name === 'apply_patch') {
    const files = parseApplyPatch(input)
    if (files && files.length > 0) {
      const totalAdd = files.reduce((n, f) => n + f.adds, 0)
      const totalDel = files.reduce((n, f) => n + f.dels, 0)
      const fileHint =
        files.length === 1 ? shortPath(files[0].path) : `${files.length} files`
      return `${fileHint}  +${totalAdd} −${totalDel}`
    }
  }
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : ''
  const o = input as Record<string, unknown>
  for (const k of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'description']) {
    if (typeof o[k] === 'string') return o[k] as string
  }
  return JSON.stringify(input)
}

export function ToolCallCard({ pair, readOnly }: { pair: ToolPair; readOnly?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const { use, result } = pair
  const arg = mainArg(use)
  const isPatch = use.name === 'apply_patch'
  const inputStr =
    typeof use.input === 'string' ? use.input : JSON.stringify(use.input, null, 2)

  return (
    <div className="collapsible">
      <div className="collapsible-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'}</span>
        <span className="tool-name" title={use.name}>{prettyToolName(use.name)}</span>
        <span className="arg">{arg}</span>
        {result?.isError && <span className="badge codex" style={{ marginLeft: 4 }}>error</span>}
        {readOnly && <span className="readonly">🔒 read-only</span>}
      </div>
      {open && (
        <div className="collapsible-body">
          {isPatch ? <PatchDiffView input={use.input} /> : <pre>{inputStr}</pre>}
          {result && (
            <>
              <div className={`tool-result-label ${result.isError ? 'error' : ''}`}>
                {result.isError ? `⚠ ${t('tool.resultError')}` : t('tool.result')}
              </div>
              <ToolResultBody output={result.output} />
            </>
          )}
          {!result && <div className="tool-result-label">{t('tool.noResult')}</div>}
        </div>
      )}
    </div>
  )
}
