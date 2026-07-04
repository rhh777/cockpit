# 09 — 审批写盘与权限档位计划

## 目标

Cockpit follow-up 当前默认只读。Agent 可以读取原生 session、生成回答和工具摘要,但不能稳定地修改用户文件。下一阶段目标是提供类似 Codex 桌面端的权限体验:

1. **请求批准**: agent 每次实际要执行写文件、shell、网络、权限提升等操作时,都先暂停并询问用户。
2. **替我审批**: 低风险操作按 agent/官方 runtime 的安全策略自动允许,检测到风险时再询问用户。
3. **完全访问权限**: 在用户明确选择后减少阻塞,但仍保留日志、敏感路径保护和事后审计。

核心边界: Cockpit 不能解析用户自然语言来猜测是否要创建文件。审批必须由 agent runtime 实际提出的 operation 触发,例如 Codex app-server 的 `item/commandExecution/requestApproval` 或 Claude SDK/hook 的 tool request。

## 当前状态

已完成的基础设施:

- 前端 composer 有三档权限选择。
- `startFollowupRun` / `startGroupRun` body 可携带 `permissions`。
- `RunRecord.permissions` 已持久化。
- adapter input 已接收 `permissions`。
- follow-up / group run 会写入 `run_permissions` timeline meta。
- 已有 `ApprovalRequest` 类型、store、routes。
- Run stream 已预留 `approval_required` / `approval_resolved` 消息。
- UI 已能渲染待审批卡片。

尚未完成的关键部分:

- Codex follow-up 仍主要走 `codex exec`,没有接 app-server 的 server-initiated approval request。
- Claude follow-up 仍主要走 `claude -p`,没有接 SDK `canUseTool` 或 CLI hook。
- `ApprovalRequest` 目前还没有被真实 adapter operation 触发,所以 UI 卡片不会在实际写盘前稳定出现。

因此当前不是“功能完成”,而是“权限 UI/API scaffold 完成,真实工具审批 adapter 未完成”。

## 设计原则

- 默认仍是只读/受限,不继承上一次全权限状态到新 run。
- 权限是 **run 级别** 的,写入 `RunRecord`,用于恢复、审计和 UI 展示。
- 审批触发点必须是 **agent runtime 的真实操作请求**,不是 Cockpit 对 prompt 的语义推断。
- 所有潜在副作用操作统一映射为 `Operation`,再交给 Cockpit 的 policy/approval 层展示、记录和决策。
- `ask` 决策必须产生 `ApprovalRequest`,通过 SSE 推给前端,并落盘。
- 写盘最终必须由受控 agent runtime 或 Cockpit 服务端代理完成,前端只做展示和决策。
- CLI adapter 不应该绕过统一 policy。若某个官方 CLI 不支持逐操作审批,只能使用 proposal/sandbox 模式,不能直接放开真实写权限。
- `full-access` 不等于无边界。敏感路径、credential 文件、系统目录、危险命令仍可被 policy 拒绝。

## 选型思考

### 不采用: prompt 语义预审批

例如用户说“在 `~/Downloads` 下写一个 `test.txt`”,Cockpit 不应该在 agent 运行前自行判断“这是创建文件请求”并弹审批。

原因:

- 判断权应在 agent/runtime,因为它才知道最终会调用 `Write`、`Edit`、`Bash`、`apply_patch` 还是只回答文字。
- prompt 语义和实际行为可能不一致。用户可能只是问“怎么写”,agent 可能选择解释而不是写盘。
- 预审批会批准一个抽象意图,但真正要审的是具体路径、命令、diff、网络 host。
- 多 agent 场景下,不同 agent 对同一 prompt 的行为可能不同。

结论: Cockpit 只审批实际 operation。

### Codex: 选择 app-server,不继续依赖 `codex exec`

`codex exec` 适合非交互自动化和简单 read-only follow-up,但它不是 rich client integration 的最佳边界。我们需要 inline approval UX、streamed item、thread/turn 生命周期和 server-initiated requests,应切到 `codex app-server`。

本地 `codex app-server generate-ts` 已确认当前 Codex schema 包含:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- legacy `execCommandApproval`
- legacy `applyPatchApproval`

对应 response:

- `CommandExecutionRequestApprovalResponse`
- `FileChangeRequestApprovalResponse`
- `PermissionsRequestApprovalResponse`
- legacy `ExecCommandApprovalResponse`
- legacy `ApplyPatchApprovalResponse`

官方 Codex app-server README 也说明: `turn/start` 使用时,app-server 会通过 server-initiated JSON-RPC request 触发 approval flow,客户端必须响应是否继续执行。参考: [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。

Promptfoo 的 Codex app-server provider 是可参考实现方向:它把 approval、permission、MCP、tool requests 都作为 app-server request 处理,并支持 deterministic `server_request_policy`。参考: [Promptfoo Codex app-server provider](https://www.promptfoo.dev/docs/providers/openai-codex-app-server/)。

结论: Codex follow-up 的写权限版本应走 app-server。`codex exec` 可保留为 read-only/simple fallback。

### Claude: 优先 SDK,备选 CLI hook

Claude 有两种可行接法:

1. **Claude Agent SDK `canUseTool`**
   - 优点: runtime callback 语义清晰,适合 Cockpit 这类产品集成。
   - 优点: 可以在工具调用时暂停,把真实 tool name/input 转成 Cockpit approval。
   - 缺点: 需要引入 SDK 依赖和一层事件转换,可能和当前 CLI session 文件兼容性有差异。

2. **Claude CLI hooks: `PreToolUse` / `PermissionRequest`**
   - 优点: 保留当前 `claude -p` CLI adapter 形态。
   - 优点: hook 能拿到真实 tool call,不是 prompt 猜测。
   - 缺点: 需要临时 settings/hook 脚本、IPC 或 HTTP 回调;hook trust/settings 行为也要处理。

Claude 官方 docs 说明 SDK 权限控制包含 hooks、allow/deny rules 和 `canUseTool` runtime callback。参考: [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)。Claude hooks 文档中 `PreToolUse` 是工具执行前触发,可以 block。参考: [Claude hooks](https://code.claude.com/docs/en/hooks)。

结论: Claude 优先评估 SDK 接入;若 SDK 对现有本机订阅/登录态或事件流不合适,再落 CLI hook 方案。

### Cursor / OpenCode

Cursor、OpenCode 当前只作为 Cockpit follow-up agent,没有稳定确认逐操作审批协议。第一版不把真实写盘能力作为必达目标:

- `ask`: 继续 plan/ask/read-only。
- `auto-safe`: 只使用官方安全/计划模式,不自行放开写盘。
- `full-access`: 只有在明确确认对应 CLI 参数能被外部 sandbox 或 runtime 约束后才启用。

结论: Cursor/OpenCode 先保留权限档位映射,但真实逐操作审批不作为 Phase 1 交付范围。

## 权限模型

```ts
type ApprovalMode = 'ask' | 'auto-safe' | 'full-access'

interface RunPermissions {
  mode: ApprovalMode
  allowNetwork: boolean
  allowWorkspaceWrite: boolean
  allowOutsideWorkspaceWrite: boolean
  allowShell: boolean
}
```

推荐默认值:

| 模式 | 网络 | workspace 写入 | workspace 外写入 | shell |
|---|---:|---:|---:|---:|
| `ask` | 询问 | 询问 | 拒绝或询问 | 询问 |
| `auto-safe` | 安全自动/风险询问 | 小范围自动/风险询问 | 询问 | 安全自动/风险询问 |
| `full-access` | 允许 | 允许 | 仍默认询问 | 允许 |

## Operation 与 PolicyDecision

```ts
type Operation =
  | { kind: 'file_read'; path: string }
  | { kind: 'file_write'; path: string; action: 'create' | 'edit' | 'delete' }
  | { kind: 'shell'; command: string; cwd?: string | null }
  | { kind: 'network'; host?: string; url?: string }

type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; approvalId: string; reason?: string }
```

`PolicyEngine` 输入包括:

- `RunRecord.permissions`
- session cwd/workspace root
- operation 类型、路径、命令、目标 host
- 风险分类规则
- 当前 run / 当前 session 内已批准的临时授权

## ApprovalRequest 存储

```txt
~/.cockpit/approvals/<approvalId>.json
```

```ts
interface ApprovalRequest {
  approvalId: string
  runId: string
  turnId: string
  source?: Source
  sessionId?: string
  groupThreadId?: string
  agent: AgentName
  operation: Operation
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  createdAt: string
  decidedAt?: string
  reason?: string
}
```

## API 与 Stream

```txt
GET  /api/approvals?status=pending
GET  /api/approvals/:approvalId
POST /api/approvals/:approvalId/approve
POST /api/approvals/:approvalId/reject
```

Run stream 消息:

```ts
{ kind: 'approval_required', approval: ApprovalRequest }
{ kind: 'approval_resolved', approvalId: string, status: 'approved' | 'rejected' }
```

Timeline 同时追加:

- `meta key='approval_required'`
- `meta key='approval_resolved'`

这样断线重连后仍能看到审批状态。

## Codex 实施方案

### Protocol client

扩展 `server/adapters/codex-app-server.ts`:

- `initialize` 使用 `capabilities.experimentalApi = true`。
- 发送 `initialized` notification。
- `thread/start` / `turn/start` 带权限相关参数:
  - `approvalPolicy`
  - `approvalsReviewer`
  - `sandboxPolicy`
  - `cwd`
  - `model`
  - `effort`
- `readLoop` 遇到带 `id + method` 的 server request 时,不要忽略,交给 approval handler。

### 权限档位到 Codex 参数

`ask`:

- `approvalPolicy = 'on-request'` 或 granular policy。
- `approvalsReviewer = 'user'`。
- `sandboxPolicy = { type: 'readOnly', networkAccess: false }` 或 workspace-write + 所有副作用询问,取决于 UX 决策。

`auto-safe`:

- `approvalPolicy = 'on-request'`。
- `approvalsReviewer = 'auto_review'`。
- `sandboxPolicy = workspaceWrite`。
- network 默认关闭,只有明确开启或审批后才打开。

`full-access`:

- `approvalPolicy = 'never'` 或更保守地保留 granular 敏感项。
- `sandboxPolicy = dangerFullAccess` 只在用户明确选择且当前 workspace 可信时使用。
- 敏感路径仍由 Cockpit policy 做额外拦截或警告。

### Server request 映射

现代 request:

| Codex method | Cockpit Operation | Approve response | Reject response |
|---|---|---|---|
| `item/commandExecution/requestApproval` | `{ kind: 'shell', command, cwd }` 或 network | `{ decision: 'accept' }` | `{ decision: 'decline' }` |
| `item/fileChange/requestApproval` | `{ kind: 'file_write', path/action }` 或 root grant | `{ decision: 'accept' }` | `{ decision: 'decline' }` |
| `item/permissions/requestApproval` | 权限提升请求 | granted permission profile | empty/declined permission profile |

Legacy request:

| Codex method | Cockpit Operation | Approve response | Reject response |
|---|---|---|---|
| `execCommandApproval` | `{ kind: 'shell', command, cwd }` | `{ decision: 'approved' }` | `{ decision: 'denied' }` |
| `applyPatchApproval` | `{ kind: 'file_write', ... }` | `{ decision: 'approved' }` | `{ decision: 'denied' }` |

### 等待与取消

- 收到 request 后创建 `ApprovalRequest`。
- `RunRegistry` 保存 waiter: `approvalId -> resolve`.
- SSE 推 `approval_required`。
- 用户 approve/reject 后 route 更新 store,调用 `runRegistry.resolveApproval`。
- adapter 将结果转成 Codex response 写回 JSON-RPC。
- run abort 时:
  - pending request 回 `cancel` / `abort`。
  - store 中 pending approval 标记为 `expired` 或 `rejected`。

### 最小交付范围

- 先支持 command/file change approval。
- `permissions/requestApproval` 先做保守处理:展示 reason 和 requested profile,批准后只给 turn 级权限,不做跨 session 持久 grant。
- MCP elicitation / dynamic tool call 可以先显示为 unsupported 并 reject,后续再接。

## Claude 实施方案

### 首选: Claude Agent SDK

新增 Claude SDK adapter:

- 使用本机 Claude Code 兼容的 SDK auth/runtime。
- 将 Cockpit context 序列化为 SDK input。
- 将 SDK event 转成 `NormalizedEvent`。
- 配置 tools 和 working dirs。
- 使用 `canUseTool` callback:
  - callback 收到真实 tool name/input。
  - 转成 `Operation`。
  - 走 Cockpit policy/approval。
  - 返回 allow/deny。

预期映射:

| Claude tool | Cockpit Operation |
|---|---|
| `Read` / `Grep` / `Glob` | `file_read` |
| `Write` / `Edit` / `MultiEdit` | `file_write` |
| `Bash` | `shell` |
| `WebFetch` / `WebSearch` | `network` |

### 备选: Claude CLI hook

继续使用 `claude -p`,但为本次 run 创建临时 settings/hook:

- `PreToolUse` hook:所有工具执行前把 JSON input 发给 Cockpit 本地 HTTP/IPC endpoint。
- Cockpit 创建 approval,等待用户决策。
- hook stdout 返回 allow/deny JSON。
- `PermissionRequest` hook:处理 Claude 自身 permission dialog 触发点。
- `--include-hook-events` 用于把 hook 生命周期同步到 timeline。

注意:

- hook 文件必须在临时目录生成,不要污染用户全局 `~/.claude`。
- settings 通过 `--settings <file>` 传入。
- hook trust 行为需要实测;如果非交互模式无法信任临时 hook,该方案降级。

### Claude 第一版边界

- 优先只接 `Bash` / `Write` / `Edit` / `MultiEdit`。
- 读文件默认可自动允许,但敏感路径仍可 deny。
- 网络工具默认 ask。
- 不做跨 run “永远允许”。

## UI 方案

审批卡片必须展示 operation 细节:

- agent 名称。
- 操作类型。
- 文件路径或 cwd。
- shell command。
- diff 或 file change 摘要。
- network host/url。
- reason。
- scope: 本次操作 / 本轮 turn / 本 session。

按钮:

- `拒绝`
- `允许`
- 后续可加 `本轮允许类似操作`

UI 不展示“你刚才说了要写文件所以要批准”这种文案,只展示 runtime 发来的实际操作。

## 实施拆分

### Phase 1: 文档与 scaffold 校正

- 明确禁止 prompt 语义预审批。✅
- 保留 permission mode UI/API。✅
- 保留 approval store/routes/UI。✅
- 更新本计划文档。✅

### Phase 2: Codex app-server approval

- 扩展 JSON-RPC client 支持 server request response。
- `initialize` 增加 `experimentalApi` 并发送 `initialized`。
- follow-up/group 中 Codex 写权限模式切到 app-server adapter。
- 实现现代 request:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
- 实现 legacy request:
  - `execCommandApproval`
  - `applyPatchApproval`
- 完成 approve/reject -> app-server response。
- 增加 unit tests:request -> ApprovalRequest -> response decision。
- 增加 integration smoke test:触发写文件,拒绝时不创建,允许时创建。

### Phase 3: Claude runtime approval

- 调研并选择 SDK 或 hook。
- 若 SDK 可行:
  - 新增 SDK adapter。
  - 接 `canUseTool`。
  - 转换 SDK stream events。
- 若 SDK 不可行:
  - 新增临时 hook settings。
  - hook 通过 local endpoint/IPC 等待 Cockpit 审批。
  - 处理 hook trust/timeout。
- 增加 smoke test:写文件拒绝/允许。

### Phase 4: PolicyEngine

- 实现路径分类:
  - workspace 内。
  - workspace 外。
  - sensitive files。
  - 系统目录。
- 实现 command classifier:
  - 明显只读命令。
  - install/network 命令。
  - destructive 命令。
- 实现 network host classifier。
- `auto-safe` 使用 classifier 自动 allow/ask/deny。

### Phase 5: sandbox/merge

- 高风险写入优先在临时 worktree/sandbox 执行。
- run 结束后展示最终 diff。
- 用户确认后 merge/apply 到真实 workspace。

## 验证计划

单元测试:

- permissions normalize。
- Codex request method 映射。
- approve/reject response shape。
- route 决策后 waiter resolve。
- UI stream 消息处理。

集成测试:

- Codex read-only:要求写文件时被拒绝或需要审批,未批准不写盘。
- Codex ask:写文件触发审批,拒绝不写盘,批准写盘。
- Codex command:危险 shell 触发审批。
- Claude SDK/hook:Write/Edit/Bash 触发审批。
- 取消 run:pending approval 过期,子进程退出。

手工验证:

- 在临时目录要求 agent 创建 `test.txt`。
- 在 workspace 内编辑文件。
- 尝试写 `~/Downloads/test.txt`。
- 尝试访问网络。
- 尝试执行 destructive shell。

每个验证都要记录:

- 是否出现 approval card。
- card 是否展示真实 operation。
- approve/reject 后 agent 是否继续。
- 文件系统最终状态是否符合决策。

## 第一版边界

- 不因为用户选择 `full-access` 就默认给所有 adapter 无限制真实写盘。
- 不处理应用退出后的 pending approval 恢复继续执行;退出后 run 仍按后台运行规则变为 `interrupted`。
- 不做跨 run 的长期“永远允许”规则。
- 不把普通 follow-up 写入原生 Claude/Codex 历史;native resume 仍走官方 CLI。
- Cursor/OpenCode 暂不承诺真实逐操作审批。

## 相关资料

- [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Promptfoo Codex app-server provider](https://www.promptfoo.dev/docs/providers/openai-codex-app-server/)
- [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
