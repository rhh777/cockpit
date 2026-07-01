// 规则版 ContextBuilder。docs/07 Phase 1/2:不调 LLM,只做抽取 + 截断。
// 所有 markdown 写盘前必须过 sensitive filter(redactSecrets / filterToolResult)。

import { filterToolResult, redactSecrets } from '../adapters/sensitive'
import { sessionRegistry } from '../registry/session-registry'
import { loadSessionDetail } from '../sessions-service'
import { groupThreadStore } from '../store/group-thread-store'
import type { EventEnvelope, NormalizedEvent } from '../loaders/types'
import type {
  BuiltContext,
  CreateHandoffInput,
  HandoffSourceRef,
  HandoffSourceSnapshot,
  TranscriptMode,
} from './types'

const RECENT_LIMIT = 30
const TOOL_OUTPUT_BUDGET = 2000

interface ResolvedSource {
  title: string
  cwd: string | null
  events: EventEnvelope[]
  snapshot: HandoffSourceSnapshot
}

export async function buildContext(input: CreateHandoffInput): Promise<BuiltContext> {
  const resolved = await resolveSource(input.source)
  const mode: TranscriptMode = input.transcriptMode ?? 'full'

  const transcriptResult = buildTranscriptWithStats(resolved.events, mode)
  const canonical = {
    summary: redactSecrets(buildSummary(resolved, input.currentRequest)).text,
    transcript: redactSecrets(transcriptResult.text).text,
    decisions: buildPlaceholder('Decisions'),
    taskState: buildPlaceholder('Task State'),
    fileRefs: redactSecrets(buildFileRefs(resolved)).text,
  }

  const entries = {
    codex: buildCodexEntry({
      cwd: resolved.cwd,
      currentRequest: input.currentRequest ?? '',
    }),
    claude: buildClaudeEntry({
      summary: canonical.summary,
      currentRequest: input.currentRequest ?? '',
    }),
  }

  const approxTokens = approxTokenCount(
    canonical.summary + canonical.transcript + canonical.decisions + canonical.taskState + canonical.fileRefs,
  )

  return {
    title: resolved.title,
    cwd: resolved.cwd,
    snapshot: resolved.snapshot,
    stats: {
      transcriptMode: mode,
      transcriptTruncated: transcriptResult.truncated,
      eventsIncluded: transcriptResult.included,
      eventsTotal: transcriptResult.total,
      approxTokens,
    },
    canonical,
    entries,
  }
}

// docs/07 Phase 3 — 粗略 token 估算(GPT/Claude 都在 3~4 char/tok 量级,取 4)。
function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

async function resolveSource(ref: HandoffSourceRef): Promise<ResolvedSource> {
  if (ref.kind === 'group-thread') {
    const state = await groupThreadStore.readState(ref.groupThreadId)
    if (!state) throw new Error(`group thread not found: ${ref.groupThreadId}`)
    const events = await groupThreadStore.readTranscript(ref.groupThreadId)
    return {
      title: state.title,
      cwd: state.cwd,
      events,
      snapshot: {
        sourceUpdatedAt: state.updatedAt,
        sourceEventCount: events.length,
        summaryRevision: state.summaryRevision,
      },
    }
  }

  const filePath = await sessionRegistry.resolve(ref.source, ref.sessionId)
  if (!filePath) throw new Error(`source session not found: ${ref.source}:${ref.sessionId}`)
  const detail = await loadSessionDetail(ref.source, ref.sessionId, filePath)
  if (!detail) throw new Error(`source session load failed: ${ref.source}:${ref.sessionId}`)

  return {
    title: detail.summary.title,
    cwd: detail.summary.cwd,
    events: detail.events,
    snapshot: {
      sourceUpdatedAt: detail.summary.updatedAt,
      // native loader 跳过坏行,event count 不严格稳定 — docs/07 允许 null。
      sourceEventCount: ref.kind === 'cockpit-followup' ? detail.events.length : null,
      fileMtimeMs: detail.summary.fileMtimeMs,
    },
  }
}

export async function currentSourceSnapshot(ref: HandoffSourceRef): Promise<HandoffSourceSnapshot | null> {
  try {
    const resolved = await resolveSource(ref)
    return resolved.snapshot
  } catch {
    return null
  }
}

function buildSummary(src: ResolvedSource, currentRequest?: string): string {
  const firstUser = src.events.find((e) => e.event.type === 'user_text')
  const lastUser = [...src.events].reverse().find((e) => e.event.type === 'user_text')
  const lastAssistant = [...src.events].reverse().find((e) => e.event.type === 'assistant_text')

  const firstText = firstUser?.event.type === 'user_text' ? firstUser.event.text : ''
  const lastUserText = lastUser?.event.type === 'user_text' ? lastUser.event.text : ''
  const lastAssistantText = lastAssistant?.event.type === 'assistant_text' ? lastAssistant.event.text : ''

  return [
    '# Summary',
    '',
    '## Goal',
    truncate(firstText, 400) || '_(none)_',
    '',
    '## Current State',
    truncate(lastAssistantText, 600) || '_(none)_',
    '',
    '## Last User Message',
    truncate(lastUserText, 400) || '_(none)_',
    '',
    '## Decisions',
    '_(none — fill in if needed)_',
    '',
    '## Open Questions',
    '_(none)_',
    '',
    '## Next Steps',
    currentRequest ? truncate(currentRequest, 600) : '_(none)_',
    '',
  ].join('\n')
}

function buildTranscript(events: EventEnvelope[], mode: TranscriptMode): string {
  return buildTranscriptWithStats(events, mode).text
}

interface TranscriptResult {
  text: string
  included: number
  total: number
  truncated: boolean
}

function buildTranscriptWithStats(events: EventEnvelope[], mode: TranscriptMode): TranscriptResult {
  if (mode === 'summary-only') {
    return { text: '# Transcript\n\n_(omitted: summary-only mode)_\n', included: 0, total: events.length, truncated: true }
  }
  const filtered = events.filter(
    (e) => e.event.type !== 'meta' && e.event.type !== 'usage' && e.event.type !== 'followup_boundary',
  )
  const slice = mode === 'recent' ? filtered.slice(-RECENT_LIMIT) : filtered
  const truncated = filtered.length > 0 && slice.length < filtered.length

  const lines: string[] = ['# Transcript', '']
  if (truncated) {
    lines.push(`_(${slice.length} of ${filtered.length} events shown, mode=${mode})_`, '')
  }
  const toolInputById = new Map<string, unknown>()
  for (const env of slice) {
    lines.push(...renderEvent(env.event, toolInputById))
    lines.push('')
  }
  return { text: lines.join('\n'), included: slice.length, total: filtered.length, truncated }
}

function renderEvent(e: NormalizedEvent, toolInputById: Map<string, unknown>): string[] {
  if (e.type === 'user_text') {
    return ['## User', '', e.text || '_(empty)_']
  }
  if (e.type === 'assistant_text') {
    if (e.delta) return []
    const who = e.agent === 'codex' ? 'Codex' : e.agent === 'claude' ? 'Claude' : 'Assistant'
    return [`## ${who}`, '', e.text || '_(empty)_']
  }
  if (e.type === 'thinking') {
    return ['## Thinking', '', e.text]
  }
  if (e.type === 'tool_use') {
    toolInputById.set(e.id, e.input)
    return [`## Tool call: ${e.name}`, '', '```json', truncate(JSON.stringify(e.input ?? {}, null, 2), 1200), '```']
  }
  if (e.type === 'tool_result') {
    const input = toolInputById.get(e.toolUseId)
    const filtered = filterToolResult(e.output ?? '', input)
    const text = truncate(filtered.text, TOOL_OUTPUT_BUDGET)
    return [`## Tool result${e.isError ? ' (error)' : ''}`, '', '```', text, '```']
  }
  return []
}

function buildFileRefs(src: ResolvedSource): string {
  const lines: string[] = ['# File References', '']
  lines.push(`- cwd: \`${src.cwd ?? '(unknown)'}\``)
  lines.push('')

  const seenPaths = new Set<string>()
  const filePaths: string[] = []
  const commands: string[] = []
  const toolInputById = new Map<string, unknown>()

  for (const env of src.events) {
    const e = env.event
    if (e.type === 'tool_use') {
      toolInputById.set(e.id, e.input)
      const o = (e.input ?? {}) as Record<string, unknown>
      for (const k of ['file_path', 'path', 'filePath', 'notebook_path']) {
        const v = o[k]
        if (typeof v === 'string' && !seenPaths.has(v)) {
          seenPaths.add(v)
          filePaths.push(v)
        }
      }
      for (const k of ['cmd', 'command']) {
        const v = o[k]
        if (typeof v === 'string' && v.trim()) commands.push(v.trim())
      }
    }
  }

  lines.push('## Files Touched')
  if (filePaths.length === 0) lines.push('_(none)_')
  for (const p of filePaths.slice(-20)) lines.push(`- \`${p}\``)
  lines.push('')

  lines.push('## Recent Commands')
  if (commands.length === 0) lines.push('_(none)_')
  for (const c of commands.slice(-10)) lines.push(`- \`${truncate(c, 200)}\``)
  lines.push('')
  return lines.join('\n')
}

function buildPlaceholder(heading: string): string {
  return [`# ${heading}`, '', '<!-- TODO: human edit -->', ''].join('\n')
}

function buildCodexEntry(opts: { cwd: string | null; currentRequest: string }): string {
  return [
    '# Continue In Codex',
    '',
    'You are continuing from a Cockpit handoff.',
    '',
    'Read these files (in the handoff directory) first:',
    '',
    '1. `summary.md`',
    '2. `task_state.md`',
    '3. `file_refs.md`',
    '4. `decisions.md`',
    '',
    'Only read `transcript.md` if the summary is insufficient.',
    '',
    '## Workspace',
    '',
    opts.cwd ? `\`${opts.cwd}\`` : '_(unknown)_',
    '',
    '## Current Request',
    '',
    opts.currentRequest || '_(none)_',
    '',
  ].join('\n')
}

function buildClaudeEntry(opts: { summary: string; currentRequest: string }): string {
  return [
    '# Continue In Claude',
    '',
    'This handoff was generated by Cockpit.',
    '',
    opts.summary,
    '',
    '## Current Request',
    '',
    opts.currentRequest || '_(none)_',
    '',
    '## Optional Local Files',
    '',
    'If you can access local files, also read `transcript.md` and `file_refs.md` in the handoff directory.',
    '',
  ].join('\n')
}

function truncate(text: string, limit: number): string {
  if (!text) return ''
  if (text.length <= limit) return text
  return text.slice(0, limit) + `\n... (${text.length - limit} chars elided)`
}

export const _internal = { buildSummary, buildTranscript, buildFileRefs }
