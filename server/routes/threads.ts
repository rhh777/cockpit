import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentName, EventEnvelope, NormalizedEvent, Source } from '../loaders/types'
import { loadSessionDetail } from '../sessions-service'
import { threadStore } from '../store/thread-store'
import { resolveAgent } from '../adapters/registry'
import { filterToolResult, redactSecrets } from '../adapters/sensitive'
import { resolveSafe } from './resolve'

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function sseWrite(res: ServerResponse, msg: unknown) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`)
  // 防中间件压缩缓冲:有 compression 时此调用强制 flush;裸 http.ServerResponse 没有 flush 方法,
  // 走 noop。配合 socket.setNoDelay 起作用,确保 codex tool_use/tool_result 不被 Nagle 攒到一起。
  ;(res as ServerResponse & { flush?: () => void }).flush?.()
}

function wrap(
  source: Source,
  ev: NormalizedEvent,
  turnId: string,
  runId: string,
): EventEnvelope {
  return {
    origin: 'cockpit',
    source,
    sourceEventId:
      ev.type === 'tool_use' ? ev.id : `evt_${randomUUID()}`,
    turnId,
    runId,
    event: ev,
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  source: Source,
  id: string,
  filePath: string,
) {
  const body = (await readBody(req)) as {
    text?: string
    targetAgent?: AgentName
    useTools?: boolean
    parentTurnId?: string
    model?: string
    effort?: string
  }
  const text = (body.text ?? '').trim()
  const targetAgent = body.targetAgent ?? 'claude'
  const useTools = body.useTools ?? true
  const parentTurnId = body.parentTurnId?.trim() || undefined
  const model = body.model?.trim() || undefined
  const effort = body.effort?.trim() || undefined
  if (!text) {
    sendJson(res, 400, { error: 'empty message' })
    return
  }

  const turnId = `turn_${randomUUID()}`
  const runId = `run_${randomUUID()}`
  const now = () => new Date().toISOString()

  // 1. 用户消息先落盘(即使 agent 失败也保留,docs/01 §五流程 B)。
  const userEnvelope: EventEnvelope = {
    origin: 'cockpit',
    source,
    sourceEventId: `evt_${randomUUID()}`,
    turnId,
    runId,
    event: { type: 'user_text', text, ts: now(), targetAgent, parentTurnId },
  }
  await threadStore.appendEvent(source, id, userEnvelope)

  // 2. SSE 升级。
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 防 nginx / 反向代理缓冲;Vite dev 没代理,但开发-生产一致更安全。
  res.setHeader('X-Accel-Buffering', 'no')
  // 关掉 Nagle:每条 SSE 事件立刻进 TCP,不被攒到 40ms。codex tool_started/completed 间隔
  // 几秒,被合并的话用户感知就是"流结束才一次性看到所有 tool 调用"。
  req.socket?.setNoDelay?.(true)
  res.flushHeaders?.()
  sseWrite(res, { kind: 'meta', turnId, runId })
  sseWrite(res, { kind: 'event', envelope: userEnvelope })

  // 3. 取消:连接断开 → abort 子任务,写 turn_status:aborted(docs/01 §五流程 B)。
  const ac = new AbortController()
  let finished = false
  req.on('close', () => {
    if (!finished) ac.abort()
  })

  const agent = resolveAgent(targetAgent)
  try {
    if (!(await agent.isAvailable())) {
      throw new Error(`agent "${targetAgent}" 不可用(本机未安装/登录对应 CLI)`)
    }
    const detail = await loadSessionDetail(source, id, filePath)
    const input = {
      text,
      contextEvents: detail?.events ?? [],
      targetAgent,
      cwd: detail?.summary.cwd ?? null,
      useTools,
      model,
      effort,
      signal: ac.signal,
    }

    // 4. 流式:每个事件 同时 落盘 + SSE 推。
    //    tool_result 落盘/回显前跑敏感路径过滤(两端,docs/01 §十)。
    const toolInputById = new Map<string, unknown>()
    for await (const raw of agent.run(input)) {
      let ev = raw
      if (ev.type === 'tool_use') {
        toolInputById.set(ev.id, ev.input)
      } else if (ev.type === 'tool_result') {
        const filtered = filterToolResult(ev.output, toolInputById.get(ev.toolUseId))
        ev = { ...ev, output: filtered.text }
      } else if (ev.type === 'assistant_text' || ev.type === 'thinking') {
        // 纵深防御:agent 可能把读到的密钥洗进自己的回复文本(docs/01 §十)。
        ev = { ...ev, text: redactSecrets(ev.text).text }
      }
      const envelope = wrap(source, ev, turnId, runId)
      // assistant_text 的流式 delta 只走 SSE,不落盘——最终的整段 assistant_text 会作为一条
      // 普通事件持久化(claude adapter 已去重),刷新页面看到的是合并后的完整文本。
      const isDelta = ev.type === 'assistant_text' && ev.delta === true
      if (!isDelta) await threadStore.appendEvent(source, id, envelope)
      sseWrite(res, { kind: 'event', envelope })
    }

    finished = true
    await threadStore.appendTurnStatus(source, id, turnId, runId, 'completed')
    sseWrite(res, { kind: 'done', turnId, status: 'completed' })
    res.end()
  } catch (err) {
    finished = true
    const aborted = ac.signal.aborted
    const status = aborted ? 'aborted' : 'failed'
    const message = aborted ? 'aborted' : String((err as Error)?.message ?? err)
    await threadStore.appendTurnStatus(source, id, turnId, runId, status, aborted ? undefined : message)
    if (!res.writableEnded) {
      sseWrite(res, { kind: aborted ? 'aborted' : 'error', turnId, status, message })
      res.end()
    }
  }
}

export async function handleThreadsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api','threads',...]
  if (parts[1] !== 'threads') return false

  const source = parts[2] ? decodeURIComponent(parts[2]) : ''
  const id = parts[3] ? decodeURIComponent(parts[3]) : ''

  // POST /api/threads/:src/:id/messages
  if (req.method === 'POST' && parts.length === 5 && parts[4] === 'messages') {
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    await handlePostMessage(req, res, source, id, filePath)
    return true
  }

  // DELETE /api/threads/:src/:id  — 清空 follow-up
  if (req.method === 'DELETE' && parts.length === 4) {
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    await threadStore.clearFollowups(source, id)
    sendJson(res, 200, { ok: true })
    return true
  }

  // DELETE /api/threads/:src/:id/turns/:turnId — 删除某一轮(支持失败轮重试)
  if (req.method === 'DELETE' && parts.length === 6 && parts[4] === 'turns') {
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const turnId = decodeURIComponent(parts[5])
    await threadStore.deleteTurn(source, id, turnId)
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
