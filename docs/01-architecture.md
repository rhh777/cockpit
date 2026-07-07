# 01 — 系统架构

## 一、定位与边界

| 维度 | 说明 |
|---|---|
| **形态** | Vite + React 单页应用,可选 Electron 桌面壳 |
| **运行** | 纯本地。Node 后端(或 Vite middleware)负责读盘 + 调本机 CLI Adapter;前端只负责渲染 |
| **数据源(只读)** | `~/.claude/projects/**/*.jsonl` 和 `~/.codex/sessions/**/*.jsonl` |
| **数据源(读写)** | `~/.cockpit/` 下:`threads/<source>/<originalSessionId>/`(followups.jsonl / summary.md / context-state.json / attachments/)、`group-threads/<id>/`、`handoffs/<id>/`、`runs/`、`runtime-links/`、`cache/` |
| **状态** | URL 路由 + 内存。Follow-up 持久化到上面那个目录,format 仿原生 JSONL；session 列表可有轻量 cache,原生文件仍是事实来源 |
| **依赖** | React · Vite · 本机已安装并登录的 `claude` / `codex` CLI |

## 二、四层架构

```
┌────────────────────────────────────────────────────────────┐
│  L4 · UI (React)                                           │
│  ┌─────────────┬───────────────────────────────────────┐   │
│  │ Session 列表 │ Session 详情                          │   │
│  │  - 来源 tab │  ┌─ 原 session (灰底, 只读) ─────────┐│   │
│  │  - 搜索     │  │ user / assistant / thinking / ... ││   │
│  │  - 排序     │  └───────────────────────────────────┘│   │
│  │             │  ┌─ Follow-up (白底, 可写) ──────────┐│   │
│  │             │  │ [You → Codex]: review please...   ││   │
│  │             │  │ [Codex]: <streaming>              ││   │
│  │             │  └───────────────────────────────────┘│   │
│  │             │  [输入框] Agent:[Codex▼] [快捷:Review]│   │
│  └─────────────┴───────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                            ↑↓ HTTP / SSE
┌────────────────────────────────────────────────────────────┐
│  L3 · App Server (Node, Vite middleware)                   │
│  核心(session + follow-up):                                │
│  - GET  /api/sessions                  列表                 │
│  - GET  /api/sessions/:src/:id         原始 session + 已有  │
│                                        follow-up 合并返回   │
│  - GET  /api/sessions/:src/:id/stream  SSE 增量(默认路径) │
│         ?since=N                                            │
│  - GET  /api/sessions/:src/:id/changes 一次性 JSON,轮询兜底 │
│  - POST /api/threads/:src/:id/messages 发一条 follow-up     │
│         (SSE 流式返回 agent 响应,完成后落盘)              │
│  - DELETE /api/threads/:src/:id        清空 follow-up       │
│  - DELETE /api/threads/:src/:id/turns/:turnId  删除某一轮   │
│  - POST /api/native/:src/:id/messages  回到原会话续写        │
│         (由官方 CLI 子进程 append 原生 jsonl,cockpit       │
│          仅做 SSE 转发与刷新触发,见 §十)                   │
│  周边(见 §六模块树):                                     │
│  - /api/attachments · /api/approvals · /api/native-dialog   │
│  - /api/git · /api/runs · /api/handoffs                     │
│  - /api/group-threads · /api/settings                       │
└────────────────────────────────────────────────────────────┘

**所有 `:id` 参数必须先校验再用于解析 filePath**(防路径穿越):见 §十安全。
                            ↑↓
┌────────────────────────────────────────────────────────────┐
│  L2 · Loader + Adapter + Thread Store                      │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────────────┐ │
│  │ Loader      │ │ Adapter     │ │ ThreadStore          │ │
│  │ (读原生)    │ │ (调本机 CLI)│ │ (读写 follow-up)     │ │
│  │ claude/     │ │ claude/     │ │ ~/.cockpit/       │ │
│  │ codex       │ │ codex       │ │   threads/...        │ │
│  │ → events[]  │ │ → SSE stream│ │ → events[]           │ │
│  └─────────────┘ └─────────────┘ └──────────────────────┘ │
└────────────────────────────────────────────────────────────┘
                            ↑↓
┌────────────────────────────────────────────────────────────┐
│  L1 · 文件系统                                              │
│  只读:                                                     │
│   ~/.claude/projects/<dir-hash>/<uuid>.jsonl               │
│   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl             │
│   ~/.codex/session_index.jsonl   ← 现成索引                │
│  读写:                                                     │
│   ~/.cockpit/threads/<source>/<id>/{followups.jsonl,summary.md,context-state.json,attachments/} │
│   ~/.cockpit/group-threads/<id>/{transcript.jsonl,summary.md,state.json,attachments/} │
│   ~/.cockpit/handoffs/<id>/{manifest.json,*.md}           │
│   ~/.cockpit/runs/native-shadow/<src>/<id>/<runId>.jsonl  │
│   ~/.cockpit/runtime-links/{codex,claude}.jsonl (opt-in)  │
│   ~/.cockpit/cache/session-index.json (可删可重建)       │
└────────────────────────────────────────────────────────────┘
```

> 设置(主题、模型、推理强度等)存浏览器 localStorage,不落 `~/.cockpit/`。

## 三、核心数据模型

**统一事件类型**(Loader 出口 / UI 入口):

```typescript
type Source = 'claude-code' | 'codex' | 'cockpit' | (string & {})  // 开放枚举,新来源扩展
type AgentName = 'claude' | 'codex' | (string & {})               // follow-up 的 target agent
type Origin = 'native' | 'cockpit'                                // 事件来自原始 CLI 还是 cockpit follow-up

interface SessionSummary {
  id: string                  // session uuid
  source: Source
  title: string               // 首条 user prompt 截断 / codex thread_name
  cwd: string | null          // 项目目录
  startedAt: string           // ISO timestamp
  updatedAt: string
  messageCount: number | null // null = 该来源列表阶段拿不到(如 Codex 只读 index),详情页再补
  filePath: string            // 原始 JSONL 路径
  fileMtimeMs: number         // 原始文件 mtime,用于 cache / 增量检查
  fileSize: number            // 原始文件 size,用于 cache / 增量检查
  hasFollowups: boolean       // 列表页角标用
  extensions?: Record<string, unknown>  // 扩展点:笔记、标签等
}

type NormalizedEvent =
  | {
      type: 'user_text'; text: string; ts: string
      targetAgent?: AgentName
      targetAgents?: AgentName[]            // 群聊 @多 agent
      mentions?: AgentName[]                // 文本中的 @mention 记录
      parentTurnId?: string                 // 回复关系
      attachments?: ChatAttachment[]        // 文件/目录/图片附件
    }
  | {
      type: 'assistant_text'; text: string; ts: string
      agent?: AgentName
      // 流式 delta:同 streamId 的多条 delta 拼接出最终文本;server 不落盘,UI 端 buildTimeline 合并
      streamId?: string
      delta?: boolean
    }
  | { type: 'thinking'; text: string; ts: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; ts: string; agent?: AgentName }
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean; ts: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; ts: string; agent?: AgentName }
  | { type: 'followup_boundary'; ts: string }    // 原始 session 与 follow-up 的分隔符
  | { type: 'meta'; key: string; value: unknown; ts: string }   // 兜底

// 附件类型(user_text.attachments 用到)
type ChatAttachment =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'directory'; path: string; name: string }
  | { kind: 'image'; path?: string; dataUrl?: string; name: string; mimeType: string }

// 每个事件都额外带:
//   origin: 'native' | 'cockpit'
//   (放在统一的 envelope 里;为了不让上面的联合类型太啰嗦,放外层)

interface EventEnvelope {
  origin: Origin
  source: Source
  sourceEventId?: string      // 原生事件 uuid / Codex call_id / cockpit 自生成 id
  parentEventId?: string      // Claude parentUuid 等,当前线性展示但不丢
  turnId?: string             // follow-up 一轮用户请求 + agent 响应的归属
  runId?: string              // 一次 Adapter stream 调用的归属
  event: NormalizedEvent
}

interface SessionDetail {
  summary: SessionSummary
  events: EventEnvelope[]
  warnings?: LoaderWarning[]  // 单行解析失败 / 未知 schema 等,不阻塞渲染
  raw?: unknown[]             // dev 模式可选
}

interface LoaderWarning {
  line?: number
  code: 'json_parse_failed' | 'unknown_schema' | 'missing_field' | string
  message: string
}
```

**为什么需要 `targetAgent` / `agent` 字段**:
- 同一个 follow-up timeline 里,用户可能这一条发给 Codex,下一条发给 Claude
- UI 渲染需要区分显示(头像/颜色),adapter 调用时也要据此选择 CLI Adapter
- 原始 session 的 events 自然 `agent` = 该 session 来源(claude / codex),follow-up 的 events `agent` 跟随用户当时的选择

**为什么这么设计**:
- `NormalizedEvent` 把 Claude 的 `assistant.content[].type` 和 Codex 的 `payload.type` **两种枚举折叠到同一个联合类型**,UI 只需要写一份渲染。
- `meta` 兜底:遇到不认识的 type 不丢,仍展示原始 JSON(可折叠),方便后续补 schema。
- `raw` 字段开发期方便调试,生产模式删掉省内存。
- `sourceEventId` / `parentEventId` 让当前线性 timeline 能保持可追溯性,不会把 Claude 的分支树、Codex 的 call_id 等信息丢掉。
- `turnId` / `runId` 只要求 cockpit follow-up 写入时必须有;原生事件可为空。
- `warnings` 是 best-effort loader 的产品化出口:某几行坏了不应导致整个 session 打不开。

## 四、Session Registry 与轻量索引

`GET /api/sessions/:source/:id` 不应每次靠 `id` 临时扫盘找文件。Loader discovery 阶段要产出 `filePath`、`fileMtimeMs`、`fileSize`,Server 内部维护 `source:id → filePath` 的 registry。

```typescript
interface SessionRegistry {
  discoverAll(): Promise<SessionSummary[]>
  resolve(source: Source, id: string): Promise<string | null>
  invalidate(source: Source, id: string): void
}
```

**规则:**
- `SessionSummary.filePath` 是 server 内部字段,前端可展示但不能把它当权限凭据。
- registry miss 时再 fallback 到 loader 的慢路径搜索。
- 可选 cache 写到 `~/.cockpit/cache/session-index.json`,只缓存 `source/id/filePath/mtime/size/title/cwd/startedAt/updatedAt`。
- cache 可随时删除重建,**原生 JSONL 永远是事实来源**。
- Codex 优先读 `~/.codex/session_index.jsonl`;详情页优先走 registry path,最后才 `find *<id>*`。

## 五、关键数据流

### 流程 A:打开 session
```
用户点列表项
  → 前端 GET /api/sessions/:source/:id
  → Server:
      1. Loader 读原始 jsonl → 原始 events
      2. ThreadStore 读 ~/.cockpit/threads/<src>/<id>/followups.jsonl → follow-up events
      3. 合并:[...原始, followup_boundary, ...follow-up],打包 EventEnvelope
      4. 返回 SessionDetail
  → 前端 timeline 渲染(灰底/白底分段)
```

**排序约定:** 事件顺序按各来源文件行序。跨来源只在 `followup_boundary` 拼接。`ts` 只展示,不排序。

### 流程 B:发一条 follow-up 给某个 agent
```
用户在详情页输入框输入消息,选择 target agent (默认上一条用过的),点发送
  (或点 [Review] 快捷按钮,预填 "Please review the above session for..." 模板)
  → 前端 POST /api/threads/:source/:id/messages
          body: { text, targetAgent: 'codex', useTools?: false }
         (SSE 升级)
  → Server:
      1. 生成 turnId + runId,立即 append 用户消息到 followups.jsonl (origin='cockpit')
      2. 重新 loadFullContext = 原始 events + 已有 follow-up events + 这条新用户消息
      3. serializeForAgent(fullContext, targetAgent) → 适合 target CLI 的输入格式
      4. 调本机 claude/codex CLI 子进程 → 流式读取 stdout/stderr,带 AbortSignal
      5. 边收 CLI 输出边:
         a. 累积到 followups.jsonl(每个事件落一行)
         b. 转成 NormalizedEvent → SSE 推给前端
      6. CLI 进程完成 → append turn_status(completed) → 发 SSE 'done' → 关闭流
  → 前端流式追加到 timeline 末尾
```

**关键约束**:
- Follow-up **持久化到 `~/.cockpit/`**,关掉浏览器不丢
- **绝不写入** `~/.claude/` / `~/.codex/`,零侵入原生 CLI
- 用户消息**先落盘再调 agent**,这样即使 agent 调用失败用户消息也保留
- Abort:前端 EventSource.close() → 后端 res.on('close') → AbortController.abort() → CLI 进程取消;已生成的部分已落盘,保留
- CLI 报错 / 用户取消必须写入 terminal status,否则 UI 无法区分“还在生成”和“半截终止”。

### 流程 C:实时增量(fs.watch + SSE)

```
用户打开 session 详情页
  → 前端 EventSource 订阅 GET /api/sessions/:source/:id/stream?since=N   (SSE 主路径)
      同一路径下还提供 GET /api/sessions/:source/:id/changes?sinceEventCount=N,
      作为一次性 JSON 轮询兜底(不升级 SSE)
  → Server subscribeWatcher:多 client 共享同一文件 watcher(fs.watch,引用计数到 0 关闭)
  → watcher 检测到文件变化 → 重读 → 推 {type:'append'|'reset', total, newEvents}
  → 前端按 sourceEventId 去重后,把 newEvents 追加到 timeline,保持滚动位置
  → 15s 心跳保活;无变化时 SSE 不推
```

**契约:**
- 请求带 `sinceEventCount`。SSE 先发 `init`,之后只推 `append`/`reset`。
- 原始文件被截断/重写导致 `total < sinceEventCount` 时,推 `reset`,前端回退全量 `GET /api/sessions/:source/:id`。
- 前端按 `sourceEventId` 去重;有活跃 follow-up SSE 时暂停 watcher。

**实现说明:**
- 后端 watcher 直接订阅原生 JSONL 与 cockpit follow-up JSONL 的文件变化,多客户端共享 watcher,避免每个页面重复创建文件监听。
- 增量只在“尾部追加”时成立。如果原生事件插入在 `followup_boundary` 前方,服务端推 `reset`,前端重拉全量,避免 timeline 顺序错位。

## 六、模块划分(代码组织)

```
cockpit/
├── README.md
├── docs/                            (本目录)
├── package.json
├── vite.config.ts
├── tsconfig.json
├── server/                          ← Node 侧
│   ├── index.ts                     ← Vite middleware 注册 API,顺序分发到 routes/*
│   ├── config.ts                    ← 数据源根目录 + 白名单常量
│   ├── sessions-service.ts          ← 打开 session:loader + threadStore 合并
│   ├── changes-service.ts           ← /changes 一次性 JSON(/stream SSE 在 routes/sessions)
│   ├── routes/
│   │   ├── sessions.ts              ← /api/sessions[/:src/:id[/stream|/changes]]
│   │   ├── threads.ts               ← follow-up 收发(SSE)、DELETE 清空/回删
│   │   ├── native.ts                ← 回到原会话续写(官方 CLI 子进程)
│   │   ├── native-dialog.ts         ← 桌面壳原生对话框
│   │   ├── group-threads.ts         ← 群聊:from-session / PATCH / /messages(legacy) / /runs
│   │   ├── handoffs.ts              ← Handoff bundle + capabilities/refresh/open-native
│   │   ├── runs.ts                  ← 后台运行注册(GET/POST /runs,SSE /runs/:id/stream)
│   │   ├── approvals.ts             ← Adapter 侧工具审批
│   │   ├── attachments.ts           ← 群聊/线程附件读取
│   │   ├── git.ts                   ← 只读 git 状态
│   │   ├── settings.ts              ← 后端可读设置
│   │   └── resolve.ts               ← :id → filePath 校验 + 白名单守卫
│   ├── loaders/                     ← 读原生 CLI(只读)
│   │   ├── types.ts                 ← 共享类型 + SessionSourceLoader interface
│   │   ├── claude-loader.ts
│   │   ├── codex-loader.ts
│   │   └── index.ts                 ← discoverAll() 合并
│   ├── registry/
│   │   └── session-registry.ts      ← source:id → filePath/cache
│   ├── store/                       ← 读写 cockpit 自己的数据
│   │   ├── paths.ts                 ← ~/.cockpit/ 路径常量
│   │   ├── thread-store.ts          ← follow-up 读/写/append/abort 恢复
│   │   ├── thread-context-store.ts  ← context-state.json 缓存(docs/11)
│   │   ├── group-thread-store.ts    ← 群聊 state / transcript / summary
│   │   ├── handoff-store.ts         ← handoff manifest 落盘
│   │   └── provider-thread-link-store.ts  ← Codex/Claude runtime thread 复用(Phase 2 opt-in)
│   ├── adapters/                    ← 调本机 CLI / Agent SDK
│   │   ├── types.ts / registry.ts / serialize.ts / sensitive.ts
│   │   ├── claude-call.ts           ← claude:CLI + Agent SDK 两条路径
│   │   ├── codex-call.ts            ← codex follow-up 走 app-server,resume 走 codex exec
│   │   ├── codex-app-server.ts / codex-runtime-manager.ts / codex-command.ts
│   │   ├── context-projector.ts     ← 增量 context 投影(docs/11)
│   │   ├── summary-generator.ts / summary-refresh.ts
│   │   ├── cursor-call.ts / opencode-call.ts / mock-adapter.ts
│   │   ├── json-cli-events.ts / cli-utils.ts
│   ├── runs/                        ← 后台运行注册中心
│   │   ├── run-registry.ts          ← runId 管理 + SSE 多客户端 fan-out
│   │   ├── run-store.ts             ← RunRecord 落盘
│   │   └── native-shadow-store.ts   ← 原生 resume 的影子日志
│   ├── handoffs/                    ← Handoff 生成 / 消费
│   ├── approvals/                   ← Adapter 侧审批状态机
│   ├── permissions/                 ← adapter-policy(mode → CLI 参数映射)
│   ├── watcher/                     ← 共享 fs.watch 引用计数
│   └── util/
└── src/                             ← React 前端
    ├── main.tsx / App.tsx
    ├── pages/                       ← SessionList / SessionDetail / 群聊 / 设置
    ├── components/                  ← Timeline / Composer / Picker / ReviewPanel 等,详见 docs/04 §六
    ├── hooks/                       ← useSessionStream / useApprovals 等
    ├── lib/
    │   ├── agents.ts                ← agent 列表 / 图标 / 默认值(共享事实来源)
    │   └── api.ts / sse.ts / ...
    └── styles.css
```

## 七、技术选型决策

| 项 | 选型 | 理由 |
|---|---|---|
| 框架 | **Vite + React 19 + TS** | 启动快,无 SSR 复杂度,前后端可共享类型 |
| 后端 | **Vite middleware**(同进程 Node) | 不引入额外服务器框架;dev/prod 同一套路由 |
| 流式 | **SSE**(Server-Sent Events) | 比 WebSocket 简单,review 场景只需服务端推 |
| 状态 | **React useState + URL 参数** | 数据量小,不需要 Zustand;路由用 `react-router` |
| UI | **Tailwind v4**(可选) | 与同类工具一致,便于复用组件 |
| 渲染 | **react-markdown + shiki** | Markdown 与代码高亮 |
| 长列表 | **@tanstack/react-virtual** | timeline 虚拟化,MB 级 session 不卡 |
| Agent 接入 | **本机 CLI Adapter** | 复用用户已安装并登录的 `claude` / `codex` CLI;不接管订阅账号、OAuth、网页登录态 |
| API key / SDK | **可选扩展** | 仅在用户明确选择官方 API Key Adapter 时需要;不是当前主路径 |
| 打包 | **Vite + Electron** | 浏览器形态用 `pnpm dev`;桌面形态由 Electron 主进程内置 http server 服务 API 与静态资源 |

## 八、Follow-up 持久化文件格式

`~/.cockpit/threads/<source>/<originalSessionId>/followups.jsonl`,**每行一个 JSON**,仿原生 CLI 风格但加显式 origin 标记:

```json
{"origin":"cockpit","source":"codex","turnId":"turn_...","runId":"run_...","type":"user_text","text":"review 上面的方案"}
{"origin":"cockpit","source":"codex","turnId":"turn_...","runId":"run_...","type":"assistant_text","text":"开始 review..."}
{"origin":"cockpit","source":"codex","turnId":"turn_...","runId":"run_...","type":"tool_use","id":"call_xxx","name":"exec_command"}
{"origin":"cockpit","source":"codex","turnId":"turn_...","runId":"run_...","type":"tool_result","toolUseId":"call_xxx","output":"..."}
{"origin":"cockpit","source":"codex","turnId":"turn_...","runId":"run_...","type":"meta","key":"turn_status","value":{"status":"completed"}}
```

**为什么这样设计:**
- **append-only**:每条事件直接 append,崩溃/abort 半截内容也保留
- **同一份 NormalizedEvent schema**:loader 输出和这里写入用同一套类型,无翻译损耗
- **origin 显式**:合并时直接打包 EventEnvelope,UI 一眼分清
- **agent 字段**:多 agent follow-up 混合时,每条 assistant 回复明确归属
- **turnId/runId**:同一轮 follow-up 可折叠、可标记 failed/aborted、可重试

**Terminal status:**
- `completed`:CLI 进程正常结束。
- `aborted`:用户取消或连接断开。
- `failed`:CLI / 序列化 / 权限错误。`value` 中保留可展示错误信息,不要写入敏感 stack。

## 九、上下文序列化策略

`serializeForAgent(events, target, opts)` 是 adapter 的核心边界。Adapter 不应绕过它直接消费原始 events。

```typescript
interface SerializeOptions {
  strategy: 'raw' | 'compact' | 'summary'
  maxChars: number
  maxToolInputChars: number
  maxToolOutputChars: number
  includeThinking: boolean
  includeToolDetails: boolean
}
```

**当前默认:**
- `strategy:'raw'`,但整体 `maxChars` 封顶。
- `includeThinking:false`。
- user / assistant 正文优先保留。
- tool_use 保留工具名 + 截断后的 input。
- tool_result 按优先级保留:错误输出 > diff/patch > 测试失败 > 文件片段 > 普通命令输出。
- 多 agent 历史必须加前缀:`[User said]`、`[Claude said]`、`[Codex said]`,避免 target agent 自代入。
- 当前触发消息只出现一次,不要在 history 和 current request 中重复。

**超出 `maxChars` 时的截断顺序(重要,别把目标砍没了):**
1. **钉住保留**:原始 session 的 `# User Goal`(首条 user prompt)+ `# Final Response`(原始 session 最后一条 assistant_text)+ `# Current Request`。这三块永不截断。
2. 从**中间历史**(timeline / tool activity / 旧 follow-up 轮次)往两头砍,优先砍 tool_result 正文、再砍 tool_use input、再砍中间 assistant_text。
3. 砍掉的地方留 `…[truncated N chars]…` 占位,让 target agent 知道有省略。

反例:简单地"从尾部截断到 maxChars" 会在多轮 follow-up 后把原始 User Goal 整段丢掉,导致 reviewer 不知道最初要解决什么。

**推荐输出结构:**
```markdown
# Original Session
## Metadata
## User Goal
## Timeline
## Tool Activity
## Final Response

# Cockpit Follow-up History

# Current Request
```

后续 `compact` / `summary` 可在不改 Adapter interface 的前提下加入。

## 十、安全 / 隐私

- **cockpit 进程对原生 CLI 文件零直接写入**,绝不修改 / 删除 / 移动。详见下面「Native Resume 与不变量 1 的边界」。
- cockpit 自己的数据全部在 `~/.cockpit/`,删掉该目录可完全清空状态而不影响原生 CLI
- **本机优先**:当前只调用用户本机已登录的官方 CLI;模型请求由官方 CLI 自己处理,cockpit 不接管账号凭证
- API key 仅属于未来可能的官方 API Key Adapter,不是当前配置项
- API key 只能在 `server/` 侧读取。禁止 `VITE_` 前缀,禁止前端 import。
- `:id` 解析路径前必须校验;最终路径必须落在白名单根目录内。
- 序列化给目标 agent 的上下文会把工具 input / output **截断**(默认 1000-2000 字符)再发送,避免泄露大量本地代码 —— 用户可在设置里调
- Follow-up 中 reviewer 默认 **read-only 工具权限**(Codex `sandboxMode:'read-only'`、Claude `disallowedTools:[Write/Edit/Bash/...]`);若用户显式开"允许写"则提升,但有提示
- read-only 不等于不泄密:agent 仍可能主动读取敏感文件并写进回复。当前缓解措施:
  - 敏感路径过滤同时作用于**两端**:序列化输入 **和** tool_result **落盘 / 回显前**都跑同一套过滤。
  - 过滤命中时在 UI 标注"已屏蔽敏感内容",而非静默。
  - 真正的按路径 deny(沙箱 / 自定义工具包装)留到后续审批层。
- 敏感路径黑名单:`.env*`、`*.pem`、`id_rsa`、`.ssh/`、`.aws/`、`.kube/`、`.git/`、`node_modules/`、`dist/`、`build/`。
- Claude 默认使用 `settingSources:['project']`,读取项目级 CLAUDE.md 以理解代码约定,但不读取用户全局设置。后续可提供“中立 review”开关切到 `settingSources:[]`。
- 工具权限分两档:
  - Safe Read:当前默认,只允许 Read/Grep/Glob 或 Codex read-only sandbox。
  - Read Shell:后续可选,允许白名单 shell 只读命令,需要 cockpit 自己校验或审批。
- 订阅制账号接入边界:不抓取网页登录态、不复用 cookie/token、不实现非官方 OAuth;只调用用户本机已经登录的官方 CLI。官方 API Key Adapter 可作为独立扩展。

### Native Resume 与不变量 1 的边界

cockpit 提供两种「发」的模式,语义与对原生 jsonl 的影响完全不同:

| 模式 | 写入哪里 | 谁在写 | 用户感知 |
|---|---|---|---|
| **Cockpit 追问**(默认) | `~/.cockpit/threads/<src>/<id>/followups.jsonl` | cockpit 自己 | 原生客户端看不到这条对话(本来就不该看到) |
| **回到原会话** | 原 `~/.claude/projects/...jsonl` 或 `~/.codex/sessions/...jsonl` | **官方 CLI 自己**(`claude -p --resume` / `codex exec resume`) | 原生客户端重启后能看到这条对话 |

**这是有意识的、且不违反不变量 1 的精神**:

1. cockpit 只启动官方 CLI;append 由官方 CLI 完成。
2. 用户必须**显式**在 composer 里切到「回到原会话」才会触发这条路径;默认是「Cockpit 追问」,不会偶然写到原生历史。
3. 这条路径不动 Loader / ThreadStore / 任何缓存 —— 调用结束后前端**重新拉一次完整 detail**,以原 jsonl 为唯一事实来源刷新 timeline。

**上游限制:** 原生客户端可能需要重启才看到续写。cockpit 不写 noop、不 touch 原生文件。

**安全收口**(与 Cockpit 追问相同):
- 同一份 `serializeForAgent` 截断 + 敏感路径过滤仍然作用于 prompt 输入。
- adapter 调用参数仍然走只读默认(`--sandbox read-only` / `--allowedTools Read,Grep,Glob`)。
- 走不通的源(`source !== 'claude-code' && source !== 'codex'`)在路由层就 400,不暴露能力。

## 十一、UI 信息架构

Timeline 不只渲染流水账,还应服务“看清 agent 干了什么”:

- **Timeline**:按事件顺序展示 user / assistant / thinking / tool_use / tool_result / usage。
- **Tool Activity Summary**:展示工具调用次数、失败工具、可能涉及的文件、总耗时。
- **Timeline Filter**:只看工具、只看错误、只看 thinking、关键词搜索。
- **Tool Pairing**:数据层构建 tool_use/tool_result pair,UI 用同一 id 视觉关联,summary 也复用同一份 pair 结果。
- **Warnings Banner**:loader 有解析失败或未知 schema 时展示“部分事件未能解析”,可展开详情。
- **Timeline 虚拟化**:`EventTimeline` 用 `@tanstack/react-virtual` + 动态测量。

## 十二、设计不变量

1. cockpit 不直接写、删、改 `~/.claude/` 或 `~/.codex/` 原生文件。
2. `~/.cockpit/` 是唯一自有写入目录;cache 可删可重建。
3. Native resume 只通过官方 CLI 子进程写回,并且必须显式选择。
4. 事件顺序按文件 append 顺序;跨来源只在 `followup_boundary` 拼接。
5. `ts` 只用于展示,不用于全局排序。
6. UI 只消费 `NormalizedEvent` / `EventEnvelope`。
7. Loader best-effort;坏行降级 warning/meta。
8. Adapter 必须走 `serializeForAgent`。
9. `:id` 解析路径前必须校验,最终路径必须落在白名单根目录。
10. API key 不进前端 bundle。
11. Follow-up 默认只读;敏感路径过滤作用于序列化输入和 tool_result。
12. cockpit 事件带 `origin`;follow-up/group 带 `turnId`;adapter stream 带 `runId`。
13. SSE/watcher 重叠时按 `sourceEventId` 去重。
14. 新 source/agent 只能通过 Loader/Adapter interface 扩展;破坏 interface 前先改设计。

## 十三、与外部工具的关系

- **不复用重型抽象**:不引入复杂 StreamEvent、artifact、orchestrator、DB、Next.js 等重方案。
- **只借思路,不引依赖**:遇到需要的设计模式就「理解 → 在 cockpit 重写最小版」,不通过 npm 依赖引入外部项目。

## 十四、扩展点

下面是为后续可能的演进预留的接口/边界,不要为了当前没用到就把这些口子焊死。

| 扩展点 | 当前状态 | 留法 |
|---|---|---|
| **新增 session 来源** | 只有 claude / codex | 新增 `SessionSourceLoader` |
| **新增 reviewer agent**(本地 LM / DeepSeek / Gemini) | 只有 claude / codex CLI Adapter | `adapters/types.ts` 定义 `ReviewAgent` interface;不在 UI/server 任何地方硬编码这两个 |
| **Review/Follow-up 持久化** | 已支持(`~/.cockpit/threads/`) | — |
| **回到原会话续写** | 已支持 | 独立 `/api/native`,不复用 `/api/threads` |
| **会话笔记 / 标签** | 不支持 | `SessionSummary` 留一个 `extensions?: Record<string, unknown>` 字段;后续在 `~/.cockpit/annotations/<source>/<id>.json` 旁挂 |
| **自建 cockpit 会话** | 不支持 | `Source` 已预留 `'cockpit'`;后续可复用 ThreadStore + cockpit loader |
| **链式 review**(A → B 再 review A 的 review) | 不支持 | Review 输出本身保持结构化(verdict + reasons + suggestions),便于被下一轮 reviewer 消费(结构化 `task-result-report` 思路) |
| **实时模式**(`fs.watch` 看 Claude 正在跑) | 已支持 | 当前在 server watcher 层实现;若未来来源需要自定义监听,可给 Loader interface 加 `watchSession?(id): AsyncIterable<NormalizedEvent>` |
| **Reviewer 调工具**(允许 Codex 读代码确认 Claude 说的对不对) | 默认开启 read-only 工具(看代码经常需要);写工具默认禁 | 用户开"允许写"时引入审批层 |
| **产物管理**(review 输出的补丁单独管) | 不支持 | review 输出目前是纯 markdown;若 reviewer 产 patch,从输出里抽取后单独存 `~/.cockpit/patches/`,不污染会话来源 |
| **桌面化**(Electron) | 已支持 | Electron 主进程服务 API 与静态资源 |

**关键约束**:扩展优先加可选字段/方法;破坏接口前先改设计。
