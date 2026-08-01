import fsp from 'node:fs/promises'
import path from 'node:path'
import { CURSOR_CHATS_ROOT, CURSOR_PROJECTS_ROOT } from '../config'
import { readJsonlCompleteLinesFrom, readJsonlLines, stringifyToolResult } from '../util/jsonl'
import { cleanTitle } from '../util/title'
import type {
  EventEnvelope,
  LoaderWarning,
  NormalizedEvent,
  SessionSourceLoader,
  SessionSummary,
} from './types'

const SOURCE = 'cursor' as const

interface CursorMeta {
  title?: string
  cwd?: string
  createdAtMs?: number
  updatedAtMs?: number
  hasConversation?: boolean
}

function isoAt(baseMs: number, lineNo: number): string {
  return new Date(baseMs + Math.max(0, lineNo - 1)).toISOString()
}

// Cursor 把用户输入包在提示词模板里落盘：<timestamp>…</timestamp> + <user_query>…</user_query>，
// 还可能附带 <additional_data> / <attached_files> 等上下文块。timeline 只展示真正的用户输入。
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/g
const CURSOR_CONTEXT_TAGS = [
  'timestamp',
  'additional_data',
  'attached_files',
  'environment_details',
  'current_file',
  'cursor_rules_context',
  'system_info',
]

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const TIMESTAMP_RE =
  /<timestamp>\s*(?:\w+,\s*)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)/i

/** 解析 `<timestamp>Saturday, Aug 1, 2026, 5:37 PM (UTC+8)</timestamp>`，失败返回 null。 */
export function parseCursorTimestamp(text: string): number | null {
  const m = TIMESTAMP_RE.exec(text)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  const day = Number(m[2])
  const year = Number(m[3])
  let hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6] ?? 0)
  const meridiem = m[7]?.toUpperCase()
  if (meridiem === 'PM' && hour < 12) hour += 12
  if (meridiem === 'AM' && hour === 12) hour = 0
  const offsetMinutes = Number(m[8]) * 60 + (Number(m[8]) < 0 ? -Number(m[9] ?? 0) : Number(m[9] ?? 0))
  const ms = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000
  return Number.isFinite(ms) ? ms : null
}

/** 剥掉 Cursor 的提示词包装，只留用户实际输入。 */
export function unwrapCursorUserText(text: string): string {
  const queries: string[] = []
  USER_QUERY_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = USER_QUERY_RE.exec(text))) {
    const inner = match[1].trim()
    if (inner) queries.push(inner)
  }
  if (queries.length) return queries.join('\n\n')

  let rest = text
  for (const tag of CURSOR_CONTEXT_TAGS) {
    rest = rest.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), '')
  }
  return rest.trim()
}

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : []
  if (!Array.isArray(content)) return []
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === 'object' && !Array.isArray(part))
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .filter(Boolean)
}

export function normalizeCursorTranscriptLine(
  row: Record<string, unknown>,
  ts: string,
): NormalizedEvent[] {
  const role = String(row.role ?? '')
  const message = row.message as Record<string, unknown> | undefined
  const content = message?.content

  if (role === 'user') {
    const out: NormalizedEvent[] = []
    if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          const text = unwrapCursorUserText(part.text)
          if (text) out.push({ type: 'user_text', text, ts })
        } else if (part?.type === 'tool_result') {
          out.push({
            type: 'tool_result',
            toolUseId: String(part.tool_use_id ?? part.toolUseId ?? ''),
            output: stringifyToolResult(part.content),
            isError: !!part.is_error,
            ts,
          })
        }
      }
    } else {
      for (const raw of textParts(content)) {
        const text = unwrapCursorUserText(raw)
        if (text) out.push({ type: 'user_text', text, ts })
      }
    }
    return out
  }

  if (role === 'assistant') {
    const out: NormalizedEvent[] = []
    if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          out.push({ type: 'assistant_text', text: part.text, ts, agent: 'cursor' })
        } else if ((part?.type === 'thinking' || part?.type === 'reasoning') && typeof part.text === 'string') {
          if (part.text.trim()) out.push({ type: 'thinking', text: part.text, ts })
        } else if (part?.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            id: String(part.id ?? part.tool_use_id ?? ''),
            name: String(part.name ?? part.tool ?? 'unknown'),
            input: part.input ?? part.arguments ?? {},
            ts,
            agent: 'cursor',
          })
        }
      }
    } else {
      for (const text of textParts(content)) out.push({ type: 'assistant_text', text, ts, agent: 'cursor' })
    }
    return out
  }

  const type = String(row.type ?? 'unknown')
  return [{ type: 'meta', key: `cursor_${type}`, value: row, ts }]
}

async function statQuiet(filePath: string) {
  try {
    return await fsp.stat(filePath)
  } catch {
    return null
  }
}

async function readMetaFile(filePath: string): Promise<CursorMeta | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as CursorMeta
  } catch {
    return null
  }
}

async function discoverMetas(): Promise<Map<string, CursorMeta>> {
  const metas = new Map<string, CursorMeta>()
  let workspaces: string[]
  try {
    workspaces = await fsp.readdir(CURSOR_CHATS_ROOT)
  } catch {
    return metas
  }
  for (const workspace of workspaces) {
    const workspacePath = path.join(CURSOR_CHATS_ROOT, workspace)
    let sessions: string[]
    try {
      sessions = await fsp.readdir(workspacePath)
    } catch {
      continue
    }
    for (const id of sessions) {
      const meta = await readMetaFile(path.join(workspacePath, id, 'meta.json'))
      if (meta) metas.set(id, meta)
    }
  }
  return metas
}

async function findMeta(id: string): Promise<CursorMeta | null> {
  return (await discoverMetas()).get(id) ?? null
}

async function transcriptFiles(): Promise<string[]> {
  const files: string[] = []
  let projects: string[]
  try {
    projects = await fsp.readdir(CURSOR_PROJECTS_ROOT)
  } catch {
    return files
  }
  for (const project of projects) {
    const root = path.join(CURSOR_PROJECTS_ROOT, project, 'agent-transcripts')
    let sessions: string[]
    try {
      sessions = await fsp.readdir(root)
    } catch {
      continue
    }
    for (const id of sessions) {
      const filePath = path.join(root, id, `${id}.jsonl`)
      if ((await statQuiet(filePath))?.isFile()) files.push(filePath)
    }
  }
  return files
}

async function firstUserText(filePath: string): Promise<string> {
  let scanned = 0
  for await (const { parsed } of readJsonlLines(filePath)) {
    if (++scanned > 100) break
    if (!parsed || typeof parsed !== 'object') continue
    const row = parsed as Record<string, unknown>
    if (row.role !== 'user') continue
    const message = row.message as Record<string, unknown> | undefined
    for (const raw of textParts(message?.content)) {
      const text = unwrapCursorUserText(raw)
      if (text) return text
    }
  }
  return ''
}

async function loadCursorRows(
  filePath: string,
  id: string,
  rows: AsyncIterable<{ lineNo: number; parsed?: unknown }>,
): Promise<{ events: EventEnvelope[]; warnings: LoaderWarning[]; messageCount: number; meta: CursorMeta | null }> {
  const events: EventEnvelope[] = []
  const warnings: LoaderWarning[] = []
  let messageCount = 0
  const meta = await findMeta(id)
  let baseMs = Number(meta?.createdAtMs) || (await statQuiet(filePath))?.mtimeMs || Date.now()
  // Cursor 行本身没有 ts，只有用户消息模板里的 <timestamp>；命中后以它为锚点，之后的行按行号微偏移。
  let anchorLine = 1

  for await (const { lineNo, parsed } of rows) {
    if (parsed === undefined) {
      warnings.push({ line: lineNo, code: 'json_parse_failed', message: 'invalid JSON line' })
      continue
    }
    const row = parsed as Record<string, unknown>
    if (row.role === 'user' || row.role === 'assistant') messageCount++
    if (row.role === 'user') {
      const raw = textParts((row.message as Record<string, unknown> | undefined)?.content).join('\n')
      const stampedMs = raw ? parseCursorTimestamp(raw) : null
      if (stampedMs !== null) {
        baseMs = stampedMs
        anchorLine = lineNo
      }
    }
    const normalized = normalizeCursorTranscriptLine(row, isoAt(baseMs, lineNo - anchorLine + 1))
    for (const [partIndex, event] of normalized.entries()) {
      events.push({
        origin: 'native',
        source: SOURCE,
        sourceEventId: `${id}:${lineNo}:${partIndex}`,
        event,
      })
    }
  }
  return { events, warnings, messageCount, meta }
}

export const cursorLoader: SessionSourceLoader = {
  source: SOURCE,

  async discover() {
    const summaries: SessionSummary[] = []
    const warnings: LoaderWarning[] = []
    const metas = await discoverMetas()
    for (const filePath of await transcriptFiles()) {
      const id = path.basename(filePath, '.jsonl')
      const st = await statQuiet(filePath)
      if (!st) continue
      try {
        const meta = metas.get(id)
        if (meta?.hasConversation === false) continue
        const firstUser = await firstUserText(filePath)
        const startedMs = Number(meta?.createdAtMs) || st.birthtimeMs || st.mtimeMs
        const updatedMs = Math.max(Number(meta?.updatedAtMs) || 0, st.mtimeMs)
        summaries.push({
          id,
          source: SOURCE,
          title: cleanTitle(meta?.title || firstUser) || '(无标题)',
          cwd: meta?.cwd || null,
          startedAt: new Date(startedMs).toISOString(),
          updatedAt: new Date(updatedMs).toISOString(),
          messageCount: null,
          filePath,
          fileMtimeMs: updatedMs,
          fileSize: st.size,
          hasFollowups: false,
        })
      } catch (error) {
        warnings.push({ code: 'json_parse_failed', message: `${id}: ${String(error)}` })
      }
    }
    return { summaries, warnings }
  },

  async loadEvents(filePath, id = path.basename(filePath, '.jsonl')) {
    const loaded = await loadCursorRows(filePath, id, readJsonlLines(filePath))
    return {
      summaryPatch: {
        title: loaded.meta?.title,
        cwd: loaded.meta?.cwd ?? null,
        startedAt: loaded.meta?.createdAtMs ? new Date(loaded.meta.createdAtMs).toISOString() : undefined,
        updatedAt: loaded.meta?.updatedAtMs ? new Date(loaded.meta.updatedAtMs).toISOString() : undefined,
        messageCount: loaded.messageCount,
      },
      events: loaded.events,
      warnings: loaded.warnings,
    }
  },

  async loadEventsFrom(filePath, state) {
    const id = path.basename(filePath, '.jsonl')
    const read = await readJsonlCompleteLinesFrom(filePath, state)
    const rows = (async function* () {
      yield* read.lines
    })()
    const loaded = await loadCursorRows(filePath, id, rows)
    return {
      state: { ...state, byteOffset: read.byteOffset, lineNo: read.lineNo, pending: read.pending },
      events: loaded.events,
      warnings: loaded.warnings,
      summaryPatch: loaded.messageCount ? { messageCount: loaded.messageCount } : undefined,
    }
  },
}
