import type { EventEnvelope } from '../loaders/types'

const DEFAULT_LARGE_TOOL_RESULT_CHARS = 4000
const DEFAULT_TOOL_RESULT_HEAD_CHARS = 600
const DEFAULT_TOOL_RESULT_TAIL_CHARS = 300

export interface ContextProjectionOptions {
  largeToolResultChars?: number
  toolResultHeadChars?: number
  toolResultTailChars?: number
}

export function projectContextEvents(
  events: EventEnvelope[],
  options: ContextProjectionOptions = {},
): EventEnvelope[] {
  const largeToolResultChars = options.largeToolResultChars ?? DEFAULT_LARGE_TOOL_RESULT_CHARS
  const toolResultHeadChars = options.toolResultHeadChars ?? DEFAULT_TOOL_RESULT_HEAD_CHARS
  const toolResultTailChars = options.toolResultTailChars ?? DEFAULT_TOOL_RESULT_TAIL_CHARS

  return events.map((env) => {
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
  })
}
