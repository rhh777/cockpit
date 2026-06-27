# CLAUDE.md

This file gives guidance to anyone working in this repository (Claude Code or otherwise). Read it before changing anything.

## 这是什么

`cockpit` 是本地 AI CLI 会话查看器与协作控制台。

- 读取 Claude Code / Codex CLI 原生会话并渲染 timeline。
- 在原会话基础上发起跨 agent follow-up、review 或群聊。
- 将 cockpit 数据保存到 `~/.cockpit/`,不直接改写原生 CLI 文件。

「回到原会话」只通过官方 CLI 子进程写入原生历史。

## 代码分布

- `src/` — React 19 前端(三栏布局、timeline、composer)
- `server/` — Vite middleware 后端(loaders / adapters / routes / store / watcher)
- `electron/` — 桌面壳(Tray 常驻)
- `__fixtures__/` — 脱敏的真实 JSONL 样本

**后台运行(`docs/06-background-runs-design.md`)仍是设计稿,未实现**——切换 session 会 abort 当前 CLI 子进程。

## 动手前先读

- `docs/01-architecture.md` — 架构契约、数据流、不变量、安全、扩展点。
- `docs/02-session-formats.md` — Claude / Codex JSONL schema 实测,loader 的事实来源。
- `docs/03-roadmap.md` — 当前能力、边界与后续方向。
- `docs/04-ui-design.md` — UI 视觉/交互规范。
- `docs/05-group-chat-design.md` — 群聊模式(transcript.jsonl + summary.md,@mention 并行调度)。
- `docs/06-background-runs-design.md` — 后台运行(未实现)。

文档记录的是已定决策。

## 技术栈与命令

Vite + React 19 + TypeScript,Vite middleware 后端,SSE,Tailwind v4,`react-markdown` + `shiki`,`@tanstack/react-virtual`,无数据库。可选 Electron。

```bash
pnpm dev              # 浏览器开发,http://localhost:5173
pnpm electron:dev      # Electron 桌面壳
pnpm test              # server 侧单测(tsx --test)
pnpm typecheck         # tsc --noEmit
pnpm electron:build    # 打 macOS dmg
```

`claude` / `codex` 是作为子进程调用的运行时依赖(需要本机已装并登录),不是 npm 包,不装官方 SDK。

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

## 数据落盘位置(都在 `~/.cockpit/`)

| 类型 | 路径 |
|---|---|
| 单 session follow-up | `~/.cockpit/threads/<src>/<id>/followups.jsonl` |
| 群聊 | `~/.cockpit/group-threads/<id>/{transcript.jsonl, summary.md, state.json, attachments/}` |
| discovery 缓存 | `~/.cockpit/cache/`(可删可重建) |

群聊附件(图片)落 `group-threads/<id>/attachments/`,**不进原生 CLI 目录**;`file`/`directory` 附件只校验存在性,不复制。
