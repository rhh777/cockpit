# 03 — 当前能力与后续方向

这份文档只描述 cockpit 当前对外呈现的能力、明确边界和后续可能扩展。实现细节以 `docs/01-architecture.md` 为准;agent adapter 设计见 `docs/08-agent-adapters-design.md`。

## 当前能力

### Session Viewer

- 扫描本机 Claude Code 与 Codex CLI 的原生 JSONL 会话。
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
- 默认只读运行:Codex 使用 read-only sandbox,Claude 限制写入/执行类工具,OpenCode 使用 `plan` agent,Cursor 使用 `ask` mode。
- 序列化输入与 tool_result 落盘/回显前都会做敏感路径过滤。
- OpenCode / Cursor 当前只作为 Cockpit follow-up agent,不作为原生 session 来源。

### Native Resume

- 用户可显式切到「回到原会话」模式,让官方 CLI 子进程续写原生 session。
- cockpit 进程不直接改写原生 JSONL,只负责启动官方 CLI、转发 SSE、结束后重读原生历史。
- 该模式只对同源原生 session 开放:Claude session 只能回到 Claude, Codex session 只能回到 Codex。
- `@mention` 多 agent 拆分在该模式下关闭,避免把群聊语义混入原生历史。

### Group Thread

- 支持 cockpit 自建群聊 thread,数据写入 `~/.cockpit/group-threads/<id>/`。
- 一条消息可通过 `@claude @codex @opencode @cursor` 并行唤醒多个 agent。
- 群聊维护 `transcript.jsonl`、`summary.md`、`state.json` 和图片附件目录。
- 图片附件复制到 cockpit 自己的附件目录;file/directory 附件只校验存在性,不复制。
- 同一 group thread 中有 agent run 未完成时,新的唤醒型消息会被拒绝,避免上下文快照落在半完成输出中间。

### Realtime

- Session 详情页通过 `GET /api/sessions/:source/:id/changes?sinceEventCount=N` 订阅 SSE 增量。
- 后端通过 `fs.watch` 监听原生 JSONL 与 cockpit follow-up JSONL,多个前端订阅共享 watcher。
- 只推 `append`/`reset` 增量,不反复回传完整 session。
- 如果原生历史在 `followup_boundary` 前增长,服务端推 `reset`,前端重拉全量,保证 timeline 顺序正确。

### Desktop

- 浏览器形态用 `pnpm dev`。
- Electron 桌面壳用 `pnpm electron:dev`,生产包用 `pnpm electron:build`。
- 桌面壳与浏览器形态共用同一套 React UI 和 server middleware。

## 当前不做

- 不接 Claude Desktop IndexedDB;Claude Desktop 通过 Claude Code 产生的会话统一从 `~/.claude/projects/` 读取。
- 不抓取网页登录态、不复用 cookie/token、不实现非官方 OAuth。
- 不接管官方 CLI 账号凭证;模型请求由本机官方 CLI 自己处理。
- 普通 follow-up 不写入原生 Claude/Codex 历史;写回历史必须显式选择 Native Resume。
- 不扫描 OpenCode / Cursor 的原生历史或项目数据库;它们当前只作为可调用 adapter。
- 不允许 follow-up agent 写盘;写权限与审批层留作后续扩展。
- 不做产物/补丁管理,review 输出目前仍是 timeline 中的 markdown。
- 不做跨 session 全文搜索。
- 不做后台运行:当前页面切走或连接关闭会 abort 对应 CLI 子进程。设计见 `docs/06-background-runs-design.md`。

## 关键风险与约束

| 风险 | 当前策略 |
|---|---|
| Claude/Codex JSONL schema 变化 | Loader best-effort + `meta` 兜底 + fixture 回归测试 |
| timestamp 同毫秒碰撞导致事件错序 | 事件顺序只认文件行序,跨来源只在 `followup_boundary` 处拼接 |
| `:id` 路由参数路径穿越 | 先校验 id 形态,再确认最终路径落在白名单根目录 |
| CLI 未安装或未登录 | Adapter 启动前检测命令,设置页 diagnostics 暴露可用性 |
| CLI 参数或输出格式变化 | Adapter 尽量结构化解析,失败时降级为 assistant_text/meta;OpenCode/Cursor 走宽松 JSON event parser |
| read-only agent 主动读取敏感文件并写进回复 | 敏感路径过滤 + 默认只读;真正按路径 deny 需要后续沙箱/审批层 |
| Follow-up 与原始 session 同时增长 | 原生历史在 boundary 前增长时触发 reset,前端全量重拉 |
| SSE 与落盘 watcher 重复推同一事件 | 前端按 `sourceEventId` 去重;有活跃 follow-up SSE 时暂停该 session watcher 订阅 |
| 半截生成无法判断状态 | 每轮都有 `turnId/runId`,完成/取消/失败都 append `turn_status` |
| API key 泄进前端 bundle | 当前 CLI adapter 不需要 API key;未来 API Key Adapter 也只能在 server 侧读环境变量 |

## 后续方向

按可能价值排序,不是承诺排期:

| 方向 | 说明 |
|---|---|
| 后台运行与重连 | agent run 脱离页面生命周期,切换 session 后继续跑并可重新 attach |
| 原生 Handoff | 从原生 session 或群聊生成 context bundle,并用 deep link / app-server / CLI 在 Claude 或 Codex 中继续 |
| 写权限与审批层 | 允许 follow-up agent 修改文件,但必须有明确审批、diff 展示和回滚边界 |
| 产物/补丁管理 | 把 patch、报告、导出文件等从普通 markdown 回复中结构化管理 |
| 全文搜索 | 跨 Claude/Codex/cockpit 会话搜索标题、正文、工具调用和路径 |
| 新 session 来源 | 接入 OpenCode / Cursor / Cline / Aider 等本地 agent 工具的历史格式 |
| 新 agent adapter | 接入 Qwen Code、Goose、本地模型、官方 API Key adapter 或其他 CLI agent |
| 会话笔记/标签 | 在 `~/.cockpit/annotations/` 旁挂用户自己的轻量标注 |
| 分支可视化 | 利用 Claude `parentUuid` 等字段展示非线性对话分支 |
| 中立 review 模式 | 允许 Claude review 时不读取项目级 CLAUDE.md 等本地规则 |
| 导出 | 将原始 session + follow-up/group thread 导出为 Markdown 或 HTML |
