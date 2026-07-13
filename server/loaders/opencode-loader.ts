import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import { promisify } from 'node:util'
import { OPENCODE_DB_PATH } from '../config'
import { cleanTitle } from '../util/title'
import type {
  EventEnvelope,
  LoaderWarning,
  NormalizedEvent,
  SessionSourceLoader,
  SessionSummary,
} from './types'

const SOURCE = 'opencode' as const
const execFileAsync = promisify(execFile)

interface OpenCodeSessionRow {
  id: string
  title?: string
  directory?: string
  time_created?: number
  time_updated?: number
  agent?: string
  model?: string
  message_count?: number
}

interface OpenCodeSessionMessageRow {
  id: string
  type: string
  seq: number
  time_created: number
  time_updated?: number
  data: string
}

interface OpenCodePartRow {
  message_id: string
  message_data: string
  part_id: string
  part_data: string
  part_time_created: number
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    maxBuffer: 16 * 1024 * 1024,
  })
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

function parseData(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function msIso(value: unknown): string {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString()
  return new Date(0).toISOString()
}

function dataTime(data: Record<string, unknown>, fallbackMs: unknown): string {
  const time = data.time as Record<string, unknown> | undefined
  return msIso(time?.created ?? time?.start ?? fallbackMs)
}

function textFromContentPart(part: Record<string, unknown>): string {
  return typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : ''
}

function normalizeToolPart(part: Record<string, unknown>, ts: string): NormalizedEvent[] {
  const id = String(part.id ?? part.callID ?? part.call_id ?? part.toolCallID ?? '')
  const name = String(part.tool ?? part.name ?? part.title ?? 'tool')
  const input = part.input ?? part.arguments ?? part.params ?? part
  const out: NormalizedEvent[] = [
    {
      type: 'tool_use',
      id,
      name,
      input,
      ts,
      agent: SOURCE,
    },
  ]

  const output = part.output ?? part.result ?? part.error
  if (output !== undefined) {
    out.push({
      type: 'tool_result',
      toolUseId: id,
      output: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
      isError: part.error !== undefined || part.status === 'error',
      ts,
    })
  }
  return out
}

function normalizePart(part: Record<string, unknown>, role: string, ts: string): NormalizedEvent[] {
  const type = String(part.type ?? '')
  if (role === 'user' || type === 'user') {
    const text = textFromContentPart(part)
    return text ? [{ type: 'user_text', text, ts }] : []
  }

  if (type === 'text') {
    const text = textFromContentPart(part)
    return text ? [{ type: 'assistant_text', text, ts, agent: SOURCE }] : []
  }
  if (type === 'reasoning') {
    const text = textFromContentPart(part)
    return text ? [{ type: 'thinking', text, ts }] : []
  }
  if (type === 'step-finish') {
    const tokens = part.tokens as Record<string, unknown> | undefined
    if (!tokens) return []
    return [
      {
        type: 'usage',
        inputTokens: Number(tokens.input ?? 0),
        outputTokens: Number(tokens.output ?? 0),
        ts,
        agent: SOURCE,
      },
    ]
  }
  if (type === 'tool' || type === 'tool-use' || type === 'tool-call') {
    return normalizeToolPart(part, ts)
  }
  if (type === 'step-start') return []
  return [{ type: 'meta', key: type || 'opencode_part', value: part, ts }]
}

function normalizeSessionMessage(row: OpenCodeSessionMessageRow): NormalizedEvent[] {
  const data = parseData(row.data)
  const ts = dataTime(data, row.time_created)
  if (row.type === 'user') {
    const text = typeof data.text === 'string' ? data.text : ''
    return text ? [{ type: 'user_text', text, ts }] : []
  }

  if (row.type === 'assistant') {
    const out: NormalizedEvent[] = []
    const content = data.content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === 'object') out.push(...normalizePart(item as Record<string, unknown>, 'assistant', ts))
      }
    }
    if (data.error) out.push({ type: 'meta', key: 'opencode_error', value: data.error, ts })
    return out
  }

  return [{ type: 'meta', key: row.type || 'opencode_message', value: data, ts }]
}

function normalizeLegacyPart(row: OpenCodePartRow): NormalizedEvent[] {
  const message = parseData(row.message_data)
  const part = parseData(row.part_data)
  const role = typeof message.role === 'string' ? message.role : 'assistant'
  const ts = dataTime(part, row.part_time_created)
  return normalizePart(part, role, ts)
}

function messageCountFromRows(rows: OpenCodeSessionMessageRow[], legacyRows: OpenCodePartRow[]): number {
  return rows.filter((r) => r.type === 'user' || r.type === 'assistant').length + new Set(legacyRows.map((r) => r.message_id)).size
}

function firstTitle(events: EventEnvelope[]): string {
  const first = events.find((e) => e.event.type === 'user_text')
  return first?.event.type === 'user_text' ? cleanTitle(first.event.text) : ''
}

async function readSessionRows(dbPath: string, id: string): Promise<OpenCodeSessionMessageRow[]> {
  return sqliteJson<OpenCodeSessionMessageRow>(
    dbPath,
    [
      'select id, type, seq, time_created, time_updated, data',
      'from session_message',
      `where session_id = ${sqlString(id)}`,
      'order by seq asc, id asc',
    ].join(' '),
  )
}

async function readLegacyPartRows(dbPath: string, id: string): Promise<OpenCodePartRow[]> {
  return sqliteJson<OpenCodePartRow>(
    dbPath,
    [
      'select m.id as message_id, m.data as message_data,',
      'p.id as part_id, p.data as part_data, p.time_created as part_time_created',
      'from message m',
      'join part p on p.message_id = m.id',
      `where m.session_id = ${sqlString(id)}`,
      'order by m.time_created asc, m.id asc, p.time_created asc, p.id asc',
    ].join(' '),
  )
}

async function readLegacyPartRowsBestEffort(dbPath: string, id: string): Promise<OpenCodePartRow[]> {
  try {
    return await readLegacyPartRows(dbPath, id)
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (message.includes('no such table: message') || message.includes('no such table: part')) return []
    throw err
  }
}

export const opencodeLoader: SessionSourceLoader = {
  source: SOURCE,

  async discover() {
    const summaries: SessionSummary[] = []
    const warnings: LoaderWarning[] = []
    let st: { mtimeMs: number; size: number }
    try {
      const stat = await fsp.stat(OPENCODE_DB_PATH)
      st = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return { summaries, warnings }
    }

    let rows: OpenCodeSessionRow[] = []
    try {
      rows = await sqliteJson<OpenCodeSessionRow>(
        OPENCODE_DB_PATH,
        [
          'select s.id, s.title, s.directory, s.time_created, s.time_updated, s.agent, s.model,',
          'coalesce(sm.c, 0) + coalesce(m.c, 0) as message_count',
          'from session s',
          'left join (select session_id, count(*) as c from session_message group by session_id) sm on sm.session_id = s.id',
          'left join (select session_id, count(*) as c from message group by session_id) m on m.session_id = s.id',
          'order by s.time_updated desc',
        ].join(' '),
      )
    } catch (err) {
      warnings.push({ code: 'opencode_sqlite_failed', message: String((err as Error)?.message ?? err) })
      return { summaries, warnings }
    }

    for (const row of rows) {
      const title = row.title?.trim() || 'OpenCode session'
      summaries.push({
        id: row.id,
        source: SOURCE,
        title,
        cwd: row.directory ?? null,
        startedAt: msIso(row.time_created),
        updatedAt: msIso(row.time_updated ?? row.time_created),
        messageCount: Number(row.message_count ?? 0),
        filePath: OPENCODE_DB_PATH,
        fileMtimeMs: st.mtimeMs,
        fileSize: st.size,
        hasFollowups: false,
        extensions: {
          agent: row.agent,
          model: row.model ? parseData(row.model) : undefined,
        },
      })
    }
    return { summaries, warnings }
  },

  async loadEvents(filePath: string, id?: string) {
    const events: EventEnvelope[] = []
    const warnings: LoaderWarning[] = []
    const summaryPatch: Partial<SessionSummary> = {}
    if (!id) {
      warnings.push({ code: 'missing_field', message: 'OpenCode session id is required' })
      return { summaryPatch, events, warnings }
    }

    let session: OpenCodeSessionRow | undefined
    let rows: OpenCodeSessionMessageRow[] = []
    let legacyRows: OpenCodePartRow[] = []
    try {
      const sessions = await sqliteJson<OpenCodeSessionRow>(
        filePath,
        `select id, title, directory, time_created, time_updated, agent, model from session where id = ${sqlString(id)} limit 1`,
      )
      session = sessions[0]
      rows = await readSessionRows(filePath, id)
      legacyRows = await readLegacyPartRowsBestEffort(filePath, id)
    } catch (err) {
      warnings.push({ code: 'opencode_sqlite_failed', message: String((err as Error)?.message ?? err) })
      return { summaryPatch, events, warnings }
    }

    let seq = 0
    const pending: Array<{ sort: number; seq: number; envelope: EventEnvelope }> = []
    for (const row of rows) {
      for (const ev of normalizeSessionMessage(row)) {
        pending.push({
          sort: Number(row.time_created ?? row.time_updated ?? 0),
          seq: seq++,
          envelope: {
            origin: 'native',
            source: SOURCE,
            sourceEventId: `${id}:session_message:${row.seq}:${seq}`,
            event: ev,
          },
        })
      }
    }
    for (const row of legacyRows) {
      for (const ev of normalizeLegacyPart(row)) {
        pending.push({
          sort: Number(row.part_time_created ?? 0),
          seq: seq++,
          envelope: {
            origin: 'native',
            source: SOURCE,
            sourceEventId: `${id}:part:${row.part_id}:${seq}`,
            event: ev,
          },
        })
      }
    }
    pending.sort((a, b) => a.sort - b.sort || a.seq - b.seq)
    events.push(...pending.map((item) => item.envelope))

    summaryPatch.title = session?.title?.trim() || firstTitle(events) || 'OpenCode session'
    summaryPatch.cwd = session?.directory ?? null
    summaryPatch.startedAt = msIso(session?.time_created)
    summaryPatch.messageCount = messageCountFromRows(rows, legacyRows)
    summaryPatch.extensions = {
      agent: session?.agent,
      model: session?.model ? parseData(session.model) : undefined,
    }

    return { summaryPatch, events, warnings }
  },
}
