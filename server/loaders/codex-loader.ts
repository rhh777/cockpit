import fsp from 'node:fs/promises'
import path from 'node:path'
import { CODEX_SESSIONS_ROOT, CODEX_SESSION_INDEX } from '../config'
import { readJsonlLines, safeJsonParse } from '../util/jsonl'
import { cleanTitle } from '../util/title'
import type {
  ChatAttachment,
  EventEnvelope,
  LoaderWarning,
  NormalizedEvent,
  SessionSourceLoader,
  SessionSummary,
} from './types'

const SOURCE = 'codex' as const
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

// Codex output 前缀:Chunk ID / Wall time / Process exited / Original token count / Output:
// 选择性剥离,只留 Output: 之后(见 docs/02 §二注意点)。
function stripCodexOutputPrefix(output: string): string {
  const idx = output.indexOf('\nOutput:\n')
  if (idx >= 0) return output.slice(idx + '\nOutput:\n'.length)
  return output
}

function codexMessageText(p: Record<string, unknown>): string {
  const text = p.content ?? p.message
  if (typeof text === 'string') return text
  return ''
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function imageAttachmentFromPath(filePath: string): ChatAttachment | null {
  const clean = filePath.trim()
  if (!IMAGE_EXT_RE.test(clean)) return null
  const ext = path.extname(clean).toLowerCase()
  return {
    kind: 'image',
    path: clean,
    name: path.basename(clean),
    mimeType: IMAGE_MIME_BY_EXT[ext] ?? 'image/png',
  }
}

function codexImageAttachments(p: Record<string, unknown>, text: string): ChatAttachment[] {
  const out: ChatAttachment[] = []
  const seen = new Set<string>()
  const addPath = (filePath: string) => {
    const attachment = imageAttachmentFromPath(filePath)
    if (!attachment || seen.has(attachment.path ?? attachment.name)) return
    seen.add(attachment.path ?? attachment.name)
    out.push(attachment)
  }

  if (Array.isArray(p.images)) {
    for (const item of p.images) {
      if (typeof item === 'string') {
        addPath(item)
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const filePath = obj.path ?? obj.file_path ?? obj.filePath
        if (typeof filePath === 'string') addPath(filePath)
      }
    }
  }

  for (const match of text.matchAll(/(?:^|\s)(\/[^\n\r]+?\.(?:png|jpe?g|webp|gif))(?=$|\s)/gi)) {
    addPath(match[1])
  }

  return out
}

function stripCodexMentionedFilesBlock(text: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0 || !/^Files mentioned by the user:/i.test(text.trim())) return text
  const requestMatch = text.match(/(?:^|\n)My request for Codex:\s*\n?([\s\S]*)$/i)
  if (requestMatch) return requestMatch[1].trim()

  let out = text.replace(/^Files mentioned by the user:\s*/i, '')
  for (const a of attachments) {
    if (!a.path) continue
    const escapedPath = a.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedName = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`\\n?${escapedName}:\\s*\\n?${escapedPath}`, 'g'), '')
    out = out.replace(new RegExp(`\\n?${escapedPath}`, 'g'), '')
  }
  return out.trim()
}

// 关键:key 在 payload.type 上,不在顶层 .type(顶层是 session_meta/event_msg/response_item)。
export function normalizeCodexLine(o: Record<string, unknown>): NormalizedEvent[] {
  const ts = (o.timestamp as string) ?? ''
  const p = o.payload as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return []
  const pt = p.type as string

  switch (pt) {
    case 'session_meta':
      return [] // 第一行,summarize 时单独处理
    case 'user_message': {
      const text = codexMessageText(p) // 实测有的用 message
      const attachments = codexImageAttachments(p, text)
      const displayText = stripCodexMentionedFilesBlock(text, attachments)
      if (displayText || attachments.length) {
        return [{ type: 'user_text', text: displayText, ts, ...(attachments.length ? { attachments } : {}) }]
      }
      return []
    }
    case 'agent_message': {
      const text = codexMessageText(p)
      if (text) return [{ type: 'assistant_text', text, ts, agent: 'codex' }]
      return []
    }
    // 流式 delta:较新 codex rollout 只写 delta、不写终态 agent_message;
    // 不归一化会让整段 assistant 文本消失。这里挂上 streamId/delta,
    // 让 buildTimeline 把同一 streamId 的 delta 合并成一行(终态到达时再覆盖)。
    case 'agent_message_delta': {
      const text = String(p.delta ?? p.text ?? '')
      if (!text) return []
      const streamId = String(p.item_id ?? p.response_id ?? p.id ?? `${ts}:agent`)
      return [{ type: 'assistant_text', text, ts, agent: 'codex', streamId, delta: true }]
    }
    case 'agent_reasoning': {
      const text = codexMessageText(p) || String(p.text ?? '')
      return [{ type: 'thinking', text, ts }]
    }
    case 'agent_reasoning_delta':
    case 'agent_reasoning_raw_content':
    case 'agent_reasoning_raw_content_delta': {
      const text = String(p.delta ?? p.text ?? '')
      if (!text) return []
      // thinking 现阶段没有 streamId 字段,delta 直接以独立 thinking 片段进入;
      // UI 端 Thinking 折叠卡能容纳多段,体感上是连续的。
      return [{ type: 'thinking', text, ts }]
    }
    // Codex 较新版本把 shell 调用拆成 begin/end 而非 function_call/_output。
    // begin → tool_use,end → tool_result,call_id 串起来。
    case 'exec_command_begin': {
      return [
        {
          type: 'tool_use',
          id: String(p.call_id ?? ''),
          name: 'shell',
          input: p.command ?? p,
          ts,
          agent: 'codex',
        },
      ]
    }
    case 'exec_command_end': {
      const stdout = typeof p.stdout === 'string' ? p.stdout : ''
      const stderr = typeof p.stderr === 'string' ? p.stderr : ''
      const exit = typeof p.exit_code === 'number' ? p.exit_code : 0
      const parts = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean) as string[]
      return [
        {
          type: 'tool_result',
          toolUseId: String(p.call_id ?? ''),
          output: parts.join('\n') || (exit !== 0 ? `(exit ${exit})` : ''),
          isError: exit !== 0,
          ts,
        },
      ]
    }
    case 'function_call': {
      let input: unknown = p.arguments
      if (typeof p.arguments === 'string') {
        const r = safeJsonParse(p.arguments)
        input = r.ok ? r.value : p.arguments
      }
      return [
        {
          type: 'tool_use',
          id: String(p.call_id ?? ''),
          name: String(p.name ?? 'unknown'),
          input,
          ts,
          agent: 'codex',
        },
      ]
    }
    case 'function_call_output':
      return [
        {
          type: 'tool_result',
          toolUseId: String(p.call_id ?? ''),
          output: stripCodexOutputPrefix(String(p.output ?? '')),
          isError: false,
          ts,
        },
      ]
    case 'custom_tool_call': {
      // Codex Desktop / 较新 CLI 把 apply_patch 等记成 custom_tool_call;input 是单字符串。
      // 不再去 JSON.parse —— apply_patch 的 input 本身就是 `*** Begin Patch` 文本。
      return [
        {
          type: 'tool_use',
          id: String(p.call_id ?? ''),
          name: String(p.name ?? 'unknown'),
          input: typeof p.input === 'string' ? p.input : p.input,
          ts,
          agent: 'codex',
        },
      ]
    }
    case 'custom_tool_call_output': {
      // output 通常是 JSON 字符串 {output, metadata:{exit_code,...}};尝试解析,失败原样保留。
      const raw = String(p.output ?? '')
      const parsed = safeJsonParse(raw)
      let text = raw
      let isError = false
      if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
        const v = parsed.value as Record<string, unknown>
        if (typeof v.output === 'string') text = v.output
        const meta = v.metadata as Record<string, unknown> | undefined
        if (meta && typeof meta.exit_code === 'number' && meta.exit_code !== 0) isError = true
      }
      return [
        {
          type: 'tool_result',
          toolUseId: String(p.call_id ?? ''),
          output: text,
          isError,
          ts,
        },
      ]
    }
    case 'reasoning': {
      // Codex 有加密 reasoning:summary 为空、payload 里只剩 encrypted_content。
      // 之前 emit 空 text thinking + UI 「加密 reasoning,无明文」占位,实测在群聊
      // (codex 走 app-server 时更根本没 reasoning notification)大量产生误导性空节点。
      // 现在明文为空就直接丢弃,timeline 索性不显示该 step。
      const summary = p.summary
      if (Array.isArray(summary) && summary.length > 0) {
        const text = summary
          .map((s) =>
            typeof s === 'string' ? s : (s as Record<string, unknown>)?.text ?? '',
          )
          .filter(Boolean)
          .join('\n')
        if (text.trim()) return [{ type: 'thinking', text, ts }]
      }
      return []
    }
    case 'token_count': {
      const info = (p.info ?? p) as Record<string, unknown>
      return [
        {
          type: 'usage',
          inputTokens: Number(info.input_tokens ?? info.total_input_tokens ?? 0),
          outputTokens: Number(info.output_tokens ?? info.total_output_tokens ?? 0),
          ts,
          agent: 'codex',
        },
      ]
    }
    case 'message':
      return [] // developer/system 指令,MVP 跳过
    case 'web_search_call':
      // Codex 把内置搜索拆成 call/end 两个事件;把 call 当 tool_use(便于和 shell/apply_patch 一起进 trace pill),
      // end 是无 payload 的结束标记,丢弃。
      return [
        {
          type: 'tool_use',
          id: String(p.call_id ?? p.id ?? ''),
          name: 'web_search',
          input: p.query ?? p.action ?? p,
          ts,
          agent: 'codex',
        },
      ]
    case 'web_search_end':
      return []
    case 'task_started':
    case 'task_complete':
    case 'turn_aborted':
      return [{ type: 'meta', key: pt, value: p, ts }]
    default:
      return [{ type: 'meta', key: pt ?? 'unknown', value: p, ts }]
  }
}

interface IndexEntry {
  id: string
  thread_name?: string
  updated_at?: string
}

export function resolveCodexUpdatedAt(indexedAt: string | undefined, fileMtimeMs: number): string {
  const fileAt = new Date(fileMtimeMs).toISOString()
  if (!indexedAt) return fileAt
  const indexedMs = Date.parse(indexedAt)
  if (!Number.isFinite(indexedMs)) return fileAt
  return indexedMs > fileMtimeMs ? new Date(indexedMs).toISOString() : fileAt
}

async function readSessionIndex(): Promise<Map<string, IndexEntry>> {
  const map = new Map<string, IndexEntry>()
  try {
    for await (const { parsed } of readJsonlLines(CODEX_SESSION_INDEX)) {
      if (parsed === undefined) continue
      const e = parsed as IndexEntry
      if (e.id) map.set(e.id, e)
    }
  } catch {
    // index 不存在,忽略
  }
  return map
}

export interface CodexFileSummaryPatch {
  title?: string
  cwd?: string | null
  startedAt?: string
}

// session_index.jsonl 只有标题和更新时间,没有 cwd。
// 列表阶段轻量扫描文件头补 cwd;缺标题时再继续找首条 user_message 兜底。
export async function summarizeCodexFile(
  filePath: string,
  maxLines = 200,
  needTitle = true,
): Promise<CodexFileSummaryPatch> {
  const patch: CodexFileSummaryPatch = {}
  let scanned = 0

  for await (const { parsed } of readJsonlLines(filePath)) {
    scanned++
    if (parsed === undefined) {
      if (scanned >= maxLines) break
      continue
    }

    const o = parsed as Record<string, unknown>
    const p = o.payload as Record<string, unknown> | undefined
    if (!p || typeof p !== 'object') {
      if (scanned >= maxLines) break
      continue
    }

    if (o.type === 'session_meta') {
      if (typeof p.cwd === 'string') patch.cwd = p.cwd
      if (typeof p.timestamp === 'string') patch.startedAt = p.timestamp
    }

    const pt = p.type
    if (needTitle && !patch.title && pt === 'user_message') {
      const title = cleanTitle(codexMessageText(p))
      if (title) patch.title = title
    }

    if ((!needTitle || patch.title) && patch.cwd && patch.startedAt) break
    if (scanned >= maxLines) break
  }

  return patch
}

// 递归 walk sessions 树,只 readdir + stat(不开文件),从文件名提取 uuid。
async function walkSessionFiles(
  root: string,
): Promise<Array<{ id: string; filePath: string; mtimeMs: number; size: number }>> {
  const out: Array<{ id: string; filePath: string; mtimeMs: number; size: number }> = []
  async function recur(dir: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await recur(full)
      } else if (ent.name.endsWith('.jsonl')) {
        const m = ent.name.match(UUID_RE)
        if (!m) continue
        try {
          const st = await fsp.stat(full)
          out.push({ id: m[0], filePath: full, mtimeMs: st.mtimeMs, size: st.size })
        } catch {
          /* skip */
        }
      }
    }
  }
  await recur(root)
  return out
}

export const codexLoader: SessionSourceLoader = {
  source: SOURCE,

  async discover() {
    const summaries: SessionSummary[] = []
    const warnings: LoaderWarning[] = []
    const index = await readSessionIndex()
    const files = await walkSessionFiles(CODEX_SESSIONS_ROOT)

    for (const f of files) {
      const entry = index.get(f.id)
      const indexedTitle = entry?.thread_name?.trim()
      const fallback = await summarizeCodexFile(f.filePath, indexedTitle ? 20 : 200, !indexedTitle)
      const updatedAt = resolveCodexUpdatedAt(entry?.updated_at, f.mtimeMs)
      summaries.push({
        id: f.id,
        source: SOURCE,
        title: indexedTitle || fallback.title || '(无标题)',
        cwd: fallback.cwd ?? null,
        startedAt: fallback.startedAt ?? entry?.updated_at ?? new Date(f.mtimeMs).toISOString(),
        updatedAt,
        messageCount: null,
        filePath: f.filePath,
        fileMtimeMs: f.mtimeMs,
        fileSize: f.size,
        hasFollowups: false,
      })
    }
    return { summaries, warnings }
  },

  async loadEvents(filePath: string) {
    const events: EventEnvelope[] = []
    const warnings: LoaderWarning[] = []
    const summaryPatch: Partial<SessionSummary> = {}
    let messageCount = 0
    let seq = 0

    for await (const { lineNo, parsed } of readJsonlLines(filePath)) {
      if (parsed === undefined) {
        warnings.push({ line: lineNo, code: 'json_parse_failed', message: 'invalid JSON line' })
        continue
      }
      const o = parsed as Record<string, unknown>
      const p = o.payload as Record<string, unknown> | undefined

      // session_meta:第一行,提 cwd / title 兜底,不入 timeline。
      if (o.type === 'session_meta' && p) {
        if (typeof p.cwd === 'string') summaryPatch.cwd = p.cwd
        if (typeof p.timestamp === 'string') summaryPatch.startedAt = p.timestamp
        continue
      }
      const pt = p?.type
      if (pt === 'user_message' || pt === 'agent_message') messageCount++
      if (!summaryPatch.title && pt === 'user_message' && p) {
        const title = cleanTitle(codexMessageText(p))
        if (title) summaryPatch.title = title
      }

      const normalized = normalizeCodexLine(o)
      for (const ev of normalized) {
        // call_id 优先;无 id 的普通消息用 filePath#行号 生成稳定 id。
        const baseId =
          ev.type === 'tool_use'
            ? ev.id
            : ev.type === 'tool_result'
              ? ev.toolUseId
              : `${path.basename(filePath)}#${lineNo}#${seq++}`
        events.push({
          origin: 'native',
          source: SOURCE,
          sourceEventId: baseId,
          event: ev,
        })
      }
    }
    summaryPatch.messageCount = messageCount
    return { summaryPatch, events, warnings }
  },
}
