# 04 — UI 设计

> 视觉与交互规范。上层信息架构见 `01 §二`(布局草图)与 `01 §十一`(timeline / summary / filter / warnings)。本文只定"长什么样、怎么交互"。
>
> 设计基调:密集、清晰、可追溯。核心视觉锚点是「灰底原始 / 白底 follow-up」分段和多 agent 头像。

## 一、借鉴来源对照(取什么 / 不取什么)

| 来源 | 取 | 不取 |
|---|---|---|
| **Codex 桌面端** | 侧栏按**项目分组** + 相对时间(2周/3周);composer 底部 **chip 行**;居中空状态 | 极简到无 timeline 结构 |
| **Claude Code 桌面端** | 底部**上下文条**(cwd / branch);**可折叠工具/动作块**;右下**模型/agent 选择器** | Chat/Cowork/Code 三态切换、Create PR 等写操作 |
| **GitHub Primer** | 语义化 color/type/spacing token;紧凑 ActionList;统一 hover/active/focus-visible;用 `rem` 保留浏览器缩放能力 | 不直接引入整套组件依赖,不照搬 GitHub 品牌色与网页信息架构 |
| **多 agent transcript 类工具** | **多 agent 头像化 transcript**(圆头像 + 名 + 时间);失败态直接在气泡里显示 | 产物库 / Agents / 分析 / orchestrator 等重模块 |

## 二、布局:三栏 + 底部 composer

```
┌──────────────┬───────────────────────────────────────────────┐
│ 侧栏(~240px) │ 详情头:[来源]title · cwd · branch · ⟳自动刷新   │
│ 🔍 搜索       │ ⚠ 部分事件未能解析 (3) ›                        │
│ [全部][CC][Cx]│ Tool Activity: 12 调用 · 2 失败 · 4 文件         │
│              │ ┌──── 原始 session(灰底)────────────────┐    │
│ ▸ metering   │ │ 👤 You / 🅒 Claude · thinking› · Read›    │    │
│   Review… 2周 │ ├──── ✦ Cockpit follow-up(紫色虚线)─────┤    │
│   by-model 2周│ │ 👤 You→Codex / 🅧 Codex <streaming…>      │    │
│ ▸ backend    │ │     turn ✓ completed                     │    │
│   token… 3周  │ └──────────────────────────────────────────┘    │
│ ⚙ 设置        │ [发送方式: Cockpit追问 / 回到原会话]            │
│              │ [composer: @claude @codex   ✨Review  🔒  ➤]    │
└──────────────┴───────────────────────────────────────────────┘
```

**三栏可拖拽**:左 SessionList / 中 Timeline / 右 ReviewPanel(可选)均通过 `Splitter` 调宽,在 `~/.cockpit/settings.json` 持久化(`useResizable.ts`)。**侧栏宽度** ~240px 默认。

## 三、设计语言

### 配色策略:颜色编码"来源",不编码"序列"

| 角色 | 浅色填充 | 文字/边框 | 用途 |
|---|---|---|---|
| **Claude 系** | 蓝 `#E6F1FB` | 蓝 `#0C447C` | 头像 C、侧栏 `CC` 角标、详情头来源标 |
| **Codex 系** | 琥珀 `#FAEEDA` | 琥珀 `#854F0B` | 头像 X、侧栏 `Cx` 角标 |
| **User** | 中性灰底 | `--color-text-secondary` | 用户头像、用户气泡 |
| **follow-up 分隔** | — | 紫 `#534AB7` | `✦ Cockpit follow-up` 分隔条 + 虚线 |
| **失败/错误** | `--color-background-danger` | `--color-text-danger` | 失败工具、`turn failed` |
| **成功** | `--color-background-success` | `--color-text-success` | `turn completed`、自动刷新激活 |

- 同一来源在**侧栏角标 / 详情头 / 头像**三处必须同色,全局一致。
- 新增 agent 时从色板挑一条新 ramp(teal / coral / pink),不复用蓝/琥珀。
- 其余一律走 `--color-*` CSS 变量,**禁硬编码 `#333`**,自动适配深色模式(深色跟随系统)。

### 字号 / 字重 / 间距

- 正文 `0.8125rem`(默认 13px,同时保留浏览器缩放能力);紧凑标签 `0.75rem`;辅助文字 `0.6875rem`。标题/session 名 weight 500,其余 400;**只用 400/500 两档**。
- 一律 sentence case,不用 Title Case / 全大写。
- 圆角 `--border-radius-md`(卡片用 `-lg`);边框统一 `0.5px`。
- 代码/工具名/路径用 `--font-mono`。
- 键盘焦点统一使用 `--focus-ring`;不得依赖浏览器默认描边,也不得只提供 hover 而没有 focus-visible。

## 四、组件规范

### 4.1 侧栏 SessionList

- 顶部:搜索框 + 来源/agent 快捷过滤 `[全部][群聊][Claude][Codex][OpenCode][Cursor]`。
  - `群聊` 只过滤 `source='cockpit'`。
  - Claude/Codex 包含对应原生来源(`claude-code` / `codex`)以及 Cockpit follow-up/group 中出现过该 agent 的 session。
  - OpenCode 包含原生来源 `opencode` 以及 Cockpit follow-up/group 中出现过 OpenCode 的 session;Cursor 当前没有原生 session loader,只按 Cockpit follow-up/group 的 `extensions.followupAgents` / `extensions.agents` 过滤。
- **按项目(cwd)分组**,不按来源分组——同项目下 Claude/Codex 混列,来源用角标区分。
- 每条:标题 + 相对时间;第二行显示来源、消息数、follow-up 角标。
- 选中态:白底 + `0.5px` 实线边框;未选中无边框。
- 「新对话」chooser 的 Review Room 来源包含 repository / folder / files / document / existing session / freeform。路径来源同时提供系统 file picker 与手动输入;existing session 可选原生 session、带 follow-up 的 session 或 Cockpit group thread。

### 4.2 详情头 + 双 banner

- 头:`[来源标] title · 📁cwd · ⎇branch`,右侧 `⟳ 自动刷新` 开关(激活=绿)。
- **Warnings banner**(黄,`--color-*-warning`):`⚠ 部分事件未能解析 (N) ›`,可展开看行号/code/message。仅 `warnings` 非空时出现。
- **Tool Activity Summary**:`12 调用 · 2 失败 · 4 文件` 三个 chip,失败 chip 用 danger 色。数据复用 tool pairing 结果(`01 §十一`)。

### 4.3 Timeline(核心)

**灰白分段**:
- 原始 events(`origin:native`)→ 灰底区(`--color-background-secondary`)。
- `followup_boundary` → 渲染成**分隔条**:`✦ Cockpit follow-up` + 紫色虚线,而非简单换底色。让用户一眼知道分隔线以下是 cockpit 加的、不在原生 CLI 文件里。
- follow-up events(`origin:cockpit`)→ 白底区(`--color-background-primary`)。

**头像化消息**:
- 每条 = `圆头像(22px) + 名/时间 + 内容`。头像色按 §三来源色。
- **用户气泡右对齐**(`flex-direction:row-reverse` + info 底色气泡),agent 左对齐——区分用户消息与 agent 消息。
- follow-up 的用户消息名显示 `You → Codex`(带 targetAgent)。

**折叠规则**(借 Claude 桌面端):
- `thinking` **默认折叠**(噪音大),单行 `💡 thinking ›`。
- `tool_use` **默认折叠**,单行 `图标 + 工具名(mono) + 主参数省略`,点开看完整 input;配对的 `tool_result` 折在同一卡内(同 `id` 关联)。
- Codex 只读工具卡右侧标 `🔒 read-only`,把安全语义显示在动作上。
- `assistant_text` / `user_text` **默认展开**。

**轮次状态**:同 `turnId` 末尾显示 `✓ completed` / `✗ failed` / `⊘ aborted`(对应 `turn_status`),失败把可展示错误显示在气泡里。

**虚拟化**:`EventTimeline` 用 `@tanstack/react-virtual`,折叠态高度不定用动态测量(`01 §十一`)。流式追加 / watcher 增量按 `sourceEventId` 去重(`01 §十二 不变量 12`)。

### 4.4 Composer(借 Codex chip 行)

- 多行 textarea,占位 "继续追问,或 @claude / @codex 同时让多个 agent 回答…",`Cmd+Enter` 发送。
- **发送方式切换**(两段开关,位于 chip 行上方):
  - `Cockpit 追问`(默认):走 `/api/threads`,写入 `~/.cockpit/threads/`,原生 jsonl 不动。
  - `回到原会话`:走 `/api/native`,仅原生 session 可用;锁定同源 agent,屏蔽 @mention。
- chip 行:
  - `发送对象`:默认下拉选设置页指定的 agent;**输入 `@claude` / `@codex` 时切换到 mention 多选 chip**(`mention-chip`),发送会并行起多条独立轮次。
  - `🔒 CLI 只读运行`(Cockpit 追问)/ `写入原历史`(回到原会话)语义提示。
  - `✨ 快捷 Review`:预填 `@codex Please review...` 模板,用户可编辑。
  - 右侧圆形发送键;发送中 → 变取消(全局取消所有进行中的流)。
- 底部一行小字根据模式切换:
  - Cockpit 追问:**"通过本机已登录的 {claude|codex} CLI 运行,只读权限"**。
  - 回到原会话:**"将通过本机 {claude|codex} CLI 续写这个原生 session,完成后以原生历史为准刷新时间线"**;并提示桌面端可能需重启才能看到。
- 发送中 → 发送键变取消;流式部分已落盘保留(`01 §五 流程 B`)。

### 4.4.1 Agent 选择器一致性

Agent 相关 UI 是全局组件体系,不是单聊/群聊各自发挥的局部控件。

- Agent 名称、顺序和 label 的唯一来源是 `src/lib/agents.ts` 的 `AGENT_OPTIONS` / `labelForAgent`。
- Agent 图标的唯一入口是 `src/components/AgentIcon.tsx`;页面不直接拼图片、不手写 agent 字母 badge。
- 单选 agent 使用 `AgentPicker`;群聊里的多 agent 展示、@mention 菜单、每个 agent 的模型 picker 必须沿用同一套 icon、label、尺寸节奏、选中态颜色。
- 同一个 agent 在以下位置必须保持一致:侧栏 session 来源、详情头来源、timeline 头像、ReviewPanel 头像、StreamingStatus、composer agent picker、群聊成员/模型设置、@mention 候选列表。
- 单聊和群聊允许交互模型不同:单聊默认一个 agent,群聊可多 agent 并行;但按钮高度、圆角、字体大小、图标尺寸、active/hover/disabled 状态必须来自同一视觉语言。
- 新增 agent 时必须同步检查:`AGENT_OPTIONS`、`AgentIcon.normalizeAgent`、agent CSS class、`FollowupComposer` 的 @mention/模型参数、设置页 CLI 检测、server adapter registry。
- 不允许为了修一个页面的视觉问题而在另一个页面制造不同步;若需要页面特化,先抽出共享 primitive,再用 prop 控制差异。

设置页提供独立的「启用的 Agents」偏好:

- `AGENT_OPTIONS` 始终保留完整注册表,供历史 timeline、来源标识和诊断展示使用;不要按用户偏好删减它。
- 首次没有偏好时,根据本机 CLI 检测结果初始化启用列表;之后只由用户显式调整。
- 未检测到 CLI 的 agent 仍显示在设置诊断中,但不能新开启;已启用列表至少保留一个 agent。
- 启用列表过滤可交互入口:侧栏 agent 快捷过滤、单聊 `AgentPicker`、新建群聊/Review Room、群聊模型与成员控件、@mention 候选和新一轮 Review Room 参与者。关闭当前侧栏 agent 过滤时回到「全部」。
- 已有 session、group transcript 和历史 agent label/icon 不因关闭而隐藏;原生来源到 agent 的映射也不受该偏好影响。
- 当前默认 agent 被关闭时,默认值切到启用列表中的第一项。

### 4.5 ReviewPanel(右侧可拖拽侧栏)

- 详情页右侧抽屉,展示**当前 follow-up 轮次的结构化 review 视图**(verdict / reasons / suggestions),与 timeline 并列,便于"边看 timeline 边对照 reviewer 结论"。
- 宽度可拖拽(`Splitter` 组件),`~/.cockpit/settings.json` 记忆;最小 280px,默认 360px。
- 仅当 follow-up 含 review 结构化字段时显示;纯 markdown 回复时收起。

### 4.6 TraceDrawer(底部抽屉)

- 用于展示某个 turnId 的完整 raw 事件流(含 thinking / 中间 tool_call / usage),便于排查 adapter 行为。
- 默认收起,timeline 上每个轮次状态条尾部有 `查看 trace ›` 触发。

### 4.7 三栏可调布局

- 左侧栏(SessionList)/ 中间 timeline / 右侧 ReviewPanel 之间均有 `Splitter`,宽度持久化到 `~/.cockpit/settings.json`。
- 移动端折叠为单栏(后续扩展,当前不做)。

### 4.8 空状态

详情未选中时居中一句引导("选个 session 看看 agent 干了什么"),借 Codex 居中空状态。

## 五、深色模式

- 跟随系统,默认开启,当前不做手动切换。
- 所有色走 CSS 变量自动适配;来源色(蓝/琥珀)用色板内的浅填充 + 深文字,深色模式下由变量/色板类自动翻转。
- 自测标准:背景若近黑,每段文字仍可读。

## 六、组件清单(对齐 `01 §六` 代码组织)

| 组件 | 职责 |
|---|---|
| `SessionList.tsx` | 侧栏:搜索 / 来源 tab / 项目分组 / session 卡 |
| `SessionDetail.tsx` | 详情头 + banner + timeline + composer 容器 |
| `EventTimeline.tsx` | 灰白分段 + 虚拟化 + 去重追加 |
| `EventItem.tsx` | 按 `NormalizedEvent.type` 分发渲染 |
| `ToolCallCard.tsx` | tool_use + tool_result 配对折叠 + 只读标 |
| `ToolActivityBar.tsx` | 调用/失败/文件 chip(工具活动摘要栏) |
| `FollowupComposer.tsx` | textarea + 双模式开关(Cockpit 追问 / 回到原会话)+ @mention 多 agent + Review 模板 + 只读标 + CLI 提示 |
| `WarningsBanner.tsx` | loader warnings 折叠展示 |
| `ReviewPanel.tsx` | 右侧抽屉,展示结构化 review 结论 |
| `TraceDrawer.tsx` | 底部抽屉,某轮次的 raw 事件流 |
| `Splitter.tsx` + `useResizable.ts` | 三栏宽度拖拽 + `~/.cockpit/settings.json` 持久化 |
| `StreamingStatus.tsx` | 进行中流式轮次的状态指示 |
| `AgentIcon.tsx` | agent 头像/字母 badge 的唯一入口 |
| `AgentPicker.tsx` | agent 选择器(单聊 / 群聊共用) |
| `SessionActionsMenu.tsx` | session 卡片操作菜单(handoff / 删除 follow-up 等) |
| `SettingsPanel.tsx` | 全局设置面板 |
| `NarrativeTimeline.tsx` | timeline 的叙事式简化视图 |
| `PatchDiffView.tsx` | Codex `apply_patch` diff 渲染 |
| `Markdown.tsx` + `CodeBlock.tsx` | Markdown 渲染与代码高亮包装 |
| `FilesHeatmapDrawer.tsx` | 会话涉及文件的热力图抽屉 |
| `JumpToBottom.tsx` | 长 timeline 跳到底部按钮 |
| `Icon.tsx` | 通用图标基元 |

> Timeline 过滤(只看工具/错误/thinking/关键词)当前内嵌在 `EventTimeline` / `SessionDetail` 的头部工具栏,不再作为独立 `TimelineFilter` 组件存在。

## 七、设计不变量(UI 侧)

1. 来源色全局一致(侧栏角标 / 详情头 / 头像同色)。
2. `followup_boundary` 必须渲染成可见分隔条,不能只靠背景色区分。
3. thinking / tool_use 默认折叠;assistant_text / user_text 默认展开。
4. 只读语义必须在 composer 与工具卡上**可见**,不能只藏在设置里。
5. 任何"将通过本机 CLI 运行"的提示必须明示,不暗示数据外发路径。
6. 所有颜色走 CSS 变量 / 色板类,深色模式可读;禁硬编码颜色。
7. Agent 选择、图标、label、顺序、active 状态必须由共享常量/共享组件驱动,单聊和群聊不得分叉实现。
8. 修改 composer、agent picker、model picker、@mention、streaming 状态时,必须同时走查单聊详情页和群聊页。
