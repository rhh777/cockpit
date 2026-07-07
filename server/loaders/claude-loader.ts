import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CLAUDE_PROJECTS_ROOT } from '../config'
import { readJsonlLines, stringifyToolResult } from '../util/jsonl'
import { cleanTitle } from '../util/title'
import type {
  ChatAttachment,
  EventEnvelope,
  LoaderWarning,
  NormalizedEvent,
  SessionSourceLoader,
  SessionSummary,
} from './types'

const SOURCE = 'claude-code' as const

function imageAttachmentFromClaudeBlock(p: Record<string, unknown>, index: number): ChatAttachment | null {
  const source = p.source as Record<string, unknown> | undefined
  const mimeType = String(source?.media_type ?? source?.mime_type ?? 'image/png')
  const name = typeof p.name === 'string' ? p.name : `claude-image-${index + 1}.${mimeType.split('/')[1] || 'png'}`

  if (source?.type === 'base64' && typeof source.data === 'string' && source.data) {
    return {
      kind: 'image',
      dataUrl: `data:${mimeType};base64,${source.data}`,
      name,
      mimeType,
    }
  }

  const pathValue = source?.path ?? source?.file_path ?? p.path
  if (typeof pathValue === 'string' && pathValue) {
    return {
      kind: 'image',
      path: pathValue,
      name,
      mimeType,
    }
  }

  return null
}

// 把一行 Claude JSONL 转成 0..n 个 NormalizedEvent(见 docs/02 §一 Loader 提取规则)。
// 同时被 claude-call adapter 复用:`claude -p --output-format stream-json` 的
// assistant/user 行与原生 JSONL 的 message.content 形状一致。
export function normalizeClaudeLine(o: Record<string, unknown>): NormalizedEvent[] {
  const ts = (o.timestamp as string) ?? ''
  const type = o.type as string
  const message = o.message as Record<string, unknown> | undefined

  switch (type) {
    case 'queue-operation':
    case 'last-prompt':
    case 'ai-title':
    case 'custom-title':
      return []
    case 'user': {
      const c = message?.content
      if (typeof c === 'string') {
        return [{ type: 'user_text', text: c, ts }]
      }
      if (Array.isArray(c)) {
        const out: NormalizedEvent[] = []
        let pendingAttachments: ChatAttachment[] = []
        for (const [index, p] of (c as Record<string, unknown>[]).entries()) {
          if (p?.type === 'tool_result') {
            out.push({
              type: 'tool_result',
              toolUseId: String(p.tool_use_id ?? ''),
              output: stringifyToolResult(p.content),
              isError: !!p.is_error,
              ts,
            })
          } else if (p?.type === 'text' && typeof p.text === 'string') {
            out.push({ type: 'user_text', text: p.text, ts, ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}) })
            pendingAttachments = []
          } else if (p?.type === 'image') {
            const attachment = imageAttachmentFromClaudeBlock(p, index)
            if (attachment) pendingAttachments.push(attachment)
          }
        }
        if (pendingAttachments.length) out.push({ type: 'user_text', text: '', ts, attachments: pendingAttachments })
        return out
      }
      return []
    }
    case 'assistant': {
      const content = message?.content
      if (!Array.isArray(content)) return [{ type: 'meta', key: type, value: o, ts }]
      const out: NormalizedEvent[] = []
      for (const p of content as Record<string, unknown>[]) {
        if (p?.type === 'text' && typeof p.text === 'string') {
          out.push({ type: 'assistant_text', text: p.text, ts, agent: 'claude' })
        } else if (p?.type === 'thinking' && typeof p.thinking === 'string' && p.thinking.trim()) {
          // 明文为空(通常伴随 signature-only redacted_thinking)不 emit,
          // 避免 UI 走「加密 reasoning,无明文」占位分支。
          out.push({ type: 'thinking', text: p.thinking, ts })
        } else if (p?.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            id: String(p.id ?? ''),
            name: String(p.name ?? 'unknown'),
            input: p.input,
            ts,
            agent: 'claude',
          })
        }
      }
      // usage(可选)
      const usage = message?.usage as Record<string, unknown> | undefined
      if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
        out.push({
          type: 'usage',
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          ts,
          agent: 'claude',
        })
      }
      return out
    }
    default:
      // 兜底:未知 type 降级为 meta,不丢(不变量 5)。
      return [{ type: 'meta', key: type ?? 'unknown', value: o, ts }]
  }
}

async function statQuiet(filePath: string) {
  try {
    return await fsp.stat(filePath)
  } catch {
    return null
  }
}

export const claudeLoader: SessionSourceLoader = {
  source: SOURCE,

  async discover() {
    const summaries: SessionSummary[] = []
    const warnings: LoaderWarning[] = []
    let projectDirs: string[]
    try {
      projectDirs = await fsp.readdir(CLAUDE_PROJECTS_ROOT)
    } catch {
      return { summaries, warnings } // 目录不存在 = 没装 Claude Code,静默
    }

    for (const dir of projectDirs) {
      const dirPath = path.join(CLAUDE_PROJECTS_ROOT, dir)
      let files: string[]
      try {
        const st = await fsp.stat(dirPath)
        if (!st.isDirectory()) continue
        files = await fsp.readdir(dirPath)
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(dirPath, file)
        const st = await statQuiet(filePath)
        if (!st) continue
        try {
          const summary = await summarizeClaudeFile(filePath, st.mtimeMs, st.size)
          if (summary) summaries.push(summary)
        } catch (e) {
          warnings.push({ code: 'json_parse_failed', message: `${file}: ${String(e)}` })
        }
      }
    }
    return { summaries, warnings }
  },

  async loadEvents(filePath: string) {
    const events: EventEnvelope[] = []
    const warnings: LoaderWarning[] = []
    const summaryPatch: Partial<SessionSummary> = {}
    let messageCount = 0

    for await (const { lineNo, parsed } of readJsonlLines(filePath)) {
      if (parsed === undefined) {
        warnings.push({ line: lineNo, code: 'json_parse_failed', message: 'invalid JSON line' })
        continue
      }
      const o = parsed as Record<string, unknown>
      if ((o.type === 'user' || o.type === 'assistant') && o.message) messageCount++
      if (!summaryPatch.cwd && typeof o.cwd === 'string') summaryPatch.cwd = o.cwd
      const sourceEventId = typeof o.uuid === 'string' ? o.uuid : undefined
      const parentEventId = typeof o.parentUuid === 'string' ? o.parentUuid : undefined

      const normalized = normalizeClaudeLine(o)
      for (const ev of normalized) {
        events.push({
          origin: 'native',
          source: SOURCE,
          sourceEventId: sourceEventId ? `${sourceEventId}:${ev.type}` : `${filePath}#${lineNo}`,
          parentEventId,
          event: ev,
        })
      }
    }
    summaryPatch.messageCount = messageCount
    return { summaryPatch, events, warnings }
  },
}

// 列表阶段只读前若干行拿 title/cwd/startedAt,避免整文件解析(大文件慢)。
async function summarizeClaudeFile(
  filePath: string,
  mtimeMs: number,
  size: number,
): Promise<SessionSummary | null> {
  const id = path.basename(filePath, '.jsonl')
  let title = ''
  let cwd: string | null = null
  let startedAt = ''
  let scanned = 0

  for await (const { parsed } of readJsonlLines(filePath)) {
    scanned++
    if (parsed === undefined) continue
    const o = parsed as Record<string, unknown>
    if (!startedAt && typeof o.timestamp === 'string') startedAt = o.timestamp
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd
    if (!title && o.type === 'user') {
      const c = (o.message as Record<string, unknown> | undefined)?.content
      const raw = typeof c === 'string' ? c : Array.isArray(c)
        ? (c.find((p: any) => p?.type === 'text')?.text ?? '')
        : ''
      if (typeof raw === 'string' && raw.trim()) title = cleanTitle(raw)
    }
    if (title && cwd && startedAt) break
    if (scanned > 200) break // title 偶尔在前几十行后;放宽一点
  }
  if (!startedAt && !title && scanned === 0) return null

  return {
    id,
    source: SOURCE,
    title: title || '(无标题)',
    cwd,
    startedAt: startedAt || new Date(mtimeMs).toISOString(),
    updatedAt: new Date(mtimeMs).toISOString(),
    messageCount: null, // 列表阶段不数,详情页补
    filePath,
    fileMtimeMs: mtimeMs,
    fileSize: size,
    hasFollowups: false, // registry/threadstore 后续回填
  }
}

export function claudeFileExistsSync(filePath: string): boolean {
  return fs.existsSync(filePath)
}
