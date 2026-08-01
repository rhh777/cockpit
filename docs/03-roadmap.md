# 03 — 当前能力与后续方向

这份文档只描述 cockpit 当前对外呈现的能力、明确边界和后续可能扩展。实现细节以 `docs/01-architecture.md` 为准;agent adapter 设计见 `docs/08-agent-adapters-design.md`。

## 当前能力

### Session Viewer

- 扫描本机 Claude Code / Codex CLI / Cursor Agent CLI 的原生 JSONL 会话,以及 OpenCode CLI 的 SQLite 会话库。
- 在统一 timeline 中渲染 user / assistant / thinking / tool_use / tool_result / usage / meta 等事件。
- 按原始文件行序展示,不按 timestamp 全局重排。
- loader best-effort:坏行或未知 schema 不阻塞整页打开,通过 warning/meta 暴露。
- 支持 tool activity summary、timeline filter、warning 展示、长列表虚拟化。
- 支持 Codex `apply_patch` diff 渲染。

### Follow-up

- 在任一原生 session 后继续提问,每条消息可发给 Claude、Codex、OpenCode 或 Cursor。
- Follow-up 历史写入 `~/.cockpit/threads/<source>/<id>/followups.jsonl`,不直接写原生 CLI 文件。
- 上下文由原始 session + 既有 follow-up + 当前请求序列化而来。
- Adapter 通过本机已安装并登录的 CLI 子进程运行,不接管账号、token 或网页登录态。
- 生成过程通过 SSE 流式回显,同时落盘;完成、失败、取消都会追加 `turn_status`。
- 默认只读运行:Codex 使用 read-only sandbox,Claude 限制写入/执行类工具,OpenCode SDK session 自动放行只读工具并对写入/执行类工具询问,Cursor 使用 `ask` mode。
- 权限是 run 级三档(ask / auto-safe / full-access),由用户在 composer 显式选择,不跨 run 继承;ask 档下写盘/shell 等操作由 agent runtime 发起审批请求,经 SSE 推给前端审批卡片(见 `docs/09-approval-and-write-access.md`)。
- 序列化输入与 tool_result 落盘/回显前都会做敏感路径过滤。
- OpenCode 与 Cursor Agent CLI 都可作为只读原生 session 来源;Cursor 原生续写仍未接入。

### Native Resume

- 用户可显式切到「回到原会话」模式,让官方 CLI 子进程续写原生 session。
- cockpit 进程不直接改写原生 JSONL,只负责启动官方 CLI、转发 SSE、结束后重读原生历史。
- 该模式只对同源原生 session 开放:Claude session 回 Claude,Codex session 回 Codex,OpenCode session 回 OpenCode。
- Cursor 只作为只读来源,暂不支持原生续写。
- 支持哪些来源由 adapter 的 `canResumeNative` 声明,不在路由层写 source 白名单(docs/01 §十)。
- `@mention` 多 agent 拆分在该模式下关闭,避免把群聊语义混入原生历史。

### Group Thread

- 支持 cockpit 自建群聊 thread,数据写入 `~/.cockpit/group-threads/<id>/`。
- 一条消息可通过 `@claude @codex @opencode @cursor` 并行唤醒多个 agent。
- 群聊维护 `transcript.jsonl`、`summary.md`、`state.json` 和图片附件目录。
- 图片附件复制到 cockpit 自己的附件目录;file/directory 附件只校验存在性,不复制。
- 同一 group thread 中有 agent run 未完成时,新的唤醒型消息会被拒绝,避免上下文快照落在半完成输出中间。

### 接力讨论(Serial Discussion)

- 群聊除并行模式外还有**接力模式**:一次只有一个 agent 发言,靠回复末尾的 `Next:` / `Status:` 协议块交棒。
- composer 可选参与成员子集、首位 agent、最大发言数、讨论策略 preset(架构先行 / 实现先行 / 双向审稿)。
- 缺协议块时向同一 agent 补问一次;仍失败才以 `protocol-missing` 终止,补问不占发言预算。
- 接力轮走 group turn 级 stream(`GET /api/group-threads/:id/turns/:groupTurnId/stream`),
  step 1..N 的 runId 都从 `serial_step` 消息下发。
- 详细设计与逐项进度见 `docs/13-serial-agent-discussion-design.md`。

### Review Room

- 把一个 repo / 目录 / 文件集 / 文档 / 已有 session / 自由文本作为评审来源,建成工作流化的群聊。
- 阶段:draft → review → compare → fix → verify → done,并可派生 fresh review 子房间。
- review 轮可并行或接力;findings 由 agent 回复末尾的 `FINDINGS` JSON 块**确定性解析**,不额外调 LLM。
- compare 视图聚类共识项与分歧项,issue 状态可派生也可人工覆盖(`open` / `fixed` / `wontfix` / `needs-check`)。
- **fix 阶段强制单 writer**,不允许多 agent 并行写盘;verify 默认换另一位 participant 复核。
- 来源快照过期会检测并提示;状态落 `~/.cockpit/group-threads/<id>/review-state.json`。
- 详细设计与逐项进度见 `docs/14-review-room-workflow-design.md`。

### 设置

- 主题(system / light / dark)、语言、字号、默认 agent、启用的 agent 列表、三栏宽度等界面偏好。
- 各 agent 的模型与推理强度从本机 CLI 发现,可按 agent 保存默认值。
- 统一持久化到 `~/.cockpit/settings.json`;首次升级会迁移旧 localStorage 设置。
- 设置页有 agent 可用性 diagnostics。

### Realtime

- Session 详情页通过 `GET /api/sessions/:source/:id/stream?since=N`(SSE)订阅增量;`GET /api/sessions/:source/:id/changes?sinceEventCount=N` 提供一次性 JSON 轮询兜底。
- 后端通过 `fs.watch` 监听原生 JSONL 与 cockpit follow-up JSONL,多个前端订阅共享 watcher。
- 只推 `append`/`reset` 增量,不反复回传完整 session。
- 如果原生历史在 `followup_boundary` 前增长,服务端推 `reset`,前端重拉全量,保证 timeline 顺序正确。

### 后台运行(Background Runs)

- Agent run 由 `RunRegistry` 托管,页面切走 / SSE 断开后仍会继续跑;重新打开可 attach 回既有 runId。
- 相关端点:`GET/POST /api/sessions/:src/:id/runs`、`POST /api/native/:src/:id/runs`、`POST /api/group-threads/:id/runs`、SSE `GET /api/runs/:runId/stream`。
- native resume 的影子日志落 `~/.cockpit/runs/native-shadow/<src>/<id>/<runId>.jsonl`。
- 详细设计见 `docs/06-background-runs-design.md`。

### Desktop

- 浏览器形态用 `pnpm dev`。
- Electron 桌面壳用 `pnpm electron:dev`,生产包用 `pnpm electron:build`。
- 桌面壳与浏览器形态共用同一套 React UI 和 server middleware。
- 本地 API 校验 loopback Host 与浏览器同源 mutation;Electron 限制静态文件目录、跨 origin 导航和可外开的 URL scheme。

## 当前不做

- 不接 Claude Desktop IndexedDB;Claude Desktop 通过 Claude Code 产生的会话统一从 `~/.claude/projects/` 读取。
- 不抓取网页登录态、不复用 cookie/token、不实现非官方 OAuth。
- 不接管官方 CLI 账号凭证;模型请求由本机官方 CLI 自己处理。
- 普通 follow-up 不写入原生 Claude/Codex 历史;写回历史必须显式选择 Native Resume。
- Cursor 只扫描公开的 Agent CLI transcript JSONL 与 meta.json;不读取 Cursor IDE 项目数据库或 chat `store.db`。
- 不默认允许 follow-up agent 写盘;写权限必须由用户为该 run 显式选择权限档位,ask 档逐操作审批(docs/09)。diff 展示与回滚边界未实现。
- 不做 prompt 语义预审批;审批只由 agent runtime 实际发起的 operation 触发。
- 不做产物/补丁管理:Review Room 已能把 findings 结构化成 issue set,但 patch、报告、导出文件仍只是 timeline 里的 markdown。
- 不做跨 session 全文搜索。

## 关键风险与约束

| 风险 | 当前策略 |
|---|---|
| Claude/Codex JSONL 或 OpenCode SQLite schema 变化 | Loader best-effort + `meta` 兜底 + fixture 回归测试 |
| timestamp 同毫秒碰撞导致事件错序 | 事件顺序只认文件行序,跨来源只在 `followup_boundary` 处拼接 |
| `:id` 路由参数路径穿越 | 先校验 id 形态,再确认最终路径落在白名单根目录 |
| CLI 未安装或未登录 | Adapter 启动前检测命令,设置页 diagnostics 暴露可用性 |
| CLI 参数或输出格式变化 | Adapter 尽量结构化解析,失败时降级为 assistant_text/meta;OpenCode 走官方 SDK event,并因历史兼容保留 JSON parser 测试;Cursor 走宽松 JSON event parser |
| read-only agent 主动读取敏感文件并写进回复 | 敏感路径过滤 + 默认只读;真正按路径 deny 需要后续沙箱/审批层 |
| Follow-up 与原始 session 同时增长 | 原生历史在 boundary 前增长时触发 reset,前端全量重拉 |
| SSE 与落盘 watcher 重复推同一事件 | 前端按 `sourceEventId` 去重;有活跃 follow-up SSE 时暂停该 session watcher 订阅 |
| 半截生成无法判断状态 | 每轮都有 `turnId/runId`,完成/取消/失败都 append `turn_status` |
| API key 泄进前端 bundle | 当前 CLI adapter 不需要 API key;未来 API Key Adapter 也只能在 server 侧读环境变量 |

## 后续方向

按可能价值排序,不是承诺排期:

| 方向 | 说明 |
|---|---|
| 原生 Handoff Phase 2+ | Codex app-server 复用与 Claude runtime thread 复用(见 docs/07 / docs/11) |
| 审批层增强 | 基础三档权限与逐操作审批已实现(docs/09);待做:网络/MCP 细粒度 policy 面板、审批时 diff 展示、回滚边界、Claude CLI hook 备份路径 |
| 产物/补丁管理 | 把 patch、报告、导出文件等从普通 markdown 回复中结构化管理 |
| 全文搜索 | 跨 Claude/Codex/cockpit 会话搜索标题、正文、工具调用和路径 |
| 新 session 来源 | OpenCode / Cursor 已接入;待接:Cline、Aider 等本地 agent 工具的历史格式 |
| 新 agent adapter | 已接:claude / codex / opencode / cursor;待接:Qwen Code、Goose、本地模型、官方 API Key adapter |
| Review Room 增强 | 结构化 task 管理、产物导出、fresh review 之外的多轮回归 |
| 接力讨论 Phase 3 剩余项 | 从文档附件建接力模板、运行中手动插队、到达发言上限时自动生成分歧摘要(docs/13) |
| 会话笔记/标签 | 在 `~/.cockpit/annotations/` 旁挂用户自己的轻量标注 |
| 分支可视化 | 利用 Claude `parentUuid` 等字段展示非线性对话分支 |
| 中立 review 模式 | 允许 Claude review 时不读取项目级 CLAUDE.md 等本地规则 |
| 导出 | 将原始 session + follow-up/group thread 导出为 Markdown 或 HTML |
