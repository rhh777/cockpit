# 11 — Agent Runtime 延迟优化计划

## 背景

Cockpit 现在的 follow-up / group chat 体验和原生 app 的主要差距,不是单个命令参数不够快,而是每轮用户消息都更接近"冷启动一次 agent runtime"。

当前关键路径:

- Claude 普通 follow-up 走 `claude -p --no-session-persistence`,每轮新建 CLI 子进程。
- Claude 审批路径走 Agent SDK `query()`,但仍按 run 创建一次 agent 会话。
- Codex 普通 follow-up 走 `codex exec --json --ephemeral`,每轮新建 CLI 子进程。
- Codex app-server 路径虽然协议更适合 rich client,但目前也是每轮 `spawn -> initialize -> thread/start -> turn/start -> kill`。
- 每轮都调用 `serializeForAgent(contextEvents, text, agent)`,长 session 会同时增加本地序列化成本和模型输入成本。

原生 app 更顺滑的核心是:

1. runtime 进程已经存活;
2. 登录态、配置、MCP、索引/工作区状态已经完成初始化;
3. 会话 thread 可以增量追加 turn,不需要每句话重放完整上下文;
4. UI 在 turn 开始前就能展示明确阶段状态。

## 目标

- 让同一 Cockpit session / group thread 中连续发送消息时,避免重复启动 Codex app-server。
- 在不改写原生 CLI JSONL 的前提下,优先复用 provider runtime 进程;provider thread 复用必须先完成原生落盘边界决策。
- 对 Claude 尽量减少 cold path:预加载 SDK、复用可复用的 native/session 能力、减少上下文输入。
- 长 session 下避免每轮序列化和发送完整历史。
- 给 UI 暴露细粒度启动阶段,让 unavoidable latency 可见、可解释。

## 非目标

- 不绕过官方 CLI / SDK / app-server 的认证和安全边界。
- 不直接写、删、改 `~/.claude` 或 `~/.codex` 原生历史文件。
- 不把 Cockpit group thread 变成原生 thread 的事实源。
- 不保证 Electron / Node 进程退出后 runtime 仍然存活。
- 不在没有真实 runtime operation 的情况下做 prompt 语义预审批。

## 设计原则

- Cockpit JSONL 仍是 Cockpit follow-up / group 的事实源;provider thread 只是运行态缓存或 linked continuation。
- 复用 runtime 不能改变 adapter 输出契约:route 和 UI 仍只消费 `NormalizedEvent` / `EventEnvelope`。
- 进程池 key 和 thread key 必须拆开:进程池只按 provider / CLI binary / version 等初始化相关字段分片;cwd、model、effort、permission profile、writable roots 属于 thread/run 层。
- 权限收紧必须开新 thread 或 run 设置;权限放宽也必须显式来自当前 run 的用户选择。权限变化不应无谓冷启新的 app-server 进程。
- runtime 失效时必须能自动降级到 cold start,不能让用户消息丢失。
- 所有用户消息仍先落 Cockpit 自己的日志,再启动或复用 agent。

## 方案总览

```txt
User sends message
  -> append user_text to Cockpit store
  -> resolve process key + optional provider thread key
  -> RuntimeManager.getOrWarm(provider, processKey)
  -> ContextProjector builds incremental prompt/input
  -> RuntimeSession.startTurn(...)
  -> adapter translates provider events to NormalizedEvent
  -> RunRegistry fans out SSE + persists Cockpit events
```

新增两个概念:

| 概念 | 作用 |
|---|---|
| `RuntimeManager` | 管理长驻 runtime 进程、warmup、idle TTL、崩溃恢复 |
| `ProviderThreadLink` | 记录 Cockpit thread/group/run 与 provider runtime thread id 的映射 |

关键拆分:

| 层级 | key 字段 | 说明 |
|---|---|---|
| 进程池 | provider、CLI binary path、CLI version、协议版本 | `initialize` 只和客户端能力/协议有关,尽量接近单例 |
| thread/run | cwd、model、effort、permission profile、writable roots、Cockpit scope | 影响 `thread/start` / `turn/start` 行为,变化时 stale thread 或用新 run 设置 |

## Phase 1: Codex app-server 长驻池

优先做 Codex,因为 app-server 本身就是长连接 JSON-RPC 协议,收益最大。

### 目标

- 将 `CodexAppServer` 生命周期从单个 run 提升到进程级 manager。
- 首次使用时启动 `codex app-server --stdio` 并 `initialize`;后续 run 复用。
- idle 超时后自动 kill,避免后台无限占资源。
- app-server 崩溃或协议错误时,清理 session 并允许下一轮 cold restart。

### 建议接口

```ts
interface CodexProcessKey {
  provider: 'codex'
  binaryPath: string
  version?: string
  protocol: 'app-server-stdio'
}

interface CodexRuntimeSession {
  key: CodexProcessKey
  client: CodexAppServer
  initializedAt: string
  lastUsedAt: string
  refCount: number
  status: 'starting' | 'ready' | 'failed' | 'stopped'
}

class CodexRuntimeManager {
  warmup(key: CodexProcessKey): Promise<void>
  acquire(key: CodexProcessKey, signal: AbortSignal): Promise<CodexRuntimeSession>
  release(session: CodexRuntimeSession): void
  dispose(key: CodexProcessKey): Promise<void>
  disposeIdle(now?: number): Promise<void>
}
```

### 实现位置

- 新增 `server/adapters/codex-runtime-manager.ts`。
- `server/adapters/codex-call.ts` 的 app-server path 改为从 manager 获取 client。
- `server/runs/run-registry.ts` 的 native continuation 也逐步迁到同一 manager,避免重复生命周期代码。

### 注意事项

- 单个 app-server 是否允许并发 `turn/start` 需要保守处理。第一版同一个 app-server 进程内串行 turn;确认 notification routing 后再开放并发。
- `onNotification` / `onServerRequest` 不能作为全局单 slot。复用后需要按 `threadId` / request id 分发到当前 turn handler。
- 现有 `translateNotification(method, params, threadId)` 的 `threadId` 来自单 run 闭包。长驻进程落地前必须确认 app-server notification payload 是否自带 `threadId`,并优先从 `params.threadId` 路由;如果某些通知不带 thread id,第一版必须保持 app-server 进程内单 active turn。
- `disposeIdle` 必须跳过 `refCount > 0` 的 session,不能只看 `lastUsedAt`。
- `CodexAppServer.stderr` 不能继续无限字符串累积;长驻前改成环形缓冲或只保留最后 N KB。
- 当前 `CodexAppServer` 类可保留协议编解码职责,manager 只负责进程和 session 生命周期。

### 当前实现状态

- 已新增 `CodexRuntimeManager`,按 Codex binary / app-server stdio 协议复用进程。
- 普通 app-server follow-up 仍每轮创建新的 `ephemeral` thread,不跨轮复用 provider thread。
- 同一 app-server 进程内第一版保持单 active turn,避免 notification 串线。
- 本地生成的 app-server schema 已确认 `turn/interrupt` 可用,取消 run 时优先 interrupt 当前 turn;失败或超时才丢弃该 runtime。
- `CodexAppServer.stderr` 已改成有限缓冲,默认只保留最后 64 KB。

## Phase 2: Provider thread 复用

长驻进程只省掉启动成本;要接近原生 app,还需要减少每轮完整上下文重放。

这个阶段有一个必须先定的边界:当前 Codex app-server follow-up 使用 `ephemeral: true`。如果 app-server 的 ephemeral thread 不能跨轮稳定 `turn/start(existingThreadId)`,要复用 thread 很可能需要非 ephemeral thread;非 ephemeral Codex thread 可能由官方 app-server 落盘到 `~/.codex/sessions`。这不是 Cockpit 直接写原生文件,但它会通过官方 runtime 产生原生 session 副作用,语义上接近 `docs/07` 的 native continuation。

因此 Phase 2 不能默认作为普通 follow-up 的透明优化直接落地。必须先二选一:

| 选择 | 语义 | 后果 |
|---|---|---|
| A. 只复用 app-server 进程,不跨轮复用 provider thread | 保持普通 follow-up 完全不产生原生 Codex session | 仍需每轮 `thread/start`,但省掉进程 cold start |
| B. 允许 provider thread 复用 | 视为受控 native-linked continuation 或显式 opt-in 缓存 | 需要 UI/文档说明会通过官方 Codex runtime 产生/复用原生 thread |

在这个边界未定前,Phase 2 只做调研和接口预留,不改变普通 follow-up 的 `ephemeral` 行为。

### 目标

- 为同一个 Cockpit follow-up thread 或 group member 复用 Codex app-server thread id。
- 后续消息直接 `turn/start(existingThreadId)`,只发送当前用户消息和必要增量上下文。
- thread link 是 Cockpit 内部缓存,不是事实源迁移。
- 如果选择 B,必须把 link 标记为 native-linked,并在 final UX 中区别于纯 Cockpit follow-up。

### 存储

```txt
~/.cockpit/runtime-links/codex.jsonl
```

```ts
interface ProviderThreadLink {
  id: string
  provider: 'codex' | 'claude'
  cockpitScope:
    | { kind: 'followup'; source: Source; sessionId: string; agent: AgentName }
    | { kind: 'group-member'; groupThreadId: string; agent: AgentName }
    | { kind: 'handoff'; handoffId: string }
  threadKeyHash: string
  nativeThreadId: string
  persistence: 'ephemeral' | 'native-linked'
  createdAt: string
  updatedAt: string
  sourceFingerprint: {
    eventCount: number
    latestTurnId?: string
    summaryRevision?: number
  }
  status: 'active' | 'stale' | 'failed'
}
```

### 失效规则

- cwd / model / effort / permission mode / writable roots 变化:旧 link stale,新建 provider thread。
- source session 原生部分增长:旧 link stale,除非后续实现了增量同步。
- group summary revision 变化:旧 link stale 或发送一次 summary refresh turn。
- app-server 返回 thread not found:旧 link failed,自动新建 thread 并重试一次。

## Phase 3: Claude cold path 优化

Claude 的最佳方案取决于 Agent SDK 和本机 Claude Code CLI 对 session 复用的能力。第一步先做可验证优化,不要假设 SDK 一定提供 app-server 级别长驻能力。

当前 Claude 有三条不同路径:

| 路径 | 当前实现 | 主要慢点 | 可安全优化 |
|---|---|---|---|
| 普通 follow-up | `claude -p --no-session-persistence ...` | 每轮 spawn CLI、加载配置/MCP、全量 prompt | CLI capability cache、context 减负、阶段状态 |
| 逐工具审批 | Agent SDK `query({ prompt, options: { canUseTool } })` | 首次 dynamic import、每轮 query runtime、全量 prompt | SDK 预加载、capability probe、可复用 session 调研 |
| native resume | `claude -p --resume <sessionId>` | 官方 CLI 续写原生 session | 保持现状,这是用户显式 native 写回 |

Claude 不像 Codex app-server 当前已有明确的长驻 JSON-RPC boundary。任何"复用 Claude session"都必须先验证 SDK/CLI 的真实语义,尤其是它是否会写入 `~/.claude/projects`、是否会污染用户原生 session、以及是否支持只作为 Cockpit runtime cache 使用。

### 目标

- app 启动或用户选中 Claude 时预加载 SDK module,避免第一次发送才 dynamic import。
- 探测 Claude SDK / CLI 是否支持可复用 session id 或 Cockpit-owned continuation 语义;能复用则建立 `ProviderThreadLink`。
- 对不能复用的路径,仍优化 context projection 和 UI 阶段状态。
- 保持普通 follow-up 不直接写 `~/.claude`。只有用户显式 native resume / handoff 时,才允许官方 Claude CLI 写回原生 session。

### Phase 3A: 低风险 warmup 与 capability cache

这部分不改变 Claude run 语义,可以先做。

1. `loadClaudeAgentSdk()` 增加 module-level promise cache。
   - 现在动态 import 已经通过 `new Function('specifier', 'return import(specifier)')` 避免 Electron CJS bundling 问题。
   - 但每次 `runClaudeSdk()` 都 `await loadClaudeAgentSdk()`;即使 ESM runtime 会缓存 module,仍应显式缓存 promise,避免并发首轮重复 import 和错误处理不一致。
2. 增加 `ClaudeRuntimeWarmup` 或 adapter-level `warmupClaude()`:
   - 检测 `claude --version`;
   - 预加载 SDK module;
   - 记录 SDK import 是否成功;
   - 不发模型请求,不创建 session,不触发网络-heavy 操作。
3. `claudeAdapter.isAvailable()` 结果短 TTL cache。
   - 当前每次 availability 可能跑 `claude --version`;
   - TTL 可以 30-60 秒,失败不长缓存,避免安装/登录修复后还卡住。
4. UI/run phase 接入:
   - `warming_runtime`: CLI/version/SDK warmup;
   - `building_context`: `serializeForAgent`;
   - `starting_turn`: spawn CLI 或 SDK query;
   - `streaming`: 第一条 delta/tool/thinking 到达。

### 当前实现状态

- `loadClaudeAgentSdk()` 已增加 module-level promise cache;SDK import 失败会清空 cache,允许后续重试。
- `claudeAdapter.isAvailable()` 已增加成功结果 TTL cache;失败不长缓存。
- 已新增 `warmupClaudeRuntime()` 和 adapter `warmup()`,只做 `claude --version` 与 SDK import,不发模型请求、不创建 session。
- 已新增 `/api/settings/warmup`,前端 app 启动和默认 agent 偏好变化时会静默触发当前默认 agent 的 warmup。
- 仍未实现 Claude session 复用;普通 follow-up 继续使用 `claude -p --no-session-persistence`。

### Phase 3B: Claude SDK session 复用调研

先写 probe / spike,再决定是否实现。

必须确认:

- SDK `query()` 是否返回可用于后续 continuation 的 session id。
- SDK 是否接受 session id / resume id 作为 Cockpit-managed continuation。
- 该 continuation 是否会写入原生 `~/.claude/projects`.
- 如果会写入,是否能显式标记为 `native-linked`,并要求用户选择。
- SDK session 是否支持不同 cwd / model / additionalDirectories / permissionMode 的安全切换。
- `canUseTool` callback 在复用 session 中是否仍按每个 run 的 permissions 生效。

可接受结果:

| 结果 | 决策 |
|---|---|
| SDK 支持不落原生历史的 Cockpit-owned session | 可以实现 Claude `ProviderThreadLink` 的 runtime-cache 模式 |
| SDK 只支持会落原生历史的 continuation | 只能做显式 native-linked / handoff,不透明用于普通 follow-up |
| SDK 不支持稳定复用 | 不做 session 复用,转向 context 减负 + warmup |

### Phase 3C: 普通 `claude -p` 路径优化

如果普通 follow-up 继续使用 `--no-session-persistence`,它天然是短命进程。可做的是减少周边开销:

- availability TTL cache,避免每轮重复版本检测。
- 在 app/session focus 时 warmup CLI/SDK。
- 将 `serializeForAgent` 前移到 `building_context` phase 并计时。
- 长上下文走 Phase 4 的 `ContextProjector`,减少 prompt size。
- 保留 `--include-partial-messages`,让首 token 后尽快流式显示。

需要谨慎评估:

- 移除 `--no-session-persistence` 可能让普通 Cockpit follow-up 写入 Claude 原生历史,默认不允许。
- 使用 `claude --continue` / `--resume` 只能作为用户显式 native resume 或 native-linked continuation,不能偷偷用于普通 follow-up。
- CLI hooks 可用于审批,但不能解决每轮 spawn 的冷启动;它更多是权限方案,不是主要加速方案。

### 实施路线

1. 增加 Claude capability probe,记录:
   - CLI `claude --version`;
   - SDK import 是否成功;
   - SDK 是否能返回/接受 session id;
   - CLI `--resume` 是否只适合 native resume,还是可用于 Cockpit-managed continuation。
2. 先实现 SDK import promise cache + availability TTL cache + warmup API。
3. 若 SDK 可复用 session:
   - 为 follow-up/group member 保存 Claude provider link;
   - 后续 run 只发当前 turn 和增量上下文。
4. 若 SDK 不可复用:
   - 保持 `claude -p` / SDK per-run;
   - 做 warm import、上下文减负、阶段 UI。

### Claude 验收标准

- 首次进入应用或选中 Claude 后,后台 warmup 不发模型请求、不创建原生 session。
- 连续 Claude SDK approval run 不重复 dynamic import SDK。
- `claude --version` availability 在 TTL 内不重复执行。
- 普通 follow-up 仍不写 `~/.claude/projects`。
- 如果实现 Claude ProviderThreadLink,必须明确 `persistence: 'ephemeral' | 'native-linked'` 语义,并通过测试覆盖权限/cwd/model 变化时的失效规则。

## Phase 4: 上下文投影与增量化

### 目标

- 避免每轮把完整原生 timeline + 所有 follow-up 全量塞给 agent。
- 对 provider thread 已经看过的上下文,后续只发送当前 turn 和必要摘要。
- 长 session 下保持回答质量和性能稳定。

### 方案

新增 `ContextProjector`,作为 `serializeForAgent` 前的选择层:

```ts
interface ContextProjection {
  mode: 'full' | 'incremental'
  events: EventEnvelope[]
  summary?: string
  fileRefs?: string[]
  providerThreadId?: string
}
```

第一版策略:

- 新 provider thread:使用现有 `serializeForAgent` 全量预算策略。
- 已有 provider thread:只发送当前用户消息 + 最近少量 Cockpit follow-up + source/session 摘要。
- 大 tool output 永远摘要化,不重复塞原文。
- group chat 复用 `summary.md`,只追加当前轮预览和 @mention 目标。

### 后续增强

- 为 follow-up thread 维护 `summary.md` 或 `context-state.json`。
- 在每轮完成后异步更新 summary。
- 将 handoff bundle 的 canonical files 复用为长上下文入口。

## Phase 5: UI 阶段状态

即使底层仍需 cold start,也要让用户立即看到系统在做什么。

### 新增 run phase

```ts
type RunPhase =
  | 'queued'
  | 'warming_runtime'
  | 'runtime_ready'
  | 'building_context'
  | 'starting_turn'
  | 'streaming'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
```

RunRegistry 通过 SSE 推 `run_phase` meta。前端可在 `StreamingStatus`、single composer、group member status 中展示一致的阶段语言。

### 触发点

- manager acquire 前: `warming_runtime`
- acquire 成功: `runtime_ready`
- context projection: `building_context`
- `thread/start` / `turn/start`: `starting_turn`
- 第一条 assistant/tool/thinking event: `streaming`
- approval request: `waiting_approval`

## Phase 6: Warmup 策略

### 触发

- Electron app 启动后,预热默认 agent。
- 用户打开 session detail 时,按 session source 和默认 follow-up agent 预热。
- 用户切换 AgentPicker / model / permission 时,预热新 key。

### 限制

- warmup 不应自动创建 provider thread,只初始化 runtime 进程和 capability。
- warmup 不应触发网络-heavy 模型请求。
- warmup 失败只写 diagnostics,不阻塞 UI。

## 风险与处理

| 风险 | 处理 |
|---|---|
| app-server notification payload 不带 threadId | Phase 1 前置调研;如果无法可靠路由,同一 app-server 进程内保持单 active turn |
| 长驻 app-server 的 notification handler 被并发 turn 覆盖 | 引入按 threadId/runId 分发的 dispatcher,第一版同进程串行 |
| 权限模式变化但误复用旧 thread | threadKeyHash 包含权限和 writable roots,变化即 stale;进程不因此冷启 |
| provider thread 复用需要非 ephemeral 并产生原生 Codex session | Phase 2 前置决策;未定前只复用进程,不透明复用 thread |
| provider thread 缓存与 Cockpit 事实源漂移 | link 只作缓存;source fingerprint 变化即重建或 refresh |
| app-server 崩溃导致 run 卡住 | readLoop 统一置 failed,RunRegistry 写 terminal status,下轮重启 |
| idle 回收杀掉活跃 turn | `disposeIdle` 跳过 `refCount > 0`;active turn 定期更新 lastUsedAt |
| 长驻进程资源泄漏 | idle TTL + app shutdown dispose + tests |
| 长驻进程 stderr 无界增长 | `CodexAppServer` stderr 改为环形缓冲,只保留最后 N KB |
| Claude SDK 无法复用 session | 不阻塞主线;先保留 per-run,优化 warmup/context/UI |
| 增量上下文导致 agent 漏看重要历史 | 新 thread 仍 full context;增量模式附 summary 和最近 turns;提供 stale/rebuild 机制 |

## 测试计划

- Codex runtime manager:
  - 同 process key 连续 acquire 只 spawn 一次。
  - cwd / model / permission 变化不创建新 app-server 进程。
  - idle TTL 后 kill refCount 为 0 的 session。
  - idle TTL 不 kill refCount 大于 0 的 session。
  - stderr ring buffer 不超过设定上限。
  - readLoop error 后 session failed,下一轮可重建。
  - abort 单个 run 不 kill 共享 runtime,除非 runtime 本身不可恢复。
- Codex app-server turn:
  - 同进程串行 turn 不串事件。
  - notification routing 优先使用 payload threadId;缺失时保持单 active turn。
  - server-initiated approval request 路由到正确 run。
- Provider thread links:
  - thread key 变化标记 stale,process key 不变。
  - thread not found 自动重建并重试一次。
  - source fingerprint 变化触发 stale。
  - `persistence: 'native-linked'` 的 link 不被当作纯 Cockpit follow-up 静默创建。
- Context projection:
  - 新 thread 使用 full context。
  - 已有 thread 使用 incremental context。
  - 大 tool output 不重复进入 incremental prompt。
- UI/run phase:
  - phase 顺序稳定。
  - 失败和 abort 都有 terminal phase。
  - group member 各自显示独立 phase。

## 实施顺序

顺序按 ROI 重新排列。Codex Phase 1 已经拿到最大启动收益;剩下的工作对 **Claude 侧的体感提升**主要靠 (a) UI 阶段状态可见、(b) 首次 warmup、(c) 长 session 上下文减负这三件事,而不是靠 SDK session 复用(SDK 现状大概率不支持无副作用复用,不要阻塞其他工作)。

### P0 — 立刻能被用户感知(优先做)

1. ~~**Phase 5 run phase SSE + UI 阶段状态**~~ 已完成
   - 落 `RunPhase` 枚举、`run_phase` meta event、`StreamingStatus` / composer / group member 一致渲染。
   - 触发点见 Phase 5 章节;Codex 走 manager acquire,Claude 走 SDK warmup / spawn。
   - 对 Claude 冷启动感知提升最大,不依赖任何 provider 能力。
2. ~~**Phase 3A — Claude warmup + capability TTL cache**~~ 已完成
   - `loadClaudeAgentSdk()` 加 module-level promise cache。
   - `claudeAdapter.isAvailable()` 增加 30–60s TTL cache,失败不长缓存。
   - 新增 `warmupClaude()`:`claude --version` + SDK import,不发模型请求、不创建 session。
   - 触发点:app 启动、session focus、AgentPicker 切到 Claude。
3. ~~**Phase 4 最小子集 — 大 tool output 摘要化 + group summary 复用**~~ 已完成
   - 只做"不重复塞大 tool output 原文"和"group chat 复用 `summary.md`"这两条。
   - 不引入 provider thread,不改变 `serializeForAgent` 契约,纯粹减少输入 tokens。
   - Claude / Codex 都直接受益。

### P1 — Codex 侧继续压榨

4. 调研 Codex app-server notification payload 是否稳定包含 thread id;记录不带 thread id 的方法清单。
5. 决定 Phase 2 是否允许非 ephemeral provider thread 复用及其 UI/文档语义;未定前禁止透明 thread 复用。
6. ~~完成 `CodexRuntimeManager` 剩余单测(idle TTL、refCount、readLoop 失败重建、stderr 上限)。~~ 已完成。
7. ~~将 handoff native continuation 的 Codex app-server 生命周期迁到同一 manager。~~ 已完成:native continuation 复用 `CodexRuntimeManager` lease,后台 turn 结束后释放,取消优先走 `turn/interrupt`。
8. 若 Phase 2 选择允许 thread 复用,增加 `ProviderThreadLink` store 和 `persistence` 语义。
9. 将 group member Codex run 接入已批准的 thread/link 策略。

### P2 — Claude 深度优化(仅当 P0 完成且仍有明显瓶颈)

10. **Phase 3B spike**(不实现,仅出结论):跑一个 probe 脚本验证 Agent SDK 是否有可复用 session id、`--resume` 是否只写原生历史。产出决策文档;若结论是"不可无副作用复用",Claude 侧到此为止,收益已在 P0 拿完。
11. Phase 4 增量上下文 full 模式(follow-up thread `summary.md` / `context-state.json`,每轮异步更新)。仅在长 session 明显慢时才做。

### 已完成

- `CodexAppServer` stderr 环形缓冲(64 KB)。
- `CodexRuntimeManager` 基础版本 + `turn/interrupt` 取消路径。
- `runCodexAppServer` 复用 manager,每轮仍新建 ephemeral thread。
- handoff native continuation 复用同一个 `CodexRuntimeManager`,不再自建 app-server/readLoop。
- Claude warmup / SDK import promise cache / availability TTL cache。
- `run_phase` SSE + `StreamingStatus` 阶段展示,覆盖 follow-up、group member、native resume、Codex native continuation。
- 大 tool output context projector,在 follow-up 和 legacy `/threads` 路径进入 agent 前裁剪长输出。
- Codex adapter `warmup()`(接 `/api/settings/warmup`):触发 `codexRuntimeManager.warmup()` 预热 app-server,不发 turn。
- `notificationTurnId` 兼容 `turn_id` snake_case,避免 abort 时因识别不到 provider turn id 而回退到 disposeRuntime。

## Claude 侧收益预期(供开发对齐)

不要按 Codex Phase 1 的量级期待 Claude,现实的加速拆分:

| 优化 | 何时生效 | 预期收益 |
|---|---|---|
| Phase 5 UI 阶段状态 | 每一次 run | 感知加速,消除"卡住"感,不改真实延迟 |
| Phase 3A warmup + TTL cache | 首次 run / 切 agent 后首轮 | 500ms – 1.5s |
| Phase 4 tool output 摘要化 | 长 session、含大 tool output | 输入 tokens 明显下降,首 token 更快 |
| Phase 3B session 复用 | 若 SDK 支持(大概率不支持) | 若拿到才评估;不阻塞其他工作 |

**结论**:Claude 侧真正能被用户感知的加速几乎全部集中在 P0 三项。P2 只在 P0 完成且仍有明显瓶颈时启动。

## 验收标准

- 同一 Codex follow-up thread 连续发送第二条消息时,不再启动新的 `codex app-server` 进程。
- Codex app-server initialize 在 idle TTL 内只发生一次。
- 切换 cwd / model / permission 不会冷启新的 app-server 进程,但会使用新的 thread/run 设置。
- Phase 2 未显式定稿前,普通 follow-up 仍保持 ephemeral,不透明生成 native-linked provider thread。
- 已批准 provider thread 复用后,后续消息不再发送完整原生 session 文本。
- UI 在第一 token 前至少能显示 runtime/context/turn 三个阶段之一。
- app-server 崩溃后下一轮可自动恢复 cold start。
- 所有事件仍写入 `~/.cockpit/`,原生 JSONL 没有被 Cockpit 直接修改。
