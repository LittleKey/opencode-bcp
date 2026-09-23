# 跨 agent 黑板（opencode-bcp）nudge 恢复第二轮实施计划

- 计划文件：`docs/plans/2026-09-23-blackboard-nudge-restore.md`
- 依据缺口文档：`docs/design-gaps-2026-09-23.md`（94 行，sha256 `173ca4ccb12abcfa0bce272d9a09f7df0989da8b3d09b91a73cd6a2b4cf1208c`，ora 终审 ready）
- 权威设计（只读基线）：`DESIGN.md` v1.3（417 行，sha256 `e3d71488ff0901b13092e14c7352af86cdf2ce9c5be2a7135f8eacfb975f2177`；本计划回写产出 v1.4）
- 交叉引用：聚合第二步计划 `docs/plans/2026-09-23-blackboard-aggregation.md`（813 行，sha256 `0a73b264c37358c695e98289920bd827385cf7ed7f58d729d5ea605715aeba42`），其 Task C 拥有 G7/G8 修复
- 日期：2026-09-23
- 验证 owner：父级编排

## Goal

在既定黑板契约内重建**强/弱两级 nudge 状态机**（轻提醒形态：三个计数 + 常量动作指令；详情经新增的第 6 工具 `board_status` 按需自查），闭环缺口文档 G1（写入触发指引）、G2（parent 补写编排协议）、G3（分级 nudge 恢复 + DESIGN 回写），并将 G7/G8 作为前置依赖与聚合计划 Task C 对齐（不重复实现）。验收基线：既有自动化回归不破坏；新增用例覆盖两级状态机与 board_status 全生命周期。

## Architecture

```
每轮（admitted round）一次初始机会 → 锁内判定强度：
  strong ⇔ 本轮本 stream 无本 agent 发布记录
           ∧ 无 not-needed 声明 ∧ 无 unavailable 声明
           ∧ strong_attempted == false
  否则   → weak
注入形态（append-part，同一位置，单 part，整体 ≤300 B）：
  [blackboard 提醒]          ← 首行锚（rounds.ts SYNTHETIC_RE 绑定 ^[blackboard，
                               注入自识别为合成、不增轮——锚不可动）
  知识 N / 目录 M / 新写 K    ← 唯一数据行（三个计数；新写=new_since_last_shown
                               既有口径，status 查询不清零）
  动作指令（常量，按 reason 三选一：strong/weak/pressure 模板见 Task 2）
  无描述、无摘要、无版本号展示、无省略循环
  （超界靠测试失败暴露，不存在运行时截断路径）
按需详情：board_status（第 6 工具，仅查自身 stream）——
  发布事实（total/this_round/last_available）+ 持久化处置状态 + 轮次账本观察值；
  不证明消息覆盖水位（无 covered_through 类字段）、不决定是否该写、
  不改变提醒账本（recover-on-read 属既有恢复契约，不算业务副作用）。
持久化：per-round disposition 落盘于 StreamMeta.budget（nudge 账本域），
  published 由 entries 推导（created_round == current_round ∧ writer.session_id == 本 session），
  not_needed / unavailable / strong_attempted 落盘布尔字段，
  走既有 writeMeta 原子事务（与 R1 双 round_known 同域）；
  落盘条件采用聚合 Task C 偏差①修复后的值快照比较形态。
```

## Tech Stack

- Bun + TypeScript，同步文件存储（既有 `src/storage.ts` flock 事务），`bun:test`；无新依赖；无新运行时服务。
- 通道设计（见「已确认决策」D1）复用既有工具注册路径（`src/tools.ts` / `src/plugin.ts` hooks.tool）。

## Requirements

以下为父级已确认决策（2026-09-23），直接采用：

1. **完整两级恢复**：不做缺口文档 P1/P3 的最小 A/B 方案，重建强/弱两级 nudge 状态机。
2. **范围**：G1（写入触发指引）、G2（parent 补写协议）、G3（分级恢复 + DESIGN 回写）全部纳入；G7/G8 不在本计划重复实现（见 Global Constraints）。
3. **分级单位 = admitted 轮次（round）**，对应原讨论的"块"。理由：DESIGN §9 轮次时钟客观存在且已持久化（rounds.current_round / last_admitted_message_id）；不引入 DESIGN 已拒绝的自动"业务块"概念。oracle 调查结论要求"块/执行身份 + 持久化 attempt/disposition 状态"——轮次身份提供前者，disposition 扩展提供后者。
4. **strong 条件**（每轮）：见 Architecture；strong 要求 agent 做出显式"写 / not-needed / unavailable"判断；**每轮至多一次自动 strong，此后无论板是否为空降为 weak**。
5. **持久化**宗旨见 Architecture；崩溃恢复语义对齐既有 recoverPending / 幂等恢复（同一 admitted messageId 重入不增轮、不重置 disposition）。
6. **strong nudge 文本**：轻提醒 = 首行锚 + 三个计数行 + 固定动作指令（先查 board_status；本轮到期前 board_put 留存 / board_disposition 声明二选一；勿自动重试）；**整体 ≤300 B**（见 Task 2 renderReminder 契约），无描述/摘要/处置展示/版本展示、无省略循环；不改变 ≤2 次/轮、≤1 次/请求的预算与不自动 reopen 的生命周期边界。
7. **weak nudge**：同形态轻提醒，动作指令换为引用提示（"需核对时查 board_status；按需引用，勿重复写"）；pressure 模板独立（目录超阈值 → board_index 取成员再 board_aggregate，无强度语义）。
8. **G7/G8 前置依赖**：聚合计划 Task C（偏差① = G8——duplicate_hook 失效侧落盘修复与值比较；偏差② = G7——轮次推进迁移至 transform 关联验证事务）先行落地，作为本计划 Task 1/2 的语义正确性基线。
9. **G2 修复方向**（缺口文档 I2 口径）：本轮交付"parent 补写编排协议"——orchestrator 侧规则/检查清单 + 复用既有派发能力（task_revive + `publication_for` 传参，src/tools.ts 已支持），不新增插件工具；验收含生命周期检查（已终结 / 未复用 / 身份权限确认 / 明确原作者与目标 / 不回退默认 agent / 不代写）。
10. **board_status（第 6 工具，D3 定案）**：仅查自身 stream 的发布与处置状态；`z.object({}).strict()` 空参、拒绝任何定向查询参数；锁内一致读取；**无账本副作用**（不推进轮次、不清新写水位、不消耗/解除提醒机会、不更新 last_shown_seq）；**不输出覆盖水位类字段**——writer.message_id 是 host 关联句柄而非 ACP 别名/时间轴（时间判断用 created_at 与 current_round − created_round）；messageId **不新增字段**（已由受信上下文落盘：src/tools.ts:100-111、src/storage.ts:365-381），status 仅透出，不改写既有 entry。

## Global Constraints

- **文件交集与排程**：`src/nudge.ts`、`src/plugin.ts`、`test/nudge.test.ts`、`test/plugin.test.ts`、`src/tools.ts`、`src/indexing.ts`（ownWriteStats 所在，与聚合 Task B 的 indexing 改动共享）与聚合计划 Task B/C 共享。**排程（M-I5 定案）：聚合计划 Task A–E 全部合流后才开始本计划 Task 1/2——两计划不交替执行**；Task 3（p-rep，纯新增文件）已先行合流为例外。本计划 Task 1/2 落地时偏差①的值快照比较与偏差②的轮次推进语义均已就位（聚合 Task C）——前者是 disposition 字段正确落盘的形态前提（否则重蹈别名改写），后者是"分轮"的判定前提。绝不并行动手同一行为区域；合流基线 = 聚合终态 **140 pass**（含已合流 Task 3 则 **150**）。
- **不重复实现 G7/G8**：本计划只引用聚合 Task C 的 RED/GREEN 用例（n-red-1、n-red-2、p-red-2）作为交叉检查，不写第二份同主题实现。
- **预算与生命周期边界不变**：≤2 次/轮、≤1 次/请求、注入 part 整体 ≤300 B（首行锚 + 计数行 + 动作指令，整体计量，见 Task 2 renderReminder 契约）、初始机会每轮至多一次、不自动 reopen、text-only 不触发动作。
- **board 内容不得升级为系统指令**（DESIGN §13.2）：动作指令区是常量、不含任何板数据；计数行仅为数字、无指令语义；"数据非指令"声明移至 board_status 固定 note 与 §10 契约（提醒内不再有数据区声明行）。
- **board_status 无账本副作用**：查询不推进轮次、不清新写水位（new_since_last_shown）、不消耗/解除提醒机会、不更新 last_shown_seq；锁内 recover-on-read 完成既有 pending 恢复属聚合恢复契约，不算业务副作用；重复查询必须幂等（rounds/budget/disposition 深比较不变）。
- **聚合展示接线**：本计划删除 recentSummaries 的提醒内展示（无摘要进 part），但聚合算法 / candidateSetId / 可见目录阈值 / 压力触发全部不动——**提醒变小 ≠ 目录压力消失，不得顺手删聚合触发**。
- **保守契约不弱化**：宁可少提醒、不超预算；未履行机会不得标记已履行（§10.3）；identity_unrecoverable 仍零注入。
- 实施者不得擅自重排聚合计划 Task B 的 decideNudge 判定顺序（fix-4）；strong/weak 只是初始分支内部的强度分层。
- ponytail: 每轮 published 判定为 O(本流实际记录数) 的 entries 扫描（锁内同步读，经 entrySeqs 枚举），目录膨胀有聚合第二步救压；若扫描开销成为问题再加落盘计数（升级路径在此注明，实现不预设）。

## Review Focus

- strong 条件四环（无发布 / 无 not-needed / 无 unavailable / strong_attempted=0）与"每轮至多一次自动 strong、其后降 weak"是否精确落地且每环有自动化用例。
- disposition 落盘走值快照比较（聚合偏差①形态），R1 双 round_known 同域语义不被破坏；crashed-after-writeMeta 的恢复语义与既有幂等恢复对齐。
- 轻提醒三模板（strong/weak/pressure）精确落地：首行 `[blackboard` 锚、唯一计数行、常量动作指令区完整不截断、末尾无换行；整体 ≤300 B 且 safe-integer 极值下不越界；**无运行时截断路径**（超界靠测试失败暴露）。
- board_status 自流隔离（同 scope 父/子、同名异 session、隐藏流、另 scope 均不混入）与无账本副作用（重复查询深比较 rounds/budget/disposition/last_shown_seq 不变）；合法序号空洞不虚增 total；未知/不一致身份保守投影为 null（禁止 0/false 伪装）；**不输出覆盖水位字段**。
- G2 六条生命周期检查完整可执行（脚本 dry-run 可验证）；不新增插件工具、不代写；self-only status 不能替代 C6 跨流授权检查。
- G1 验收以**实际工具轨迹**为准（status 查询 → 发布/处置行为），不得仅凭"已注入提醒文本"宣称履行。
- DESIGN v1.4 回写与正文指纹复算（按既有复算法）正确；G3 裁决（handoff loss，受限结论）与 message ID 能力边界如实登记。
- 与聚合计划的排程互斥声明、G7/G8 交叉检查的一致性。

## 已确认决策（父级定案 2026-09-23）

| # | 事项 | 定案（按此实现） |
|---|---|---|
| D1 | not-needed / unavailable 声明的写入通道 | 新增第五个工具 `board_disposition`：args `{ status: "not-needed" \| "unavailable", reason?: string (≤200 码点) }`；执行 = 锁内 writeMeta 置 `budget.round_disposition`，不产生知识记录，返回确认；unregistered_session / unresolved scope 拒绝语义与既有三工具一致 |
| D2 | strong/weak 与既有 reason 集合的关系 | 初始分支注入 reason 拆为 `strong_reminder` / `weak_reminder`（**移除** `initial_reminder` 注入实例；`fulfilled_initial`/`no_budget`/`state_unchanged`/`duplicate_hook`/`identity_unrecoverable`/`pressure_reminder`/`set_already_prompted` 全部不变）。改名影响面清单见 Task 2 Step 0 |
| D3 | nudge 数据注入与按需详情（oracle 修正版混合式，用户已批准） | ①提醒只留三计数 + 常量动作指令（strong/weak/pressure 三模板，整体 ≤300 B；删除描述/摘要/处置展示/版本展示与全部省略循环）；②新增第 6 工具 `board_status`（self-only、空参 strict、锁内一致读、无账本副作用、不证明覆盖水位、不决定是否该写）；③不新增 messageId 字段（`writer.message_id` 已由受信上下文落盘，status 仅透出；host 关联句柄，非 ACP 别名/时间轴——时间判断用 created_at 与 current_round − created_round）；④共享写入统计 `ownWriteStats`（nudge 与 status 同一份作者/轮次过滤逻辑） |

RED 用例断言即以定案为准，无备选分支。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/storage.ts` **Modify** | `BudgetLedger` 增 `round_disposition` 域；`newStreamMeta` 初始化（写入统计移至 indexing.ownWriteStats，本文件不再新增 helper） |
| `src/nudge.ts` **Modify** | `classifyStrength` 纯函数；decideNudge 初始分支强度分层；strong/weak/pressure 三模板与 `renderReminder(counts, reason)`；`snapshotVersionOf` 改 counts-only（保留键名 snapshot_version）；落盘条件纳入 disposition 值比较（继承聚合偏差①形态） |
| `src/rounds.ts` | 不改（disposition 在 budget 域；roll 重置在 nudge.ts `rollLedgerForNewRound`） |
| `src/indexing.ts` **Modify** | 共享写入统计 `ownWriteStats(scope, streamId, sessionId, round|null)`——nudge 消费 `this_round > 0`，board_status 消费 total/this_round/last_available；单份作者/轮次过滤逻辑，O(本流记录数) 锁内扫描 |
| `src/tools.ts` **Modify** | `board_disposition`（D1）与 `board_status`（D3：`z.object({}).strict()` 空参、self-only、锁内一致读、BoardStatus 返回体与拒绝阶梯）两工具；注册达**六工具** |
| `src/plugin.ts` **Modify** | hooks.tool 注册 board_disposition/board_status；transform 注入 = `renderReminder` 返回值（**保留** snapshotCounts；版本计算替换为 `snapshotVersionOf(counts)` 并继续传入 decideAndPersist——内部去重版本不删；**删除**目录读取/描述列表/版本号展示/标题外拼；日志 omission 字段保留恒 0 兼容既有消费者）；传入判定所需 writer 身份（sessionId） |
| `test/nudge.test.ts` **Modify** | Task 1/2 RED-GREEN（强/弱判定、strong_attempted、预算、轻提醒三模板与 300B、renderer 旧用例改写） |
| `test/tools.test.ts` **Modify** | board_disposition 用例（成功置位 / unregistered 拒绝 / 锁内原子）+ board_status 用例 t-status-1…7 |
| `test/plugin.test.ts` **Modify** | 轻提醒注入装配（三模板、≤300B、无描述进 part）+ p-status-1（六工具接线、status 无账本副作用） |
| `docs/orchestrator/parent-repair-protocol.md` **Create** | G2 parent 补写编排协议：规则 + 六条检查清单 + 证据要求 |
| `scripts/parent-repair-check.ts` **Create** | G2 脚本化检查工具（dry-run 可验证） |
| `test/parent-repair.test.ts` **Create** | G2 检查脚本 dry-run 用例（10 例：两模式各一条正向 + 每检查一条负向） |
| `DESIGN.md` **Modify** | Task 4 回写 v1.4（§10 两级契约、§11 工具面、§13/§15 风险与开放问题、修订记录 + 指纹复算） |

## Task 1: per-round disposition / strong_attempted 状态扩展（storage/nudge schema + 崩溃安全）

**前置**：聚合 Task C 已落地（值快照比较形态可用）。

**Files:** `src/storage.ts`、`src/indexing.ts`、`src/nudge.ts`、`test/nudge.test.ts`

**Interfaces:**

```ts
// src/storage.ts — BudgetLedger 增域
export type RoundDisposition = {
  not_needed: boolean
  unavailable: boolean
  strong_attempted: boolean
}
export type BudgetLedger = {
  // …既有字段不变…
  round_disposition: RoundDisposition
}
// newStreamMeta() 初始化：{ not_needed: false, unavailable: false, strong_attempted: false }

// src/indexing.ts — 共享写入统计（锁内同步；ponytail: O(本流实际记录数) 扫描；
// nudge 与 board_status 共用同一份作者/轮次过滤逻辑，不保留两份）
export type OwnWriteStats = {
  total: number              // 本 stream 已发布 ∧ writer.session_id===sessionId
                             //（含 index_summary；covered/superseded 不消除发布事实；
                             //  tombstone 计存在、内容不返回）
  this_round: number | null  // round===null → null；否则 created_round===round 计数
  last_available: null | {   // 集合中未被 tombstone 的最大 sequence（按 sequence 不按时间戳）
    id: string; sequence: number; kind: RecordKind
                             // 复用既有 RecordKind（src/storage.ts:20-29），与 BoardStatus 六值枚举同源；
                             // 历史 entry 缺 kind 按既有 note 语义归一化，不做工具层类型断言
    message_id: string | null  // 历史 entry 缺该字段 → null（不推导、不改写不可变记录）
    created_at: string; created_round: number | null; description: string
  }
}
export function ownWriteStats(scope: Scope, streamId: string, sessionId: string, round: number | null): OwnWriteStats {
  // 锁内（调用方已持锁、恢复完成后）；遍历 entrySeqs(scope, streamId) 逐条 readEntry 过滤
  // （复用既有枚举原语——与聚合计划 L302 同源；复杂度 O(本流记录数)）；
  // 合法序号空洞（失败预留）不当计数、不以 high_water 代替数量
}
// nudge 侧消费口径：publishedThisRound = ownWriteStats(...).this_round > 0（Task 2 接线）

// src/nudge.ts — newLedger / rollLedgerForNewRound 增初始化与重置
// newLedger(): round_disposition: { not_needed: false, unavailable: false, strong_attempted: false }
// rollLedgerForNewRound(): round_disposition 重置为全 false（其余行为不变）
```

**Step 1: RED 先写（失败证据）**

`test/nudge.test.ts`：

```ts
// n-strong-1：roll 重置 per-round disposition
test("n-strong-1 rollLedgerForNewRound 重置 round_disposition", () => {
  const l1: NudgeLedger = { ...newLedger(), round_id: "m1", round_known: true,
    round_disposition: { not_needed: true, unavailable: false, strong_attempted: true } }
  const rolled = rollLedgerForNewRound(l1, "m2")
  expect(rolled.round_disposition).toEqual({ not_needed: false, unavailable: false, strong_attempted: false })
})
```

Run（修复前）: `bun test test/nudge.test.ts -t "n-strong-1"`
Expected: FAIL——`round_disposition` 不存在 → TS 编译失败或断言报 undefined（RED 证据存档到任务记录，与聚合计划 RED 惯例一致：编译失败亦计为 RED 失败证据）。

**Step 2: 实现（storage + nudge schema）**

按 Interfaces 落地；`newStreamMeta()`、`newLedger()`、`rollLedgerForNewRound()` 同步初始化/重置。既有落盘路径（`writeMeta`/`Scope.put`）不产生对 disposition 的读取依赖——存量 metadata.json 缺该字段时用默认值补齐（`readMeta` 后轻量归一化 `meta.budget.round_disposition ??= {...false}`，避免旧元数据读取崩溃；升级不破坏既有 stream）。

**Step 3: 落盘条件纳入值比较**

`decideAndPersist` 的 changed 快照比较清单（聚合偏差①修复后形态）追加：

```ts
round_disposition.not_needed !== meta.budget.round_disposition.not_needed ||
round_disposition.unavailable !== meta.budget.round_disposition.unavailable ||
round_disposition.strong_attempted !== meta.budget.round_disposition.strong_attempted
```

Run（修复后）: `bun test test/nudge.test.ts -t "n-strong-1"`
Expected: PASS。

**Step 4: 崩溃安全追加用例（GREEN 直写，一例）**

- `n-strong-4`（保留，语义收窄为"put 隔离"）：scope.put 后 faultHook 注入 `after_publish` 抛错再重开 scope，assert `recoverPending` 后 `budget.round_disposition` 不被 put 事务改写（put 不触碰 disposition；writeMeta 仅由 nudge/disposition 路径变更）。
- `n-strong-9`（真正的 nudge 落盘崩溃窗口，填补 I4）**整体移至 Task 2 Step 2**——其①依赖 Task 2 才实现的 decideAndPersist strong 注入，本任务无法转绿。Task 1 退出时此用例不存在。

**本任务退出判据**：`bun test test/nudge.test.ts`（含聚合累计用例）全绿；`bunx tsc --noEmit` 0 错误。

## Task 2: strong/weak 判定与 nudge 文本注入（decideNudge 扩展 + plugin 注入分区 + 预算合规）

**Files:** `src/nudge.ts`、`src/plugin.ts`、`src/tools.ts`（D1）、`test/nudge.test.ts`、`test/plugin.test.ts`、`test/tools.test.ts`

**Interfaces:**

```ts
// src/nudge.ts
export type NudgeStrength = "strong" | "weak"
export type NudgeReason =
  | "strong_reminder" | "weak_reminder"   // 初始分支注入两态（D2）
  | "pressure_reminder"
  | "duplicate_hook" | "no_budget" | "state_unchanged"
  | "set_already_prompted" | "identity_unrecoverable" | "fulfilled_initial"
// "initial_reminder" 移除（D2；既有断言与审计脚本随之更新，迁移清单见 Task 2 Step 0）

// 纯函数（无 I/O）：strength 判定要素全部作为参数传入；
// publishedThisRound 由 decideAndPersist 锁内经 ownWriteStats(...).this_round > 0 计算后传入。
export function classifyStrength(
  d: RoundDisposition,
  publishedThisRound: boolean,
  roundKnown: boolean,
): NudgeStrength {
  if (!roundKnown) return "weak" // 保守：身份不可恢复实际在 decideNudge 早期返回 identity_unrecoverable，不达本函数此态
  return (publishedThisRound || d.not_needed || d.unavailable || d.strong_attempted) ? "weak" : "strong"
}
```

`decideNudge` input 类型增 `strength: NudgeStrength`（由 decideAndPersist 锁内经 classifyStrength 计算后传入；纯函数不自行分类）。初始分支改造（判定顺序不动，不改聚合 fix-4 重排）：

```ts
// 轻提醒渲染（D3）：唯一入口，返回完整注入 part 文本（plugin 不再拼任何行）。
// 模板常量（两处换行、末尾无换行；实测三计数=0 时 212/112/150 B，
// 三计数均为 Number.MAX_SAFE_INTEGER 时 257/157/195 B → 上限 300 B 覆盖整个 part）
export function renderReminder(
  counts: SnapshotCounts,
  reason: "strong_reminder" | "weak_reminder" | "pressure_reminder",
): string
// strong（首行 [blackboard 提醒] 锚 + 唯一计数行 + 动作指令）：
//   [blackboard 提醒]
//   知识 {N} / 目录 {M} / 新写 {K}
//   先查 board_status。本轮到期前：需留存用 board_put；否则用 board_disposition 声明 not-needed（附理由）或 unavailable；勿自动重试。
// weak：
//   [blackboard 提醒]
//   知识 {N} / 目录 {M} / 新写 {K}
//   需核对时查 board_status；按需引用，勿重复写。
// pressure：
//   [blackboard 提醒]
//   知识 {N} / 目录 {M} / 新写 {K}
//   目录超阈值：查 board_status；需整理时用 board_index 取成员，再 board_aggregate。
// 约束：计数须为非负 safe integer（渲染前校验；不得先消耗提醒机会再因渲染失败丢弃）；
// 无描述、无摘要、无版本号、无省略循环；超界让测试失败，不存在运行时截断路径。
// （新写 K = counts.new_since_last_shown 既有口径；status 查询不清零）
```

`decideNudge` 判定顺序不变（聚合 fix-4 重排后的控制流），仅在**初始分支**的注入决定处按 strength 决定 reason：

```ts
// fix-4 控制流（已在聚合 Task B 落地，本任务不重排）：
// 0) seen_requests → duplicate_hook
// 1) roundKnown && !initial_fulfilled → 初始分支（候选集非空时仍优先初始——fix-4）：
//      注入时：reason = strength === "strong" ? "strong_reminder" : "weak_reminder"
//       strong 注入：ledger = { ...ledger, round_disposition: { ...ledger.round_disposition, strong_attempted: true } }
//       weak 注入：不动 strong_attempted
//      mark_fulfilled / round_used+1 / snapshot_version / seen_requests 语义与现行 initial_reminder 完全一致
//      初始未注入且 candidateSetId ≠ null → 继续压力分支（fix-4 不变）
// 2) initial_fulfilled 或 !roundKnown → 压力/identity_unrecoverable（不变）
// 压力分支注入 reason 恒为 pressure_reminder，使用 pressure 模板（常量动作指令），不参与 strong/weak 分类。
```

`decideAndPersist`：锁内重读 meta 后计算 `roundKnown`（既有 roundKnownFor）；`publishedThisRound = roundKnown ? (ownWriteStats(scope, streamId, input.sessionId, meta.rounds.current_round).this_round ?? 0) > 0 : false`（null 显式归零，不依赖外层条件收窄）；`strength = classifyStrength(meta.budget.round_disposition, publishedThisRound, roundKnown)`；将 strength 传入 decideNudge。锁内推进/roll 之后的轮次与 disposition 即强度计算的输入（同一次锁事务）。

`plugin.ts` transform：part 文本**整体**取自 `renderReminder(counts, reason)` 返回值（counts 由 `snapshotCounts` 同口径计算——**snapshotCounts 保留**；版本计算替换为 `snapshotVersionOf(counts)` 并继续传入 decideAndPersist，内部去重版本不删；**删除**目录读取/描述列表/版本号展示/标题外拼——日志 omission 字段保留恒 0 兼容既有消费者）；**不新增 `strength` 结果字段**（三模板已由 reason 完全区分；内部 classifyStrength 与 decideNudge 输入 strength 保留）；part id 仍 `part_bb_${lastMsgId}`；logs 无条件 `ev:"decision"` 的 reason 即新枚举。

`board_status` 工具契约（D3，src/tools.ts 实现、src/plugin.ts hooks.tool 注册）：

```ts
// 输入：z.object({}).strict()——无 session/stream/scope/view/cursor 参数，额外字段 zod 拒绝
// 权限：resolveScope(ctx.sessionID, ctx.agent) → 仅 authz.ownStreamId（与 put 同款选择方式；
//       不得包装 board_index——它含跨流发现结果 other_streams）
// 拒绝阶梯（与既有三工具同语义）：
//   未注册/解析 null     → rejected: unregistered_session（不自动注册、不创建存储）
//   无 own-stream 权限   → rejected: forbidden_stream
//   meta 缺失/不可解析   → rejected: metadata_unavailable（不创建默认 meta、不伪装空流）
//   entry 读取/锁/恢复失败 → rejected: status_unavailable（不返回伪完整统计）
// 读取路径（锁内一致读）：
//   解析空参 → resolveScope → scope.withLock{
//     复核 own-stream 授权 → recoverPending(ownStream)（既有恢复契约）
//     → 重读 meta → 计算 round 可知性 → snapshotCounts（与 board_index own-stream 同口径）
//     → ownWriteStats（Task 1 共享统计）→ 组装返回 } → 序列化
//   复用：scope 解析/授权/锁/恢复/entrySeqs/readEntry/snapshotCounts；
//   不用 listIndex(limit) 求总量（分页与 compact 折叠会漏记录）；
//   不新增持久化 counters/缓存/第二份账本。
export type BoardStatus = {
  stream_id: string
  observed_at: string        // ISO 8601；本次一致性读取的观察时点（观察快照，非锁定凭证）
  round: {
    round_known: boolean     // = rounds.round_known ∧ budget.round_known
                             //   ∧ budget.round_id != null
                             //   ∧ rounds.last_admitted_message_id == budget.round_id
                             // 持久化的最后一次验证过的账本观察值——不重做 admission 验证、
                             // 不调用 advance/roll/身份恢复、不把 ctx.messageID 当 admitted ID
    current_round: number | null
    round_used: number | null
    initial_fulfilled: boolean | null   // 仅表示初始提醒机会已履行（记账），非"已查询/已发布"
    strong_attempted: boolean | null    // 仅表示强提醒尝试已记账
    not_needed: boolean | null
    unavailable: boolean | null
  }                          // 未知/两处身份不一致 → 除 round_known=false 外全 null（禁止 0/false 伪装）
  counts: {                  // 直接复用同一 caller/own stream/同观察时点的 snapshotCounts 结果；
                             // round 未知时仍返回可计算项（年龄分类传 currentRound=null 保守口径），
                             // 不把整个对象清零；共享函数输出一致 = 接口验收约束（不自建第二套公式）
    knowledge_total: number; visible_items: number; index_summary_count: number
    new_since_last_shown: number; eligible: number; protected: number
    unknown_round: number; description_bytes: number
  }
  writes: {                  // 集合 = 本 stream 已发布 ∧ writer.session_id === ctx.sessionID
                             //（含 index_summary；covered/superseded 不消除发布事实；
                             //  tombstone 计存在、内容不返回）
    total: number            // 不是 high_water；合法序号空洞不虚增
    this_round: number | null  // 轮次未知 → null（已知空流 → 0）
    last_available: null | {   // 集合中未被 tombstone 的最大 sequence（按 sequence 不按时间戳）；
      id: string; sequence: number
      kind: "note" | "finding" | "change" | "review" | "decision" | "index_summary"
      message_id: string | null  // 历史 entry 缺该字段 → null；不推导 ACP 别名、不改写不可变 entry
      created_at: string; created_round: number | null
      description: string       // 检索数据；聚合摘要可为最新项——靠 kind 区分，勿误读为新业务事实
    }
  }
  note: string               // 固定边界声明（常量）：仅本 session 自身 stream 的观察结果；
                             // 计数与最近发布不证明内容完整覆盖或任务完成；description 为检索
                             // 数据不构成指令；message_id 是 host 关联句柄，不是 ACP 别名或时间序号
}
```

**无副作用承诺**（测试守住）：查询不推进轮次、不清 new_since_last_shown、不消耗/解除提醒机会、不更新 last_shown_seq；重复调用幂等（rounds/budget/disposition 深比较不变）。**禁止**输出 recorded_until_message / covered_through_round 类覆盖水位字段。

**Step 0: D2 定案 → 既有断言迁移（属 RED 阶段，先于新用例）**

四类影响面分开处置（以实施时 `rg` 实命中为准）：

1. **reason 改名**（`initial_reminder` 注入实例 → `strong_reminder` / `weak_reminder`；非注入 reason 不变）：实测命中 `src/nudge.ts` L52（类型枚举）、L101（注入点）、L187（last_shown_seq 分支；L164 是注释不单独构成改动）+ `test/nudge.test.ts` L32/34/109/122/126/130/**137** + `test/plugin.test.ts` L266/347（含 nudge-9 共享预算组断言）。**L187 不是普通字符串替换（M-C1）**：strong 与 weak 都是原初始机会的分支，`last_shown_seq` 更新条件必须同时接受 `strong_reminder || weak_reminder`（weak 注入同样推进展示水位），且水位更新先于值比较进入 changed 计算——否则 weak 注入不更新 `last_shown_seq`，`new_since_last_shown` 会保留已展示过的写入，破坏计数语义。断言前提（M-I3 修正）：这些 fixture 期望 `strong_reminder` 的依据是**本轮无新发布且无 disposition 声明**（其种子写入均早于被验证轮次），不是"fixture 无记录"——存在旧候选不排除本轮另有新记录（此时按分级规则应为 weak）；强度由生产路径计算（**生产接线测试的断言不得手工指定强度；纯 decideNudge 直调单测仍显式传 `strength` 参数，见第 2 条**）。期望注入 reason 改为 `strong_reminder` 的用例，在注入断言后补 `ledger.round_disposition.strong_attempted === true`；**另补 weak 水位断言（独立夹具）**：构造初始机会尚未履行即产生 weak 注入的合法账本情境，断言该次 weak 注入更新 `last_shown_seq` 且其后 `new_since_last_shown === 0`；**不得"先真实注入 strong、再期待同轮第二次初始 weak"**（初始机会每轮至多一次——Global Constraints 与 §10.3 契约，会违反既有用例语义）。
2. **签名调用点与渲染器改名**：`decideNudge` input 新增必填 `strength` → **全部既有直调调用点**（test/nudge.test.ts 所有 decideNudge 直调；**聚合 Task B 的 p-agg-1 是生产接线测试、不直调 decideNudge，不在此清单**——其强度由生产路径计算）同步补参；`renderSnapshot(counts, descriptions, summaries, version, opts)` → `renderReminder(counts, reason)`——既有调用点（plugin.ts L277 注入组装、test/nudge.test.ts L174-195 的 renderer 用例）**改写而非叠加保留失效断言**（"省略 26 条"类旧省略循环断言随省略循环一并删除）；`snapshotVersionOf` 改 counts-only（保留持久化键名 `snapshot_version`，不做 metadata 迁移）——断言拆两层：**展示断言**改为三计数行/无版本号展示；**内部版本断言保留**（验证 counts-only 版本计算、传参及 `snapshot_version/state_unchanged` 接线；另保留 `seen_requests/duplicate_hook` 断言——那是请求去重，不是版本比较；"无版本展示" ≠ "无需内部版本"）。
3. **聚合计划联动断言**：聚合 Task B 的 p-agg-1 A/C 段断言 `initial_reminder` → 合流后改为 `strong_reminder`（前提修正 M-I3：其断言成立条件 = **A/C 段全部种子写入早于被验证轮次**（本轮无新发布），不是"fixture 无发布记录"——p-agg-1 的候选集非空恰恰要求已有旧记录；强度断言以生产路径实际计算结果为准）；**p-agg-1 是生产插件接线测试，不得以 decideNudge 直调 + 手工补 `strength` 参数替代真实分类**（直调用例已由 n-strong 系列承载）。聚合 Task B 的「恰三工具」基线断言已改四工具，本计划 D1+D3 增 board_disposition 与 board_status → 再次更新为**六工具**。
4. **标题与日志迁移**：旧标题断言 `[blackboard 目录快照 v` → `[blackboard 提醒]`（test/plugin.test.ts:79 及其余实命中处）；plugin transform 删除目录读取/描述列表/版本号展示/标题外拼（src/plugin.ts:237-245、277-278 中对应行——**snapshotCounts 调用保留**；版本计算替换为 `snapshotVersionOf(counts)` 而非删除，内部去重版本继续生产）；日志 omission 字段（src/plugin.ts:270-272、297-299）**保留恒 0**（兼容既有日志消费者），不保留旧省略算法。

Run: `bun test test/nudge.test.ts test/plugin.test.ts` → Expected: FAIL（strong_reminder 尚不存在；RED 证据存档；与 Step 1 新 RED 共享同一实现作为 GREEN 前提）。

**Step 1: RED 先写（strong 分支不存在）**

```ts
// n-strong-2：首轮无发布 → strong_reminder
test("n-strong-2 首轮无发布无声明 → strong_reminder 且 strong_attempted 置位", () => {
  const { decision, ledger } = decideNudge(newLedger(), { requestId: "r1", roundKnown: true,
    candidateSetId: null, snapshotVersion: "v1", strength: "strong" })
  expect(decision).toEqual({ inject: true, reason: "strong_reminder", mark_fulfilled: true })
  expect(ledger.round_disposition.strong_attempted).toBe(true)
})
```

Run（修复前）: `bun test test/nudge.test.ts -t "n-strong-2"`
Expected: FAIL——TS 编译失败（`strength` 输入与 `strong_reminder` reason 均不存在）。RED 证据存档。

**Step 2: 实现升判定后补 GREEN（任务内顺序，逐个 run）**

实现后递减新增用例并逐条跑：

- `n-strong-3`：表驱动四环分类（`classifyStrength` 纯函数，每环独立一列）：roundKnown=true 下 ①全 false → strong；②publishedThisRound=true（其余 false）→ weak；③not_needed=true → weak；④unavailable=true → weak；⑤strong_attempted=true → weak。另设一列 roundKnown=false → 分类默认 weak（保守），**且**断言决策层（decideNudge with roundKnown=false）reason=identity_unrecoverable、inject=false——分类与决策两层语义分开，不写"roundKnown=false → weak_reminder"。
- `n-strong-5`（Task 1 已占用 n-strong-4=崩溃安全例，此处从 5 起编号）：
  - a) 同轮 strong 后：同请求重复 hook → duplicate_hook（不重复强推）；
  - b) 同轮第二次初始机会 → fulfilled_initial（每轮一次初始机会不变）；
  - c) roll 到新轮（无新发布）→ 可再 strong_reminder（strong_attempted 已随 roll 重置）；
  - d) 本轮已发布（publishedThisRound=true）→ weak_reminder；
  - e) disposition.not_needed=true → weak_reminder；
  - f) disposition.unavailable=true → weak_reminder；
  - g) 仅 strong_attempted=true（其余 false）→ weak_reminder（证明该环独立有效，而非被前置去重闸门遮蔽）；
  - h) 候选集非空（candidateSetId≠null）且初始未履行 → strong_reminder（fix-4 语义：候选非空也优先初始机会，随后才 pressure）。
- `n-strong-8`：published 推导接线（decideAndPersist 级）——**两个独立且身份已验证的 fixture，不靠删 entry/重开流隐式重置提醒机会**（R3-②：weak 注入已持久化 initial_fulfilled=true、预算与请求状态，同轮重入会被去重契约抑制，删 entry 不会清账本）：
  - a) fixture A：全新 stream/meta（无任何 entry、全新 admitted 身份）→ decideAndPersist 注入 `strong_reminder`（锁内 ownWriteStats 真实接线 this_round=0）；
  - b) fixture B：另一条独立 stream（**与 A 不共享 meta/账本**，admitted 身份不同），预置一条本 session 本轮 entry（created_round == current_round）→ decideAndPersist 注入 `weak_reminder`。
  - 两 fixture 各自断言 `ledger.round_disposition`（A：strong_attempted=true；B：strong_attempted=false——weak 注入不动该布尔）。
- `n-strong-9`：nudge 落盘崩溃窗口（自 Task 1 移入；①–③依赖本任务实现的 decideAndPersist strong 注入，④依赖本任务的 board_disposition）：
  - ①构造 strong 注入完成后（decideAndPersist 已 writeMeta，`strong_attempted=true`、`round_used=1`）**重开 scope**（同存储根、新 Scope 实例）；
  - ②同一 admitted messageId 重入（chat.message 幂等恢复路径）→ disposition 三布尔与 `round_used` 均不被重置、不重新注入（`recoverPending` 不触碰 budget）；
  - ③重开后同轮同 snapshot 再次 decideAndPersist → 不再次 strong（`fulfilled_initial`）；
  - ④disposition 路径写失败：**直接令 `Scope.writeMeta` 抛错**（`(scope as any).writeMeta = () => { throw new Error("io") }`，复用既有测试模式；**本任务不新增故障点**——保留既有 `after_reserve`/`after_publish` 与聚合前置已新增的 `agg_after_reserve`/`agg_after_publish`（聚合计划 2026-09-23-blackboard-aggregation.md L131），nudge 路径不依赖任何 FaultPoint）→ `board_disposition` 不得返回成功确认（工具层断言 rejected/error 而非 ack），且账本未被部分写坏（重开 scope 后 disposition 三布尔保持注入前值）。
- `n-strong-6`：预算合规——初始 strong 一次（round_used=1）+ 压力一次（round_used=2）→ 第三次 no_budget（≤2 次/轮不破；与 nudge-9 语义一致但 reason 为 strong_reminder）。
- `n-strong-7`：轻提醒三模板与字节预算——`renderReminder` 三 reason 各断言：首行 `[blackboard 提醒]`（SYNTHETIC_RE 锚）、唯一计数行格式 `知识 N / 目录 M / 新写 K`、常量动作指令区完整在尾、末尾无换行；三计数 = 0 时整体 bytes 分别为 212/112/150（模板常量 + 数字替换的**字节精确断言**，非约数）；三计数均为 `Number.MAX_SAFE_INTEGER` 时整体 bytes ≤ 300；计数校验前置：负数 / 小数 / 非整数 / 超 safe integer → 抛错且**不消耗提醒机会**（渲染失败不得先记账后丢弃）。
- `p-strong-1`（plugin）：transform 注入消息最后一个 part 的 text 以 `[blackboard 提醒` 开头（首行锚）、含三计数行与动作指令区、**无任何描述/摘要/版本号进入 part**；part text 整体 bytes ≤ 300；`ev:"decision"` 日志 reason=strong_reminder。
- `t-disp-1`（tools，D1 已定案）：board_disposition not-needed → meta.budget.round_disposition.not_needed=true、entries 无新记录；unregistered session → `rejected: unregistered_session`；锁内原子（并发两份 writeMeta 不失）。

**Step 2b: board_status 工具实现与用例（RED/GREEN，D3 契约见本任务 Interfaces）**

实现要点（照 Interfaces 契约落地，不重述）：`z.object({}).strict()` 空参；resolveScope → ownStreamId；锁内 `复核授权 → recoverPending → 重读 meta → round 可知性（四条件合取）→ snapshotCounts → ownWriteStats`；拒绝阶梯四种各自返回 `rejected: <code>` 不伪装；`observed_at` 为观察时点。

新增 8 个顶层用例（子场景测试内表驱动）：

- `t-status-1` 正向与来源：own stream 的 total / this_round / last_available 准确（fixture 预置多条本 session 记录）；message_id 来自已存 writer（不由查询参数提供）；按 sequence 而非时间戳选最新；kind 透出（含 index_summary 情形）。
- `t-status-2` 入参与未注册：`{}` 合法；额外 session/stream 参数 zod 拒绝；未注册 → `rejected: unregistered_session`（不自动注册、不创建存储）。
- `t-status-3` 跨流隔离：同 scope 父/子 stream、同 agent 名不同 session、隐藏流（councillor 隔离）、另一 scope 的记录均不混入；改变其他 stream 的记录不改变自身统计。
- `t-status-4` 空流与未知轮次：已知空流 this_round=0、last_available=null；未知空流 this_round=null；身份字段不一致（rounds 与 budget 错位）→ round 保守投影 null；查询不重置持久账本。
- `t-status-5` 缺失与损坏：无 meta / 坏 JSON / 读取失败 → `metadata_unavailable` / `status_unavailable`，不伪报空流；合法序号空洞不虚增 total（不以 high_water 代替数量）。
- `t-status-6` 全量与导航语义：>200 条记录正确统计与定位末条（不依赖 listIndex 分页）；covered/superseded 不漏计；tombstone 记存在但内容不返回；幂等 replay 不增加发布数。
- `t-status-7` 恢复与无副作用：pending 事务恢复后一致读取；多次 status 深比较 rounds/budget/disposition/last_shown_seq 均不变；new_since_last_shown 不被清零。
- `p-status-1` 工具及提醒接线（plugin）：六工具注册；三种轻提醒（strong/weak/pressure）正确渲染；无目录描述/摘要进入 part；status 调用不增加提醒机会、不解除 once-per-set；合成提醒不增轮。

Run: `bun test test/nudge.test.ts test/tools.test.ts test/plugin.test.ts`
Expected: 新增用例（含 t-status-1…7、p-status-1）全部 PASS；既有用例回归 0 fail（含聚合计划累计基线）。

**Step 3: 全量回归与类型**

Run: `bun test` → Expected: 聚合终态基线（聚合 A–E 完成 = **140 pass**；Task 3 已先行合流含 p-rep 10 例 = **150**）＋ 本计划 Task 1/2 新增全绿并列出实际数（阶段口径：Task 1 结束 = 基线+2——n-strong-1/n-strong-4；Task 2 结束 = 基线+**19**——累计加 n-strong-2/3/5/6/7/8/9、p-strong-1、t-disp-1（+9）及 t-status-1…7、p-status-1（+8），合计 2+9+8=19；weak 水位断言若仅为既有用例追加断言，不增顶层计数；Task 3 的 p-rep-1…10 已计入基线，不在本链重复累加。现实链：150 → Task 1 后 152 → Task 2 后 **169**；未预合流 p-rep 的对应分支：142 → **159**）。
Run: `bunx tsc --noEmit` → Expected: 无输出（0 错误）。

## Task 3: G2 parent 补写编排协议

**Files:** `docs/orchestrator/parent-repair-protocol.md` **Create**、`scripts/parent-repair-check.ts` **Create**、`test/parent-repair.test.ts` **Create**

**背景**：本仓库无 orchestrator 运行时；G2 修复落地为「规则/检查清单文档 + 脚本化检查工具」。底层能力已具备：`board_put` 接受 `publication_for`（src/tools.ts，`PutArgs.publicationFor`）；派发复用既有 task_revive；不新增插件工具。

**不因 D3（board_status）改变**：self-only 的 status 只查自身 stream，**不能替代** C6 的跨本 scope 已注册 streams 授权检查（parent 代写检测必须跨流枚举 scope.json.session_index）——本任务协议与十例检查维持原样。

**协议要点（写入文档，逐条对应 DESIGN §10.5）**：

1. 触发：仅 parent 判断值得保存时启动；child 结束且已终结、未复用；
2. 身份/权限：scope 成员资格 + board 权限校验（复用 resolveSession/isolation）；请求对象=原 child（session 身份在派发参数中显式给出，不得省略 agent）；
3. 请求内容：明确**原作者**（child session）+ **目标**（原执行/原消息 id）+ 补写理由；`publication_for` 由原作者在写时显式传入；
4. 禁止：不代写；不回退 defaultInfo()（对照 DESIGN V4）；不重开已终结 child 的 runner 状态之外的路径；
5. parent 侧留痕：请求动作记录（派发参数快照 + board 上补写记录 id）供验证与验收。

**脚本**（`scripts/parent-repair-check.ts`，`bun run`；**dry-run 语义：只读检查，不派发、不写板**）。**两阶段双模式**（R3-①：派发前尚无补写记录，必须存在不依赖记录的独立成功出口）：

- **preflight 模式**（派发前）：只执行 A 阶段；`published_record_id` **不要求**（输入中省略）；A 全 PASS → rc=0（允许派发）；存在 FAIL/UNVERIFIABLE → rc=1（不派发）。输入为**拟派发参数快照**（explicit_agent_given/agent_param 取自 parent 即将使用的派发参数）。
- **postflight 模式**（补写后）：A+B 全部执行；`published_record_id` 必填；**核对实际派发参数**（输入为实际发生的派发参数，与 preflight 快照可对照）。**A+B 全部 PASS → rc=0；任一 FAIL 或 UNVERIFIABLE → rc=1**（验收口径：权限/生命周期证据不完整即不得判通过——`p-rep-7` 的 C3a UNVERIFIABLE 正是此规则的直接验证）。

```
输入 JSON（stdin 或 --file）——最小受信输入（每字段来源与观察时点声明）：
{
  mode: "preflight" | "postflight",
  original_execution: {            // 原执行标识（归一化字符串）
    child_session: string, child_agent: string,
    target_ref: string,            // publication_for 目标（字符串；bb id 或规范化 description_ref）
  },
  parent: { session: string, agent: string },   // 请求方 parent 身份
  dispatch_proof: {                // 派发证据（preflight=拟派发参数快照；postflight=实际派发参数）
    explicit_agent_given: boolean, // 派发参数是否显式传了原 agent
    agent_param: string,           // 实际传入（或拟传入）的 agent 值
    at: string,
  },
  lifecycle: {                     // 生命周期观察证据（含来源与时点，非裸布尔）
    terminal: boolean, reused: boolean,
    observed_via: string, at: string,
  },
  authorization: {                 // 派发前的权限确认结果
    scope_member: boolean, board_permission_ok: boolean,
  },
  published_record_id?: string,    // 仅 postflight 必填（声称的补写记录 id）
}
检查（逐项输出 PASS/FAIL/UNVERIFIABLE）：
  A 阶段（两种模式都执行，不读记录）：
    C1 original_execution 与 lifecycle 完整且 terminal===true
       （缺字段→UNVERIFIABLE；observed_via/at 缺失同样 UNVERIFIABLE）
    C2 reused===false
    C5 explicit_agent_given===true ∧ agent_param===child_agent
       （显式传原 agent 是契约要求；未给→FAIL）
    C3a authorization.scope_member ∧ board_permission_ok
       （派发前权限确认结果；缺失→UNVERIFIABLE）
  B 阶段（仅 postflight，读 board）：
    C3b 记录 writer.session_id===child_session ∧ writer.agent===child_agent
    C4  记录 publication_for 归一化后 === original_execution.target_ref
         （或经 description_ref 解析后对应；规则明确定义归一化函数）
    C6  查询边界（明确可执行，不写「全集」了事）：
         - scope 绑定 = original_execution.child_session 所属 scope
           （scope-index.json 仅映射 root session → scope ID，
           src/storage.ts:516-519；由调用方解析后传入，脚本不跨
           scope 枚举）；
         - stream 枚举 = 该 scope 的 scope.json.session_index[*].stream_id
           去重集合（src/storage.ts:37-43、207-209；DESIGN.md:106——
           stream 注册关系在 scope.json，**不在 scope-index.json**）；
         - 范围 = 上述 stream 中 `publication_for` 归一化后 === target_ref
           的记录 ∪ source_refs/related 包含 target_ref 的记录；
         - 遍历完成条件 = 对每个 stream 按 metadata.json 的 high_water
           顺序扫描 entries e000001…e<high_water>，全部读完且无读取错误；
         - FAIL 判定 = 该范围内存在 writer.session_id === parent.session
           的记录（parent 身份=输入 parent.session/agent；查到即 FAIL）；
         - UNVERIFIABLE 判定 = scope.json/session_index 不可读、任一
           stream 的 metadata/entries 不可读或遍历未完成（输出缺口
           清单，不假 PASS 也不武断 FAIL）。
退出码：preflight：A 全 PASS→0，否则 1（不派发）；postflight：A+B 全 PASS→0，任一 FAIL/UNVERIFIABLE→1（逐项结果打印）
```

**Step 1: RED/GREEN dry-run 用例**（`test/parent-repair.test.ts`，10 例——**两模式各一条正向 + 每检查一条负向**，不只 C3/C6）：

- `p-rep-1`：**preflight** 全合规（无任何记录存在、无 published_record_id）→ A 阶段全 PASS、rc=0（允许派发）。
- `p-rep-2`：**postflight** 全合规（fixture 记录由 child 写、带 publication_for）→ A+B 全 PASS、rc=0。
- 负向（各 rc=1 且对应检查标 FAIL/UNVERIFIABLE）：`p-rep-3` lifecycle 缺失 → UNVERIFIABLE（不得假 PASS）；`p-rep-4` terminal=false → C1 FAIL；`p-rep-5` reused=true → C2 FAIL；`p-rep-6` explicit_agent_given=false（漏传 agent）→ C5 FAIL——即便默认 agent 恰好等于 child 也要 FAIL；`p-rep-7` authorization 缺 scope_member → C3a UNVERIFIABLE；`p-rep-8` 记录 writer 为另一 session（非 child 非 parent 的第三方）→ C3b FAIL；`p-rep-9` publication_for 与 target 不一致 → C4 FAIL；`p-rep-10` **C6 独立场景**：选中记录确由 child 写且 publication_for 合规，但同一查询范围（同 target_ref）内**另有 parent 代写记录**（writer.session_id===parent.session）→ C6 FAIL（其余检查全 PASS 也不能 rc=0）。**fixture 必须使用真实索引结构**：构造 scope 的 scope.json.session_index 注册**至少两条 stream**（child 所在 + 另一条），parent 代写记录置于**另一条已注册 stream**——验证 C6 的 stream 枚举（session_index 去重集合）确实扫到非 child stream、无漏扫（若实现只扫 child 所在 stream 会假 PASS）。

Run: `bun test test/parent-repair.test.ts` → 10 pass（dry-run，无派发无写板）；`bun run scripts/parent-repair-check.ts --file <fixture.json>; echo $?` → 各例退出码如上（p-rep-1 为 preflight 输入；p-rep-2…10 为 postflight 输入）。

## Task 4: DESIGN.md 回写 v1.4

**File:** `DESIGN.md`（本计划唯一设计回写；实施时执行，非本计划交付物）。**锚点事实**（实施前复核）：DESIGN v1.3 §13.2/§15 均为风险条目列表，**不存在 G1/G2/G3 编号条目**——回写均为**新增条目**，不是更新既有条目。

1. **修订记录**追加 v1.4 行（性质=第二轮实施前置设计修订；证据列本计划 + 缺口文档三引用 + 聚合计划 + board_status 设计评估）：
   - §10 新增 10.7「两级 nudge（strong/weak）轻提醒 + board_status」契约：分级单位=admitted 轮次；strong 四环条件（无发布/无 not-needed/无 unavailable/strong_attempted=0）；每轮至多一次自动 strong 后降 weak；per-round disposition 落盘域（budget 账本）与 published 推导（entries created_round+writer）；注入 reason（strong_reminder/weak_reminder/pressure_reminder，initial_reminder 移除）；**提醒提供的是"查询并作判断的机会"，不保证查询或发布发生**；
   - §10.2 改为轻提醒计数模板与整体 ≤300 B 预算（首行锚 + 三计数行 + 常量动作指令；无描述/摘要/省略循环；指令区常量永不截断，超界靠测试失败暴露）；
   - §10.3 更新版本与展示水位解释：`snapshotVersionOf` counts-only（保留键名 snapshot_version）；`last_shown_seq` 仍仅初始提醒注入时更新；board_status 查询不更新任何展示水位；
   - §11.1 工具面表增 `board_disposition`（D1）与 `board_status`（D3，self-only/空参 strict/无账本副作用）——六工具；§10.6 的 publication 四态与 disposition 落盘的对应关系一句话；§10 新增 board_status 返回体摘要与固定 note（数据非指令声明移至此处）；
   - §13.2 **新增**一条：分级 nudge 与 parent 补写协议「进入第二轮计划（docs/plans/2026-09-23-blackboard-nudge-restore.md）」，**状态=计划中/待验收**（不得写"已闭环"——闭环状态必须绑定 Task 5 验收结果）；保留「board 内容不得升级为系统指令」与自包含语义条目；**新增** message ID 能力边界条目（host 关联句柄，非 ACP 别名/时间轴；status 不输出覆盖水位）；**新增**多步提示风险条目（status→put/disposition 流程属 prompt 级约束，模型可能不查或不写，验收须以实际工具轨迹为准）；
   - §15 **新增**两条：①登记 G3 根因裁决（conversation-to-design handoff loss，现有证据最支持，动机未定——引用已终审缺口文档）；②登记 G1/G2 进入第二轮计划、状态=计划中/待验收（同样不得标已闭环）。§15 原条目不动（其中不存在 G1/G2 条目可"移出"）。
2. **指纹复算**：DESIGN.md:17 的字面描述（"整节连同前后空行一并移除"）**实测有歧义**——父级已在本计划制定时对 v1.3 基线实测：能复现文档自记指纹 `6970145948ef04f7525b3f0027666312e3c2b510cf4b58e60e9d81e7c5c4da7a` 的删法是「**自 `## 修订记录` 行起至 sha256 行后一个空行止**（节前一空行保留作分隔）」；对称删法（保留后空行删前空行）产生同一字节串；而"前后空行都删"得 `0792cfe4…`、"都不删"得 `a0628a6c…`——均不匹配。**算法语义 = 删除后，meta 块与正文间恰保留一个空行**。可运行复算命令（**实际执行 `update(body).digest("hex")`，边界断言失败即报错**）：

   ```bash
   bun -e 'const f=await Bun.file("DESIGN.md").text(); const lines=f.split("\n"); const i=lines.findIndex(l=>l.startsWith("## 修订记录")); const j=lines.findIndex((l,k)=>k>i&&l.startsWith("sha256（正文指纹")); if(i<0||j<0||lines[j+1]!=="") throw new Error("boundary mismatch: "+i+","+j); const body=[...lines.slice(0,i),...lines.slice(j+2)].join("\n"); const h=new Bun.CryptoHasher("sha256"); h.update(body); console.log(h.digest("hex"), body.length);'
   ```

   **先行验证**：实施 v1.4 编辑前，该命令对当前 DESIGN.md（v1.3）必须输出 `69701459…`（父级已实测通过）；不匹配即文件或算法漂移，禁止继续。v1.4 编辑后同一命令取新指纹并更新「旧 → 新」行；复核 = 同一命令再跑一遍输出一致（**比对 hex 摘要，不是长度**）。该命令随 v1.4 修订记录留档，且 **v1.4 修订须顺带把 DESIGN.md:17 复算法描述更正为上述无歧义实测语义**（避免后续复现者再踩同一歧义）。
3. **验收**：v1.4 行 + §10.7 与 Task 1/2 实现的判定语义逐项对读一致；**状态均为「计划中/待验收」**；指纹复算命令实际执行成功且重算核对一致。闭环状态的后置更新（「待验收 → 已验收」）属 Task 5 完成后父级追加，不在本任务写入。

## Task 5: 验收映射与回归

| 缺口 | 验收项 | 证据/命令 |
|---|---|---|
| G1（写入触发指引） | 轻提醒（三计数+动作指令）注入后，agent **实际工具轨迹**含 board_status 查询 → board_put 发布或 board_disposition 声明（doc-3 类观察窗口同口径切片）；**不得仅凭"已注入提醒文本"宣称履行**；统计实际提醒字节、status 调用数/失败数、总 token 往返成本（实测，不承诺净收益） | Task 2 用例 + live 复验日志切片 |
| G2（parent 补写编排协议） | 十例 dry-run：preflight/postflight 各一条正向 + 每检查一条负向（FAIL/UNVERIFIABLE）均定位到对应 C1–C6；脚本 dry-run 不派发不写板 | Task 3 `p-rep-1…10` |
| G3（分级恢复） | strong→weak 全状态转移自动化（四环判定 + 每轮一次 + roll 重置 + 预算不破）；轻提醒三模板 ≤300B 精确断言；DESIGN v1.4 已回写且登记 handoff loss 裁决与 message ID 能力边界 | Task 1/2 用例；DESIGN 修订记录 |
| board_status（D3） | 自流隔离（t-status-3）与无账本副作用（t-status-7/p-status-1）全通过；空流/未知轮次/缺失损坏的保守投影正确（null 不伪装 0/false）；不输出覆盖水位字段 | Task 2 Step 2b 用例 |
| G7/G8（交叉检查） | 聚合 Task C 的 n-red-1、n-red-2、p-red-2 全通过；本计划未另写实现、文件交集无冲突合流 | `bun test test/nudge.test.ts test/plugin.test.ts` |
| 回归 | 全量套件无回归；类型干净 | `bun test`（全绿，列出实际 pass 数）、`bunx tsc --noEmit`（0 错误） |

## 任务依赖与顺序

```
聚合计划 Task A → Task B → Task C（G7/G8 修复，含值比较与 transform 推进）→ Task D → Task E
                              │
本计划 Task 1 ────────────────┘（依赖聚合终态形态；A–E 全部合流后才开始，两计划不交替）
   → Task 2（依赖 Task 1；D1/D3 通道随实现——含 Step 2b board_status）
   → Task 4（依赖 Task 2 契约定型后才回写 DESIGN）
   → Task 5（依赖 Task 1/2/3/4 全部）
Task 3（已先行合流为例外：纯新增文件——规则文档/脚本，不触碰 src 与共享测试文件；脚本读板走既有公开 API）
```
排程互斥（M-I5 定案）：**聚合计划 Task A–E 全部合流后**才开始本计划 Task 1/2（两计划不交替执行；Task 3 已先行合流为例外）；本计划按聚合终态回归基线（140 用例；含 p-rep 则 150）起步。同一批会话协调执行顺序，任何行为区域（nudge.ts/plugin.ts 的事务与判定）单写者推进。