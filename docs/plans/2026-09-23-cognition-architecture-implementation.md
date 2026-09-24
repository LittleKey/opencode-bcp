# 认知注入架构调整实施计划（契约基线：DESIGN.md v1.4.6）

> 范围：本轮架构调整的**全部**落地——从当前「有状态目录快照 + 每轮初始机会状态机」实现迁移到 v1.4.6 的事件驱动「可误中的词法提醒机制」+ 认知契约（§11.6/§11.7），并完成 §14.4 验收。不是只做 S+ 增量。
> 定稿链：oracle 终审 APPROVE（指纹 `443cab12…`）；黑板决定 `bb://7dc68da1…/e9b29e2c…/e000001`。本文件为 Orchestrator 内部执行状态。

## Goal

按 DESIGN v1.4.6（含 T0 补缺后的 v1.4.7）完成认知注入架构调整：三常量模板提醒取代目录快照注入、词法信号引擎、工具描述认知契约、task 工具定义注入、验收迁移与 live 验证。

## Scope

**In**：§10 全章重写落地（10.1–10.7）、§11.6/§11.7 认知契约落地、§14.1 语义注记对应的测试迁移、§14.4 新增验收、results.md 已知缺陷②（聚合压力 live 恒不激活）修复、§15① 观察口径。
**Out**：board 工具语义/存储/聚合原子性/权限（不变）；§9 轮次维护语义（不变，仅账本字段演进）；nudge-restore strong/weak 状态机与 board_status/board_disposition（§10.7 搁置，明确不做）；install/uninstall 脚本与回滚 drill（已验证，不重做）；七场景中属业务流程编排的部分只验收不改造。

## 现状（2026-09-23 直读核实）

- `src/nudge.ts`（285 行）：`NudgeLedger=BudgetLedger`（round_id/round_known/round_used/seen_requests/snapshot_version/prompted_set_hashes/initial_fulfilled/last_shown_seq）；`decideNudge` 8 reasons——`initial_reminder`（每 admitted 轮注入快照一次，快照版本去重）、`pressure_reminder`（候选集去重）、6 个去重/降级分支；`roundKnownFor`/`decideAndPersist`（锁内推进/恢复/条件落盘）；`renderSnapshot`（≤2KiB 目录快照）/`snapshotVersionOf`/常量 SNAPSHOT_MAX_BYTES 等。
- `src/plugin.ts`（339 行）：旧极简工具描述（:147-150）；`chat.message` 准入登记（classifyInput + st.admitted）；`experimental.chat.messages.transform` 锁内读块（meta0/requestVerified/snapshotCounts/listIndex/aggregateCandidates→candidateSetId 阈值判定/recentDescriptions/recentSummaries/snapshotVersion）→ `decideAndPersist`（锁外）→ decision 日志（注入+非注入 bytes:0）→ `renderSnapshot` 注入 `part_bb_<lastMsgId>`；`event` session.created 注册兜底。**无 `tool.definition` hook**。
- `src/eligibility.ts`：聚合资格公式（聚合域，不受本轮影响）。
- 测试基线：`bun test` 150 pass / 0 fail、tsc 干净（harness/acceptance/results.md）。plug-* 系列断言 `initial_reminder`/快照行为——须按 §14.1 语义注记迁移。
- 已知缺陷（results.md 收尾发现②）：transform 读块 caller agent 取 `session_index[sessionId].agent` 常为空串 → `aggregateCandidates` 全员 not_original_author → 候选集恒 null → **信号③ live 从未激活**。
- 契约缺口：§10.2 模板②（聚合压力提醒）仅有内容要点（"以 board_index 取候选成员 → board_aggregate 提交折叠"），无逐字常量文案。
- 持久化迁移注意：`~/.cache/opencode/blackboard/v1` 已有旧账本字段；fsck 只核记录域/幂等域，不校验 budget 字段集。

## Work Graph

### T0 — 契约补缺 mini 修订 v1.4.7（owner: doc-1；复核 ora-1；并行波次①）

§10.2 模板②补逐字英文常量（≤512B、不含板数据、条件化表述与模板①同风格——不新增聚合义务，仅当候选确实存在且作者身份适用时提示；内容要点照 :283）。顺带登记：入口事件去重的账本字段属实现细节（§10.3 只约束"账本唯一落盘形状"），不需要契约修订。流程：doc-1 修订（标「[第四轮修订]（T0 补缺）」+ v1.4.7 行 + 指纹重算）→ orchestrator 复算指纹 → ora-1 快速复核（单点变更）。
**acceptance**：v1.4.7 落地、指纹链延续、模板②文案 ora-1 认可；DESIGN 其余零改动。

### T1 — 认知契约文案落地（owner: fixer；写域 `src/constants.ts` 新建 + `src/plugin.ts` 的 hooks.tool 描述与新增 tool.definition 段；并行波次①，与 T3 写域以文件内分区+先后顺序隔离：T1 先行合入）

deliverable：
1. `src/constants.ts` 单源导出：
   - `NORMATIVE_SENTENCE = "If there are reusable findings, publish them and return their board IDs."`
   - `ENTRY_REMINDER_TEMPLATE`：§10.2 :289-291 三句逐字（362B/LF）
   - `PRESSURE_REMINDER_TEMPLATE`：T0 产出的模板②逐字文案
   - `TOOL_DESCRIPTIONS`（board_put/board_get/board_index 按 §11.6 :436 起前三段逐字；board_aggregate 按 §11.6 注记）
   - `TASK_DESC_APPEND`：§11.6 task 段 = advisory 前五物理行逐字 + v1.4.5 追加文案（规范句在交付文本中一个物理行）
2. `src/plugin.ts`：hooks.tool 四工具 description 改引常量；新增 `tool.definition` hook——对宿主 `task` 工具 description 追加 `TASK_DESC_APPEND`（VP-1 已证机制可达；Plugin 返回 `{hooks:{…}}` 直接映射，勿再包一层）。
3. 旧描述字符串删除，禁止出现第二份规范句字面量。

**acceptance**（单测进 T4 汇总）：各描述与 DESIGN 对应段**逐字节相等**（golden 断言）；`TASK_DESC_APPEND` 含子串 === `NORMATIVE_SENTENCE`（import 单源）；`ENTRY_REMINDER_TEMPLATE` ≤512B；`rg` 规范句在 src/ 仅 constants.ts 一处字面量。

### T2 — 词法信号判定引擎（owner: fixer；写域 `src/signals.ts` 新建 + `test/signals.test.ts`；并行波次①）

deliverable：纯函数 `detectSignals(prompt: string): { s1: boolean; s2: boolean }`，严格按 §10.4：
- A1 反引号围栏（列 0 ≥3 反引号开启；N 长只被列 0 ≥N 闭合；未闭合余文全属围栏内）；A2 有限拒绝（围栏外、非列 0 `>` 行中，列 0 以 `~~~` 开头 → **完整扫描后** s1/s2 均 false，不得命中即提前返回）；A3 列 0 `>` 行整行排除。
- s1 = 有效协议区域 `bb://` 子串存在性（裸 scheme 命中；缩进代码/行内代码/HTML 注释/带前导空格引用延续行**不排除**）；s2 = 整行精确等于 `NORMATIVE_SENTENCE`（区分大小写；LF/CRLF 分隔且 `\r` 随分隔符移除；行尾仅 U+0020/U+0009；不裁行首；无其他归一化）。
- 不识别任何其他 Markdown 结构。

**acceptance**：§10.4 判定示例①–⑤ + 边界样例表 14 行（:359-374）逐行命名单测，s1/s2 分开断言；oracle 终审推导表补充用例（P 前导 SPACE/NBSP→false、P 后孤立 `\r`→false、句内折行→false、CRLF 尾→true）全覆盖；`bunx tsc --noEmit` 干净。

### T3 — 提醒系统重构（owner: fixer；写域 `src/nudge.ts`、`src/plugin.ts` transform/chat.message/event 段、`src/storage.ts` BudgetLedger 形状；依赖 T0/T1/T2）

**删除**：`initial_fulfilled`/`snapshot_version`/`last_shown_seq` 字段及其读写；`initial_reminder`/`fulfilled_initial`/`state_unchanged` reasons；`renderSnapshot`/`snapshotVersionOf`/SNAPSHOT_MAX_BYTES/MAX_RECENT_* 常量；transform 读块中 snapshotCounts/listIndex/recentDescriptions/recentSummaries/snapshotVersion 计算；快照文本注入路径。
**保留**：`decideAndPersist` 锁内事务模式（推进/恢复/条件落盘、双 round_known 一致性）；≤2/轮、≤1/请求预算；seen_requests 同请求去重；prompted_set_hashes 候选集跨轮持续抑制；身份不可恢复保守抑制；decision 日志全决策留痕（§10.6）。
**新增**：
1. `BudgetLedger` 增 `entry_prompted_message_ids: string[]`（跨轮持久、无截断，语义同 prompted_set_hashes）；旧字段读取容忍（缺失/多余字段不崩，fsck 不校验 budget 字段集——已核实）。
2. `rollLedgerForNewRound` 不再重置 entry_prompted_message_ids。
3. 入口信号判定：transform 中按 `st.admitted.get(sessionId)` 定位 admitted 消息，取其**原始 parts 文本**（排除本插件 `part_bb_*` 注入 part，防自触发）跑 `detectSignals`；s1||s2 → 注入 `ENTRY_REMINDer_TEMPLATE`（一条注入一次预算，模板不拆分；合并语义）；事件去重按 admitted messageId（§10.3：重放/工具循环/continuation/重启不产生新入口事件，新 admitted 输入可）；同请求入口优先于压力。
4. 压力路径：candidateSetId 计算保留（aggregateCandidates + AGG_TRIGGER_* 阈值），注入 `PRESSURE_REMINDER_TEMPLATE` 取代快照文本。
5. **修复缺陷②**：transform 读块 caller agent 改用注册时登记的 agent（registerScopeContext/chat.message 已有 hookInput.agent，随 scope 缓存传递），不依赖 `session_index` 空串——修后 live 候选集可非空，③可激活。skipAgents/isolated 判定不回归。
6. reasons 枚举：`entry_signal_1`/`entry_signal_2`/`entry_signal_merged`/`pressure_reminder`/`duplicate_hook`/`no_budget`/`set_already_prompted`/`identity_unrecoverable`/`entry_already_prompted`（命名实现细节，日志可观测即可）。

**acceptance**（单测，进 T4）：信号 prompt 首请求注入恰一次（part id 形如 `part_bb_<lastMsgId>`）；同 admitted id 重放/多请求不二次注入；新 admitted 输入（含 bb://）新入口事件成立；无信号零注入且不消费预算；A2 后置撤销最终不注入；预算边界（第 3 次/轮 no_budget 且 bytes:0 留痕）；入口+压力同请求仅入口；压力模板注入 bytes ≤512 且不含板数据；旧账本字段残留数据可读不崩。

### T4 — 测试与验收迁移（owner: fixer；写域 `test/**`；依赖 T1–T3）

1. 迁移 plug-* 中断言 `initial_reminder`/快照/`fulfilled_initial`/`state_unchanged` 的用例 → §14.1 语义注记新语义（M0-1→信号机会、M0-7→同事件不重复注入、M0-8→固定模板 ≤512B）；M0-2/4/9/10、M1 全部、acc-agg-* 保持绿。
2. 新增 §14.4 词法验收自动化部分：边界表逐行（=T2 套件）、产出—识别一致性四子项（描述规范句字节=识别器常量；实际分发文案=§11.6 task 段全文；无标题仅规范句 prompt 触发②；推荐模板触发①②合并）、①②分开断言贯穿、场景 7 反例（明确"不读写黑板"的误提醒任务行为断言——单测层面断言模板第三句保护文案存在+检测不产生工具调用路径）。
3. 全量 `bun test` + `bunx tsc --noEmit`；results.md 追加新章节（历史章节不动，含 L 系列历史证据）。

**acceptance**：全绿；results.md 新章节列明迁移映射表（旧用例→新用例/删除理由）；无跳过且无 TODO 残留。

### T5 — live 验收（owner: orchestrator；依赖 T4；需宿主环境）

1. 重建产物并重装（`bun build` → install.sh 流程；不重做回滚 drill）。
2. 复跑语义变化项：L1（无信号零注入——旧 initial_reminder 消失）、L3/L4（decision reason 分布为新枚举）、L2 隔离不回归；缺陷②修复验证——真实膨胀目录会话触发 ③（候选集非 null → pressure 注入模板②）。
3. §14.4-3 自然委派：中文、英文各一个正常发布委派（task.prompt 由模型按**实际分发 description** 生成，禁人工塞句）；≥1 场景不含 bb:// 单验②；四环节逐段记录（description 分发 → 模型产出 → ②检测 → 接收者行为）；中文含 bb:// 无英文结构场景覆盖①。
4. VP 复验：task.description 追加文案在真实分发中逐字节可见（VP-1 方法）；ACP 共存不干扰（VP-4 方法）。
5. 证据归档 `harness/acceptance/`，live 文档 `docs/live-check-<date>-event-driven.md`；失败路径（如中文场景模型未产出规范句→②未命中）如实登记为 §15①(d) 发现，不放行不修饰。

**acceptance**：上述各段落脚证据文件；②-only 场景成立或登记；reason 分布统计表（供 T7 基线）。

### T6 — oracle 实现复审（owner: ora-1 会话复用；依赖 T4 全绿 + T5 初轮）

范围：实现对照 v1.4.6+v1.4.7 全契约（§10/§11.6/§11.7/§14.4 映射、缺陷②修复正确性、账本迁移安全性）。明确指示：**契约本身非免检真理**——实现揭示契约缺陷则升级回 doc-1/ora-1 修订循环，不得硬改实现迁就或反向篡改契约。
**acceptance**：APPROVE，或材料性发现回 fixer 修正后复审闭环。

### T7 — 观察口径与收尾（owner: orchestrator；依赖 T6）

1. §15① 四项风险的观察口径：基于 decision 日志 reason 分布（误中→entry_signal_* 注入率、漏报→无信号轮占比、A2 拒绝→a2 类 reason 计数、规范句产出失败→②命中/①命中比），定义采样期（建议：两周或 50 个委派任务）与复查触发条件；不新增干预逻辑（advisory §6 第四步：先记录不干预）。
2. 黑板补记架构调整完成决定（supersede 本 stream `bb://e9b29e2c…`）；results.md/live 文档交叉链接；本计划标记完成。

**acceptance**：观察口径一页说明（黑板或 docs）；黑板决定更新；无未闭环项。

## Dependencies / Dispatch 波次

```
波次①（并行）：T0(doc-1, DESIGN) ∥ T1(fixer, constants+描述) ∥ T2(fixer, signals)
波次②：T3(fixer, nudge+plugin 重构)   ← 依赖 T0/T1/T2 全部
波次③：T4(fixer, 测试迁移) → T5(orchestrator, live)
波次④：T6(oracle) → T7(orchestrator)
```
写域隔离：T1 与 T3 都触 plugin.ts——T1 先行完成合入后 T3 才启动（波次保证）；T2 独立文件。

## 全局约束

- DESIGN v1.4.6(+T0 的 v1.4.7) 为唯一契约源；实现遇契约缺口→停线上报走修订循环，禁止即兴设计。
- 常驻文案逐字节来自契约，唯一自由文本是代码注释与测试名。
- 不变项清单（验收基线）：board 工具行为、存储布局、聚合原子性、权限掩码、§9 轮次语义、M0-2/4/9/10 与 M1 全部既有断言、results.md 历史章节。
- 每任务自验后汇报，orchestrator 复核（指纹/断言抽查）再进下一波次。
