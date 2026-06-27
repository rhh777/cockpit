# 06 — 后台运行与可重连设计

## 现状

当前 agent run 绑定页面发起的 POST + SSE 连接。

- 切换 session 会 abort 当前 CLI 子进程。
- 返回 session 后只能读取已落盘事件。
- 没有可重连的后台任务模型。

## 目标

页面切换只断开订阅,不取消任务。

```
Agent Run
  -> server-side task
  -> append-only event log
  -> active run registry
  -> attachable SSE stream
  -> explicit cancel
```

后台运行只保证同一个 Cockpit 服务端进程内有效。Electron/Node 进程退出后,运行中任务标记为 interrupted。

## 适用对象

### Follow-up / review

- 发起 run 后可切换 session。
- 事件继续写入 `~/.cockpit/threads/.../followups.jsonl`。
- 返回 session 后先读落盘事件,再 attach active run。
- 只有显式 cancel 才 abort。

### Group thread

- `@claude @codex` 后可切走。
- 每个 agent run 独立完成、失败或取消。
- 同一 group thread 仍保持单个 active group turn。

### Native resume

- 中间事件写入 Cockpit shadow log。
- 完成后重新读取原生 session。
- 原生 JSONL 仍只由官方 CLI 子进程写入。

## 非目标

- 不保证应用退出后任务继续运行。
- 不做跨设备 attach。
- 不改变 adapter 输出契约。
- 不让普通 follow-up 写入原生历史。
- 不把群聊绑定到原生长期 session。

## 核心模型

```ts
type RunKind = 'followup' | 'native-resume' | 'group-member'
type RunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'

interface RunRecord {
  runId: string
  kind: RunKind
  status: RunStatus
  source?: Source
  sessionId?: string
  groupThreadId?: string
  turnId: string
  agent: AgentName
  startedAt: string
  endedAt?: string
  error?: string
}
```

RunRegistry 负责:

- 创建 run 和 `AbortController`。
- fan-out 事件给 subscribers。
- 写入事件和终态。
- 处理 attach / detach。
- 只在 cancel API 被调用时 abort。
- 保证 terminal status 幂等。

## API

```txt
POST   /api/runs/:runId/cancel
GET    /api/runs/:runId/stream
GET    /api/sessions/:source/:id/runs?status=running
GET    /api/group-threads/:id/runs?status=running
```

启动 run 可以复用现有 message endpoints,也可以新增显式 start endpoints:

```txt
POST /api/sessions/:source/:id/runs
POST /api/group-threads/:id/runs
POST /api/native/:source/:id/runs
```

推荐新增 start endpoints,让“启动任务”和“订阅任务”语义分离。

## 存储

```txt
~/.cockpit/runs/index.jsonl
~/.cockpit/runs/native-shadow/<source>/<id>/<runId>.jsonl
```

- `index.jsonl` 记录 run 元数据和终态。
- follow-up/group events 继续写原有 thread/transcript。
- native shadow 只用于运行中展示和失败审计,不混入最终 timeline。

服务启动时扫描 `status=running` 的旧记录,统一降级为 `interrupted`。

## 前端恢复

进入 session:

1. `fetchSessionDetail(source,id)` 读取事实历史。
2. `fetchActiveRuns(source,id)` 获取运行中任务。
3. 为每个 active run 调 `attachRunStream(runId)`。
4. session stream 继续监听落盘变化。

离开 session:

1. 关闭 attach stream。
2. 关闭 session stream。
3. 不调用 cancel。

取消:

1. 调 `POST /api/runs/:runId/cancel`。
2. 服务端 abort worker。
3. 抢到 terminal CAS 的一方写终态。
4. 前端通过 run stream 或 session stream 更新 UI。

## 实现拆分

### 1. RunHandle

- 收拢 `AbortController`、终态写入、subscriber fan-out。
- 保持现有 close-abort 行为。
- 补 terminal 幂等测试。

### 2. RunRegistry

- 后台执行 adapter。
- event fan-out。
- attach / detach / cancel。
- 服务启动时恢复 interrupted 状态。

### 3. 前端解耦

- 切换 session 不再 cancel run。
- pending 状态由 active runs 派生。
- 取消按钮调用 cancel API。

### 4. 群聊后台化

- 每个 member agent 是一个 `group-member` run。
- group turn 状态由 member statuses 汇总。
- 保留同一 group thread 单轮互斥。

### 5. Native shadow

- native resume 中间事件写 shadow JSONL。
- 完成后重读原生 session。
- shadow 不作为原生事实源。

## 风险

| 风险 | 处理 |
|---|---|
| delta 事件重连后丢失 | 先接受;后续可加 run ring buffer |
| 服务端重启 | running 降级 interrupted |
| native shadow 与原生历史重复 | shadow 只用于运行中/失败展示 |
| 多 run 并发写同一 thread | 继续依赖 append queue + `turnId/runId` |
| cancel 与完成竞态 | terminal CAS,只写一个终态 |

## 测试

- subscriber 断开不 abort run。
- cancel 才触发 AbortController。
- completed / failed / aborted 只写一个终态。
- 服务启动时 running run 降级 interrupted。
- follow-up 切走后继续运行,切回可 attach。
- 群聊单个 agent 失败不影响另一个 agent。
- native resume 完成后以原生 session 重读结果为准。
