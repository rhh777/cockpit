# CLAUDE.md

This file gives guidance to anyone working in this repository (Claude Code or otherwise). Read it before changing anything.

## 这是什么

`cockpit` 是本地 AI CLI 会话查看器与协作控制台。

- 读取 Claude Code / Codex / OpenCode / Cursor Agent CLI 原生会话并渲染 timeline。
- 在原会话基础上发起跨 agent follow-up、review、群聊、接力讨论或 Review Room。
- 将 cockpit 数据保存到 `~/.cockpit/`,不直接改写原生 CLI 文件。

「回到原会话」只通过官方 CLI 子进程写入原生历史,当前支持 Claude / Codex / OpenCode;Cursor 只读。

## 代码分布

- `src/` — React 19 前端(三栏布局、timeline、composer)
- `server/` — Vite middleware 后端(loaders / adapters / routes / store / watcher)
- `electron/` — 桌面壳(Tray 常驻)
- `__fixtures__/` — 脱敏的真实 JSONL 样本

后台运行已实现(`server/runs/run-registry.ts`,设计见 `docs/06-background-runs-design.md`):agent run 由 RunRegistry 托管,切换 session 只断开订阅不 abort,切回可 attach 回既有 runId;只有显式 cancel 或服务端进程退出才终止。

## 动手前先读

- `docs/01-architecture.md` — 架构契约、数据流、不变量、安全、扩展点。
- `docs/02-session-formats.md` — Claude / Codex / Cursor JSONL 与 OpenCode SQLite schema 实测,loader 的事实来源。
- `docs/03-roadmap.md` — 当前能力、边界与后续方向。
- `docs/04-ui-design.md` — UI 视觉/交互规范。
- `docs/05-group-chat-design.md` — 群聊模式(transcript.jsonl + summary.md,@mention 并行调度)。
- `docs/06-background-runs-design.md` — 后台运行(RunRegistry / attach / cancel,已实现)。
- `docs/07-native-continuation-and-handoff.md` — 原生会话延续、deep link 与 handoff bundle。
- `docs/08-agent-adapters-design.md` — agent adapter 设计。
- `docs/09-approval-and-write-access.md` — 权限档位与审批层。
- `docs/10-agent-integration.md` / `docs/11-agent-runtime-latency-plan.md` — agent 接入与运行时延迟优化。
- `docs/12-design-review-findings.md` — 设计评审问题清单与修复进度(动手修复前先看这里)。
- `docs/13-serial-agent-discussion-design.md` — 群聊串行/接力讨论模式。
- `docs/14-review-room-workflow-design.md` — 从 session、仓库、文件、文档触发 Claude/Codex 方案协作与 fresh review。
- `docs/15-release-process.md` — 打 tag 发版、checksum、签名与公证。

文档记录的是已定决策。

## UI 改动同步规则

任何 UI 改动都必须先判断是否影响另一个页面或模式。尤其是 agent 选择、模型/权限 chip、composer、timeline agent 头像、状态提示这些共享体验,不能只改当前看到的页面。

- 改 agent 名称、顺序、可选项、默认值:先改 `src/lib/agents.ts`,再检查 `AgentIcon`、`AgentPicker`、`FollowupComposer`、`SessionList`、`SessionDetail`、`ReviewPanel`、`StreamingStatus` 是否仍一致。
- 改 agent 图标、颜色、尺寸、选中态:优先改共享组件/样式(`AgentIcon` / `AgentPicker` / 全局 agent class),不要在群聊或单聊页面各写一套。
- 改 composer 布局或交互:同时检查单聊 follow-up、原生续写、群聊三个状态。群聊可以有多 agent 设置,但视觉语言必须和单聊 agent picker / model picker 对齐。
- 改文案或占位符:**一律走 `src/lib/i18n.ts` 的 `t()`,不要在组件里写死任何用户可见文案**(en + zh-CN 两边同时加 key),并确认单聊与群聊的语义差异只是必要差异,不是风格漂移。
  - 数据层 / 纯函数不产出人类语言:返回结构化描述或 `MessageKey`,由组件渲染时 `t()`(如 `timeline.ts` 的 `NarrativeAction`、`StreamingStatus` 的 `PHASE_LABELS`)。也不要用显示字符串做逻辑判断(用 kind/枚举)。
  - 模块级 helper 需要文案时,把 `t` 作为参数传进去,别在模块作用域调 `translate()`——那样语言切换后不会重渲。
  - 例外(不要"顺手翻译"):`serialize.ts` 写进 agent prompt 的 `请以 X 的身份…` 前缀是 prompt 契约,`display.ts` / `title.ts` / `EventItem` 都靠正则匹配它;源码注释保持中文。
  - 自检:`grep -nP '[\x{4e00}-\x{9fff}]' src/**/*.tsx` 命中的应该只有注释。
- 新增 agent 或 CLI 参数:必须同时覆盖 agent 列表、@mention、群聊成员、单聊默认 agent、streaming 状态、权限/模型 picker、设置页检测状态。
- 复用优先级:先抽到共享组件或共享常量;只有页面确有不同信息架构时才允许局部差异,并在代码注释里说明原因。
- 提交前至少人工走查两个入口:一个原生 session 详情页的单聊 composer,一个 cockpit 群聊页的 composer/agent 列表。

如果某次改动故意只影响一种模式,PR/提交说明必须写清楚"为什么不影响另一种模式"。

## 技术栈与命令

Vite + React 19 + TypeScript,Vite middleware 后端,SSE,Tailwind v4,`react-markdown` + `shiki`,`@tanstack/react-virtual`,无数据库。可选 Electron。

```bash
pnpm dev              # 浏览器开发,http://localhost:5173
pnpm electron:dev      # Electron 桌面壳
pnpm test              # server/ 与 electron/ 单测(tsx --test)
pnpm typecheck         # tsc -b --noEmit
pnpm electron:build    # 打当前平台安装包(另有 :mac / :win / :linux)
```

`claude` / `codex` / `opencode` / `cursor-agent` 是作为子进程调用的运行时依赖(需要本机已装并登录),不是 npm 包。
例外:Claude 与 OpenCode 的深集成路径确实装了官方 SDK(`@anthropic-ai/claude-agent-sdk`、`@opencode-ai/sdk`),
但它们内部仍然驱动本机 CLI/runtime 的登录态,cockpit 不接管 OAuth 或 provider API key(详见 docs/10)。

## 核心约束

完整版见 `docs/01 §十二`。

1. cockpit 不直接写、删、改原生 CLI 文件;自身数据只写 `~/.cockpit/`。
2. Native resume 只能由官方 CLI 子进程写回,且必须用户显式选择。
3. 事件顺序按文件 append 顺序;跨来源只在 `followup_boundary` 拼接,不按 `ts` 重排。
4. UI 只消费 `NormalizedEvent` / `EventEnvelope`,不解析原生 schema。
5. Loader best-effort;坏行降级 warning/meta,不能阻断 session。
6. Adapter 必须走 `serializeForAgent`,不直接喂原始 events。
7. `:id` 解析路径前必须校验并限制在白名单根目录。
8. API key 不进前端 bundle;follow-up 默认只读并过滤敏感路径。
9. cockpit 事件必须带 `origin`;follow-up/group 带 `turnId`;adapter stream 带 `runId`。
10. 扩展只能加可选字段/方法;破坏 interface 先改设计。
11. 本地 HTTP API 必须经过 `cockpitApi()` 的 loopback/origin guard,新增路由不得绕过。

## 数据落盘位置(都在 `~/.cockpit/`)

| 类型 | 路径 |
|---|---|
| 单 session follow-up | `~/.cockpit/threads/<src>/<id>/{followups.jsonl, summary.md, context-state.json, attachments/}` |
| 群聊 | `~/.cockpit/group-threads/<id>/{transcript.jsonl, summary.md, state.json, attachments/}` |
| Review Room | 复用群聊目录,额外一个 `~/.cockpit/group-threads/<id>/review-state.json`(阶段 / 轮次 / issueSet / 人工状态) |
| Handoff | `~/.cockpit/handoffs/<id>/{manifest.json, *.md}` |
| 后台运行 | `~/.cockpit/runs/index.jsonl`,native resume 影子日志 `~/.cockpit/runs/native-shadow/<src>/<id>/<runId>.jsonl` |
| 逐操作审批 | `~/.cockpit/approvals/<approvalId>.json`(docs/09) |
| Provider thread 链接(Phase 2 opt-in) | `~/.cockpit/runtime-links/{codex,claude}.jsonl` |
| discovery 缓存 | `~/.cockpit/cache/`(可删可重建) |
| 应用设置 | `~/.cockpit/settings.json`(主题、语言、agent、模型、推理强度、界面偏好) |

群聊附件(图片)落 `group-threads/<id>/attachments/`,**不进原生 CLI 目录**;`file`/`directory` 附件只校验存在性,不复制。
