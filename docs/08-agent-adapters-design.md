# 08 — Agent Adapter 设计

## 定位

Agent Adapter 是 Cockpit 调用本机 CLI agent 的边界。它只负责:

- 检测本机 CLI 是否可用。
- 把统一上下文序列化后交给 CLI。
- 把 CLI stdout/stderr 翻译成 `NormalizedEvent`。
- 通过 SSE 流给前端,并由上层 run registry 落盘到 Cockpit 自己的 JSONL。

Adapter 不负责:

- 登录、OAuth、API key 管理或网页 cookie 复用。
- 直接读取或改写原生 CLI 历史。
- 决定 UI 渲染结构。
- 绕过 `serializeForAgent` 直接消费原始 native schema。

当前已注册 agent:

| Agent | 命令 | 主要用途 | 原生 Resume | 原生 Session Loader |
|---|---|---|---|---|
| Claude | `claude` | Claude Code follow-up / native resume | 是 | 是 |
| Codex | `codex` | Codex follow-up / native resume / handoff | 是 | 是 |
| OpenCode | `opencode` | provider-agnostic follow-up / group chat / native resume | 是 | 是 |
| Cursor | `cursor-agent` 或 `agent` | Cursor headless follow-up / group chat | 否 | 否 |

## 统一接口

所有 adapter 实现 `ReviewAgent`:

```ts
interface ReviewAgent {
  name: AgentName
  isAvailable(): Promise<boolean>
  run(input: AgentRunInput): AsyncIterable<NormalizedEvent>
  canResumeNative?(source: string): boolean
  resumeNative?(input: NativeResumeInput): AsyncIterable<NormalizedEvent>
}
```

`ReviewAgent` 这个名字沿用早期 review 场景,实际代表所有 follow-up agent。

注册规则:

- 新 agent 只在 `server/adapters/registry.ts` 注册。
- UI 不应该为某个 agent 写专用执行逻辑。
- 允许按 agent 提供显示名、颜色、默认 CLI 参数,但不能让 UI 解析原生 CLI schema。

## 调用流程

```txt
POST /api/sessions/:source/:id/runs
  -> runRegistry 创建 turnId/runId
  -> ThreadStore append user_text
  -> load full context
  -> serializeForAgent(context, currentText, targetAgent)
  -> resolveAgent(targetAgent).run(...)
  -> adapter yield NormalizedEvent
  -> runRegistry 包 EventEnvelope + append + SSE
  -> append turn_status
```

群聊也是同一个 adapter 调用路径,区别是上下文来自 `transcript.jsonl` + `summary.md`,并且同一轮多个 agent 共享同一个 `baseEventSeq` 快照。

## 只读策略

Cockpit follow-up 当前默认只读。各 adapter 尽量使用 CLI 原生的只读/分析模式:

权限映射统一收敛在 `server/permissions/adapter-policy.ts`,mode ∈ `read-only` / `auto-safe` / `full-access`:

| Agent | read-only(默认) | auto-safe | full-access |
|---|---|---|---|
| Claude | `--permission-mode default --allowedTools Read,Grep,Glob`;`useTools=false` 时改成 `--disallowedTools Bash,Edit,Write,MultiEdit,WebFetch,WebSearch` | `--permission-mode acceptEdits` | `--permission-mode bypassPermissions` |
| Codex | `--sandbox read-only` + `--ask-for-approval never` | `--sandbox workspace-write` + `--ask-for-approval untrusted --search` | `--sandbox danger-full-access` + `--dangerously-bypass-approvals-and-sandbox --search` |
| OpenCode | SDK session ruleset:read allow,其它 ask | SDK session ruleset:read/edit allow,shell/web ask | SDK session ruleset:`*` allow |
| Cursor | `cursor-agent -p --mode ask` | `--auto-review --trust` | `--force --trust --sandbox disabled` |

Codex follow-up 不再走 `codex exec`——走 `codex app-server --stdio`(JSON-RPC 长连接),
所有权限参数以启动时的 `newConversation` payload(`sandboxPolicy` 等)传入;
`codex exec` 只在 `resumeNative` / native continuation 里使用。

注意:这些是 CLI 层面的 best-effort。不同 CLI 对“只读”的定义并不完全一致。Cockpit 仍会在序列化输入和 tool_result 回显/落盘前做敏感路径过滤。

## OpenCode Adapter

文件:`server/adapters/opencode-call.ts`

探测:

```txt
opencode --version
```

运行:

```txt
follow-up / group:
  @opencode-ai/sdk/v2
  createOpencodeServer({ hostname: '127.0.0.1', port: 0 })
  createOpencodeClient({ baseUrl, directory: <cwd> })
  v2.session.create({ location: { directory: <cwd> }, model?, agent? })
  session.update({ permission: Cockpit ruleset })
  v2.event.subscribe() + v2.session.prompt()

native resume:
  opencode run -s <sessionId> --format json --dir <cwd> [--variant <effort>] [--auto] <prompt>
```

设计取舍:

- 使用官方 `@opencode-ai/sdk` 启动/连接本机 OpenCode server;认证和 provider 配置仍来自用户本机 OpenCode,不是 Cockpit 管 API key。
- 每个 Cockpit run 创建 ephemeral OpenCode session,只把 Cockpit transcript 落到 `~/.cockpit/`;OpenCode 原生历史由 loader 只读 `~/.local/share/opencode/opencode.db`。
- OpenCode native resume 走官方 CLI `opencode run -s <sessionId> --format json`,因为 SDK `v2.session.prompt()` 会产生 transient stream 但当前实测不会可靠落到 loader 读取的 SQLite 历史。CLI 写入 legacy `message` / `part` 表,loader 必须和 `session_message` 合并读取。
- `model` 需要是 OpenCode 的 `provider/model` 形态;`effort` 作为 `ModelRef.variant` 传入。
- Cockpit 权限档转换成 OpenCode session `permission` ruleset:`ask` 自动放行 read/glob/grep/list/todowrite,其它 ask;`auto-safe` 额外自动放行 edit,shell/web 仍 ask;`full-access` 全 allow。
- `permission.v2.asked` / legacy `permission.asked` 事件映射为 Cockpit `Operation`,经统一 approval UI 决策后回 `once` / `always` / `reject`。
- OpenCode native resume 的 CLI 通道不支持 Cockpit 逐工具审批;`trusted` 模式映射为 `--auto`,默认模式不自动批准。
- OpenCode 也有 plugin/server 体系,但当前 SDK v2 permission API 已足够桥接审批;临时 plugin 留给未来需要更细粒度 UI/工具元数据时再评估。

当前不做:

- 不通过 `opencode session list/export` 作为 session source;原生历史读取走 SQLite loader。
- 不创建或修改用户的 OpenCode agent 配置。

## Cursor Adapter

文件:`server/adapters/cursor-call.ts`

探测顺序:

```txt
cursor-agent --version
agent --version
```

运行:

```txt
cursor-agent -p \
  --output-format stream-json \
  --stream-partial-output \
  # 权限映射:read-only → --mode ask;auto-safe → --auto-review --trust;full-access → --force --trust --sandbox disabled
  [--model <model>] \
  <serialized prompt>
```

如果 `cursor-agent` 不存在,会 fallback 到 `agent`。

设计取舍:

- 使用 headless/print 模式,避免打开 Cursor UI。
- 使用 `stream-json` 让前端能流式显示。
- 使用 `--stream-partial-output` 优先拿文本 delta。
- 使用 `--mode ask` 对齐只读语义。
- `effort` 不单独透传。Cursor CLI 把推理强度编码在账号返回的模型变体 ID 中
  (也支持参数化 `--model '...[effort=high]'`),所以 Cockpit 直接展示
  `cursor-agent --list-models` 的真实变体,不伪造独立 effort 下拉。

当前不做:

- 不调用 Cursor IDE 内部 API。
- 原生历史 loader 只读 Cursor Agent CLI 的 transcript JSONL 与 `meta.json`;adapter 不读取 Cursor workspace/index/session 数据库或 `store.db`。
- 不做 Cursor Cloud handoff。

## JSON Event Parser

文件:`server/adapters/json-cli-events.ts`

OpenCode 和 Cursor 的 JSON event 形状可能随版本变化,所以 parser 使用“宽进严出”策略:

- 能识别的文本事件转 `assistant_text`。
- 能识别的工具开始事件转 `tool_use`。
- 能识别的工具完成事件转 `tool_result`。
- 能识别的 token usage 转 `usage`。
- OpenCode 1.4.x 的 `part` 结构按一等 schema 处理:`part.type='text'` → `assistant_text`,`part.type='tool'` → `tool_use` / `tool_result`,`part.tokens` → `usage`。
- 不能识别的事件保留为 `meta`,不丢原始 payload。
- 非 JSON stdout 累积为普通 `assistant_text` fallback。

这样做的目标是让 CLI 小版本变形时最多损失精细工具展示,不让整轮 run 中断。

## UI 与设置

前端共享 agent 元数据:

- `src/lib/agents.ts`:agent value + label。
- `src/lib/mentions.ts`:识别 `@claude` / `@codex` / `@opencode` / `@cursor`。
- `src/components/FollowupComposer.tsx`:发送对象、mention 菜单、每 agent CLI 参数。
- `src/components/SettingsPanel.tsx`:默认 agent、模型/推理设置、CLI diagnostics。
- `src/components/AgentIcon.tsx`:头像与 label。

模型与推理强度发现统一走 `GET /api/agents/:agent/models`,响应同时包含
`models`、`modelDetection` 和 `effortDetection`;设置页与单聊/群聊 composer 复用同一份结果:

| Agent | 模型来源 | 推理强度来源 |
|---|---|---|
| Claude | CLI 无账号级机器可读列表,明确标记 unsupported,降级显示当前 CLI 接受的 alias | 从当前安装版本的 `claude --help` 解析 `--effort` 档位 |
| Codex | `codex app-server` 的 `model/list` | 每个模型的 `supportedReasoningEfforts` |
| OpenCode | SDK provider/config runtime 的已连接 providers | 每个模型的 `variants` |
| Cursor | `cursor-agent --list-models`(fallback binary 同 adapter 探测顺序) | 编码在模型变体中,标记为 embedded |

发现是 best-effort:失败不能阻断设置页或对话;UI 保留 CLI 默认和静态降级候选。
Codex 的 metadata request 复用 app-server 进程,但不占用 turn mutex,也不创建 thread/turn。

Claude 的 alias fallback 覆盖当前 CLI 菜单中的 Fable 5 / Opus 5 / Sonnet 5 /
Haiku 4.5 和可见旧版本,但不把它伪装成账号级探测结果。Cursor CLI 在 macOS 上
可能因 Keychain 暂不可读而输出 `SecItemCopyMatching failed` 并以成功状态退出；
空解析结果不能覆盖已知模型。成功探测的账号列表写入
`~/.cockpit/cache/cursor-models.json`,后续失败时显示最近一次真实列表并标明缓存来源。

OpenCode / Cursor 当前使用字母头像和独立配色,不新增图片资源。

## 新增 Agent Checklist

1. 新建 `server/adapters/<agent>-call.ts`,实现 `ReviewAgent`。
2. 在 `server/adapters/registry.ts` 注册。
3. 如果 CLI 输出是 JSONL/NDJSON,优先复用或扩展 `json-cli-events.ts`。
4. 在 `src/lib/agents.ts` 增加 label。
5. 在前后端 mention parser 增加 `@agent`。
6. 在 composer/settings 中增加默认 CLI 参数组。
7. 在 CSS 中增加 agent 色板与 chip/状态样式。
8. 增加 parser 或 adapter 单测。
9. 跑 `pnpm test`、`pnpm typecheck`、`pnpm build`。

如果要新增“原生 session 来源”,不要放在 adapter 里做;应新增 `SessionSourceLoader`,并把历史格式记录到 `docs/02-session-formats.md` 或单独文档。
