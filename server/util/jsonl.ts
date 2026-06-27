import fs from 'node:fs'
import readline from 'node:readline'

export function safeJsonParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

export interface JsonlLine {
  lineNo: number
  raw: string
  parsed: unknown | undefined // undefined = parse 失败
}

// 流式逐行读 JSONL,大文件(MB 级)不一次性 readFileSync(见 docs/02 §一注意点)。
export async function* readJsonlLines(filePath: string): AsyncGenerator<JsonlLine> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let lineNo = 0
  for await (const raw of rl) {
    lineNo++
    if (!raw.trim()) continue
    const r = safeJsonParse(raw)
    yield { lineNo, raw, parsed: r.ok ? r.value : undefined }
  }
}

// tool_result 的 content 形状很杂:
//   - Claude 原生:string 或 [{type:'text',text}, {type:'image', source:{...}}]
//   - MCP 工具:{ content: [...] } 包一层
//   - 自定义 tool:任意嵌套对象
// 这里递归拍平成可读字符串,保留 image 的 data URL(前端再决定要不要渲染缩略图)。
export function stringifyToolResult(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (typeof content !== 'object') return String(content)

  if (Array.isArray(content)) {
    return content.map((p) => stringifyToolResult(p)).filter((s) => s !== '').join('\n')
  }

  const o = content as Record<string, unknown>

  // MCP 风格 { content: [...] } 直接拆包
  if (Array.isArray(o.content)) return stringifyToolResult(o.content)

  // 文本片段
  if (typeof o.text === 'string') return o.text

  // 图片片段:尽量保留 data URL,前端能渲染。
  if (o.type === 'image') {
    const src = o.source as Record<string, unknown> | undefined
    if (src && src.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
      return `![image](data:${src.media_type};base64,${src.data})`
    }
    if (typeof o.url === 'string') return `![image](${o.url})`
    return '[image]'
  }

  // 其它对象兜底 JSON
  return JSON.stringify(content)
}
