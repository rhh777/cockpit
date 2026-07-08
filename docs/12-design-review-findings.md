# 12 — 设计评审问题清单与修复进度

2026-07-08 对全量代码与文档做的一次设计评审。本文档是修复工作的唯一进度事实源:
每修完一项,更新对应条目的**状态**并在文末「进度记录」追加一行。

状态取值:`未开始` / `进行中` / `已完成` / `不修复(写明理由)`。

## 总览

| ID | 分类 | 问题 | 严重度 | 状态 |
|---|---|---|---|---|
| A1 | 文档失真 | CLAUDE.md / docs/06 称「后台运行未实现」,与代码矛盾 | 高 | 已完成 |
| A2 | 文档失真 | docs/03「当前不做」仍称不允许写盘/无审批层 | 高 | 已完成 |
| B1 | 架构冗余 | legacy `/messages` 三条路径与 run-registry 双实现,前端已不调用 | 高 | 已完成 |
| C1 | 安全 | 流式 delta 绕过 redactSecrets,实时回显未脱敏 | 高 | 不修复(已文档化) |
| C2 | 安全 | 审批通过即 session 级放行整个工具(如所有 Bash) | 中 | 未开始 |
| C3 | 安全 | 降噪路径(node_modules/dist)与安全路径(.env/.ssh)混用同一黑名单 | 中 | 已完成 |
| D1 | 扩展性 | server 侧多处硬编码 agent 名与能力判断,违反 docs/01 扩展点约定 | 中 | 已完成 |
| E1 | 序列化 | 群聊上下文在 run-registry 手搓 prompt,再被 serializeForAgent 二次包装 | 中 | 未开始 |
| E2 | 序列化 | 「当前请求去重」靠文本相等,带附件必失效导致重复 | 中 | 已完成 |
| E3 | 序列化 | `maxChars: 24000` 写死,docs/01 承诺的「设置里可调」未接线 | 低 | 已完成 |
| F1 | 实时 | watcher 每次变化全量重读重解析整个 session,追加密集时 O(N²) | 中 | 未开始 |
| F2 | 实时 | `tryWatch` 对尚不存在的文件返回 null 后永不重建 | 中 | 已完成 |
| F3 | 实时 | 前端活跃 run 期间丢弃 session stream append,而非按 sourceEventId 去重 | 中 | 已完成 |
| G1 | 资源 | `RunHandle.replay` 无上限,含全部 delta,重连全量重放 | 中 | 已完成 |
| G2 | 并发 | `startGroupTurn` 互斥检查与登记之间隔多个 await,有竞态窗口 | 低 | 已完成 |
| G3 | 数据完整性 | native resume 走自动重试,可能在原生历史里写入重复 user turn | 中 | 已完成 |
| G4 | 体验 | 列表 `updatedAt` 只取原生 mtime,follow-up 活动不影响排序/分组 | 低 | 已完成 |

## 条目详情

### A1 · 「后台运行未实现」与现实矛盾(文档失真,高)

- **现象**:`CLAUDE.md` 加粗声明「后台运行(docs/06)仍是设计稿,未实现——切换 session 会 abort 当前 CLI 子进程」;`docs/06` 的「现状」一节同样描述实现前状态。但 `server/runs/run-registry.ts` 是完整实现,前端(`src/lib/sse.ts` 的 `startFollowupRun`/`attachRunStream` 等)已全面走 `/runs` 路径,`docs/03 §后台运行` 也说已实现。
- **危害**:CLAUDE.md 是所有协作者(人/agent)的第一手指引,这条错误声明会直接把后续改动引向错误前提。
- **修复方向**:更新 CLAUDE.md 相应段落;重写 docs/06「现状」为已实现状态说明。

### A2 · docs/03「当前不做」与审批/写权限实现矛盾(文档失真,高)

- **现象**:`docs/03` 「当前不做」称「不允许 follow-up agent 写盘;写权限与审批层留作后续扩展」,但 `server/permissions/adapter-policy.ts` 已有 `auto-safe`/`full-access` 档,`server/approvals/` 审批状态机已实现,docs/09 是成文设计。同一文档「后续方向」也仍把「写权限与审批层」列为未来项。
- **修复方向**:把 docs/03 的能力清单、「当前不做」、「后续方向」三处改成与 docs/09 及实现一致的表述。

### B1 · legacy `/messages` 双实现(架构冗余,高)

- **现象**:三条 legacy 路径与 run-registry 几乎逐行重复:
  - `server/routes/threads.ts handlePostMessage` ↔ `run-registry.executeFollowup`
  - `server/routes/native.ts /messages` ↔ `executeNativeResume`
  - `server/routes/group-threads.ts /messages(legacy)` ↔ `executeGroupMember`
  - incremental 门槛常量在 `threads.ts` 与 `run-registry.ts` 两处靠注释「改动时同步更新」。
- 前端的 `postFollowupStream` / `postNativeResumeStream` / `postGroupMessageStream`(`src/lib/sse.ts`)**无任何调用者,是死代码**。
- **行为分叉**:legacy 路径不接收 `permissions`、无审批流、不支持附件——直接 POST 该端点绕过 run 权限模型。
- **修复方向**:删除三条 legacy 路由与前端死代码;`INCREMENTAL_*` 常量收拢到单一模块。若要保留兜底,必须收口成 run-registry 的薄壳而非独立实现。
- **修复记录(2026-07-08)**:
  - 删除 `server/routes/native.ts` 整个文件(`/api/native/:src/:id/runs` 由 `routes/runs.ts` 覆盖);
  - `threads.ts` 只保留 DELETE 清空/回删,legacy POST handler 及 incremental 常量副本移除(常量单一来源现为 `run-registry.ts`);
  - `group-threads.ts` 移除 legacy `handlePostMessage`/`projectContext`/`activeTurns` 等 ~250 行,cancel 统一走 `runRegistry.cancelGroupTurn`;
  - `src/lib/sse.ts` 删除 `postFollowupStream` / `postNativeResumeStream` / `postGroupMessageStream` 死代码;
  - 同步 docs/01(L3 端点、流程 B、模块树)、docs/05、docs/06、docs/10 及 `docs/assets/10-agent-integration.svg`;
  - 验证:`pnpm typecheck` 通过、94 个单测全绿、dev server 冒烟(session 列表 200,三个 legacy 端点 404,`/api/runs` 200,无 console 错误)。
  - 备注:`DELETE /api/threads/...` 两个端点保留但当前前端也没有调用方(与 B1 无关,属独立功能,不在本项范围)。

### C1 · 流式 delta 绕过脱敏(安全,高)

- **现象**:`redactSecrets` 按行匹配(`server/adapters/sensitive.ts`),但 `run-registry.executeFollowup` / `executeGroupMember` 对每个 token 级 delta 单独调用它,正则几乎不可能在碎片上命中。落盘的终态整段文本会被正确脱敏,但用户实时看到的流未脱敏——docs/01 §十「过滤作用于两端」在流式路径失效。
- **修复方向**:对同一 `streamId` 的 delta 在 server 侧做行缓冲(按换行 flush),整行过完 redactSecrets 再下发;或在合并边界上做滑动窗口匹配。修完后在 docs/01 §十注明流式语义。
- **决策(2026-07-08,用户确认)**:接受现状 + 写清边界,不改代码。理由:
  - 该缺口只影响"直播窗口期的屏幕显示"(屏幕共享/录屏时密钥闪现);落盘(②)与下一轮 prompt(③)都是整段脱敏,不会把密钥持久化或传给其他 agent;tool_result 不走 delta,不受影响。
  - 任何有效的流式脱敏都要 server 侧缓冲,会削弱刚实现的打字机效果(e710809),对本机单人工具不值得。
  - 已在 docs/01 §十与 `server/adapters/sensitive.ts` 头注释写明边界与重启条件:cockpit 走出本机(远程访问/多人/常态化录屏)时,改用小窗口滞后方案(每 streamId 保留 ~80 字符尾部缓冲 + span 级掩码)补齐。

### C2 · 审批放行粒度过粗(安全,中)

- **现象**:`server/adapters/claude-call.ts permissionUpdatesForApproval` 在批准后追加 `addRules: {toolName}` 的 session 级 allow——批准一次 `Bash(ls)` 等于本 session 放行所有 Bash。代码中无注释说明这是有意取舍。
- **修复方向**:要么改为带具体 rule content 的精确放行(如 `Bash(ls:*)`),要么保持现状但在代码与 docs/09 写明「批准即 session 级放行该工具」是有意的产品决策。

### C3 · 降噪与安全混用一个黑名单(安全,中)

- **现象**:`SENSITIVE_PATH_PATTERNS` 里 `.env`/`.ssh`/`.aws` 与 `node_modules/`/`dist/`/`build/` 同列,命中即整段 tool_result 替换为「已屏蔽敏感内容」。读依赖源码是 reviewer 常见动作,被安全话术挡住,既误导又损功能。
- **修复方向**:拆成两组语义——安全组保持整段屏蔽;降噪组改为截断或直接放行(tool_result 已有大输出收缩),UI 文案区分。
- **修复记录(2026-07-08)**:`node_modules/`、`dist/`、`build/` 从整段屏蔽黑名单移除——降噪已由 context-projector 大输出收缩 + serialize `maxToolOutputChars` 截断覆盖,内容级密钥扫描(redactSecrets)仍对所有输出生效;`.git/` 保留(config 可能内嵌带 token 的 remote URL)。docs/01 §十同步。

### D1 · server 硬编码 agent 名与能力(扩展性,中)

- **现象**:docs/01 扩展点明确「不在 UI/server 任何地方硬编码这两个」,但:
  - `run-registry.ts` 有 `sessionAgentOf` / `agentName` 两个硬编码映射;
  - 审批能力靠 `targetAgent === 'codex' || targetAgent === 'claude'` 判断(followup 与 group 两处);
  - `serialize.ts agentSpeaker` 又一份显示名映射。
- **修复方向**:把 `displayName`、`supportsApproval`、`nativeSource` 等挂到 `ReviewAgent` 接口 / adapter registry,run-registry 与 serialize 从 registry 取。
- **修复记录(2026-07-08)**:
  - `ReviewAgent` 新增可选 `displayName` / `supportsApproval`;五个 adapter 各自声明;
  - 新增零依赖叶子模块 `adapters/agent-meta.ts` 承载显示名(registry 注册时写入),serialize 从它取,避免 serialize→registry→adapter→serialize 循环导入;
  - registry 新增 `agentForNativeSource(source)`(canResumeNative 反查),run-registry 的 `sessionAgentOf` / `agentName` 硬编码映射删除;
  - 审批能力判断由 `targetAgent === 'codex' || 'claude'` 改为 `agent.supportsApproval`(followup 与 group 两处);
  - 前端两份本地 `sessionAgentOf`(SessionDetail / SessionActionsMenu)收进 `src/lib/agents.ts`(`sessionAgentOf` / `nativeAgentForSource`),符合 CLAUDE.md 共享事实源规则。
  - 遗留:`run-registry.startCodexContinuation` 与 `nativeLinked`(codexAcceleratedMode)本身就是 Codex 专属特性,保留显式 codex 引用属合理。

### E1 · 群聊 prompt 套 prompt(序列化,中)

- **现象**:`run-registry.projectGroupContext` 手搓完整群聊 prompt,包成一条合成 `user_text` 传给 adapter;adapter 内部再套 `serializeForAgent` 的 `# Original Session / ## User Goal` 模板。结果群聊 prompt 以「User Goal」的名义出现,当前请求文本重复两遍;序列化职责分裂在两处,不变量 8 名存实亡。
- **修复方向**:给 `serializeForAgent` 增加 group 模式(或独立的 `serializeForGroupAgent` 同层实现),群聊上下文构建收回序列化边界内;run-registry 只传结构化数据。

### E2 · 当前请求去重靠文本相等(序列化,中)

- **现象**:`serialize.ts` 用 `ev.text.trim() === currentText.trim()` 从 history 剔除当前消息;但 run-registry 传给 adapter 的 `text` 是 `withAttachments()` 拼过附件行的版本,而落盘 user_text 是原文——带附件时判断必然失败,当前请求出现两次,违反 docs/01 §九「当前触发消息只出现一次」。
- **修复方向**:按 `turnId`(当前 run 的 turnId)或 sourceEventId 剔除,不比文本;`withAttachments` 的拼接挪到序列化内部统一处理。
- **修复记录(2026-07-08)**:
  - `run-registry.executeFollowup` 在构建 contextEvents 前按当前轮 `turnId` 剔除已落盘的 user_text / run_permissions;
  - `serialize.ts` 移除文本相等去重,`AgentRunInput.contextEvents` 契约改为「不含当前请求」(types.ts 注释 + docs/01 §九);
  - 群聊路径核实无此问题(`appendEvent` 返回 append 前 index,`slice(0, baseEventSeq)` 已排除当前消息);
  - `withAttachments` 拼接保持原位:历史中已无当前消息,附件行只出现在 Current Request,重复问题结构性消除;
  - serialize.test.ts 更新为新契约测试;typecheck + 94 单测通过。

### E3 · serialize maxChars 写死(序列化,低)

- **现象**:`DEFAULT_SERIALIZE.maxChars = 24000` 无任何外部接线;docs/01 §十说「用户可在设置里调」。
- **修复方向**:接入设置(server 可读的 settings 或请求参数),或修改 docs 移除该承诺。
- **修复记录(2026-07-08)**:选「修文档」——docs/01 §十改为准确表述(代码内常量,不提供设置项,需要时再加请求级参数)。为没人调的旋钮加 server 侧设置管道不值得。

### F1 · watcher 全量重解析(实时,中)

- **现象**:`server/watcher/session-watcher.ts reload` 每次(50ms 防抖)调 `loadSessionDetail` 重新解析整个 JSONL;native CLI 活跃写入时是 O(N²)。前端虚拟化支撑「MB 级 session」的目标被后端全量 reparse 抵消。
- **修复方向**:记录上次读到的 byte offset,追加场景只读增量行(仅当文件变短/中段变化才全量);或至少缓存 native 段解析结果。

### F2 · 不存在的文件永远 watch 不上(实时,中)

- **现象**:`tryWatch` 失败(文件尚不存在)返回 null,订阅期间无重建机制。订阅时还没有 followups.jsonl 的 session,第一条 follow-up 落盘不会触发推送(本窗口 run stream 兜底,但双窗口/Electron+浏览器并开时另一端看不到)。
- **修复方向**:watch 父目录,或在 reload 成功后检测「watcher 为 null 但文件已存在」时补建。
- **修复记录(2026-07-08)**:新增 `ensureWatchers`——watcher 建不齐时每 2s 补建(REBUILD_INTERVAL_MS,unref 不阻进程退出),新建成功即触发一次 reload 补上 watch 建立前写入的内容;watcher error(文件被删/换 inode)也走同一补建路径;退订时清理补建 timer。
  - 新增 `session-watcher.test.ts` 功能测试:订阅时 followups.jsonl 不存在 → 落盘第一条 follow-up → ~2s 内收到 append。

### F3 · 活跃 run 期间丢弃而非去重(实时,中)

- **现象**:`SessionDetail.tsx` 在 `streamsRef.current.length > 0` 时直接丢弃 session stream 的 append;不变量 13 说的是「按 sourceEventId 去重」。丢弃窗口内原生文件若同时增长(用户在终端继续原生会话),事件不会补回,直到下次 reset/切页。
- **修复方向**:恢复消费 + 按 `sourceEventId` 去重(seenIds 已存在);或 run 结束后做一次 changes 对齐。
- **修复记录(2026-07-08)**:采用「run 结束后 changes 对齐」方案——run 期间的丢弃保留(有意:避免 reset 全量重拉与打字机 pacer / 流式中间态冲突),在 `streams.length > 0 → 0` 转换时调一次 `fetchChanges(eventsLen)`:reset/变短走全量 `resetFrom`,否则 `appendEnvelopes` 增量补回(sourceEventId 去重兜底重复)。guard 与订阅 effect 一致(autoRefresh/loading/error)。
  - 验证:typecheck + 97 单测通过;preview 打开 session 详情页无 console 错误。streams 转换路径需真实 agent run 才能端到端触发,逻辑与既有 runPoll 兜底一致。

### G1 · RunHandle.replay 无上限(资源,中)

- **现象**:`replay` 数组记录包括全部打字机 delta 在内的所有消息,完成后仍驻留 5 分钟;长回复一次 run 可达数万条,重连 attach 全量逐条重放。
- **修复方向**:replay 内对同 `streamId` 的 delta 合并成快照(与落盘策略一致);终态后可只保留合并结果。
- **修复记录(2026-07-08)**:
  - `RunHandle.write` 内新增 `mergeDeltaIntoReplay`:同 `streamId` 的相邻 delta 克隆合并成一条累积 delta(保留首个 sourceEventId,顺序不变);实时订阅者仍收原始碎片,重连 attach 收合并结果,UI buildTimeline 本就按 streamId 拼接,语义等价。
  - replay 体积由 O(token 数) 降为 O(非 delta 事件数 + stream 数);非 delta 事件与实际工具调用量同阶且重连正确性依赖它们,故未加硬性条数上限(有意取舍)。
  - 新增 `server/runs/run-registry.test.ts` 三个用例(合并/不跨界合并/实时 vs 重放)。

### G2 · startGroupTurn 互斥竞态(并发,低)

- **现象**:`groupTurns.has(input.id)` 检查与 `groupTurns.set` 之间隔多个 await,并发两次唤醒可同时通过检查。
- **修复方向**:检查通过后立即同步占位(再做 async 工作,失败时回滚),或引入 per-thread 互斥队列。
- **修复记录(2026-07-08)**:`has()` 检查 + `pending` 占位在任何 await 之前同步完成;主体包 try/catch,失败回滚占位;成功后被真实 ActiveGroupTurn 覆盖,完成路径仍由 Promise.all().finally 删除。

### G3 · native resume 自动重试可能重复写原生历史(数据完整性,中)

- **现象**:`runClaudeWithRetry` 同样作用于 `resumeNative`;若首次尝试在 CLI 已把 user 消息 append 进原生 jsonl 后才因网络失败,重试再次 `--resume` 会造成原生历史重复 user turn。与「原生文件只由官方 CLI 写、cockpit 保守对待」的项目哲学冲突。
- **修复方向**:resume 路径禁用自动重试(交给用户手动重试),或重试前校验原生文件是否已增长。
- **修复记录(2026-07-08)**:claude adapter 的 `resumeNative` 不再包 `runClaudeWithRetry`,直接单次 `runClaudePrint --resume`,失败交给用户手动重试(代码注释写明理由);codex adapter 本无重试逻辑,核实无需改动。普通 follow-up(写 cockpit 自有目录)保留重试。

### G4 · updatedAt 不感知 follow-up(体验,低)

- **现象**:`sessions-service.ts` 的 `updatedAt` 只取原生文件 mtime;刚聊完 follow-up 的 session 不会浮到列表「今天」。`hasFollowups` 有回填,时间没有。
- **修复方向**:`updatedAt = max(原生 mtime, followups.jsonl mtime)`,列表与详情同源。
- **修复记录(2026-07-08)**:threadStore 新增 `followupsMtimeMs()`;`listSessions` 与 `loadSessionDetail` 的 `updatedAt` 都取 `max(原生 mtime, followups mtime)`。

## 建议修复顺序

1. **A1 / A2**(零风险,纠正协作前提)
2. **B1**(删掉双实现,后续所有修复只需改一处)
3. **C1**(安全承诺与实现的真实差距)
4. **E2 / G1 / F3**(正确性与资源,改动面小)
5. **D1 / E1**(扩展性重构,受益于 B1 已完成)
6. **F1 / F2 / C2 / C3 / G2 / G3 / G4 / E3**(按需排)

## 进度记录

| 日期 | 条目 | 动作 | 说明 |
|---|---|---|---|
| 2026-07-08 | — | 建立本清单 | 评审基线:main @ d6f0a3e |
| 2026-07-08 | A1 | 已完成 | 更新 CLAUDE.md 后台运行声明;重写 docs/06「现状」为已实现说明 |
| 2026-07-08 | A2 | 已完成 | docs/03 能力清单/当前不做/后续方向与 docs/09 及实现对齐 |
| 2026-07-08 | B1 | 已完成 | 删除三条 legacy `/messages` 路由 + 前端死代码;文档/SVG 同步;typecheck + 94 单测 + dev 冒烟通过 |
| 2026-07-08 | C1 | 不修复(已文档化) | 用户确认接受现状;docs/01 §十 + sensitive.ts 头注释写明流式边界与重启条件 |
| 2026-07-08 | E2 | 已完成 | run-registry 按 turnId 剔除当前轮;serialize 移除文本相等去重;contextEvents 契约改为不含当前请求 |
| 2026-07-08 | G1 | 已完成 | RunHandle.replay 同 streamId 相邻 delta 合并;新增 3 个单测(97 全绿) |
| 2026-07-08 | F3 | 已完成 | run 结束时(streams 清空)做一次 changes 对齐,补回丢弃窗口内的文件增长 |
| 2026-07-08 | G2 | 已完成 | startGroupTurn 互斥占位改为 await 前同步执行,失败回滚 |
| 2026-07-08 | G3 | 已完成 | claude resumeNative 禁用自动重试,防止原生历史重复 user turn |
| 2026-07-08 | G4 | 已完成 | updatedAt 取原生与 followups mtime 较新者,列表/详情同口径 |
| 2026-07-08 | F2 | 已完成 | watcher 周期补建(2s)+ error 重建;新增功能测试验证首条 follow-up 可推送 |
| 2026-07-08 | C3 | 已完成 | node_modules/dist/build 移出整段屏蔽黑名单,降噪交给截断,密钥扫描仍全量生效 |
| 2026-07-08 | E3 | 已完成 | docs/01 移除「设置里可调」未兑现承诺,明确为代码内常量 |
| 2026-07-08 | D1 | 已完成 | agent 显示名/审批能力/原生来源反查收口到 ReviewAgent + registry;前端 sessionAgentOf 收进 lib/agents |
