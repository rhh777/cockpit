# 13 — 群聊串行讨论模式设计

## 定位

当前群聊是「用户消息里的 `@mention` 触发一个或多个 agent 并行回复」。这个模式适合让多个 agent 对同一问题各自发表意见,但不适合让 agent 互相读完上一位结论后再接力讨论。

串行讨论模式提供另一种 orchestration:

- 用户选择若干 group 成员和一个技术文档、代码片段、session 摘要或主题。
- 系统按顺序只唤醒一个 agent。
- 当前 agent 可以在回复末尾用 `Next: @codex` / `Next: @claude` / `Next: @opencode` / `Next: @cursor` 指定下一位接棒。
- 每一步都读取前面已经完成的讨论内容。
- 达到最大发言数、没有下一位、agent 明确达成一致,或被用户取消时结束。
- 结束时系统在 transcript 里写入 `@user` 的收口消息,提醒用户讨论完成或需要人工介入。

命名建议:

- 产品文案:「接力讨论」。
- API / schema: `mode: 'serial'`。
- 内部 orchestrator: `SerialGroupTurn`。

不建议叫 solo mode。这里并不是单人聊天,而是多 agent 串行接力;「solo」容易和单 agent follow-up 或 read-only 旁路混淆。

## 用户体验

### 创建或发送


群聊 composer 增加一个模式切换:

| 模式 | 行为 |
|---|---|
| 并行讨论 | 保持现状,文本里的多个 `@agent` 同时启动 |
| 接力讨论 | 首位 agent 启动后,后续由 agent 输出末尾的 `Next:` 指令决定 |

接力讨论发送时需要配置:

- 参与成员:默认使用当前 group thread 的 `agents`,也允许临时取消某些 agent。
- 首位 agent:默认是文本里的第一个有效 `@mention`;如果没有 `@mention`,使用 composer 当前选中的 agent。
- 最大发言数:默认 6,可选 2 到 20。一次 agent 回复算一次发言,所以 Claude→Codex→Claude 算 3。
- 结束策略:默认「自动检测一致」。

示例:

```text
请对这份缓存设计做接力讨论。先由 @claude 看架构风险,如果需要实现细节 review 再叫 @codex。
```

这类长提示不应该要求用户每次手写。第一版 UI 应把它拆成结构化控制:

- 模式:接力讨论。
- 主题/材料:用户只输入“请讨论这份缓存设计”或直接附上文档。
- 参与成员:例如 Claude、Codex。
- 首位 agent:例如 Claude。
- 讨论策略 preset:例如“架构先行,实现复核”。
- 最大发言数:例如 6。

发送给 agent 的真实 prompt 由 Cockpit 根据 preset 生成。用户文本只表达目标和材料,不要承担调度协议。

执行过程:

1. Cockpit 写入用户消息和 `turn_start`。
2. Claude 回复,如果末尾协议块写出 `Next: @codex`,系统启动 Codex。
3. Codex 读取用户请求、Claude 回复和共享摘要后回复。
4. 如果 Codex `Next: @claude` 继续,且没超过最大发言数,再启动 Claude。
5. 如果 Codex 写出 `Status: consensus` / `Next: @user`,或不再给出合法下一位,写入结束 meta 和 `@user` 收口。

### UI 展示

- Timeline 仍按 append 顺序展示:用户消息、Claude、Codex、Claude...
- StreamingStatus 展示「接力讨论 2/6: Codex 回复中」。
- turn_start 卡片或状态行显示:
  - 模式:接力讨论
  - 参与成员
  - 当前发言数 / 最大发言数
  - 下一位 agent 或结束原因
- 允许用户取消整个接力讨论;第一版不做「只取消当前 step 但继续下一位」。

## 数据模型

保持群聊事实源仍为:

```text
~/.cockpit/group-threads/<id>/
  state.json
  transcript.jsonl
  summary.md
  attachments/
```

`GroupThreadState` 不需要新增必填字段。接力讨论是每个 turn 的运行模式,不是 thread 的永久类型。

新增可选类型:

```ts
type GroupTurnMode = 'parallel' | 'serial'

interface SerialGroupOptions {
  mode: 'serial'
  participants: AgentName[]
  firstAgent: AgentName
  maxSteps: number
  stopOnConsensus: boolean
}

interface SerialStepMeta {
  step: number
  maxSteps: number
  agent: AgentName
  requestedBy: 'user' | AgentName | 'orchestrator'
  mentionText?: string
}

interface SerialStopMeta {
  reason:
    | 'no-next-agent'
    | 'consensus'
    | 'max-steps'
    | 'protocol-missing'
    | 'agent-failed'
    | 'aborted'
  lastAgent?: AgentName
  nextAgent?: AgentName
  message?: string
}
```

`turn_start` 的 `value` additive 扩展:

```json
{
  "groupTurnId": "turn_...",
  "mode": "serial",
  "baseEventSeq": 12,
  "targetAgents": ["claude"],
  "participants": ["claude", "codex"],
  "serial": {
    "firstAgent": "claude",
    "maxSteps": 6,
    "stopOnConsensus": true
  },
  "runs": []
}
```

每个 step 启动时追加 meta:

```json
{
  "type": "meta",
  "key": "serial_step_start",
  "value": {
    "groupTurnId": "turn_...",
    "step": 2,
    "maxSteps": 6,
    "agent": "codex",
    "requestedBy": "claude",
    "mentionText": "@codex 请 review 这个边界"
  }
}
```

结束时追加:

```json
{
  "type": "meta",
  "key": "serial_turn_status",
  "value": {
    "groupTurnId": "turn_...",
    "status": "completed",
    "reason": "consensus",
    "steps": 3
  }
}
```

再追加一条系统收口 `assistant_text` 或 `meta`。推荐第一版用 `meta key='user_notification'`,避免把 Cockpit 自己伪装成某个 agent:

```json
{
  "type": "meta",
  "key": "user_notification",
  "value": {
    "text": "@user 接力讨论已完成: Claude 和 Codex 对方案达成一致。",
    "groupTurnId": "turn_..."
  }
}
```

## API

扩展 `POST /api/group-threads/:id/runs` 请求体:

```ts
interface SendGroupMessageBody {
  text: string
  mode?: 'parallel' | 'serial'
  targetAgents?: AgentName[]
  serial?: {
    participants?: AgentName[]
    firstAgent?: AgentName
    maxSteps?: number
    stopOnConsensus?: boolean
  }
  useTools?: boolean
  permissions?: RunPermissions
  cliByAgent?: Partial<Record<AgentName, { model?: string; effort?: string }>>
  attachments?: ChatAttachment[]
}
```

兼容规则:

- `mode` 为空时按现有并行行为处理。
- 并行模式继续只根据有效 `@mention` 唤醒 agent。
- 接力模式允许 `targetAgents` / `serial.firstAgent` 指定首位 agent;不再要求用户文本必须包含 `@mention`。
- 服务端必须把目标限制在 `state.agents` 交集内。
- `serial.firstAgent` 必须同时属于 `serial.participants` 和 `state.agents`。
- `serial.participants` 过滤后至少要有 1 个成员;为空时返回 400。
- `serial.maxSteps` 表示最大发言数,不是一来一回的 round。
- 同一 group thread 仍只允许一个 in-flight group turn。

响应保持两段式启动模型,但接力模式启动时只能返回首个 run:

```ts
{
  groupTurnId: string
  baseEventSeq: number
  mode: 'serial'
  records: [{ runId: string, agent: AgentName }]
  userEnvelope: EventEnvelope
  turnStart: EventEnvelope
}
```

后续 step 的 run 由 orchestrator 在服务端创建。接力模式必须引入 group turn 级 stream,不能只依赖现有 per-run EventSource。

新增:

```txt
GET /api/group-threads/:id/turns/:groupTurnId/stream
```

原因:

- 现有 per-run stream 要求前端在发送响应里拿到所有 runId。
- 接力讨论的 step 2..N runId 在响应时还不存在。
- 如果 step 1 的 run stream 已经 `done`,再通过它通知 step 2 会有竞态和漏订阅风险。
- group turn stream 生命周期覆盖整个 serial turn,是后续 step 发现、取消、状态展示的事实通道。

SSE:

```ts
type GroupSseMessage =
  | { kind: 'serial_step'; groupTurnId: string; step: number; maxSteps: number; agent: AgentName; runId: string }
  | existing messages...
```

前端在接力模式下订阅 group turn stream;收到 `serial_step` 后可以选择继续通过 turn stream 消费事件,或为了复用现有 UI 状态再附加订阅对应 run stream。第一版推荐 turn stream 承载完整 serial 事件,per-run stream 保持现有 parallel/follow-up 能力。

turn stream 对 **step 1** 也发一次 `serial_step`(而不是只对 step 2..N)。这样前端只有一个 runId 来源:初始 HTTP 响应只用来拿 `groupTurnId` 并建立 turn stream 订阅,所有 step(含 step 1)的 runId 都从 `serial_step` 事件里获得,消除「initial response vs turn stream」两处 runId 来源的分叉逻辑。

## 调度算法

新增 `runRegistry.startSerialGroupTurn(input)` 或在 `startGroupTurn` 内按 mode 分派。

伪代码:

```ts
async function executeSerialGroupTurn(input) {
  reserve groupTurns[id]
  append userEnvelope
  append turnStart(mode='serial')

  // baseEventSeq 是 append userEnvelope 前的 transcript count。
  // 与现有 parallel 路径保持一致:上下文历史不含当前用户消息;
  // 当前请求通过 input.text / originalRequest 单独进入 prompt,避免重复。
  let transcript = readTranscript(id).slice(0, baseEventSeq)
  let currentAgent = firstAgent
  let requestedBy: AgentName | 'user' | 'orchestrator' = 'user'

  for step in 1..maxSteps {
    if (isGroupTurnAborted(id, groupTurnId)) return stop('aborted')

    const run = createGroupMemberRun(currentAgent, groupTurnId)
    append serial_step_start
    await executeGroupMember(run, {
      text: buildSerialStepRequest(input.text, step, currentAgent),
      transcript,
      summary,
      baseEventSeq
    })

    transcript = await readTranscript(id)
    // 归因顺序很重要:步内取消会让当前 run 的 status = 'aborted'(≠ 'completed')。
    // 必须先判 aborted,否则会被下面的 !== 'completed' 抢先命中,把用户主动取消
    // 误标成 agent-failed。abort 判定在「步间(循环开头)」与「步内(run 结束后)」
    // 两条路径上必须一致。
    if (isGroupTurnAborted(id, groupTurnId)) return stop('aborted')
    if (run.status !== 'completed') return stop('agent-failed')

    const lastText = latestAssistantText(transcript, groupTurnId, run.runId)
    let directive = parseSerialDirective(lastText)
    if (!directive.ok) {
      directive = await requestProtocolRepairOnce(currentAgent, run)
      if (!directive.ok) return stop('protocol-missing')
    }
    if (stopOnConsensus && directive.status === 'consensus') return stop('consensus')
    if (directive.next === '@user' || directive.status === 'blocked') return stop('no-next-agent')
    const next = selectNextAgentFromDirective(directive, participants, currentAgent)
    if (!next) return stop('no-next-agent')

    requestedBy = currentAgent
    currentAgent = next
  }

  return stop('max-steps')
}
```

`groupTurns` 需要从 `{ groupTurnId, baseEventSeq, runIds }` 扩展为 turn 级状态:

```ts
interface ActiveGroupTurn {
  groupTurnId: string
  baseEventSeq: number
  runIds: string[]
  aborted?: boolean
  mode?: 'parallel' | 'serial'
}
```

`cancelGroupTurn(id)` 必须先把 `active.aborted = true`,再 abort 当前 `runIds`。串行 orchestrator 在每个 step 开始前和每个 run 完成后检查该标志。否则用户在两个 step 之间点击取消时,没有活跃 run 可 abort,下一步仍会被启动。

串行 orchestrator 必须用 `try/finally` 包住整个 turn,在任何成功、失败、取消或异常路径中释放 `groupTurns` mutex,并写入 `serial_turn_status`。进程被 kill 时内存 mutex 会随进程消失;重启后的未完成 turn 通过 transcript 中缺少终态 meta 识别为 interrupted,不应永久阻塞该 group thread。

### 下一位选择

`selectNextAgentFromDirective` 规则保守:

1. 只解析结构化 `Next:` 指令行,不从正文散文里回退解析裸 `@mention`。
2. `Next:` 行必须在回复末尾的协议块里,且不在 code fence、inline code、blockquote 中。
3. `@user` 是合法终点,但不是 `AgentName`,必须由 `parseSerialDirective` 特判。
4. `@agent` 只保留 `participants` 且不是当前 agent 的目标。
5. 如果出现多个目标,第一版判协议不合格,触发一次 protocol repair;不自动选择第一个。
6. 如果没有合法目标,结束或 `protocol-missing`,取决于 `Status`。

不建议第一版让 agent 同时 `@` 多个下一位后再并行,否则模式会退化成混合调度,测试面明显变大。

### 共识检测

第一版只采用显式协议,不做额外 LLM 判断,也不做裸文本启发。

原因:

- agent 可能复述协议说明,例如“当你达成一致时写 Status: consensus”。
- agent 可能写“we have not reached consensus”。
- 裸文本匹配会误判提前结束。

在接力 prompt 中要求 agent 在回复末尾写一个机器可读状态行:

```text
Next: @codex
Status: needs-review
```

或:

```text
Next: @user
Status: consensus
```

允许的 `Status`:

- `needs-review`: 需要下一位 agent。
- `needs-changes`: 发现问题,但不一定需要继续讨论。
- `consensus`: 当前参与 agent 已达成一致。
- `blocked`: 需要用户输入。

解析优先级:

1. 只检查回复末尾非 fence/非 quote 的协议块。
2. 容忍大小写、全角冒号、行尾空白和多余空行。
3. 如果存在 `Status: consensus`,以 `consensus` 结束;此时 `Next` 必须是 `@user` 或为空。
4. 如果存在 `Next: @agent`,按该 agent 接棒。
5. 如果存在 `Next: @user` 或 `Status: blocked`,结束并通知用户。
6. 如果缺少 `Next` 或 `Status`,追加一次协议修复请求给同一 agent,要求只补协议块;仍缺失则 `protocol-missing` 结束。已实现,细节见 §实现进度「协议修复实现记录」。

不要复用普通 `parseMentions` 解析 `Next:` 行。普通 parser 只认识 agent mention,不认识 `@user`;而接力协议需要区分 `@user`、非法 agent、多个 agent 和无目标。

## Prompt 约束

`buildGroupContextEvents` 需要新增接力模式上下文,或增加 options:

```ts
buildGroupContextEvents(transcript, summary, targetAgent, attachments, {
  mode: 'serial',
  participants,
  step,
  maxSteps,
  originalRequest,
  previousAgent,
})
```

接力模式 prompt 分两层:

1. **Orchestrator system prompt**:由 Cockpit 固定生成,包含接力协议、参与成员、最大发言数、输出状态行格式和停止条件。
2. **User task prompt**:用户输入的真实目标、文档、附件说明或从 session 导入的上下文。

用户不需要写“如果需要实现细节 review 再叫 Codex”这种流程话术。它应该由 preset 翻译成 system prompt。

接力模式 prompt 应明确:

- 你是当前 step 的唯一发言 agent。
- 你必须阅读前面所有接力发言,不要重复已经达成一致的内容。
- 如果需要另一位 agent review,用 `Next: @agent` 指定一个下一位。
- 如果认为已经达成一致,写 `Status: consensus` 和 `Next: @user`。
- 不要 `@` 不在 participants 里的 agent。
- 到达最大发言数前也可以结束。

这比依赖自然语言 `@mention` 更稳定,同时仍兼容用户想看的文本讨论风格。

### 讨论策略 preset

第一版建议内置少量 preset,不做复杂 prompt 编辑器:

| Preset | 首位建议 | 策略 |
|---|---|---|
| 架构先行,实现复核 | Claude | 先评估目标、边界、风险和方案形状;需要代码级 review 时 `Next: @codex` |
| 实现先行,架构复核 | Codex | 先检查代码、数据流、测试和可落地性;需要产品/架构取舍时 `Next: @claude` |
| 双向审稿 | 用户选择 | 每位 agent 只补充新风险或明确同意;避免重复总结 |

Preset 只影响 system prompt 和默认首位 agent,不改变 transcript schema。

示例 system prompt 片段:

```text
You are participating in a Cockpit serial discussion.
Only one agent speaks at a time. You are {currentAgent}, step {step}/{maxSteps}.
Participants: {participants}.

Discussion preset: Architecture first, implementation review second.
- If architecture/product risk remains, address it yourself.
- If implementation details, code paths, tests, or edge cases need review, set Next: @codex.
- If the participants have converged, set Status: consensus and Next: @user.

End every response with exactly:
Next: @agent-or-@user
Status: needs-review | needs-changes | consensus | blocked
```

## 权限与安全

- 默认权限沿用群聊当前 `ask` / read-oriented 策略。
- 接力讨论内每个 step 都是独立 `runId`,审批也按 run 隔离。
- 不支持多个 agent 同时写文件,因为接力模式天然串行。
- 如果用户选择 `full-access`,仍只代表当前 step agent 可按现有 adapter 策略执行;下一 step 继续复用同一 permissions,并在 UI 上保持可见。
- 敏感信息过滤、tool_result 截断、summary 更新规则沿用现有群聊设计。

## Summary 更新

第一版在整个接力 turn 结束后更新一次 `summary.md`。

原因:

- 每个 step 后更新 summary 会增加额外写入和 race surface。
- 当前 step 已经可以读取完整 transcript,不依赖 summary 捕获上一 step。
- 最终 summary 更适合记录决策、争议和 tasks。

如果接力很长,可后续增加每 N step 的 compact summary,但不作为第一版范围。

## 实现计划

### Phase 1: 后端最小可用

1. 扩展 `SendGroupMessageBody` 和 `GroupTurnStartInput`,支持 `mode: 'serial'` 与 `serial` options。
2. `server/routes/group-threads.ts` 在 serial 模式下接受 body 指定首位 agent,并校验 participants。
3. `run-registry` 增加 serial orchestrator,复用 `executeGroupMember` 的 agent 调用、落盘、审批和 SSE。
4. 增加 `serial_step_start` / `serial_turn_status` / `user_notification` meta。
5. 增加 `selectNextAgentFromDirective`、`parseSerialDirective`、`protocol-missing` 单测。

### Phase 2: 前端控制

1. `FollowupComposer` 的 group mode 增加并行 / 接力 segmented control。
2. 增加最大发言数输入和首位 agent 选择。
3. StreamingStatus 支持 serial step 进度。
4. Timeline 对 serial meta 做轻量展示。
5. 保持单 session follow-up、native resume、group parallel 的 UI 不漂移。

### Phase 3: 打磨

1. 接力结束时自动生成更好的 `@user` 收口文本。
2. 支持从技术文档附件创建接力讨论模板。
3. 可选:手动插队,用户在接力运行中指定下一位 agent。
4. 可选:在最大发言数到达时生成分歧摘要。

## 实现进度

审计日期 2026-07-30(main @ 7f76a99)。本节是接力讨论的进度事实源:改动落地后更新对应行。

| Phase | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | `mode: 'serial'` + `serial` options 贯通 body / `GroupTurnStartInput` | 已完成 | `server/routes/group-threads.ts`、`server/runs/run-registry.ts` |
| 1 | serial 模式由 body 指定首位 agent,校验 participants | 已完成 | 目标限制在 `state.agents` 交集内 |
| 1 | serial orchestrator 复用 `executeGroupMember` | 已完成 | `startSerialGroupTurn` / `executeSerialGroupTurn`;abort 判定在步间与步内两条路径一致,`try/finally` 释放 mutex |
| 1 | `serial_step_start` / `serial_turn_status` / `user_notification` meta | 已完成 | `finishSerialTurn` |
| 1 | group turn 级 stream(step 1..N 都发 `serial_step`) | 已完成 | `GET /api/group-threads/:id/turns/:groupTurnId/stream`,前端只有一个 runId 来源 |
| 1 | `parseSerialDirective` / `selectNextAgentFromDirective` 单测 | 已完成 | `server/util/serial-directive.test.ts`(4 例) |
| 1 | 协议修复请求(`requestProtocolRepairOnce`) | 已完成 | 见下方「协议修复实现记录」 |
| 2 | composer 并行 / 接力 segmented control | 已完成 | `FollowupComposer` |
| 2 | 最大发言数输入 | 已完成 | `serialMaxSteps`,默认 6 |
| 2 | 首位 agent 与 participants 子集选择 | 已完成 | 见下方「Phase 2 前端控制实现记录」 |
| 2 | 讨论策略 preset 选择 | 已完成 | 见下方「Phase 2 前端控制实现记录」 |
| 2 | `StreamingStatus` serial step 进度 | 已完成 | 见下方「Phase 2 前端控制实现记录」 |
| 2 | timeline 对 serial meta 轻量展示 | 已完成 | `EventItem` 渲染协议 chip + `serial_turn_status` 卡片 |
| 3 | 更好的 `@user` 收口文本 | 已完成 | 按 consensus / max-steps / blocked / returned / aborted / protocol failure 区分;达到上限时明确提示检查剩余分歧 |
| 3 | 从文档附件创建接力模板 / 手动插队 / 分歧摘要 | 未开始 | 设计里已标为可选项 |

### 协议修复实现记录(2026-07-30)

`RunRegistry.requestProtocolRepairOnce`(`server/runs/run-registry.ts`):

- 触发点:step 结束后 `parseSerialDirective` 失败(缺 `Next`/`Status`、非法 status、多个目标)。
- 行为:用**同一 agent** 起一个独立 run,prompt 明确「不要重答,只回两行协议」,并列出合法
  `Next` 目标(participants 去掉自己 + `@user`)。解析这次回复;成功则照常接棒。
- **每个 step 只补一次**:helper 自身不重试,失败即 `protocol-missing`。
- **不占发言预算**:`step` 与 `completedSteps` 都不推进,`serial_turn_status.steps` 里不计入。
  补协议是格式修复,不是一次发言,不该吃掉用户设的最大发言数。
- **强制 `useTools: false`**:只要两行文本,不该再跑工具。
- 可观测性:落 `meta key='serial_protocol_repair'`(含 agent + reason),`serial_step` 用**同一个
  step 号**下发(进度不因补协议前进);`EventItem` 渲染成「缺少接力协议块,已请 X 补一次」提示,
  否则用户会看到一次莫名的额外短回复。
- 上下文用全量 transcript(不 slice),让 agent 看到自己刚才那条缺协议的回复。
- 终止归因:补问 run 自身跑失败 → `agent-failed`;跑成功但仍无合法协议 → `protocol-missing`;
  补问前后都检查 turn 级 `aborted`。

测试覆盖现状:`server/util/serial-directive.test.ts`(4 例,纯解析)+
`server/runs/serial-protocol-repair.test.ts`(6 例,**orchestrator 端到端**:注册脚本化 agent
顶掉真实 CLI,跑真实 `startGroupTurn(mode='serial')` 再按 transcript 断言)。后者覆盖补问成功后
接棒、补问仍失败终止且只补一次、补问不占预算、补问不带工具、prompt 内容约束、协议齐全时不触发。

下方「测试计划」里其余依赖 orchestrator 的用例(步间取消不启动下一步、`max-steps` 终止、
正文散文里的 `@codex` 不误触发、firstAgent 校验 400)**仍未落地**,但
`serial-protocol-repair.test.ts` 已经把 orchestrator 的测试脚手架(脚本化 agent + 等
`serial_turn_status` + 清理 group thread)搭好,后续补这些用例可以直接复用。

### Phase 2 前端控制实现记录(2026-07-31)

- **讨论策略 preset**:三个 preset(架构先行 / 实现先行 / 双向审稿)在 composer 里可选,
  不再写死 `architecture-first`。选择直接进 `serial.preset`,由 `buildGroupContextEvents`
  翻成 system prompt 段落(该映射早就实现了,此前只是选不到)。
- **首位 agent**:「自动」= 原行为(文本里第一个 @mention,否则当前选中 agent);也可显式指定。
  显式指定的首位若被移出参与成员,自动回落到第一个参与成员,不会发出一个不在 participants
  里的 firstAgent(那会被后端 400)。
- **参与成员**:存的是**排除集**而不是包含集,这样 group 成员变化时新成员默认参与,
  不会因为旧快照被漏掉。至少保留一名成员(最后一个的取消按钮 disabled),否则没人能发言。
- **StreamingStatus 进度**:`ActiveStream` 增加可选 `serial: {step, maxSteps}`,
  由 turn stream 的 `serial_step` 消息填充,渲染成「接力 2/6」的 chip。
  同一 run 重复收到 `serial_step`(协议修复复用同一步号)时更新而不是重复插入。
- **布局**:接力设置单独占一行(`.group-composer-stack` 纵向堆叠)。塞进原来的
  `.group-composer-controls` 会把模型选择器挤出可视区 —— 那一行是 `nowrap + overflow-x:auto`
  的横向滚动区。并行模式下这一行不渲染,单聊 / 原生续写的 composer 不受影响。

## 测试计划

后端:

- serial 无 `@mention` 但指定 firstAgent 时会启动。
- serial participants 会过滤非 group 成员。
- serial firstAgent 不在 participants 或 state.agents 时返回 400。
- agent 回复 `Next: @codex` 后启动 Codex。
- agent 回复 `Status: consensus` 后不再启动下一 step。
- agent 正文散文里提到 `@codex` 但末尾没有 `Next: @codex` 时不会误启动 Codex。
- `Next: @user` 能被 `parseSerialDirective` 识别,不依赖普通 `parseMentions`。
- 缺少协议块时只触发一次 protocol repair,仍缺失则写 `serial_turn_status(reason='protocol-missing')`。
- 最大发言数到达后停止并写 `serial_turn_status(reason='max-steps')`。
- agent 失败后停止并保留已完成 transcript。
- cancel 会设置 turn 级 `aborted` 标志、abort 当前 run,并释放 group turn mutex。
- 在两个 serial step 之间取消不会启动下一 step。
- serial group turn stream 能发现 step 1..N 的 runId(step 1 也走 `serial_step`);不依赖任何 per-run stream 存活,前端只有一个 runId 来源。
- 现有 parallel 群聊行为不变。

前端:

- group composer 在并行模式下仍只由 `@mention` 决定 targets。
- 接力模式可选择首位 agent 和最大发言数。
- 活跃接力讨论期间发送按钮/取消按钮状态正确。
- 手动检查:
  - 原生 session detail 的单聊 composer。
  - Cockpit group chat 的并行 composer。
  - Cockpit group chat 的接力 composer。

## 取舍

第一版刻意不做:

- 多下一位并行分叉。
- agent 自由选择不在 participants 里的新成员。
- 跨 group thread 的接力。
- 写入原生 Claude/Codex 历史。
- 额外 LLM 共识裁判。

这些都可以后续加,但第一版先保持一个清楚的不变量:同一时刻只有一个 agent 在为这个 group turn 运行。
