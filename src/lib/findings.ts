// FINDINGS block splitter — 与 server 的 extract-issues 匹配的 lite 版,只做视觉分离和摘要。
// 不复用 server parser,前端保持零依赖。

const FENCE_RE = /(?:^|\n)FINDINGS\s*\n(```(?:json|JSON)?\s*[\s\S]*?```)/

export interface FindingsSplit {
  prose: string
  rawBlock?: string
  json?: string
  summary?: {
    issues: number
    results: number
    next?: string
  }
}

function findFenceInBlock(block: string): string | null {
  const m = block.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  return m ? m[1].trim() : null
}

function safeParse(chunk: string): unknown {
  try {
    return JSON.parse(chunk)
  } catch {
    const last = Math.max(chunk.lastIndexOf('}'), chunk.lastIndexOf(']'))
    if (last <= 0) return null
    try {
      return JSON.parse(chunk.slice(0, last + 1))
    } catch {
      return null
    }
  }
}

export function splitFindings(text: string): FindingsSplit {
  if (typeof text !== 'string' || !text.includes('FINDINGS')) return { prose: text }
  const match = FENCE_RE.exec(text)
  if (!match) return { prose: text }
  const prose = text.slice(0, match.index).replace(/\s+$/, '')
  const rawBlock = match[0].replace(/^\n/, '')
  const json = findFenceInBlock(match[1]) ?? undefined
  let summary: FindingsSplit['summary'] | undefined
  if (json) {
    const parsed = safeParse(json)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      const issues = Array.isArray(obj.issues) ? obj.issues.length : Array.isArray(parsed) ? parsed.length : 0
      const results = Array.isArray(obj.results) ? obj.results.length : 0
      const next = typeof obj.next === 'string' ? obj.next : undefined
      summary = { issues, results, ...(next ? { next } : {}) }
    }
  }
  return { prose, rawBlock, json, summary }
}
