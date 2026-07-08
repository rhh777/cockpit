import type { NormalizedEvent } from '../loaders/types'
import type { AgentRunInput, ReviewAgent } from './types'

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })

// Phase 2a mock:不调真实 CLI,流式吐几段事件,验证 ThreadStore + turnId/runId + SSE UI。
// Phase 2b/2c 用真实 claude-call / codex-call 替换,路由层不变。
export const mockAdapter: ReviewAgent = {
  name: 'mock',
  displayName: 'Mock',
  async isAvailable() {
    return true
  },
  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    const { signal, targetAgent } = input
    const now = () => new Date().toISOString()
    const agent = targetAgent

    yield { type: 'thinking', text: `(mock ${agent}) 读取上面的会话上下文…`, ts: now() }
    await sleep(400, signal)

    yield {
      type: 'assistant_text',
      text: `好的,我是 mock **${agent}**。这是一个用于验证 follow-up 闭环的假回复。`,
      ts: now(),
      agent,
    }
    await sleep(500, signal)

    // 演示只读工具调用 + 结果(渲染配对卡)。
    yield {
      type: 'tool_use',
      id: `mock_call_${Date.now()}`,
      name: 'Read',
      input: { file_path: input.cwd ? `${input.cwd}/README.md` : 'README.md' },
      ts: now(),
      agent,
    }
    await sleep(500, signal)
    yield {
      type: 'tool_result',
      toolUseId: `mock_call`,
      output: '(mock) 文件前几行…\n# project\n...',
      isError: false,
      ts: now(),
    }
    await sleep(500, signal)

    yield {
      type: 'assistant_text',
      text: `针对你的请求「${input.text.slice(0, 40)}…」,mock 的结论:看起来没问题 ✅(这是占位回复,Phase 2b 接真实 CLI)。`,
      ts: now(),
      agent,
    }
  },
}
