# 10 — Agent 集成开发者指南

面向想搞清楚 **cockpit 到底怎么连各个 agent** 的人:follow-up、group chat、写回原生会话、handoff,分别走的是 CLI 还是 SDK,数据怎么落盘。

想快速看架构直接看下面这张图。

![Cockpit agent 集成拓扑](./assets/10-agent-integration.svg)

- 蓝 = React 前端
- 绿 = Vite middleware 后端(routes / registry / serialize)
- 橙 = Agent adapter
- 红 = 本机 CLI 子进程
- 紫 = 文件系统(原生 JSONL + `~/.cockpit/`)

## TL;DR

- **一切都走本机 CLI 子进程**,复用用户已登录的 `claude` / `codex` / `opencode` / `cursor-agent`。cockpit **不** 装官方账号 SDK,不管 OAuth。
- 唯一例外:Claude 逐工具审批走 `@anthropic-ai/claude-agent-sdk`(仍然透过本机 `claude` 可执行文件),Codex 逐工具审批走 `codex app-server --stdio` 的 JSON-RPC。**认证仍然来自本机 CLI**,SDK 只是替换了 IO 通道以拿到审批钩子。
- 所有 adapter 都实现 `ReviewAgent` 接口,统一在 [server/adapters/registry.ts](server/adapters/registry.ts) 注册,业务代码只调 `resolveAgent(name).run(...)` / `.resumeNative(...)`。
- 事件流一律翻成 [`NormalizedEvent`](server/loaders/types.ts),由 route 补 `EventEnvelope`(`origin/turnId/runId`),SSE 推给前端 + 追加到 `~/.cockpit/**/*.jsonl`。
- 原生会话文件是只读的事实来源;cockpit 只写 `~/.cockpit/`。写回原生 JSONL **只能** 通过官方 CLI 子进程完成(不变量 1/2)。

## 统一接口

[server/adapters/types.ts](server/adapters/types.ts):

```ts
interface ReviewAgent {
  name: AgentName
  isAvailable(): Promise<boolean>          // which/--version 检测本机 CLI
  run(input: AgentRunInput): AsyncIterable<NormalizedEvent>
  canResumeNative?(source: string): boolean
  resumeNative?(input: NativeResumeInput): AsyncIterable<NormalizedEvent>
}
```

`AgentRunInput` 关键字段:`text` / `contextEvents` / `cwd` / `permissions` / `writableRoots` / `model` / `effort` / `requestApproval?` / `signal`。有 `requestApproval` 回调时,adapter 必须走能拦截工具调用的通道(Claude Agent SDK / Codex app-server);没有时走一次性的 `-p` / `exec --json`。

不变量 6(见 [CLAUDE.md](CLAUDE.md)):adapter 必须调 `serializeForAgent(contextEvents, text, agent)` 拼 prompt,不能直接消费原始 events。

## 四种连线方式

### 1. Follow-up(同 session 追问)

前端 `POST /api/threads/:src/:id/messages` →
[server/routes/threads.ts](server/routes/threads.ts:51) 里 `handlePostMessage`:

1. 生成 `turnId` / `runId`,把 `user_text` envelope 追加到 `~/.cockpit/threads/<src>/<id>/followups.jsonl`。
2. SSE 升级,`loadSessionDetail` 拿原生 events + 已有 follow-up。
3. `resolveAgent(targetAgent).run({ text, contextEvents, cwd, signal, … })`。
4. 每条 `NormalizedEvent` 过敏感过滤 → 包 envelope → 同时落盘 + `sseWrite`。`assistant_text` 的 delta 只走 SSE,最终整段作为一条持久化事件。
5. 结束追加 `turn_status`(`completed` / `failed` / `aborted`)。

底层 CLI 调用:

- **Claude**([claude-call.ts:70](server/adapters/claude-call.ts:70) `runClaudePrint`)

  ```text
  claude -p --output-format stream-json --verbose \
         --include-partial-messages \
         [--model X] [--effort X] [--add-dir …] [permission-args]
  ```
  prompt 走 stdin。stdout 是 JSONL,`stream_event.content_block_delta` → `assistant_text` delta,`assistant` 行按 message id 去重 text 块,补 `tool_use` / `thinking` / `usage`。

- **Codex**([codex-call.ts:268](server/adapters/codex-call.ts:268) `runCodexExec`)

  ```text
  codex [-c …] exec --json --ephemeral --sandbox <mode> \
        --skip-git-repo-check [--model X] [-c model_reasoning_effort=…] \
        -C <cwd> [--add-dir …] <prompt>
  ```
  stdout 是 codex-sdk ThreadEvent JSONL。`item.started` 立刻 emit `tool_use`(让 UI 立即看到工具被调用),`item.completed` 追 `tool_result` 或文本;`turn.completed` 带 usage。

- **OpenCode / Cursor**:`opencode run --agent plan` / `cursor-agent -p --mode ask`,同样是子进程 + 行式 JSON。见 [opencode-call.ts](server/adapters/opencode-call.ts)、[cursor-call.ts](server/adapters/cursor-call.ts)。

### 2. Group chat(@mention 并发多 agent)

`POST /api/group-threads/:id/messages` → [group-threads.ts:211](server/routes/group-threads.ts:211) `handlePostMessage`:

1. 读 `transcript.jsonl` + `summary.md` + `state.json`(存在 `~/.cockpit/group-threads/<id>/`)。
2. `parseMentions(text)` ∩ `state.agents` = 本轮目标。冲突时 409(同一 group 不允许并发轮)。
3. 用户消息落 `transcript.jsonl`,记 `baseEventSeq`,widening 一个 `turn_start` meta(带所有 runIds)。
4. 对每个目标 agent:`projectContext(transcript, summary, text, agent, attachments)` 生成 **共享快照** 的伪 `contextEvents`,然后 `resolveAgent(agent).run(...)`。
5. `Promise.all(runs.map(runOne))` 并发跑,各自 SSE + 各自落 `run_done`。整体最终 `done: completed | partial | failed`。

关键点:group chat **复用 follow-up 的 adapter 接口**,只是 `contextEvents` 换成基于 group 快照的 markdown user_text(见 `projectContext`),这样多 agent 看到的是**一致的 transcript + summary + current preview**,不会串戏。attachments(图片)写入 `group-threads/<id>/attachments/`,**不**进原生 CLI 目录。

### 3. 写回原生会话(native resume)

用户显式点击"回到原会话" → `POST /api/native/:src/:id/messages` → [native.ts](server/routes/native.ts):

- 仅当 `agent.canResumeNative(source)` 且 `agent.resumeNative` 存在。目前只有:
  - `claude-code` ↔ `claude adapter`([claude-call.ts:564](server/adapters/claude-call.ts:564)):`claude -p --resume <sessionId>`,prompt 走 stdin。
  - `codex` ↔ `codex adapter`([codex-call.ts:420](server/adapters/codex-call.ts:420)):`codex --sandbox read-only --cd <cwd> exec resume --json --skip-git-repo-check <sessionId> -`。
- SSE 事件带 `origin: 'native'`,**不写 `~/.cockpit/`**。真正的写回由 CLI 追加到 `~/.claude/projects/…` 或 `~/.codex/sessions/…`,watcher 检测到变更后 SSE 推增量给前端(不变量 2/3)。
- cockpit 端事件仅用于即时展示;刷新后事实来源仍是原生 JSONL。

### 4. Handoff(把上下文交给另一条原生会话)

`POST /api/handoffs`(见 [handoffs.ts](server/routes/handoffs.ts))→ `buildContext` 从当前 source(follow-up thread / group / native session)抽取上下文,写成 markdown 到 `~/.cockpit/handoffs/<id>/{manifest.json, entry-claude.md, entry-codex.md}`。

`POST /api/handoffs/:id/open-native`:

| provider | method | 做法 |
|---|---|---|
| `codex` | `deeplink` | `buildCodexDeeplink` 拼 `codex://` URL,前端 `open` 打开。prompt 超预算时返回 `fallbackPrompt` 让用户手贴。 |
| `codex` | `app-server` | `runRegistry.startCodexContinuation` 起一个 `codex app-server --stdio` 常驻子进程,`initialize` → `thread/start` 拿 `threadId`,后续 `turn/start` 用户请求。回来的 `ServerNotification` 走 `translateNotification` → `NormalizedEvent`。native-continuation 目前不接审批 UI,server-initiated request 直接 -32601 拒绝。 |
| `claude` | `manual` | Phase 1 只返回渲染好的 prompt,让用户自己粘到 `claude`。 |

Handoff 产物本身在 `~/.cockpit/`;`nativeLink.linkLevel === 'linked'`(Codex app-server)后 `runRegistry` 持有 threadId,可以后续 mirror 回 Codex thread 到 handoff 目录。

## 逐工具审批(SDK 通道)

普通 follow-up 是"一趟往返"的 CLI 子进程,不能中断问用户。要做逐工具审批时(`permissions.mode === 'ask'` 且路由带 `requestApproval` 回调):

- **Claude**:[claude-call.ts:466](server/adapters/claude-call.ts:466) `runClaudeSdk`。动态 `import('@anthropic-ai/claude-agent-sdk')`,调用 `query({ prompt, options: { pathToClaudeCodeExecutable: 'claude', canUseTool, permissionMode: 'default', tools: { preset: 'claude_code' } } })`。`canUseTool` 把工具映射成 `Operation`(Read/Grep 自动放行,其它调 `requestApproval`),返回 `allow` 时顺带补 `PermissionUpdate` addRules/addDirectories。**注意 SDK 仍然通过本机 `claude` 可执行文件运行 agent 循环,cockpit 不需要 API key**。
- **Codex**:[codex-call.ts:173](server/adapters/codex-call.ts:173) `runCodexAppServer`。起 `codex app-server --stdio`,`initialize` → `thread/start`(带 sandboxPolicy / approvalPolicy)→ `turn/start`。收 server → client request(`execCommandApproval` / `applyPatchApproval` / `item/*/requestApproval`)→ `mapCodexApprovalRequest` 转 `Operation` → `requestApproval` → 回 `accept` / `decline`。
- **run-registry** 层负责创建 `ApprovalRequest`,在 SSE 上广播 `approval_required`,前端答复后调 `resolveApproval(id, status)` 唤醒 waiter。

## Serialize 边界

[serialize.ts](server/adapters/serialize.ts) 是 adapter 与上下文之间的强边界:

- 拆 `followup_boundary`:边界前是原生 events,边界后是 cockpit follow-up,不按 ts 重排(不变量 3)。
- 分区块:User Goal / Timeline / Tool Activity / Follow-up History / Final Response / Current Request。首尾钉住,中段超预算从中间腰斩。
- 全程 `redactSecrets`,tool input/output 有独立字符预算。
- adapter 拿到的是一整段 markdown 文本(Claude / Codex CLI 都当 prompt 塞进去),不是结构化事件。

## 目录一览

```
server/
  adapters/
    types.ts              ReviewAgent 接口
    registry.ts           agentName → adapter
    claude-call.ts        claude CLI + Agent SDK
    codex-call.ts         codex exec + app-server 切换
    codex-app-server.ts   JSON-RPC 客户端 + 事件翻译
    opencode-call.ts      opencode CLI
    cursor-call.ts        cursor-agent CLI
    serialize.ts          serializeForAgent(边界 6)
    sensitive.ts          redactSecrets + filterToolResult
  routes/
    threads.ts            follow-up SSE
    group-threads.ts      group chat SSE
    native.ts             写回原生会话 SSE
    handoffs.ts           handoff 创建 + open-native
  runs/
    run-registry.ts       runId/turnId、审批、Codex app-server 生命周期
    run-store.ts          RunRecord JSONL
    native-shadow-store.ts native resume 影子记录
  loaders/                claude / codex / cockpit JSONL → NormalizedEvent
  handoffs/               context-builder / capabilities / codex-deeplink
  store/                  thread-store / group-thread-store / handoff-store
```

## 加一个新 agent 的最短路径

1. 写 `server/adapters/foo-call.ts`,实现 `ReviewAgent`。`isAvailable` 用 `commandExists('foo', ['--version'])`,`run` spawn CLI,把 stdout JSONL 翻成 `NormalizedEvent` 并 `yield`。
2. 在 [registry.ts](server/adapters/registry.ts) 加一行 `registerAgent(fooAdapter)`。
3. `AgentName` 类型加成员;`agentName()` 显示名(group / serialize 里出现的地方)。
4. 只做 follow-up / group 就够了;想支持写回原生会话再实现 `canResumeNative` + `resumeNative`,并添加一个 loader 把它的原生 JSONL 也读进 timeline。

**不要**在 route 或 UI 里 `if (agent === 'foo')`(不变量 9/10)。差异化配置(默认 model、颜色)透过 adapter 表达,不透过分支。
