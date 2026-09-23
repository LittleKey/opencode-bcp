# 设计缺口文档：DESIGN.md × 第一轮实施/验收（v1.2 复核修订版）

- 仓库：`/home/littlekey/github/opencode-bcp`
- 历史基线：DESIGN.md v1.1（全文 sha256 `80e2b3adcddb5d722d17fb7133c1f6e3edf30d73da32fc760871a3c5b3129843`；第一轮实施/验收时的对照对象）
- 本轮复核依赖：DESIGN.md v1.2（415 行，复核快照 sha256 `b8d8fdcf…`，逐字节快照见 `/tmp/opencode/oracle/gap-review/`）；章节引用一律以**章节名/风险条目名**锚定，行号仅在引用 ora 复核快照时使用（DESIGN.md 在途修订持续漂移，不依赖行号）
- 对照物：第一轮实施（git `52d910d` / `888c037` / `2ed895b`）、harness/live-protocol.md（Phase A 结论 A-C1..A-C8、偏差 D1..D7）、harness/acceptance/results.md（M0/M1 验收、8 项偏差、gated 清单）、src/ 抽查、实测事件切片 doc3-zero-write-events.jsonl（ora gap-review 快照）
- 日期：2026-09-23（经 ora-1 复审后修订：C1 + I1–I6）
- 本文性质：缺口识别与评估记录，供第二轮计划输入；不回写 DESIGN.md、不改 src/**、不提交 git。
- 收尾状态对齐（2026-09-23）：G2、G7/G8 已解决；G1/G3 暂缓（用户裁定 2026-09-23，裁定记录 bb://264c3aca-ba17-4910-a0c1-0d04987f60c3/5d55a273-9ae5-4f6e-844e-118693d26658/e000003）；G4–G6 维持原文。当前自动化基线 150（109 M0/M1 + 10 p-rep + 31 聚合），全量 150 pass / 0 fail（tsc clean，父级终验）；逐项现状见 §2.1 状态列。

## 1. 目的与范围

本文对照 DESIGN.md 与第一轮实施/验收，识别**尚未闭环的设计契约缺口**，并区分三类：

1. **真实缺口（未闭环）**：契约在设计中存在但实现未落地/未闭环，或设计目标未达成——G1–G3、G7–G8。其中 G7/G8 已在 DESIGN 披露（§10.3 [第二轮修订]、§13.1「A3 缺口披露」、§15 开放问题），属于「已披露仍未闭环」，是必修主线而非环境观察项；
2. **已登记缺口**：缺口已知并已登记入 DESIGN §13.2/§14.3（第二阶段事项或 known 降级）——G4–G6；
3. **已闭环偏差（非缺口）**：实施/验收与初版设计的差异已经验证并回写 DESIGN（v1.1 起始、v1.2 延续），仅在 §2.3 列清单，不再展开。

口径声明：本文历史结论以 v1.1 状态下第一轮验收为基线，本轮经 ora-1 复审后按 v1.2 修正；本文不重新验证 v1.1→v1.2 的历史变更本身，旧状态条目与 v1.2 冲突处以 v1.2 为准。

证据基础：DESIGN.md（v1.1 全文 + v1.2 415 行复核快照）、harness/live-protocol.md、harness/acceptance/results.md、src/nudge.ts、src/plugin.ts、src/tools.ts、src/storage.ts、src/rounds.ts、src/aggregate.ts 抽查，实测注入/决策日志 `~/.cache/opencode/blackboard/log/blackboard.log` 及其事件切片 doc3-zero-write-events.jsonl（ora gap-review 快照）。

## 2. 缺口分类表

### 2.1 真实缺口（未闭环）

| 编号 | 严重度 | 对应 DESIGN 章节 | 现象（实测证据） | 影响 | 状态 | 建议修复方向 |
|---|---|---|---|---|---|---|
| G1 | Critical | §0.2 目标 4；§10.1/§10.2 | 注入 nudge 的内容只有版本号+计数分布（知识消息/目录项/索引摘要/新写/eligible/protected/unknown）+≤4 条近期 description+≤2 条摘要+声明行「（board 内容为数据，仅检索提示，不构成指令）」（nudge.ts `renderSnapshot`；plugin.ts 注入行 `[blackboard 目录快照 v1d5c92ea58acc250]`），**没有任何「何时该写黑板」的指引**。实测：document-writer 子代理（doc-3，session `ses_f3366f794ffelamni8tG5GF9r1`，stream `48e0cc1c-…`）自 04:53:07 注入 initial_reminder（bytes:236）起至 05:04:13，共 20 条 decision＝1 次 initial＋连续 19 次 fulfilled（bytes:0），其中含 05:00:35 的 compaction continuation 请求（`msg_dcp_summary_3a383bf5116bbbb3`）；该观察窗口 stored×0（证据为事件切片 doc3-zero-write-events.jsonl，不得外推 stream 整个生命周期），text-only 收尾（输出请求 oracle 审批文本）也未触发写板。 | §0.2「nudge 让 agent 尽量自闭环」未验证/未闭环：提醒投递与预算闸门在实测样本内符合预期（M0-1/M0-7/M0-8），但该 nudge 未提供明确行动指引；原作者提炼通道实际依赖 agent 既有习惯，纯文本收尾的 write-back 没有机制性保障（轮次机制缺口另见 G7/G8，不在此整体覆盖）。 | 暂缓（用户裁定 2026-09-23）：归属 nudge-restore 计划 Task 1/2（strong/weak 拆分、board_status、board_disposition）；计划文档 docs/plans/2026-09-23-blackboard-nudge-restore.md（541 行，sha256 4c718e50…，三轮复审 ready）保留为已批准未执行，恢复实施时按其原文执行 | 先明确选 A（常驻规则/派发指令）或 B（nudge 文本追加固定可信动作指令）；固定可信行为规则与 board 数据分区展示，边界不止于保留「不构成指令」声明行（该声明属 §13.2「board 内容不得升级为系统指令」；§10.6 约束板状态≠执行状态、新旧执行分离、不自动 reopen 等生命周期边界）；发布处置口径覆盖「已发布/not-needed/unavailable（含工具失败）」——不迫使把无法发布伪装成无需发布、不因此反复重试；保持 §10.2 ≤2 KiB 预算与 §10.3 预算规则；纳入第二轮。 |
| G2 | High | §10.5（parent 补写协议） | DESIGN §10.5 定义 parent 补写协议（不自动重开已终结 child；目标已终结、未复用、身份/权限确认后由 parent 请求原作者补写，标 publication_for、不得回退默认 agent、不代写），但§10.5 本身**没有「收结果三选一」条文**。本轮未交付或验证完整的 parent 补写编排协议：父侧触发判断、请求、生命周期检查与验收闭环均未落地；底层工具已支持接收并保存 `publication_for`（tools.ts:30、111）；工具面仅注册 board_put/board_get/board_index 不能证明宿主层或 parent 无法显式请求原作者补写。 | child 漏写时唯一允许的补救路径缺父侧编排实现与验收；「parent 只能代写或放弃」是过度断言——§10.5 允许显式请求原作者，方向未落地属交付缺口而非契约禁止。 | 已解决（nudge-restore 计划 Task 3 落地）：docs/orchestrator/parent-repair-protocol.md（92 行）、scripts/parent-repair-check.ts（340 行）、test/parent-repair.test.ts（189 行、10 例）；119 基线时代合流，父级独立复跑通过 | 第二轮补齐 parent 侧编排与验收闭环：父侧触发（判断值得保存）、生命周期检查（已终结、未复用、身份及权限确认）、请求原作者补写（明确原作者与目标、标 publication_for、不回退默认 agent）、验证与验收；不代写。优先复用既有派发能力，不必预设新增工具。 |
| G3 | Medium | §10（nudge 整体） | 早期设计讨论出现过两级 nudge 概念（强：块内无发布处置记录时要求做出「写/not-needed」判断；弱：已有记录时仅提示；每块至多一次自动强推；unavailable 等发布处置另列——「空板→强」只是简写，非完整条件）。在检查过的可达仓库工件中**未发现完整两级状态机**：DESIGN §10 与实现仅有 initial_reminder/fulfilled_initial/pressure_reminder/duplicate_hook/no_budget/state_unchanged/set_already_prompted/identity_unrecoverable 8 个 reason（nudge.ts），残留概念只有「不立即触发下一次强提醒」（§10.3）与 publication 四态（§10.6）。 | 强 nudge（要求做出判断）缺失，与 G1 同源放大自闭环缺口；「每块至多一次自动强推」的节制机制连带消失——现行预算以轮为单位（§10.3 ≤2 次/轮），而非以块为单位。 | 暂缓（用户裁定 2026-09-23）：归属 nudge-restore 计划 Task 1/2（strong/weak 拆分、board_status、board_disposition），计划文档保留为已批准未执行；根因受限结论保留原文——现有证据最支持 conversation-to-design handoff loss，能定位遗漏阶段，不能确定真实动机 | 记录纠偏先行：将本节受限裁决登记入 DESIGN；行动指引修正并入 G1 立项（A/B 不重复立项，且 A/B 均不恢复完整分级状态机）；完整两级状态机恢复（块/执行身份＋持久化 attempt/disposition 状态）列为需 parent 另行决定的方案。详见本节 G3 根因裁决段。 |
| G7 | High | §9（轮次时钟）；§13.1「A3 缺口披露」；§15 开放问题 | 实施版在 `chat.message` 处取得 `output.message.id` 后即 `applyInput` 推进轮次并滚动预算（plugin.ts:152–179）；请求上下文关联验证（admittedId ∈ 本次请求消息）要到注入侧 transform 才发生（plugin.ts:235–236）。R5a noReply 实测：SDK `session.prompt(noReply=true)` 产生 `chat.message` user 行、transform 行 0 条（live-protocol.md:121）→ 收到 admission 但未进入 runner 的样本会先推进轮次，与 §9「实际进入该 agent 处理」存在差异（「接收即推进」vs「进入才增轮」）。 | 轮次是近期保护、自动聚合资格（created_round）与 nudge 预算的依附单位；提前推进使 created_round/预算滚动口径失真，noReply 等未处理样本污染轮次。 | 已解决（聚合计划 Task C；缺口曾披露于 DESIGN §13.1/§15）：src/nudge.ts decideAndPersist 重写（admittedMessageId 关联验证、advanced/identityRestored、七项值快照比较），src/plugin.ts chat.message 改观察式 ev:"round_observed"；RED 证据 n-red-1/p-red-2（/tmp/opencode/fix/agg-taskC-red.log）；150 基线内回归 | 必修主线：将轮次推进对齐「实际进入处理」（transform 侧验证），或修订 §9 契约并同步实现与验收；不属等待环境补齐的观察项。 |
| G8 | High | §10.3「账本实现 [第二轮修订]」；§15 开放问题 | `decideNudge` 的 duplicate_hook 分支原样返回传入 ledger 对象（nudge.ts:75–76）；已记录请求重复进 hook 且本次 requestVerified=false 时，:185 内存改写 `ledger.round_known = roundKnown`（roundKnown=false）与该对象是同一引用，:186 与 `meta.budget.round_known` 比较不再成立 → :190 不进写入分支（nudge.ts:185–195），磁盘两处 round_known 可保持 true；put 侧仍据此填已知 `created_round`（tools.ts:100–101）；`readMeta` 每次磁盘读（storage.ts:240–245），内存修改不自动持久化。 | 失效侧身份状态未落盘 → created_round 可能携带已失效轮次值。§10.3 保守契约（宁可少提醒、不超预算）不受影响且继续有效，但该偏差不得宣告已满足。 | 已解决（聚合计划 Task C，与 G7 同批；缺口曾披露于 DESIGN §10.3 [第二轮修订]）：decideAndPersist 重写把失效侧身份状态纳入判定并落盘（advanced/identityRestored、七项值快照比较）；150 基线内回归 | 必修主线：duplicate_hook 分支返回副本（或先独立比较）后再判定并落盘；与 G7 同步纳入第二轮，不得作为环境观察项。 |

**G3 根因裁决（oracle，2026-09-23；受限结论）**：**现有证据最支持** conversation-to-design handoff loss——未记录的语义回归，非实施阶段移除；**能定位遗漏阶段（对话→设计交接），不能确定真实动机**，亦不排除未提供的外部草稿或未记录决策。证据链（每步有仓库依据）：①在检查过的仓库可达历史中未发现完整两级状态机——DESIGN.md 三 commit（52d910d/888c037/2ed895b）blob 完全一致（25a396e6…），§10 自始只有 initial-publication + aggregation-pressure 机会、≤2 次/轮、快照去重、parent 补写、无自动 post-final reopen；残留概念仍在 v1.2 §10.3（「聚合失败、模型未调用、主动判断不需要，都不立即触发下一次强提醒」）与 §10.6（publication 四态）两处。②取代者：初始机会（每轮一次，无论板是否为空）+ 聚合压力触发；计划 P13 裁定「初始机会每轮至多一次」（plan L16）；生产接线恒传 candidateSetId:null（plugin.ts:248-254；plan L744）→ 生产路径每轮通常仅一次注入，第二预算槽不是未发布后的重试。③正交性：预算（能否提醒）/强度（要求做什么）/发布处置（已写/not-needed/unavailable）三维正交，强提醒可占用现有初始机会而不增加预算；DESIGN/修订记录/风险登记/实现偏差（results.md:62-71）均**未发现**移除决定记录——这只能证明未发现书面决策，**不能证明作者没做过该选择**。④机制缺口：decideNudge 只收请求身份/轮次/候选集/快照版本，不检查作者是否已发布（nudge.ts:70-73）；首次 eligible 即标记 fulfilled 而不观察写板行为（:99-108）；渲染文本=版本+计数+声明行，无发布/判断指令（:203-229）；观察窗口 04:53:07–05:04:13 共 20 次 decision 零 stored（完整事件切片 25 行＝3 条 round＋22 条 decision，initial×2、fulfilled×20、stored×0；doc3-zero-write-events.jsonl），与实现行为一致；text-only 收尾不触发动作是刻意生命周期策略（§10.1 无成功写入保证；plan L745 排除 text.complete 处理）。⑤验收只测投递闸门：M0-7 接受一次 initial_reminder 后仅 fulfilled_initial、M0-1 以 stored=0 通过；live 写入场景显式请求 board.put，不验证自发发布（plan L785-790）。结论：当前 nudge 缺少明确发布／判断指引，自闭环效果尚未验证、机制仍未闭环；不能由单次零写入推出普遍不可达成。§10.1 不承诺成功写入。最小修正三档：A standing rule/派发指令（零插件改动，最小）；B nudge 文本追加固定可信动作指令（最小插件改动，不恢复分级追踪）；C parent 补写协议（§10.5 已有，兜底非自闭环）。A/B 均不恢复完整分级状态机；精确两级恢复额外需要块/执行身份＋持久化 attempt/disposition 状态（流级计数、轮重置的 initial_fulfilled 不等价），列为需 parent 另行决定的方案。

### 2.2 已登记缺口（§13.2 / §14.3，第二阶段或 known 降级）

| 编号 | 对应 DESIGN 章节 | 现象（证据） | 影响 | 状态 | 建议 |
|---|---|---|---|---|---|
| G4 | §13.2「聚合端到端 gated」；§14.3 第二步；§8 | board.aggregate 未实现：src/aggregate.ts 仅保留 `AggregateInput` 类型与 `AGGREGATE_DEFERRED` 说明，明确不注册工具、不实现机制；plugin.ts transform 中 `candidateSetId` 恒为 null（压力类提醒未接线）；候选集/covered_by/关键词聚合端到端未验收（results.md gated 清单 1，报告编号 M1-4/M1-8/M1-10；DESIGN §14.2 映射表对应原条目 M1-4/M1-10/M1-11）。 | 目录真实膨胀后无救压手段；聚合策略唯一入口。 | 已知、已登记、属第二阶段 | 维持 §14.3 第二步计划，待 M1 live 且目录真实膨胀后另立计划；本文不新增处理。 |
| G5 | §13.2「M0-6 compaction 子场景降级-未满足」 | M0-6 compaction 子场景无法 live 构造，验收记「降级-未满足」（results.md M0-6、gated 清单 3），以 A-C6（压缩语态实测）为支持证据；M0-6 整体不判通过。 | **compaction 相关子场景**未闭环（非所有同会话复用未验证）。 | 已知 | 待具备 live compaction 构造条件时补测（观察项）。 |
| G6 | §13.2「councillor 隔离 live 未验证」 | councillor 隔离 live 未验证：本机无 councillor 运行时，由权限单测（isolation 黑名单、隔离流）承载（results.md gated 清单 4）。 | 独立席隔离的 live 语义未证实。 | 已知 | 待具备 councillor 环境时补 live 专项（观察项）。 |

### 2.3 已闭环偏差清单（非缺口，仅登记）

以下偏差均已在第一轮验证并回写 DESIGN（v1.1 起始、v1.2 延续，对应位置标「[第一轮修订]」），不在本文展开：

| 偏差 | 回写位置 / 实现证据 |
|---|---|
| install .ts 产物（A-C3） | §0.4 V9；results.md 偏差 1 |
| admission 身份源（A-C2） | §0.4 V8；results.md 偏差 2；plugin.ts admission 取 `output.message.id` |
| 下划线工具键 | §11.1 [第一轮修订]；results.md 偏差 5 |
| kind 枚举 | §4 [第一轮修订]；schema.ts KINDS |
| NudgeLedger 别名 | §10.3 [第一轮修订]；nudge.ts 类型别名 |
| R1 双 round_known（幂等恢复侧，已闭环） | §10.3 [第一轮修订]；plugin.ts:171–180 同 admitted messageId 幂等：applyInput 原样返回不增轮，恢复路径同一 writeMeta 置两处 `round_known=true` |
| 非注入决策日志（bytes:0） | §10.1 [第一轮修订]；results.md 偏差 3；plugin.ts 非注入分支 |

注 1：R1 的失效侧落盘（duplicate_hook 分支）未闭环，已登记为 G8（§2.1），不列于本清单。
注 2：results.md 偏差 4/6/7/8（host zod 拦截层级、recentIds 手工构造、harness prompts 补齐、验收登记位置）未作为设计契约回写 DESIGN，与本文缺口判定无关，故不列入。

## 3. 影响评估（对照 §0.2 设计目标）

| 设计目标（§0.2 / 概述） | 当前达成度 | 依据 | 关联缺口 |
|---|---|---|---|
| 信息不失真（概述：parent/child 传递不再依赖模型转述） | 部分 | 已具备原作者记录与不可变引用通道（V7/V8/A-C1/A-C2 live 验证；报告 M1-2/报告 M1-7 基元）；跨 scope 拒绝语义实测（M0-9）仅为访问控制证据。但「实际交接不再依赖转述」不等于内容完整正确——writer 语义限定：不代表内容为真或完整（§4）；通道存在不能推出交接必然经此通道。 | — |
| 原作者自己提炼并发布（目标 1） | 部分 | 写入工具与权限完整且验收通过（M0-3/M0-4/M0-5/报告 M1-1/报告 M1-3）；但缺写入触发（G1）：nudge 不含「何时写板」指引，doc-3 观察窗口 20 次 decision 0 写；parent 补写编排闭环未交付（G2）。 | G1（根因）、G2、G3 |
| 记录不可变、自包含、可独立使用（目标 2） | 部分验证 | 不可变机制有测试支持（§4 hash 约定：报告 M1-2/报告 M1-7 旧 id 字节与 hash 不变、导航投影在 hash 字节之外——报告编号，与 DESIGN 原 M1-7「聚合丢关键证据内容」含义不同）。自包含是语义要求：工具只能校验格式与引用、无法校验语义自包含（§13.2 该风险条目）；不可变/可回取不能证明语义自包含与独立可用。另：报告 M1-2/M1-3 live 专项 gated（results.md:58），自动化覆盖不可与其混同。 | — |
| 支持索引查询与目录层有损聚合（目标 3） | 部分 | board_index compact/all 实测通过（M0-10 声明行；报告 M1-10 本 scope 关键词命中）；聚合（候选集/covered_by/关键词）未实现且端到端未验收。 | G4 |
| nudge 让 agent 尽量自闭环（目标 4） | 未验证/未闭环 | 注入样本内提醒机会与预算闸门符合设计（M0-1/M0-7/M0-8：每轮恰 1 次、bytes≤236、无注入环）；但提醒缺少明确行动引导（G1）→ 自闭环效果未验证；单次零写入样本不能外推普遍不可达成；轮次准入（G7）与失效侧落盘（G8）另登记，不能以「提醒与预算机制正常」整体覆盖；M1-2/M1-3 live 专项 gated（results.md:29-30、58）不可与自动化覆盖混同。 | G1（根因）、G2、G3、G7、G8 |

收尾对齐（2026-09-23）：本表为第一轮时点的达成度评估，证据链保留原文；G2、G7/G8 此后已解决，G1/G3 暂缓（用户裁定 2026-09-23），现状以 §2.1 状态列为准。

## 4. 修复优先级建议

按影响与闭环必要性降序：

收尾对齐（2026-09-23）：P0（G7/G8）、P2（G2）已解决；P1（G1）、P3（G3）暂缓——用户裁定 2026-09-23，归属 nudge-restore 计划 Task 1/2；G4–G6 维持原文。以下保留第一轮时点的原始建议原文。

1. **P0 — G7/G8（High，必修主线，纳入第二轮）**：轮次与身份保守契约纠偏。G7：轮次推进对齐「实际进入处理」（transform 侧验证），或修订 §9 契约并同步实现与验收；G8：duplicate_hook 失效侧落盘修复。两项 DESIGN 已披露仍未闭环，至少与 G1 同级，不属等待环境补齐的观察项。
2. **P1 — G1（Critical，纳入第二轮）**：先明确选 A（常驻规则/派发指令）或 B（nudge 文本追加固定可信动作指令）；固定可信行为规则与 board 数据分区展示，边界不止于保留「不构成指令」声明行——该声明属 §13.2，§10.6 约束板状态≠执行状态等生命周期边界。发布处置覆盖「已发布/not-needed/unavailable（含工具失败）」：不迫使把无法发布伪装成无需发布，也不因此反复重试；保留 §10.2/§10.3 预算与不自动 reopen 限制。回归口径：doc-3 类观察窗口 0 写场景须变为「有记录、或显式 not-needed 说明、或 unavailable 留痕」之一。
3. **P2 — G2（High，纳入第二轮）**：补齐 parent 侧编排与验收闭环（父侧触发判断、生命周期检查、请求原作者补写、验证与验收）；不代写；优先复用既有派发能力，不预设新增工具；底层 board_put 已支持 publication_for（tools.ts:30、111）。
4. **P3 — G3（Medium）**：设计记录纠偏先行——把本节受限裁决（现有证据最支持 handoff loss，动机未定）登记入 DESIGN；行动指引修正并入 P1 立项，不重复立项；完整两级状态机恢复（块/执行身份＋持久化 attempt/disposition 状态）列为需 parent 另行决定的方案。
5. **G4（第二阶段，已登记）**：维持 §14.3 第二步计划（M1 live 且目录真实膨胀后另立 aggregate 计划），第二轮无需新动作，仅跟踪。
6. **G5 / G6（环境补齐后补测）**：分别待 live compaction 可构造、councillor 运行时可用时补测，属观察项，不阻塞第二轮主线。

## 5. 证据索引

| 实测证据 | 位置 | 支撑条目 |
|---|---|---|
| doc-3 零写事件切片 | doc3-zero-write-events.jsonl（ora gap-review 快照；session `ses_f3366f794ffelamni8tG5GF9r1`、stream `48e0cc1c-…`）：完整切片 25 行＝3 条 round＋22 条 decision（initial×2、fulfilled×20、stored×0）；窗口 04:53:07–05:04:13 共 20 条 decision（1 次 initial＋连续 19 次 fulfilled）；窗口 04:58:50–05:04:13 连续 14 次 fulfilled；首个 initial 所属轮次的日志 `current_round=2`（非元数据第一轮）。stored×0 限定为该切片窗口，不得外推 stream 整个生命周期。 | G1 |
| 注入快照内容结构 | src/nudge.ts `renderSnapshot`（head=版本+六类计数；tail=「不构成指令」声明行；无写板指引）；src/plugin.ts 注入行 `[blackboard 目录快照 v${snapshotVersion}]` | G1 |
| parent 补写协议与工具面 | src/plugin.ts:146-148（3 工具）；src/tools.ts:30、111 已接受保存 publication_for；父侧编排闭环未交付（第一轮时点；收尾对齐：已由 nudge-restore Task 3 交付闭环） | G2 |
| 聚合未实现、压力提醒未接线 | src/aggregate.ts（仅类型+`AGGREGATE_DEFERRED`）；src/plugin.ts `candidateSetId: null`；results.md gated 清单 1 | G4 |
| 分级 nudge 证据（受限） | src/nudge.ts NudgeReason 8 取值（无强/弱）；DESIGN.md 三 commit blob 一致（25a396e6…），完整两级状态机未见于可达工件；残留概念见 DESIGN v1.2 §10.3、§10.6 | G3 |
| M0-6 降级、councillor 承载 | results.md M0-6 行、gated 清单 3/4；DESIGN §13.2「M0-6 compaction 子场景降级-未满足」「councillor 隔离 live 未验证」两风险条目 | G5、G6 |
| Phase A 结论与偏差 | harness/live-protocol.md A-C1..A-C8、D1..D7 | §3 达成度依据 |
| G7 轮次准入（接收即推进） | src/plugin.ts:152–179（chat.message 即 applyInput 推进轮次+滚动预算）、:235–236（requestVerified 于 transform 侧校验）；harness/live-protocol.md:121 R5a noReply（chat.message 有、transform 0 条）；DESIGN v1.2 复核快照 §13.1「A3 缺口披露」、§15 开放问题 | G7 |
| G8 失效侧落盘 | src/nudge.ts:75–76（duplicate_hook 返回原 ledger）、:185–195（同引用比较、不入写分支）；src/tools.ts:100–101（按盘上 round_known 填 created_round）；src/storage.ts:240–245（readMeta 磁盘读）；DESIGN v1.2 复核快照 §10.3 [第二轮修订] | G8 |
