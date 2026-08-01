# 02 — 原生 CLI 会话文件格式(实测)

> 数据基于 2026-06-16 在本机实测样本。Anthropic / OpenAI 不公开承诺此格式,SDK 升级可能改字段 —— **loader 必须 best-effort,忽略未知字段**。

## 一、Claude Code

### 路径

```
~/.claude/projects/<dir-hash>/<session-uuid>.jsonl
```

**`<dir-hash>` 规则**:把项目绝对路径里的 `/` 全换成 `-`。
- `/Users/you/projects/my-app` → `-Users-you-projects-my-app`

**额外**:
- `~/.claude/sessions/*.json` — TUI 窗口状态(非会话内容,**忽略**)
- `~/.claude/history.jsonl` — 命令历史(非会话内容,**忽略**)

### 行的顶层 `.type` 枚举(实测分布,某 147 行 session)

| `.type` | 占比 | 处理 |
|---|---|---|
| `assistant` | 42% | **保留** — Claude 回复(含 thinking / tool_use / text) |
| `user` | 31% | **保留** — 用户消息 **或** tool_result |
| `queue-operation` | 11% | 忽略(输入队列管理) |
| `last-prompt` | 6% | 忽略(内部缓存) |
| `system` | 5% | 忽略 / 选择性保留(系统提示) |
| `attachment` | 5% | 二期支持(附件) |

### Schema

**用户消息**(`type:"user"`,content 是字符串):
```json
{
  "type": "user",
  "message": { "role": "user", "content": "<text>" },
  "uuid": "281cd187-...",
  "sessionId": "db9d647e-...",
  "timestamp": "2026-05-29T07:59:27.376Z",
  "cwd": "/Users/you/projects/my-app",
  "gitBranch": "develop",
  "permissionMode": "acceptEdits",
  "entrypoint": "claude-desktop",   // 也可能是 "claude-code"
  "version": "2.1.149",
  "parentUuid": null
}
```

**Claude 回复**(`type:"assistant"`,content 是数组):
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "<text>" }
      // 或
      { "type": "text", "text": "<text>" }
      // 或
      { "type": "tool_use", "id": "toolu_018...", "name": "Bash", "input": { "command": "...", "description": "..." } }
    ]
  },
  "timestamp": "...",
  "uuid": "..."
}
```

**工具结果**(套在 `type:"user"` 里,content 是数组):
```json
{
  "type": "user",
  "message": {
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_018...",
        "is_error": false,
        "content": "<string 或 array of {type,text}>"
      }
    ]
  }
}
```

**已观察到的工具名**:`Bash` · `Read` · `Edit` · `Write` · `Grep` · `Glob` · `TodoWrite` · `WebFetch` · `WebSearch` · `Task`(子 agent)。

### Loader 提取规则

```
对每一行 line:
  o = JSON.parse(line)
  switch o.type:
    case "queue-operation" | "last-prompt": skip
    case "system": 可选保留为 meta
    case "user":
      c = o.message?.content
      if typeof c === "string":
        emit { type: "user_text", text: c, ts: o.timestamp }
      else if Array.isArray(c):
        for p of c:
          if p.type === "tool_result":
            emit { type: "tool_result", toolUseId: p.tool_use_id,
                    output: stringifyToolResult(p.content),
                    isError: !!p.is_error, ts: o.timestamp }
    case "assistant":
      for p of o.message.content:
        if p.type === "text":     emit assistant_text
        if p.type === "thinking": emit thinking      (text 从 p.thinking 取)
        if p.type === "tool_use": emit tool_use
    default:
      emit meta(o.type, o)   // 兜底
```

### Session Summary 提取

- `id` = 文件名去掉 `.jsonl`(也等于行内的 `sessionId`)
- `cwd` = 第一条带 `cwd` 字段的事件
- `title` = 第一条 `user_text` 的前 60 字
- `startedAt` = 第一行的 `timestamp`,`updatedAt` = 文件 mtime
- `messageCount` = `assistant` + `user`(有 content 的)数量
- `filePath` / `fileMtimeMs` / `fileSize` = 原始 JSONL 的 stat 信息,供 SessionRegistry 和增量检查使用
- `sourceEventId` = 行内 `uuid`;`parentEventId` = 行内 `parentUuid`

### 注意点

- ⚠️ `claude-desktop` 入口的会话也落到 `~/.claude/projects/`,**不需要单独支持 Claude Desktop**
- ⚠️ `parentUuid` 形成对话树(分支编辑),当前 timeline **线性展示**,但保留 parent 信息,后续可做分支可视化
- ⚠️ tool_result 的 `content` 可能是 string,也可能是 `[{type:"text",text:"..."}, {type:"image",...}]`;loader 要 `stringifyToolResult` 折叠
- ⚠️ 大文件(实测 343KB / 一个 session)需要**流式读**,不要一次性 `readFileSync`

---

## 二、Codex CLI

### 路径

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-time>-<session-uuid>.jsonl
~/.codex/session_index.jsonl     ← 列表索引(每行 {id, thread_name, updated_at})
```

**列表页强烈建议优先用 `session_index.jsonl`** —— 不用扫盘,一次读完。详情页再按 id 在 sessions 子树里 `find -name "*<id>*.jsonl"`(或维护 id→path 映射缓存)。

**实现要求:** discovery 阶段应把 `id → filePath` 写入 SessionRegistry。详情页优先走 registry path,只有 cache miss 时才 fallback 扫盘。

### 行的顶层结构

```json
{ "timestamp": "...", "type": "event_msg", "payload": { ... } }
```

**关键字段在 `.payload.type`** 上,而不是顶层 `.type`。

### `.payload.type` 枚举(实测分布,某 369 行 session)

| `.payload.type` | 占比 | 处理 |
|---|---|---|
| `function_call` | 19% | **保留** — 工具调用 |
| `function_call_output` | 19% | **保留** — 工具结果 |
| `message` | 16% | 协议层 message — 大部分是 developer/system 指令,当前默认跳过 |
| `token_count` | 15% | **保留为 usage**(可选展示) |
| `agent_message` | 11% | **保留** — Codex 给用户看的回复(就是要展示的) |
| `reasoning` | 10% | **保留**(常为空 `[]`,o-series 模型才有) |
| `user_message` | 4% | **保留** — 用户发言 |
| `task_started` / `task_complete` / `turn_aborted` | <1% | 保留为 meta(任务边界标记) |
| `patch_apply_end` / `custom_tool_call*` | <1% | apply_patch 流程,二期处理 |
| `session_meta` | 第一行 | 解析后丢 `SessionSummary`,不进 timeline |

### Schema

**Session 元数据**(每个文件第一行):
```json
{
  "payload": {
    "type": "session_meta",
    "payload": {
      "id": "019d7151-...",
      "timestamp": "2026-04-09T08:17:51.889Z",
      "cwd": "/Users/you/Downloads",
      "originator": "codex-tui",
      "cli_version": "0.118.0",
      "model_provider": "openai",
      "base_instructions": { "text": "You are Codex..." }
    }
  }
}
```

**用户消息**:
```json
{ "payload": { "type": "user_message", "content": "<text>" } }
```

**Codex 回复**(用 `agent_message`,**不是** `message`):
```json
{ "payload": { "type": "agent_message", "message": "<text>" } }
```

**工具调用**:
```json
{
  "payload": {
    "type": "function_call",
    "name": "exec_command",
    "call_id": "call_dzaJQ...",
    "arguments": "{\"cmd\":\"pwd\",\"workdir\":\"...\"}"
  }
}
```
**⚠️ `arguments` 是字符串化的 JSON,要 `JSON.parse` 一次**。

**工具结果**:
```json
{
  "payload": {
    "type": "function_call_output",
    "call_id": "call_dzaJQ...",
    "output": "Chunk ID: d2b12c\nWall time: ...\nProcess exited with code 0\nOutput:\n..."
  }
}
```

**Reasoning**:
```json
{ "payload": { "type": "reasoning", "summary": [...] } }
```

### Loader 提取规则

```
对每一行 line:
  o = JSON.parse(line)
  p = o.payload; if !p: skip
  switch p.type:
    case "session_meta": 提到 summary,不入 events
    case "user_message":
      emit { type: "user_text", text: p.content, ts: o.timestamp }
    case "agent_message":
      emit { type: "assistant_text", text: p.message, ts: o.timestamp }
    case "function_call":
      input = typeof p.arguments === "string" ? safeJsonParse(p.arguments) : p.arguments
      emit { type: "tool_use", id: p.call_id, name: p.name, input, ts: o.timestamp }
    case "function_call_output":
      emit { type: "tool_result", toolUseId: p.call_id, output: p.output, isError: false, ts: o.timestamp }
    case "reasoning":
      if p.summary length > 0:
        emit { type: "thinking", text: stringify(p.summary), ts: o.timestamp }
    case "token_count":
      emit usage(...)
    case "message":
      skip (developer/system 指令,后续可选展示)
    default:
      emit meta(p.type, p)
```

### Session Summary 提取

**优先用 `~/.codex/session_index.jsonl`** 拿到 `{id, thread_name, updated_at}`,再按需打开文件读 `session_meta` 拿 cwd / cli_version。

如果某 id 在 index 中找不到(老 session),fallback 到扫盘第一行 `session_meta`。

同时记录 `filePath` / `fileMtimeMs` / `fileSize`。`sourceEventId` 优先取 `call_id`,否则用文件路径 + 行号生成。

⚠️ **列表页字段缺口**:`session_index.jsonl` 只有 `{id, thread_name, updated_at}`,**没有 `cwd` / `messageCount`**。若不开文件就拿不到这两列。

- 类型对齐:`SessionSummary.cwd` 与 `messageCount` 均为 `… | null`(见 01 §三)。Codex 列表阶段**填 `null`**,语义是"未知"而非 0;TS 强制下游 `?? '—'` 处理,漏不掉。
- UI:列表页对 `null` 渲染 `—`;用户点进详情页时才读 `session_meta` / 数 events 补全真值;或后台懒加载逐步回填 registry cache。
- **不要为了这两列在列表页同步打开所有文件**,否则丧失 index 免扫盘的好处。

### 注意点

- ⚠️ `function_call.name` 主要是 `exec_command`(Codex 的默认工具),也有 `apply_patch`、自定义工具
- ⚠️ `function_call_output.output` 开头可能有 Codex metadata;loader 可剥离到 `Output:` 之后
- ⚠️ `custom_tool_call` 和 `patch_apply_end` 暂归 meta;**二期专门展示 apply_patch 的 diff**(产品差异化亮点)

---

## 三、Claude Desktop

**不单独支持。**

`~/Library/Application Support/Claude/` 是 Electron 应用目录,对话历史在 `IndexedDB/`(LevelDB 格式),无格式承诺、解析复杂。

Claude Desktop 调用 Claude Code 时,会话也落到 `~/.claude/projects/`;Claude Code loader 可覆盖这类入口。

---

## 四、OpenCode CLI

### 路径

```
~/.local/share/opencode/opencode.db
```

OpenCode 1.17.x 使用 SQLite 保存会话。Cockpit 只读该 DB,不写入、不迁移、不修改 OpenCode 原生数据。

### 关键表

| 表 | 用途 |
|---|---|
| `session` | 会话摘要:`id`, `title`, `directory`, `time_created`, `time_updated`, `agent`, `model` |
| `session_message` | 新格式消息流:`session_id`, `type`, `seq`, `data` |
| `message` / `part` | 旧格式消息与分片;当 `session_message` 为空时 fallback |

### Loader 提取规则

- `session.id` 形如 `ses_...`,不是 UUID;路由按 `source='opencode'` 使用专门 id 校验。
- `session_message.type='user'`, `data.text` → `user_text`。
- `session_message.type='assistant'`, `data.content[]` 中:
  - `type='text'` → `assistant_text(agent='opencode')`
  - `type='reasoning'` → `thinking`
  - `type='step-finish'` tokens → `usage`
  - tool 类 part → `tool_use` / 可选 `tool_result`
- legacy `message.role` + `part.data.type` 使用同一套 part 映射。
- 未知 part 降级为 `meta`,不能阻塞 session 打开。

---

## 五、Cursor Agent CLI

### 路径

```
~/.cursor/projects/<workspace>/agent-transcripts/<uuid>/<uuid>.jsonl
~/.cursor/chats/<workspace-hash>/<uuid>/meta.json
```

`agent-transcripts` 是时间线事实来源;`meta.json` 提供 `title`、`cwd`、`createdAtMs`、
`updatedAtMs`。Cockpit 只读这些文件,不读取/修改 `store.db`,也不把 Cursor 原生续写
伪装成已支持能力。

### 行结构(实测 Cursor Agent CLI 2026.07)

```json
{"role":"user","message":{"content":[{"type":"text","text":"..."}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"turn_ended","status":"completed"}
```

- `role='user'` 的 text part → `user_text`。
- `role='assistant'` 的 text part → `assistant_text(agent='cursor')`。
- thinking/reasoning/tool part 按统一事件类型 best-effort 保留。
- transcript 行当前没有时间戳;loader 以 meta `createdAtMs` 为基准按行号生成稳定递增时间,
  只用于展示,不据此跨来源重排。
- `turn_ended` 与未知行降级为 `meta`。

Cursor CLI 的 `--stream-partial-output` 形状与落盘 transcript 不同:流式 assistant
片段是带 `timestamp_ms` 的 `type='assistant'`,最后还有一条无 `timestamp_ms` 的完整
assistant。Adapter 必须把前者标成同一 `streamId` 的 delta,后者作为终态覆盖,不能把
每个 token 落成独立回复。

---

## 六、未来可能接入的来源(占位)

| 来源 | 位置(待验证) | 优先级 |
|---|---|---|
| Cline (VS Code) | `~/.vscode/.../cline/` | 中 |
| Aider | `.aider.chat.history.md` (项目内) | 中 |

**接新来源的标准做法**:写一个新 `loaders/<source>-loader.ts`,产出统一的 `NormalizedEvent[]` + `SessionSummary`,其他层不动。

---

## 七、Loader 容错与 warnings

所有 loader 都必须 best-effort:
- 单行 JSON parse 失败:记录 `LoaderWarning{line, code:'json_parse_failed'}`,跳过该行。
- 已知 type 但缺关键字段:记录 `missing_field`,尽量降级为 `meta`。
- 未知 type/schema:记录 `unknown_schema`,降级为 `meta`。
- 整个文件不可读:列表页可跳过并记录 server log;详情页返回可展示错误。

`warnings` 返回给 UI,用于详情页顶部提示“部分事件未能解析”。这比静默丢失更利于发现 Claude/Codex schema 变化。
