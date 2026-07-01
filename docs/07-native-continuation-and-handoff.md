# 07 — 原生会话延续与 Handoff 设计

## 定位

本文定义 Cockpit 中几类会话转换动作:

- 从 Claude/Codex 原生 session 创建 Cockpit 群聊。
- 从 Cockpit 单聊或群聊继续到 Codex/Claude。
- 从 Cockpit 打开或创建原生 Codex/Claude 会话。
- 用 context bundle 保留上下文,避免依赖完美原生同步。

核心原则:

- **群聊属于 Cockpit**,不是 Claude/Codex 原生 session。
- **继续是 fork/continuation**,不破坏来源 session。
- **打开原生工具是 bridge**,不是事实源迁移。
- **上下文事实源在 Cockpit**,原生 thread 只保存自己的后续历史或入口 prompt。
- **Handoff 默认是一次性快照**,source 后续变化只让 handoff 变 stale,不会自动变成活引用。

## 术语

| 名称 | 含义 |
|---|---|
| Source session | 已存在的 Claude/Codex 原生 session,或 Cockpit follow-up/group thread |
| Group thread | Cockpit 自己维护的群聊 thread,见 `docs/05-group-chat-design.md` |
| Continuation | 从一个 source session 派生出的后续工作入口 |
| Native thread | Codex/Claude 原生客户端里的会话 |
| Context bundle | Cockpit 生成的上下文快照文件集合,供 agent 读取 |
| Handoff entry | 面向某个 provider 的入口文件,由 context bundle 派生 |
| Handoff prompt | 发给原生 agent 的短 prompt,通常指向 handoff entry |
| Native link | Cockpit 保存的原生 thread/deep link 映射 |

## 非目标

- 不把群聊完整镜像到 `~/.claude/projects/` 或 `~/.codex/sessions/`。
- 不直接编辑 Claude/Codex 原生 JSONL。
- 不承诺 Claude/Codex 原生客户端里能看到完整 Cockpit 群聊历史。
- 不在同一个群聊轮次中让多个 agent 同时写文件。
- 不把用户已有的原生日常 session 改造成群聊。

## 操作语义

### 转为群聊

从当前 session 创建一个 Cockpit group thread。

```
Claude/Codex native session
  -> create Cockpit group thread
  -> import summary + recent transcript
  -> add participants
  -> source session unchanged
```

规则:

- 默认新建 `~/.cockpit/group-threads/<groupId>/`。
- 记录 `source_links`,但不写回原生 session。
- 首次创建时生成 `summary.md` 和 context bundle。
- 当前 agent 可作为 group participant,但它的原生 session 不会成为群聊事实源。

### 拉 Claude/Codex 进来

这是 participant 管理动作。

- 当前是 solo/follow-up 时,等价于创建 group thread 并加入目标 agent。
- 当前已经是 group thread 时,只更新 group participants。
- 无 `@mention` 时不自动唤醒新增 agent。

### 和 Codex 继续

创建一个 Codex continuation。

```
source session
  -> generate context bundle
  -> create/open Codex entry
  -> save native link if available
```

有三种执行等级:

| 等级 | 入口 | 能力 | 适用 |
|---|---|---|---|
| `deeplink` | `codex://threads/new?path=&prompt=` | 打开 Codex Desktop 新 thread,预填 prompt | MVP |
| `app-server` | `codex app-server` JSON-RPC | 创建 thread、发送 turn、流式事件、拿到 thread id | 深集成 |
| `cli` | `codex` / `codex exec` / `codex resume` | 后台执行或终端执行 | 自动化/无桌面 |

推荐优先级:

1. 用户明确要去原生桌面端: `deeplink`。
2. Cockpit 要驱动和展示运行过程: `app-server`。
3. 非交互脚本或 app-server 不可用: `cli`。

### 和 Claude 继续

创建一个 Claude continuation。

```
source session
  -> generate context bundle
  -> open Claude Desktop / Claude Code entry when possible
  -> fallback to prompt copy/upload
```

Claude 侧能力需要按本机实际支持检测:

- MVP 默认返回 manual prompt,由用户复制/粘贴或作为附件内容发送。
- 只有 handoff prompt 足够短、且确认本机支持 `claude://...` 时,才尝试 deep link。
- 如果支持 Claude Code CLI resume/new,可用 CLI 启动或恢复。
- 如果无法让 Claude 直接读本地文件,将 `handoff.claude.md` 内容作为首条消息或附件内容。

Claude 和 Codex 不需要做成对称能力。Codex 可以通过 workspace path 读取 bundle;Claude Desktop 可能不能读本地文件,而 `claude://` URL 又有长度上限,所以 Claude 的默认路径必须是可复制的 self-contained prompt。

## 类型来源

| 类型 | 出处 |
|---|---|
| `Source` | `server/loaders/types.ts` |
| `AgentName` | `server/loaders/types.ts` |
| `SessionSummary` | `server/loaders/types.ts` |
| `NormalizedEvent` / `EventEnvelope` | `server/loaders/types.ts` |
| `RunRegistry` | `server/runs/run-registry.ts` |

handoff 层禁止重新声明这些类型,只能 import。新增结构(`HandoffManifest` / `NativeLink` 等)放在 `server/handoffs/types.ts`。

## 存储结构

### Context bundle

推荐放在 source 所属 Cockpit 目录下:

```txt
~/.cockpit/handoffs/<handoffId>/
  manifest.json
  summary.md
  transcript.md
  decisions.md
  task_state.md
  file_refs.md
  handoff.codex.md
  handoff.claude.md
```

如果 source 是 group thread,也可在 group 目录中保留引用:

```txt
~/.cockpit/group-threads/<groupId>/
  handoffs/<handoffId> -> ~/.cockpit/handoffs/<handoffId>
```

`manifest.json`:

```ts
interface HandoffSourceSnapshot {
  sourceUpdatedAt: string | null
  sourceEventCount: number | null
  summaryRevision?: number
  fileMtimeMs?: number
}

interface HandoffManifest {
  handoffId: string
  source: {
    kind: 'native-session' | 'cockpit-followup' | 'group-thread'
    source?: Source
    sessionId?: string
    groupThreadId?: string
  }
  createdAt: string
  cwd: string | null
  title: string
  snapshotMode: 'snapshot'
  sourceSnapshot: HandoffSourceSnapshot
  files: {
    canonical: {
      summary: string
      transcript: string
      decisions: string
      taskState: string
      fileRefs: string
    }
    entries: {
      codex: string
      claude: string
    }
  }
  nativeLinks: NativeLink[]
}

interface HandoffDetail extends HandoffManifest {
  freshness: {
    status: 'fresh' | 'stale' | 'unknown'
    staleSince?: string
    reason?: string
  }
}
```

规则:

- `snapshotMode` 固定为 `snapshot`。Phase 1/2 不支持 live reference。
- `sourceSnapshot` 记录创建 handoff 时的 source 指纹。
- `GET /api/handoffs/:handoffId` 可重新读取 source 并计算 `freshness`。
- source 在 handoff 创建后继续增长时,旧 handoff 只标记 stale。
- `刷新 handoff` 默认创建新的 `handoffId`;不要原地静默改写旧快照。
- `files.canonical` 是唯一上下文事实源;`files.entries` 是可再生成的 provider 入口产物。

### Native link

```ts
type NativeLinkLevel = 'none' | 'linked' | 'mirrored'
type NativeProvider = 'codex' | 'claude'
type NativeOpenMethod = 'deeplink' | 'app-server' | 'cli' | 'manual'

interface NativeLink {
  id: string
  provider: NativeProvider
  handoffId: string
  createdAt: string
  method: NativeOpenMethod
  linkLevel: NativeLinkLevel
  nativeThreadId?: string
  runId?: string
  url?: string
  cwd?: string | null
  status: 'created' | 'opened' | 'failed'
  error?: string
}
```

含义:

- `method`: 入口方式,描述 Cockpit 怎么打开或启动原生工具。
- `linkLevel='none'`: 没拿到原生 thread id,例如 manual prompt 或仅打开 deep link。
- `linkLevel='linked'`: Cockpit 知道原生 thread id,可再次打开。
- `linkLevel='mirrored'`: 未来能力,表示 Cockpit 和原生 thread 做增量同步。即使 mirrored,Cockpit group thread 仍是群聊事实源,原生 thread 不反向成为事实源。

## Handoff 生命周期

Handoff 在 Phase 1/2 是一次性快照。

```
source session at T1
  -> create handoff H1
  -> source session continues at T2
  -> H1 becomes stale
  -> user can create handoff H2
```

规则:

- 创建后不自动追随 source session。
- source 继续增长时,旧 handoff 仍可打开,但 UI 应显示 stale。
- stale 判断基于 `sourceSnapshot` 与当前 source 的 `updatedAt` / event count / summary revision。
- 原生 session loader 当前对 `eventCount` 不保证稳定(loader 会跳过坏行),所以 `sourceEventCount` 允许为 `null`;只要 `sourceUpdatedAt` 或 `fileMtimeMs` 有一个比 snapshot 新,就判 stale。
- group thread / follow-up 来源使用 transcript 行数作为 `sourceEventCount`,这一路是稳定的。
- 刷新 handoff 默认创建新 handoff,并继承旧 handoff 的 target/provider 选择。
- 原生 NativeLink 指向创建它时使用的 handoff;刷新后不会偷偷把旧原生 thread 改绑到新 handoff。

## Context bundle 内容

Context bundle 分两类文件:

- `summary.md`、`transcript.md`、`decisions.md`、`task_state.md`、`file_refs.md` 是 canonical files。
- `handoff.codex.md`、`handoff.claude.md` 是 provider entries,必须由 canonical files 生成,不要作为新的事实源编辑。

刷新策略:

- 更新上下文时先生成新的 canonical snapshot。
- 再从 canonical snapshot 重新生成 provider entries。
- 不在多个文件里手写维护同一段 summary/decisions/current request。

### 生成策略

Phase 1/2 全部走**规则抽取 + 截断**,不调用 LLM:

- `summary.md`: 从 source 的 `SessionSummary.title`、首条 user message、最近 user message、最近 assistant message 拼装,字段缺失则留 `_(none)_`。
- `transcript.md`: 直接把 `NormalizedEvent` 序列化为 markdown(`user:` / `assistant:` / `tool:` 块),tool output 超过阈值折叠为 `... (N bytes elided)`。
- `decisions.md` / `task_state.md`: Phase 1 输出 placeholder + `<!-- TODO: human edit -->`,不强行抽取。
- `file_refs.md`: 从 source 的 `cwd`、最近 N 条 `tool_use` 的 path 参数、最近 bash 命令 stdout 摘要构造。

LLM-driven summary 留到 Phase 3,且必须显式触发(`POST /api/handoffs/:id/refresh-summary?mode=llm`),不在默认创建路径里调用。

### summary.md

面向所有 agent 的短摘要。

```md
# Summary

## Goal

## Current State

## Decisions

## Open Questions

## Next Steps
```

### transcript.md

完整或截断后的会话记录。

规则:

- 默认写完整 transcript。
- 大于阈值时写最近 N 条 + 摘要,并在 manifest 标记 `truncated: true`。
- tool output 默认折叠为摘要,避免把巨量日志塞给 agent。

### task_state.md

当前任务状态:

- 已完成。
- 正在进行。
- 阻塞。
- 下一步。
- 需要保留的约束。

### file_refs.md

与任务有关的文件/目录/分支/commit/命令结果摘要。

```md
# File References

- cwd: `/Users/hrh/code/ai/cockpit`
- branch: `...`
- relevant files:
  - `server/routes/group-threads.ts`
  - `docs/05-group-chat-design.md`
- recent commands:
  - `pnpm test`: passed/failed summary
```

### handoff.codex.md

专门给 Codex 的薄入口说明。Codex 通常能读取 workspace 和本地文件,所以 entry 应尽量短,只指向 canonical files。

```md
# Continue In Codex

You are continuing from Cockpit handoff `<handoffId>`.

Read these files first:

1. `<absolute path>/summary.md`
2. `<absolute path>/task_state.md`
3. `<absolute path>/file_refs.md`
4. `<absolute path>/decisions.md`

Only read `transcript.md` if the summary is insufficient.

Workspace:

`<cwd>`

Current request:

...
```

### handoff.claude.md

专门给 Claude 的派生入口说明。Claude 未必能直接读本地文件,因此该文件可以是 self-contained prompt,但它仍然是从 canonical files 注入生成的派生产物,不是第二份事实源。

```md
# Continue In Claude

This handoff was generated by Cockpit.

## Summary

...

## Important Decisions

...

## Current Request

...

## Optional Local Files

If you can access local files, read:

- `<absolute path>/transcript.md`
- `<absolute path>/file_refs.md`
```

生成规则:

- 如果用于 manual prompt 或附件,`handoff.claude.md` 可以包含 summary/decisions/current request 的完整文本。
- 如果用于 deep link,必须先估算编码后 URL 长度;超出安全阈值(`encodeURIComponent(prompt).length > 1800`,给 scheme + 其他 query 预留余量)时返回 manual prompt,不打开 deep link。
- 如果 Claude 环境确认能读本地文件,也可以生成薄入口,但不能把本地文件访问当默认能力。

## API 设计

### 创建群聊

```txt
POST /api/group-threads/from-session
```

```ts
interface CreateGroupFromSessionBody {
  source: Source
  sessionId: string
  agents: AgentName[]
  title?: string
  includeRecentEvents?: number
}
```

返回:

```ts
interface CreateGroupFromSessionResponse {
  groupThreadId: string
  handoffId?: string
}
```

### 创建 handoff

```txt
POST /api/handoffs
GET  /api/handoffs/:handoffId
GET  /api/handoffs/capabilities                       # Phase 3
POST /api/handoffs/:handoffId/refresh                 # Phase 3
POST /api/handoffs/:handoffId/native-links/:linkId/mirror  # Phase 4
POST /api/handoffs/:handoffId/reveal
```

```ts
interface CreateHandoffBody {
  source:
    | { kind: 'native-session'; source: Source; sessionId: string }
    | { kind: 'cockpit-followup'; source: Source; sessionId: string }
    | { kind: 'group-thread'; groupThreadId: string }
  target: 'codex' | 'claude' | 'both'
  currentRequest?: string
  transcriptMode?: 'full' | 'recent' | 'summary-only'
}
```

### 打开原生入口

```txt
POST /api/handoffs/:handoffId/open-native
```

```ts
interface OpenNativeBody {
  provider: 'codex' | 'claude'
  method?: 'auto' | 'deeplink' | 'app-server' | 'cli' | 'manual'
  mode?: 'open-only' | 'start-turn'
}
```

返回:

```ts
interface OpenNativeResponse {
  nativeLink: NativeLink
  fallbackPrompt?: string
}
```

## Codex 实现

### Deep link MVP

构造 URL:

```txt
codex://threads/new?path=<encoded absolute cwd>&prompt=<encoded handoff prompt>
```

规则:

- `path` 必须是绝对目录。
- `prompt` 尽量短,只指向 `handoff.codex.md`。
- 用系统打开 URL,Electron 中可走 `shell.openExternal(url)`。
- 成功打开只能记录 `method='deeplink'`、`linkLevel='none'`,因为此路径通常拿不到 thread id。

Handoff prompt 示例:

```txt
Please continue from this Cockpit handoff.

Read:
/Users/hrh/.cockpit/handoffs/<handoffId>/handoff.codex.md

Workspace:
/Users/hrh/code/ai/cockpit
```

### App-server 进阶

使用 `codex app-server`:

1. 启动或连接 app-server。
2. `initialize`。
3. `thread/start` 创建 thread。
4. 创建 `RunKind='native-continuation'` 的 RunRegistry run。
5. 在该 run 内调用 `turn/start` 发送 handoff prompt。
6. 通过 RunRegistry 流式 fan-out events、处理 cancel/attach/terminal status。
7. 保存 `nativeThreadId`。

成功后:

```json
{
  "provider": "codex",
  "method": "app-server",
  "linkLevel": "linked",
  "nativeThreadId": "019...",
  "runId": "run_..."
}
```

之后可用:

```txt
codex://threads/<nativeThreadId>
```

打开原生桌面端。

### CLI fallback

适合后台自动化:

```bash
codex --cd <cwd> "Please read <handoff.codex.md> and continue."
codex exec --cd <cwd> "Please read <handoff.codex.md> and continue."
```

如果已知 thread id:

```bash
codex resume <SESSION_ID>
codex exec resume <SESSION_ID> "Continue from <handoff.codex.md>"
```

CLI 路径可能生成原生 session 文件,但 Cockpit 不应直接写这些文件。

## Claude 实现

Claude 实现必须能力检测,不要假设所有环境都有相同 deep link/CLI。

MVP 推荐:

1. 生成 `handoff.claude.md`。
2. 返回 self-contained manual prompt。
3. 如果 prompt 很短且检测到 `claude://` 可用,才提供 `Open in Claude` deep link。

### Deep link

如果检测到 Claude Desktop 支持 URL scheme:

```txt
claude://...
```

则打开新会话并带上 `handoff.claude.md` 的摘要或文件路径。

注意:

- Claude 桌面端未必能读取本地文件路径。
- `claude://` URL 长度有限,不能承载长 transcript 或完整 bundle。
- 如果不能读文件,把 `handoff.claude.md` 内容作为 manual prompt 或附件。
- 如果无法确认 conversation id,只记录 `method='deeplink'`、`linkLevel='none'`。
- deep link 不是 Claude 路径默认入口;它只是短 prompt 的便利打开方式。

### Claude Code CLI

如果本机有 `claude` CLI:

```bash
claude "<handoff prompt>"
```

如果 CLI 支持 resume:

```bash
claude --resume <session>
```

此路径只作为 continuation 启动方式,不直接写 `~/.claude/projects`。

## 前端 UX

### Session 详情页动作

在 Claude/Codex 原生 session 或 Cockpit follow-up 上:

- `转为群聊`
- `和 Codex 继续`
- `和 Claude 继续`
- `生成 Handoff`

在 group thread 上:

- `邀请 Claude`
- `邀请 Codex`
- `和 Codex 单独继续`
- `和 Claude 单独继续`
- `打开 Handoff 文件夹`

### 推荐交互

`和 Codex 继续`:

1. 创建 handoff。
2. 默认用 deep link 打开 Codex Desktop。
3. 如果用户启用 deep integration,改用 app-server 创建 thread。
4. UI 展示 native link 状态。

`和 Claude 继续`:

1. 创建 handoff。
2. 默认展示一条可发送的 manual prompt。
3. 如果内容足够短且检测到 Claude deep link 可用,额外显示 `Open in Claude`。
4. 如果 Claude 环境能读取本地文件,manual prompt 可以降级为薄入口;否则保持 self-contained。

`转为群聊`:

1. 创建 group thread。
2. 从 source session 生成 summary。
3. 跳转到 group thread。
4. source session 保持只读不变。

## 安全与隐私

- Handoff 文件可能包含敏感上下文,默认放 `~/.cockpit/handoffs`。
- 所有文件路径写入 handoff 前必须经过 sensitive filtering,复用 follow-up 链路里已有的过滤函数(`server/adapters` 下,实现时确认入口位置,不要复制一份)。
- ContextBuilder 输出每个 markdown 前都过一次过滤,**不要只在最外层 manifest 过**。
- 打开 deep link 前必须显示目标 provider 和 cwd。
- `path` 只能使用本地绝对目录,不可从前端任意传入后直接拼接。
- `cwd` / `path` 必须由后端从 source session、group thread state 或 registry 解析得出;前端只能选择 source,不能提交任意 cwd。
- 不要把 secret 原样写入 `transcript.md`;tool output 要折叠。
- 不直接修改 `~/.claude` / `~/.codex` 原生会话文件。
- 删除 group thread 时不要默认删除 handoff,除非用户确认。

## 实现拆分

### 1. HandoffStore

- 创建 `~/.cockpit/handoffs/<handoffId>`。
- 写 `manifest.json` 和 markdown 文件。
- 读取 handoff detail。
- 更新 native links。

### 2. ContextBuilder

- 从 native session、follow-up、group thread 构造统一上下文。
- 复用现有 loaders 和 group transcript。
- 输出 summary/transcript/decisions/task_state/file_refs。

### 3. NativeOpenService

- Codex deep link builder。
- Codex app-server worker,必须通过 RunRegistry 执行。
- Codex CLI fallback。
- Claude deep link builder。
- Claude CLI fallback。
- 能力检测和降级。

### 3.1 RunRegistry integration

- `method='app-server'` 且 `mode='start-turn'` 时创建 `native-continuation` run。
- run 负责 app-server event fan-out、attach、cancel 和 terminal status。
- NativeOpenService 只负责启动 worker 和保存 NativeLink,不单独实现一套流式订阅机制。

### 4. Routes

- `POST /api/handoffs`
- `GET /api/handoffs/:handoffId`
- `POST /api/handoffs/:handoffId/open-native`
- `POST /api/group-threads/from-session`

### 5. UI

- Session detail action menu。
- Group thread participant/invite UI。
- Handoff status panel。
- Native link open/retry/fallback prompt。

## 推荐阶段

### Phase 1: 文件 handoff + deep link ✅

- 实现 HandoffStore。
- 实现 handoff snapshot 和 stale 检测。
- 实现 Codex `codex://threads/new?path=&prompt=`。
- Claude 先实现 manual prompt;deep link 只作为短 prompt best-effort。
- 实现 `转为群聊` 创建 Cockpit group thread。

Phase 1 **不做**:

- Codex app-server 集成、RunRegistry `native-continuation` run。
- Claude / Codex CLI fallback。
- NativeLink 持久化(Phase 1 直接在 response 返回临时 `NativeLink`,不写盘)。
- LLM-driven summary / decisions 抽取。
- `Refresh handoff` UI(stale 状态先在 detail 接口里返回,但不提供刷新入口)。

### Phase 2: Codex app-server linked thread ✅

已实现:

- `server/adapters/codex-app-server.ts`:spawn `codex app-server --stdio`,newline-delimited JSON-RPC 2.0 客户端,`translateNotification` 把 ServerNotification 翻译成 `NormalizedEvent`。
- `RunRegistry.startCodexContinuation`:同步 `initialize` + `thread/start` 拿 `threadId` 后返回;后台跑 `turn/start`,事件走 run stream。RunKind 加了 `'native-continuation'`。
- `POST /api/handoffs/:id/open-native` 支持 `method='app-server'`,成功写 NativeLink `{ method:'app-server', linkLevel:'linked', nativeThreadId, runId, url:'codex://threads/<id>' }`;失败返 502,不自动降级(auto 场景由 UI 决定重试哪种)。
- 前端菜单增加「和 Codex 继续(深集成)」入口;linked 结果显示 Thread ID + `codex://threads/<id>` 打开按钮。

### Phase 3: richer native continuation ✅

已实现:

- Claude/Codex 能力检测:`GET /api/handoffs/capabilities` 返回每个 provider 的 `cliAvailable / supportsDeeplink / supportsAppServer / supportsCli / supportsManual`。Claude 默认不启 deeplink(URL scheme 在跨版本不稳定)。
- `POST /api/handoffs/:handoffId/refresh`:从同一 `sourceRef` 重新抽取 canonical + entries,写入 **新 handoffId**。旧 handoff 的 `nativeLinks` 保留在旧 manifest 上,新 handoff 从空开始。新 manifest 用 `predecessorId` 记录来源,`inheritedTarget` 继承创建目标。
- Manifest 增加 `stats: HandoffStats { transcriptMode, transcriptTruncated, eventsIncluded, eventsTotal, approxTokens }`。`approxTokens` 是粗略估算(char/4);不精确,供 UI 显示预算参考。
- 前端在 handoff 结果弹窗渲染 `Native links` 列表(方法/等级/thread id/打开按钮)以及 `Bundle` 概要(events + tokens)。

`transcriptMode='recent'` 保留最近 `RECENT_LIMIT=30` 条 non-meta 事件,并在正文顶部注明 `_(N of M events shown, mode=recent)_`。`transcriptMode='summary-only'` 完全省略 transcript,用于 token 预算最紧的情况。

### Phase 4: mirrored sync exploration ✅ (scaffold)

Phase 4 目前仍是探索,实现范围只覆盖 **Codex** 上的 **一次性** thread 快照,不做长驻同步。

- 端点:`POST /api/handoffs/:handoffId/native-links/:linkId/mirror`。
- 要求:目标 nativeLink 必须是 `provider='codex' && method='app-server' && nativeThreadId != null`。
- 动作:spawn 一次 `codex app-server`,`initialize` + `thread/read includeTurns=true`,把返回的 turns/items 序列化落到 `~/.cockpit/handoffs/<handoffId>/mirror.<linkId>.md`,把 `nativeLink.linkLevel` 升级到 `'mirrored'`。
- 失败:如果目标此前是 `mirrored`,降回 `'linked'`(即 provider 断了不再同步,但保留 linked 入口);否则不动。永远不会覆盖 handoff canonical bundle。
- 前端 `Native links` 行提供「同步 (Phase 4)」按钮,反复点可重新抓取。
- Claude 侧暂不做镜像:Anthropic 未暴露稳定的本地读接口。

Phase 4 显式保留 docs 头部的非目标约束:

- Cockpit group thread 仍是群聊事实源;`mirror.<linkId>.md` 只是本地快照,不参与 UI 消费的 `NormalizedEvent` 流。
- 不做增量 diff:每次全量重写,失败可无损重试。
- 不假设 provider 协议向前兼容;协议变化时把 mirror 端点关掉,前端还能用 linked/deeplink。

## 测试

- 从 Claude native session 创建 group thread,原 session 文件不变。
- 从 Codex native session 创建 handoff,生成所有 markdown 文件。
- Codex deep link URL 正确编码 `path` 和 `prompt`。
- deep link 打开成功时保存 `method='deeplink'`、`linkLevel='none'`。
- app-server 成功时保存 `nativeThreadId`。
- app-server continuation 通过 RunRegistry attach/cancel/terminal status。
- app-server 失败时降级到 deep link 或 manual prompt。
- Claude 无本地文件读取能力时,返回 self-contained fallback prompt。
- Claude prompt 超过 deep link 阈值时不打开 URL,只返回 manual prompt。
- handoff transcript 大于阈值时截断并保留 summary。
- source session 在 handoff 创建后增长时,GET handoff 返回 stale。
- sensitive filtering 不把 known secret pattern 写入 handoff。
- 删除/重试 native link 不影响 source session。

## 与现有文档关系

- 群聊运行模型见 `docs/05-group-chat-design.md`。
- 后台 run 和 native shadow 见 `docs/06-background-runs-design.md`。
- 原生 JSONL 只读解析见 `docs/02-session-formats.md`。
- 本文只定义 continuation/handoff 层,不改变原有 session loader 事实源。
