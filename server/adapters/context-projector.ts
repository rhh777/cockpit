import type { EventEnvelope, NormalizedEvent } from '../loaders/types'

const DEFAULT_LARGE_TOOL_RESULT_CHARS = 4000
const DEFAULT_TOOL_RESULT_HEAD_CHARS = 600
const DEFAULT_TOOL_RESULT_TAIL_CHARS = 300

export interface IncrementalContextInput {
  // summary.md 内容,作为已被摘要覆盖那段原生历史的替代文本。
  summary: string
  // 摘要覆盖到的最后一条原生 sourceEventId(含),之后的原生事件仍以原文进入 prompt。
  // 若在 events 中找不到,则视为 checkpoint stale,回退全量。
  upToSourceEventId: string
}

export interface ContextProjectionOptions {
  largeToolResultChars?: number
  toolResultHeadChars?: number
  toolResultTailChars?: number
  incremental?: IncrementalContextInput
}

const CONTEXT_SUMMARY_META_KEY = 'context_summary'

// 用一条 meta 事件承载 summary,让 serializeForAgent 走它专属的渲染分支。
// 这样保留 EventEnvelope[] 契约,不用新增顶层事件类型,adapter/loader 不受影响。
function buildSummaryEnvelope(source: EventEnvelope, summary: string): EventEnvelope {
  const ev: NormalizedEvent = {
    type: 'meta',
    key: CONTEXT_SUMMARY_META_KEY,
    value: { summary },
    ts: (source.event as { ts?: string }).ts ?? new Date().toISOString(),
  }
  return {
    origin: 'cockpit',
    source: source.source,
    sourceEventId: `summary:${source.sourceEventId ?? 'anchor'}`,
    event: ev,
  }
}

function shrinkLargeToolResult(
  env: EventEnvelope,
  largeToolResultChars: number,
  toolResultHeadChars: number,
  toolResultTailChars: number,
): EventEnvelope {
  const ev = env.event
  if (ev.type !== 'tool_result' || ev.output.length <= largeToolResultChars) return env
  const head = ev.output.slice(0, toolResultHeadChars)
  const tail = ev.output.slice(Math.max(toolResultHeadChars, ev.output.length - toolResultTailChars))
  return {
    ...env,
    event: {
      ...ev,
      output: [
        `[Large tool output summarized for agent context: ${ev.output.length} chars, error=${ev.isError ? 'true' : 'false'}]`,
        head,
        `...[omitted ${Math.max(0, ev.output.length - head.length - tail.length)} chars]...`,
        tail,
      ].join('\n'),
    },
  }
}

export function projectContextEvents(
  events: EventEnvelope[],
  options: ContextProjectionOptions = {},
): EventEnvelope[] {
  const largeToolResultChars = options.largeToolResultChars ?? DEFAULT_LARGE_TOOL_RESULT_CHARS
  const toolResultHeadChars = options.toolResultHeadChars ?? DEFAULT_TOOL_RESULT_HEAD_CHARS
  const toolResultTailChars = options.toolResultTailChars ?? DEFAULT_TOOL_RESULT_TAIL_CHARS

  // followup_boundary 之前是原生;incremental 只裁原生段,不动 Cockpit follow-up。
  const boundaryIdx = events.findIndex((e) => e.event.type === 'followup_boundary')

  let workingEvents = events
  if (options.incremental) {
    const { upToSourceEventId, summary } = options.incremental
    const nativeEnd = boundaryIdx === -1 ? events.length : boundaryIdx
    // 只在原生段中查找 checkpoint;找不到视为 stale。
    let anchorIdx = -1
    for (let i = 0; i < nativeEnd; i++) {
      if (events[i].sourceEventId === upToSourceEventId) {
        anchorIdx = i
        break
      }
    }
    if (anchorIdx !== -1 && summary.trim().length > 0) {
      const anchor = events[anchorIdx]
      const summaryEnv = buildSummaryEnvelope(anchor, summary)
      workingEvents = [summaryEnv, ...events.slice(anchorIdx + 1)]
    }
    // 找不到 anchor 时静默回退到 full,由上层根据 checkpoint mismatch 决定是否重建 state。
  }

  return workingEvents.map((env) =>
    shrinkLargeToolResult(env, largeToolResultChars, toolResultHeadChars, toolResultTailChars),
  )
}

export const _internal = { CONTEXT_SUMMARY_META_KEY }
