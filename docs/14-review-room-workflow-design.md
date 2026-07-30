# 14 — Review Room 方案协作工作流设计

## 定位

Review Room 是 Cockpit 对「让 Claude 和 Codex 围绕一个方案互相 review、修正、复核」这一高频场景的固定化入口。

它不是新的原生会话格式,也不是简单把群聊按钮换个名字。它是在现有 group thread、follow-up、handoff、background runs 之上增加一层有状态 orchestration:

```text
上下文来源
  -> 建立 Review Room
  -> 多 agent review
  -> 汇总问题与分歧
  -> 选择修复方式
  -> 复核
  -> 可选 fresh review
```

命名建议:

- 产品文案:「方案协作室」或「Review Room」。
- API / schema: `review-room`。
- 工作流: `ReviewWorkflow`。

Review Room 的核心目标是减少用户手动步骤:

- 不再手动创建群聊、添加 agent、写 `@claude @codex` prompt。
- 不再手动复制一方指出的问题给另一方修。
- 不再手动总结两边意见。
- 修完后可以一键让另一个 agent 或一个新会话重新 review。

## 使用入口

Review Room 有两个一级触发方向。

### 从已有 session 进入

在 Claude / Codex / OpenCode 原生 session 详情页、Cockpit follow-up、Cockpit group thread 中提供:

- `Start Review Room`
- `Claude <> Codex Review`
- `Discuss This Session`

语义:

```text
当前 session / follow-up / group thread
  -> 生成 source snapshot
  -> 创建 Review Room group thread
  -> 导入 summary + recent transcript + file refs
```

适合场景:

- 已经和某个 agent 讨论过方案,现在想让另一个 agent 挑问题。
- Codex 写了实现,想让 Claude 做架构/产品/边界 review。
- Claude 给了方案,想让 Codex 做代码路径和测试可行性 review。

### 从新对话进入

左侧「新对话」不应只打开空白聊天。它可以先打开一个轻量 chooser:

```text
Start from
[Empty chat]
[Repository / folder]
[Files]
[Document]
[Existing session]

Mode
[Ask one agent]
[Claude <> Codex review]
[Fresh review]
```

选择 `Claude <> Codex review` 后创建 Review Room。

适合场景:

- 直接对某个仓库讨论一个新需求。
- 让 Claude 和 Codex 对某个文件夹里的实现做 review。
- 围绕一个设计文档、PRD、技术方案文档展开讨论。
- 还没有任何原生 session,但想让两个 agent 先给方案和风险。

## 上下文来源

Review Room 必须显式记录 source kind。第一版支持:

```ts
type ReviewSourceKind =
  | 'native-session'
  | 'cockpit-followup'
  | 'group-thread'
  | 'repository'
  | 'directory'
  | 'files'
  | 'document'
  | 'freeform'
```

建议结构:

```ts
interface ReviewRoomSource {
  kind: ReviewSourceKind
  title: string
  cwd: string | null
  snapshotCreatedAt: string
  nativeSession?: {
    source: Source
    sessionId: string
  }
  groupThreadId?: string
  paths?: {
    kind: 'repository' | 'directory' | 'file' | 'document'
    path: string
    name: string
  }[]
  freeformText?: string
  sourceSnapshot?: {
    eventCount?: number
    summaryRevision?: number
    fileMtimeMs?: number
    gitHead?: string
  }
}
```

规则:

- `repository` / `directory` / `files` / `document` 都只是 Cockpit source snapshot,不写入原生 CLI 历史。
- 文件和目录必须先做路径校验,并限制在用户选择或允许的 workspace roots 内。
- document 第一版可按附件处理:记录 path + 提取摘要;不需要建立新的文档数据库。
- source snapshot 默认是一次性快照。后续源文件变化时,旧 Review Room 标记 stale 或显示「source changed」,不要静默改写历史。

## 与现有能力的关系

Review Room 复用现有 group thread 作为事实源:

```text
~/.cockpit/group-threads/<id>/
  state.json
  transcript.jsonl
  summary.md
  attachments/
```

新增的是 `state.json` 的可选 metadata,而不是新建独立存储目录。

```ts
interface ReviewRoomStateExtension {
  mode: 'review-room'
  review: {
    source: ReviewRoomSource
    phase: ReviewPhase
    participants: AgentName[]
    rounds: ReviewRound[]
    currentIssueSetId?: string
  }
}

type ReviewPhase =
  | 'draft'
  | 'review'
  | 'compare'
  | 'fix'
  | 'verify'
  | 'done'
```

兼容规则:

- 普通 group thread 没有 `review` metadata 时行为不变。
- Review Room 仍可显示为 group thread timeline。
- Review Room 的主 UI 是 workflow view;timeline 是证据和展开细节。
- agent 回复、tool_use、tool_result 仍写入 `transcript.jsonl`。
- summary 更新继续遵守 `docs/05-group-chat-design.md`。

## 工作流阶段

### Draft

用户选择 source、目标和参与 agent。

可选目标 preset:

| Preset | 说明 |
|---|---|
| 方案 review | 找架构、边界、实现和测试风险 |
| 实现 review | 检查当前代码、diff、测试覆盖和隐藏 bug |
| 方案对比 | 让 agent 比较多个方向并收敛建议 |
| Debug 讨论 | 围绕一个 bug 或失败日志提出排查路径 |
| 文档审稿 | 审设计文档、PRD、迁移方案或结论文档 |

默认参与 agent:

- Claude
- Codex

### Review

系统并行或串行唤醒参与 agent。

第一版建议提供两种执行模式:

| 模式 | 行为 | 适用 |
|---|---|---|
| Parallel review | Claude 和 Codex 基于同一个 source snapshot 分别 review | 快速收集独立意见 |
| Serial discussion | 一个 agent 先发言,另一个读取前文后接力 | 需要互相指出问题和收敛方案 |

串行讨论的具体调度协议沿用 `docs/13-serial-agent-discussion-design.md`。Review Room 不重新定义 `Next:` 协议,只把它作为可选执行模式。

### Compare

Review 完成后,Cockpit 生成结构化 issue set:

```ts
interface ReviewIssueSet {
  id: string
  reviewRoomId: string
  roundId: string
  createdAt: string
  issues: ReviewIssue[]
  agreements: string[]
  disagreements: ReviewDisagreement[]
  recommendedNextStep?: string
}

interface ReviewIssue {
  id: string
  title: string
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  raisedBy: AgentName[]
  status: 'open' | 'fixed' | 'wontfix' | 'needs-check'
  evidence?: string
  suggestedFix?: string
  fileRefs?: { path: string; line?: number }[]
}

interface ReviewDisagreement {
  id: string
  topic: string
  positions: Partial<Record<AgentName, string>>
  needsUserDecision: boolean
}
```

第一版可以由一个 orchestrator prompt 汇总 transcript 产生 markdown + JSON-ish meta。结构化 JSON 解析失败时,仍把 markdown summary 写入 transcript,issue set 降级为空并提示用户。

### Fix

用户选择修复方式:

```text
Apply fix with
[Codex] [Claude] [I'll fix manually]
```

规则:

- 选择 agent 修复时,启动单 agent run,输入包含 issue set、source snapshot、当前文件状态和用户选择的修复范围。
- 默认由发现问题以外的 agent 修复,但用户可以改。
- 选择 `I'll fix manually` 时,Review Room 标记 phase=`fix`,issues 保持 `open` 或 `needs-check`。
- 用户手动修完后点击 `I fixed it, verify now` 进入 Verify。

写权限:

- 默认沿用 group run 的权限档位。
- 第一版建议 `ask` 为默认,避免 Review Room 一键入口默默写盘。
- 多 agent 不并行写文件。Parallel review 只能只读;Fix 阶段只允许一个 selected fixer agent 运行。

**实现记录(2026-07-30)**:单 writer 约束落在 `server/review/round-plan.ts` 的 `planReviewRound`
(纯函数,便于单测),route 只负责读 store 和调 runRegistry:

- `kind='fix'` 恒定唤醒 1 个 agent;显式传多个 fixer 抛 `RoundPlanError` → HTTP 400。
- fix 轮的 `mode='serial'` 降为单发(serial orchestrator 对单 agent 无意义,第一步就 `no-next-agent`)。
- fix 轮落盘 `ReviewRound.mode='single'`,与并行轮可区分。
- 默认 fixer = 最近一轮已完成 review 里**提出问题较少**的一方(对自己结论锚定最少),
  并列或无 issueSet 时按 participants 顺序取首位,保证默认值稳定。
- 前端 `ReviewRoomPanel` 在 `nextKind='fix'` 时把「并行/接力」换成「单写者:自动 / Claude / Codex」;
  选「自动」时不传 participants,由后端按上述规则挑,不在前端复制该规则。
- 覆盖:`server/review/round-plan.test.ts`(13 例)。
- **仍存在的敞口**:verify 轮允许多 agent 且 `useTools=true`,理论上仍可并发写盘;
  当前只靠默认 `ask` 权限档逐操作拦截,没有结构性约束。

### Verify

修复后提供两个复核方式:

| 方式 | 语义 | 适用 |
|---|---|---|
| Thread verify | 在当前 Review Room 中继续复核 | 快速确认刚才的问题是否修掉 |
| Fresh review | 基于最新 source 创建新 snapshot,启动独立 reviewer | 避免同一会话惯性,找新问题 |

默认策略:

- 如果 Codex 修,优先让 Claude verify。
- 如果 Claude 修,优先让 Codex verify。
- 如果用户手动修,默认让两个 agent parallel verify。

### Done

当 issue set 全部为 `fixed` / `wontfix`,或用户手动结束时,进入 Done。

Done 阶段展示:

- 最终决策。
- 已修复问题。
- 未修复但接受的问题。
- 后续任务。
- 关联 source snapshot 和可能的 fresh review 结果。

## Fresh Review

Fresh Review 是 Review Room 的重要能力,用于解决「同一个会话里改正方案后,模型可能仍受前文影响」的问题。

语义:

```text
当前 Review Room / 当前仓库状态
  -> 生成新的 handoff snapshot
  -> 新建独立 reviewer context
  -> 让指定 agent 在最少历史负担下重新找问题
```

Fresh Review 不是清空当前 Review Room。它是从当前状态派生一个新的 review run 或新的 Review Room child。

推荐第一版实现为 child Review Room:

```ts
interface FreshReviewLink {
  parentReviewRoomId: string
  childReviewRoomId: string
  handoffId: string
  reviewerAgents: AgentName[]
  createdAt: string
  reason: 'verify' | 'new-risks' | 'user-requested'
}
```

上下文策略:

- 包含当前目标、最终方案、关键文件引用、已修复 issue 列表。
- 不包含完整争论 transcript,只包含必要决策摘要。
- 明确要求 reviewer 重新判断,不要默认接受之前结论。
- source snapshot 必须重新计算 freshness,例如 git head、文件 mtime、session event count。

Fresh Review 的输出回链到 parent Review Room:

- 新发现问题追加到 parent 的 issue set,状态为 `open`。
- 如果没有新问题,parent 可以标记 `verified`。
- child timeline 保留独立证据链。

## UI 设计

### 左侧新对话

点击「新对话」时出现 start chooser,而不是直接进入单一空白 composer。

建议结构:

```text
New conversation

Start from
  Empty chat
  Repository / folder
  Files
  Document
  Existing session

Mode
  Ask one agent
  Claude <> Codex review
  Fresh review
```

选择 repository / folder:

- 使用系统 file picker 或手动 path 输入。
- 默认 cwd 设为所选目录。
- 如果目录是 git repo,记录 git root 和 HEAD。

选择 files / document:

- 文件作为 attachments 进入 group thread。
- 文档可先提取 text summary,原文件 path 仍保留。

### Review Room 页面

Review Room 页面建议是双视图:

```text
Header: source + phase + participants + permissions

Left/main:
  Workflow panel
    Draft / Review / Compare / Fix / Verify / Done
    Issue list
    Next action buttons

Right or collapsible:
  Transcript timeline
```

如果空间不足,移动端或窄宽度使用 tabs:

- `Issues`
- `Discussion`
- `Source`

不要把它做成营销式 landing page。第一屏就是可操作工作台。

### Session 详情页入口

原生 session 详情页的 actions 中增加:

- `Start Review Room`
- `Fresh review from here`

第一个创建带完整 workflow 的 Review Room。第二个直接创建最小 Review Room 并进入 Review 阶段,适合用户只想让另一个 agent 独立挑问题。

## API 草案

新增端点建议:

```txt
POST /api/review-rooms
GET  /api/review-rooms/:id
POST /api/review-rooms/:id/review
POST /api/review-rooms/:id/compare
POST /api/review-rooms/:id/fix
POST /api/review-rooms/:id/verify
POST /api/review-rooms/:id/fresh-review
```

这些可以是 `group-threads` 的薄包装,不要复制 run-registry。

```ts
interface CreateReviewRoomBody {
  source: ReviewRoomSourceInput
  goal: string
  preset?: 'plan-review' | 'implementation-review' | 'compare-approaches' | 'debug' | 'document-review'
  participants?: AgentName[]
  mode?: 'parallel' | 'serial'
  permissions?: RunPermissions
  cliByAgent?: Partial<Record<AgentName, { model?: string; effort?: string }>>
}
```

创建响应:

```ts
interface CreateReviewRoomResponse {
  groupThreadId: string
  reviewRoomId: string
  state: GroupThreadState
}
```

实现约束:

- `reviewRoomId` 第一版可以等于 `groupThreadId`。
- 后端内部仍调用 `GroupThreadStore` 和 `RunRegistry`。
- 不增加和 `/api/group-threads/:id/runs` 平行的第二套 agent 执行路径。
- 如果未来 API 稳定后,可把 Review Room routes 做成更明确的一等资源。

## 数据落盘

第一版不需要新目录。扩展 group thread:

```text
~/.cockpit/group-threads/<id>/
  state.json
  transcript.jsonl
  summary.md
  attachments/
  review-state.json       # 可选,也可内嵌 state.json
```

建议将较大的 issue set / round state 放 `review-state.json`,避免 `state.json` 越来越重。

```ts
interface ReviewRoomDiskState {
  version: 1
  reviewRoomId: string
  groupThreadId: string
  source: ReviewRoomSource
  goal: string
  preset: string | null
  phase: ReviewPhase
  rounds: ReviewRound[]
  issueSets: ReviewIssueSet[]
  freshReviews: FreshReviewLink[]
}

interface ReviewRound {
  id: string
  kind: 'review' | 'fix' | 'verify' | 'fresh-review'
  mode: 'parallel' | 'serial' | 'single'
  startedAt: string
  completedAt?: string
  agents: AgentName[]
  groupTurnId?: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
}
```

写入规则:

- review-state 写入必须 best-effort 但不能破坏 transcript。
- transcript 是发言事实源;review-state 是 workflow 投影。
- review-state 损坏时,页面应能回退到普通 group thread timeline,并展示 warning。

## Prompt 模板

Review Room prompt 分为三层:

1. Source context:session 摘要、repo/file/document 摘要、附件说明。
2. Workflow instruction:当前阶段、agent 角色、输出结构。
3. User goal:用户真实目标。

Review 阶段要求每个 agent 输出:

```text
## Findings
## Risks
## Suggested Fixes
## Questions
```

Compare 阶段要求 orchestrator 输出:

```text
## Common Issues
## Disagreements
## Recommended Next Step
## Issue List
```

Verify 阶段要求 reviewer 明确标记:

```text
Fixed:
Still Open:
New Issues:
Confidence:
```

Fresh Review prompt 必须包含:

```text
You are reviewing a fresh snapshot. Do not assume previous reviewers were correct.
Focus on issues that remain after the described fixes.
```

## 权限与安全

- Review 阶段默认只读。
- Fix 阶段才允许写权限选择。
- Fresh Review 默认只读。
- 不把 Review Room transcript 写入 Claude/Codex/OpenCode 原生历史。
- Native resume 仍必须显式选择,且不能从 parallel multi-agent turn 自动进入。
- 路径 source 必须经过 allowed roots 校验。
- 文档和文件内容进入 agent prompt 前走敏感信息过滤和长度截断。
- API key 不进 frontend bundle。

## 与 Handoff 的关系

Review Room 创建时可以不生成 handoff。只有以下情况需要 handoff:

- 从 Review Room 打开原生 Codex / Claude continuation。
- Fresh Review 需要独立 snapshot。
- 用户导出 review bundle。

Fresh Review 推荐复用 `docs/07-native-continuation-and-handoff.md` 的 context bundle:

```text
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

但 Fresh Review 默认仍可以在 Cockpit 内运行,不必打开原生客户端。

## 实现计划

### Phase 1: 新建入口 + 最小 Review Room

1. 新增 `review-state.json` 类型和读写 store。
2. 新增 `POST /api/review-rooms`,内部创建 group thread。
3. 左侧「新对话」增加 chooser:empty / repository-folder / files / document / existing session。
4. 原生 session detail actions 增加 `Start Review Room`。
5. Review Room 创建后自动进入 parallel review,复用 `/api/group-threads/:id/runs`。
6. 页面先以普通 group timeline + phase header 展示,不做复杂 issue UI。

### Phase 2: Compare + Issue Set

1. 增加 compare run,基于 review transcript 生成 issue set。
2. UI 展示 issue list、共同问题、分歧和推荐下一步。
3. 支持 issue status 手动修改。
4. summary.md 记录 goal、decisions、tasks、file state。

### Phase 3: Fix + Verify

1. 增加 `Fix with Claude/Codex/Manual`。
2. agent fix 走单 agent group run,只允许一个 writer。
3. 手动修复支持 `I fixed it, verify now`。
4. Verify 默认让另一个 agent 或两个 agent 复核。

### Phase 4: Fresh Review

1. 生成 handoff snapshot。
2. 创建 child Review Room。
3. Fresh reviewer 不读取完整 parent transcript,只读取 goal、current solution、decisions、fixed issue summary 和 file refs。
4. Fresh Review 结果回链 parent issue set。

### Phase 5: Serial Discussion

1. 接入 `docs/13` 的 serial mode。
2. Review Room 创建时允许选择 parallel / serial。
3. 对 serial step 状态做 workflow 展示。

## 实现进度

审计日期 2026-07-30(main @ 7f76a99)。本节是 Review Room 的进度事实源:改动落地后更新对应行。
状态取值:`已完成` / `部分完成` / `未开始`。

| Phase | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | `review-state.json` 类型与读写 store | 已完成 | `server/store/review-room-store.ts` |
| 1 | `POST /api/review-rooms` 内部创建 group thread | 已完成 | `server/routes/review-rooms.ts`;`reviewRoomId === groupThreadId` |
| 1 | 「新对话」chooser | 部分完成 | repository / directory / files / document / freeform 已有;**缺 `Existing session` 入口**(从 session 详情页的 `Start Review Room` 反向可达);路径为手输,未接 native file picker |
| 1 | session detail 增加 `Start Review Room` | 已完成 | `src/components/SessionActionsMenu.tsx` |
| 1 | 创建后自动进入 review,复用 `/api/group-threads/:id/runs` | 已完成 | `startReview: true` |
| 1 | group timeline + phase header | 已完成 | `ReviewRoomPanel`(`src/pages/SessionDetail.tsx`) |
| 2 | compare 生成 issue set | 已完成(实现方式与设计不同) | 未用 orchestrator LLM 轮次;改为**确定性解析** agent 回复末尾的 `FINDINGS` JSON 块(`server/review/extract-issues.ts`),GET 时对已完成轮次自动补抽。可见、可追溯、无额外 token 成本 |
| 2 | UI 展示 issue list / 共同问题 / 分歧 / 推荐下一步 | 已完成 | `ReviewCompareView` 按 Jaccard + path 聚类,标出双方共识项 |
| 2 | **issue status 手动修改** | **未开始** | `ReviewIssue` 连 `status` 字段都没有(只有 fix/verify 回填的 `outcome`),store 无 update 方法,compare 视图纯只读 |
| 2 | summary.md 记录 goal / decisions / tasks | 部分完成 | 沿用群聊 summary 机制,未按 Review Room 语义定制 |
| 3 | `Fix with Claude/Codex` | 已完成 | 见上文 §Fix 实现记录(2026-07-30 收口单 writer) |
| 3 | agent fix 只允许一个 writer | 已完成 | `server/review/round-plan.ts` |
| 3 | **`I'll fix manually` / `I fixed it, verify now`** | **未开始** | 用户可手动把下一轮 kind 选成 verify,但没有「手动修复」这个显式状态 |
| 3 | Verify 默认让另一个 agent 复核 | 部分完成 | verify 轮唤醒全部 participants,没有实现「Codex 修则 Claude verify」的默认反选 |
| 4 | 生成 handoff snapshot | 已完成 | `tryBuildHandoffForFresh`;path/freeform source 建不出 handoff 时回落 inline snapshot |
| 4 | 创建 child Review Room | 已完成 | `POST /api/review-rooms/:id/fresh-review`,`extensions.reviewRoom.parentReviewRoomId` 双向可跳转 |
| 4 | fresh reviewer 只读 goal / 决策 / 已修 issue,不读完整 transcript | 已完成 | `buildFreshReviewSnapshot` |
| 4 | **Fresh Review 结果回链 parent issue set** | **未开始** | 只有 `linkFreshReview` 记链接;child 新发现的 issue 不会以 `open` 追加到 parent,parent 也不会标 `verified` |
| 5 | 接入 docs/13 serial mode | 已完成 | 创建时和每轮都可选 parallel / serial |
| 5 | serial step 状态的 workflow 展示 | 部分完成 | timeline 有 `serial_step_start` / `serial_turn_status` 卡片;`StreamingStatus` 没有「第 N/M 步」进度(见 docs/13) |
| — | **`done` 收口阶段** | **未开始** | `ReviewPhase` 有 `'done'`,但 store 从不写它,UI 也没有结束入口;§Done 描述的最终决策/已接受未修问题/后续任务面板不存在 |
| — | **source snapshot stale 检测** | **未开始** | `sourceSnapshot`(gitHead / fileMtimeMs / eventCount)已落盘,但从不与当前状态比对,§上下文来源要求的「标 stale 或显示 source changed」没有实现 |

测试覆盖现状:`server/review/extract-issues.test.ts`(8 例)+ `server/review/round-plan.test.ts`(13 例)。
下方「测试计划」里的**路由级**用例(路径校验 400、非 allowed root、不写原生 CLI 文件、
review-state 损坏可降级为普通 timeline、fresh review 建 child + handoff)**尚未落地**。

## 测试计划

后端:

- repository / directory / files / document source 都能创建 Review Room。
- 非 allowed root 路径返回 400。
- native session source 会记录 source id 和 event count。
- 创建 Review Room 不写原生 CLI 文件。
- parallel review 复用 group run,不新增第二套 adapter 调用路径。
- Fix 阶段同一时间只启动一个 writer agent。
- Fresh Review 创建 child Review Room 和 handoff snapshot。
- review-state 损坏时 group thread 仍能作为普通 timeline 打开。

前端:

- 左侧新对话 chooser 可创建 empty chat 和 Review Room,互不影响。
- 从 session detail 创建 Review Room 后,source 信息正确展示。
- Review Room phase header、participants、permissions 状态正确。
- group parallel composer、single-session follow-up、native resume 不因入口调整漂移。
- 手动检查:
  - 原生 session detail 的单聊 composer。
  - Cockpit group chat 的普通 composer。
  - 新对话 chooser 创建 repository Review Room。
  - Review Room 的 review / fix / verify flow。

## 第一版不做

- 不做多 agent 并行写文件。
- 不自动写回 Claude/Codex 原生历史。
- 不做 live source binding;source 变化只标 stale 或重新 snapshot。
- 不做复杂 PR/diff artifact 管理。
- 不用额外 LLM 当隐藏裁判决定谁对谁错;Compare 输出可见、可追溯。
- 不把 Review Room 做成独立于 group thread 的第二种 transcript 格式。

## 关键取舍

Review Room 应该是「工作流化的 group thread」,不是「另一个聊天系统」。

这个取舍能保留现有 Cockpit 的几个核心不变量:

- transcript 仍只有一份事实源。
- agent run 仍由 RunRegistry 托管。
- 权限、审批、summary、附件和 SSE 都复用已有路径。
- 后续如果 Review Room 设计不合适,仍能退回普通 group thread 查看完整历史。

Fresh Review 应该作为一等动作进入设计。它解决的是同一上下文内模型互相影响的问题,不是普通 verify 的 UI 变体。第一版即使只做 child Review Room + snapshot,也比让用户手动新开会话、复制摘要、再回贴结论更稳定。
