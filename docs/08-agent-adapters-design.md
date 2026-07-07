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
| OpenCode | `opencode` | provider-agnostic follow-up / group chat | 否 | 否 |
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
| OpenCode | `opencode run --agent plan` | `--agent plan` | `--dangerously-skip-permissions` |
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
opencode run \
  --format json \
  --dir <cwd> \
  # 权限映射:read-only/auto-safe → --agent plan;full-access → --dangerously-skip-permissions
  [--model <provider/model>] \
  [--variant <effort>] \
  <serialized prompt>
```

设计取舍:

- 使用 `run` 非交互模式,避免进入 TUI。
- 使用 `--format json` 读取 raw JSON events。
- 使用 `--agent plan` 对齐 Cockpit follow-up 只读语义。
- `model` 透传为 OpenCode 的 `provider/model`。
- `effort` 透传为 OpenCode 的 `--variant`,因为 OpenCode 把推理强度建模成 provider-specific variant。

当前不做:

- 不使用 `opencode serve` 长驻 server。
- 不读取 `opencode session list/export` 作为 session source。
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
- `effort` 当前不透传,因为 Cursor CLI 没有稳定统一的 reasoning effort flag。

当前不做:

- 不调用 Cursor IDE 内部 API。
- 不读取 Cursor workspace/index/session 数据库。
- 不做 Cursor Cloud handoff。

## JSON Event Parser

文件:`server/adapters/json-cli-events.ts`

OpenCode 和 Cursor 的 JSON event 形状可能随版本变化,所以 parser 使用“宽进严出”策略:

- 能识别的文本事件转 `assistant_text`。
- 能识别的工具开始事件转 `tool_use`。
- 能识别的工具完成事件转 `tool_result`。
- 能识别的 token usage 转 `usage`。
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
