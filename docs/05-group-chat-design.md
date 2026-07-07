# 05 — 群聊模式设计

## 定位

群聊是 Cockpit 自己的 thread,不绑定原生 Claude/Codex session。

```
~/.cockpit/group-threads/<id>/
  state.json
  transcript.jsonl
  summary.md
  attachments/
```

- `transcript.jsonl` 是群聊事实源。
- `summary.md` 是跨轮次共享摘要,可展示、可编辑。
- agent 只在被 `@mention` 时运行。
- agent 回复写回 Cockpit transcript,默认不写原生 CLI 历史。

## 数据模型

```ts
interface GroupThreadState {
  id: string
  kind: 'group-chat'
  title: string
  cwd: string | null
  agents: AgentName[]
  startedAt: string
  updatedAt: string
  summaryUpdatedAt: string | null
  summaryRevision: number
}

interface GroupRun {
  runId: string
  agent: AgentName
  turnId: string
  baseEventSeq: number
  status: 'running' | 'completed' | 'failed' | 'aborted'
}

interface GroupTurnMeta {
  groupTurnId: string
  baseEventSeq: number
  targetAgents: AgentName[]
  runs: GroupRun[]
}
```

群聊事件复用 `EventEnvelope` / `NormalizedEvent`:

- 用户消息:`origin='cockpit'`, `source='cockpit'`, `event.type='user_text'`
- agent 回复:`event.type='assistant_text'`, `event.agent` 为被唤醒的 `AgentName`
- 工具事件:`tool_use` / `tool_result`,通过 `runId` 归属到具体 agent
- 轮次事件:`meta key='turn_start'` / `meta key='turn_status'`

每个群聊轮次使用一个 `groupTurnId`;每个被唤醒 agent 使用独立 `runId`。

## 发送流程

### 单 agent

```
@codex 看下这个方案
  -> parseMentions = ['codex']
  -> append user_text
  -> append turn_start
  -> run Codex adapter
  -> append Codex events
  -> append turn_status
  -> update summary
```

### 多 agent 并行

```
@claude @codex @opencode @cursor 分别 review
  -> parseMentions = ['claude', 'codex', 'opencode', 'cursor']
  -> append user_text
  -> 记录 baseEventSeq
  -> 为每个 agent 创建 run
  -> 并行调用 adapters
  -> 每个 run 独立写事件和终态
  -> 全部收口后更新 summary
```

并行规则:

- 同一轮内所有 agent 使用同一个 `baseEventSeq` 快照。
- agent 不读取同一轮其他 agent 尚未完成的回复。
- 下一轮通过 transcript + summary 读取上一轮结果。
- 同一 group thread 同时只允许一个 in-flight group turn。
- 无 `@mention` 的消息只落盘,不唤醒 agent。

## 上下文构造

每次唤醒 agent 时构造一次 prompt:

```md
# Cockpit Group Chat

## Shared Summary
...

## Recent Transcript
[User]: ...
[Codex]: ...
[Claude]: ...

## Current Request
...
```

规则:

- 固定保留 shared summary 和 current request。
- Recent Transcript 默认取最近 30 条。
- `tool_use` / `tool_result` 只投影为摘要,不原样塞入 prompt。
- `usage` / `meta` 默认不进 prompt。
- 文件摘要、diff、工具摘要都必须过 sensitive filtering。

## Summary

`summary.md` 是摘要事实源。

- 自动更新必须基于最新 `summary.md` 合并写回。
- 用户手写内容不能被解析缓存覆盖。
- `summaryRevision` 用于避免自动更新覆盖用户编辑。
- 摘要更新失败不阻塞主流程。

建议结构:

```md
# Shared Summary

## Goal
## Decisions
## Open Questions
## Tasks
## File State
## Agent Notes
```

## @mention 解析

规则保守:

- 识别独立 `@claude` / `@codex` / `@opencode` / `@cursor`。
- 忽略 code block、inline code、blockquote。
- 解析结果去重,并与 thread 成员取交集。
- 无有效目标时按静默消息处理。

## API

```txt
GET    /api/group-threads
POST   /api/group-threads
POST   /api/group-threads/from-session          # 从原生 session 复制上下文创建群聊
GET    /api/group-threads/:id
PATCH  /api/group-threads/:id                   # 目前用于修改 title
POST   /api/group-threads/:id/runs              # 主发送路径,返回 202 + { groupTurnId, records, userEnvelope, turnStart };
                                                # SSE 流通过 GET /api/runs/:runId/stream 消费
POST   /api/group-threads/:id/messages          # legacy 同步 SSE 路径,仍保留但前端已切到 /runs
POST   /api/group-threads/:id/turns/:groupTurnId/cancel
DELETE /api/group-threads/:id
```

发送:

```ts
interface SendGroupMessageBody {
  text: string
  mode?: 'parallel'
  targetAgents?: AgentName[]
  useTools?: boolean
  attachments?: ChatAttachment[]
}
```

`/runs` 走两段式:先 `POST /runs` 拿到 `{ groupTurnId, records: [{ runId, agent }] }`,再对每个 `runId`
分别 `GET /api/runs/:runId/stream` 订阅事件,断线可重连(见 docs/06)。`/messages` 的同步 SSE
保留用于兜底,输出结构仍是下面的 `GroupSseMessage`。

SSE(`/messages` legacy 与 `/runs` 单 run 通用):

```ts
type GroupSseMessage =
  | { kind: 'meta'; groupTurnId: string; baseEventSeq: number; runs: { agent: AgentName; runId: string }[] }
  | { kind: 'event'; groupTurnId: string; runId?: string; agent?: AgentName; envelope: EventEnvelope }
  | { kind: 'run_done'; groupTurnId: string; runId: string; agent: AgentName; status: 'completed' | 'failed' | 'aborted'; message?: string }
  | { kind: 'summary'; markdown: string; parsed?: ParsedSharedSummary }
  | { kind: 'done'; groupTurnId: string; status: 'completed' | 'partial' | 'failed'; message?: string }
  | { kind: 'error'; groupTurnId: string; message: string }
```

## 边界

- 群聊默认只读。
- 不把群聊同步进 `~/.claude/projects/`、`~/.codex/sessions/` 或其他 agent 原生历史。
- 不复用用户日常原生 session 作为群聊成员记忆。
- 不支持多轮群聊并发写同一 thread。
- 不支持多 agent 同时写文件。
- 如果未来加入原生 resume,必须是显式模式,并禁用多 `@mention`。
