# 贡献指南

感谢你考虑为 cockpit 贡献代码!这是一个本地优先的小工具,欢迎 Issue、PR、文档改进和新 loader/agent 适配。

## 开发准备

需要 **Node.js ≥ 20** 和 **pnpm ≥ 9**,以及本机已安装并登录的 Claude Code / Codex CLI(follow-up 功能作为子进程调用它们)。

```bash
pnpm install
pnpm dev              # 浏览器开发,http://localhost:5173
pnpm electron:dev     # Electron 桌面壳
```

## 提交前必跑

```bash
pnpm typecheck && pnpm test
```

类型检查或测试不通过请勿提交 PR。

## 代码约定

- **先读文档再动手**:`docs/01-architecture.md` 是契约,尤其 §十二「设计不变量」和 §十「安全」—— 这是「善意改动」最容易踩破的地方。
- **UI 永不解析原生 Claude/Codex schema**:只消费 `NormalizedEvent` / `EventEnvelope`。新增 source/agent 通过实现 `SessionSourceLoader` / 适配器 interface,不在 UI/server 里硬编码 `if (source === '...')` 分支。
- **零直接写入原生 CLI 文件**:所有 cockpit 自身数据放 `~/.cockpit/`。「回到原会话」模式也只能由官方 CLI 子进程自己 append,cockpit 不直接改写原生 JSONL。
- **Loader 必须 best-effort**:单行坏 JSON 不能让整个 session 打不开,未知字段降级为 `meta`。
- 代码风格、注释密度跟随周围代码。中文文档保持中文。

## 提交规范

提交信息使用约定式提交(Conventional Commits),例如:

```
feat(composer): 支持多 agent @mention 拆分
fix(loader): codex function_call arguments 解析失败时降级为 meta
docs: 补充群聊设计文档
```

## 新增来源 / agent

新增 session 来源请参考 `docs/02-session-formats.md`,实现 `SessionSourceLoader`,产出统一的 `NormalizedEvent[]` + `SessionSummary`。新增可调用 agent 则实现 `ReviewAgent`,注册到 `server/adapters/registry.ts`,并按 `AGENTS.md` 的 UI 同步清单接入共享 agent 列表、图标、模型/权限选择、@mention 和运行状态。来源与 agent 是两条独立扩展路径,不要只写 loader 后在 UI/server 硬编码名称。

## 报告问题

提 Issue 时请附:cockpit 版本、Node/pnpm 版本、本机 CLI 版本(`claude --version` / `codex --version`)、复现步骤。**不要**贴出未脱敏的真实会话 JSONL——`~/.claude/projects/` 和 `~/.codex/sessions/` 里可能含敏感代码。
