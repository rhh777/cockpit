# cockpit

> **查看、续聊、调度 Claude Code / Codex CLI 会话。**

## 这是什么

`cockpit` 是本地 AI CLI 会话查看器与协作控制台。

- 查看 Claude Code / Codex CLI 的完整会话 timeline。
- 基于原会话发起跨 agent follow-up、review 或群聊。
- 将 cockpit 产生的数据保存到 `~/.cockpit/`,不直接改写原生 CLI 文件。

Follow-up agent 默认只读。「回到原会话」模式只通过官方 CLI 子进程写入原生历史。

## 范围

**当前能力:** timeline · follow-up · 群聊 · 原生 resume · 实时刷新 · patch diff · 会话筛选 · 附件 · 模型设置 · Electron。

**未做:** follow-up 写盘审批 · 产物/补丁管理 · 自动编排 · 后台运行 · 全文搜索。

详见 `docs/01-architecture.md §十四`。

## 文档

- `docs/01-architecture.md` — 系统架构、数据流、模块划分、扩展点、设计不变量
- `docs/02-session-formats.md` — Claude / Codex 会话文件格式实测
- `docs/03-roadmap.md` — 当前能力、边界与后续方向
- `docs/04-ui-design.md` — UI 视觉与交互规范
- `docs/05-group-chat-design.md` — 群聊模式(@mention 并行调度、shared summary)
- `docs/06-background-runs-design.md` — 后台运行设计(未实现)

## 快速开始

### 系统要求

- **Node.js ≥ 20**,**pnpm ≥ 9**
- 本机已安装并登录的 **Claude Code CLI**(`claude`)和/或 **Codex CLI**(`codex`)—— 它们是 follow-up 功能的运行时依赖(作为子进程调用),不是 npm 包。只读 viewer 模式不需要它们。

### 运行

```bash
pnpm install
pnpm dev
```

### 测试与构建

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # server 侧单测
pnpm build        # 前端生产构建
pnpm electron:dev # Electron 开发模式
pnpm electron:build
```

## 技术栈

Vite + React 19 + TypeScript,Node 后端以 Vite middleware 同进程运行。流式用 SSE,样式用 Tailwind v4,Markdown/代码渲染用 `react-markdown` + `shiki`。无数据库。

## 设计原则

1. **直接读原生路径** — session 来源是 `~/.claude/projects/` 和 `~/.codex/sessions/`;`~/.cockpit/cache` 只做可删索引。
2. **格式 best-effort** — Claude / Codex 的 JSONL schema 非官方 spec,会迭代。loader 忽略未知字段、新 type 加 fallback,不阻塞渲染。
3. **零侵入** — 不修改原生 CLI 的任何文件,只读(「回到原会话」由官方 CLI 子进程自己写,cockpit 不改写字节)。
4. **默认只读 + 可追溯** — follow-up agent 默认 read-only;cockpit 自己产生的事件带 `turnId`/`runId`/`origin`,完成、取消、失败都有 terminal status。
5. **轻** — Vite + React,无 DB,无独立后端服务。可选 Electron 桌面壳共用同一份代码。

## 贡献

欢迎提 Issue 和 PR。开发约定见 `CLAUDE.md` 与 `docs/`。跑通测试与类型检查后再提交:

```bash
pnpm typecheck && pnpm test
```

## 许可证

[MIT](./LICENSE) © haorenhui
