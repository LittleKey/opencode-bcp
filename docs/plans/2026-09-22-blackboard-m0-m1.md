# 跨 agent 黑板（opencode-bcp）M0+M1 实现计划

> 步骤使用复选框（`- [ ]`）跟踪进度。

**Goal:** 依据冻结设计 `DESIGN.md`（v3，sha256 `067a773d0a748613abc61166ea993222dc2bc9bbb17b3622491f158a844bcf24`，369 行）实现 M0+M1 第一步上线（DESIGN §14.3）：immutable put/get/index + 稳定 ID + 必填 description + 有界目录 nudge，并用 live spike 验证 §15 开放问题；聚合（§8）不在本计划范围。

**Architecture:** 单个 opencode 插件（TypeScript 源码，bun 直接加载；安装时以 `bun build` 产出单文件 `dist/blackboard.js`，依赖内联，运行时零外部导入）。插件向宿主注册 3 个工具（`board.put` / `board.index` / `board.get`）、目录快照注入（`experimental.chat.messages.transform`）、会话与轮次观测（`chat.message` / `event`）。存储层、资格校验、nudge 决策均为与插件解耦的纯 TS 模块，`bun test` 可独立验证；权限矩阵与 pin 读取作用于目录元数据与派生引用。会话→scope/stream 归属以**持久化映射**为准：存储根下 `scope-index.json` 记录 `rootSessionId → scope_id`，scope 内 `session_index` 记录 `sessionId → stream`；子会话经宿主 parent 链（A-C5 确认字段）挂到父 scope；**未知会话不自动并入任何 scope**（读路径拒绝、写路径显式错误；工具路径只做 lookup-only 解析，注册仅发生在会话事件钩子，C2）。nudge 预算账本以 `session + admitted input` 为主键持久化于 `StreamMeta.budget`，身份不可恢复时一律抑制（无兜底额度）。

**Tech Stack:** bun 1.3.14（`/home/littlekey/.bun/bin/bun`；宿主 opencode 1.18.31 单二进制）；TypeScript 5（`bunx tsc --noEmit` 类型检查）；测试 `bun test`；依赖仅 `zod ^4.6.5`（dependencies）与 `@opencode-ai/plugin ^1.18.31`、`typescript ^5`、`@types/bun`（devDependencies，构建时内联、运行时不解析）；构建 `bun build --target=bun`。live 验证用 `opencode run`（flags：`--pure`、`--format json`（仅 CLI 级事件：text/tool_use 等，**不是**完整 message/session 事件流）、`--print-logs`、`--log-level DEBUG`、`-m provider/model`、`-s session`、`--title`）。live 证据主渠道 = 插件侧结构化日志（探针 `evidence.jsonl`、blackboard `blackboard.log`），不依赖 CLI 事件完整性。

**Requirements:**
- 权威设计：`/home/littlekey/github/opencode-bcp/DESIGN.md`（不得修改）。本计划逐节引用：§0.4 已核实前提 V1–V6、§3 存储布局与 scope/stream 语义、§4 消息 schema、§5 稳定 ID、§6 写入与幂等语义、§7 必填 description、§8 聚合（仅资格校验函数复用，聚合本体不在范围）、§9 轮次时钟、§10 nudge 契约、§11 工具面与权限、§12 证据边界与 pin 前置、§13 假设分层、§14.1/§14.2 M0(10)/M1(12) 验收、§15 开放问题。
- 派发要求（父级）：Phase A–D 划分、技术选择必须明确、聚合不在范围、验收断言逐字一致、无占位。
- 父级裁定 P1–P5（全部采纳）：P1 删除兜底额度、身份未知一律抑制且显式标记降级；P2 幂等=提交字节精确相等；P3 第一步仅逻辑 tombstone；P4 Phase A 三身份不可观测即停止升级；P5 宿主事实按独立核对更正（见附录 A）。
- 父级裁定 P6–P9（本轮新增，全部采纳）：P6 幂等域/记录域两个字节域分离——幂等域 TLV **空数组必须显式编码（缺失与空数组字节不同）**，记录域 = 落盘完整 JSON 字节用于存储+hash+证据绑定，各自只在自己域内校验；P7 superseded 记录**不**因被修正而额外受保护，按 D:§8.3 与其他旧记录同资格；P8 验收状态仅 {通过/失败/gated/降级-未满足}，无"观察项"，无法在第一步充分验证的子场景要么 gated 要么登记降级、不得让整体项"通过"；P9 配额 = scope 目录**实际磁盘占用**口径（提交数据 + 元数据增量 + pending journal + 临时文件），锁内核算并留可证明上界。
- 父级裁定 P10–P16（本轮新增，全部采纳）：P10 锁回收改用**内核 flock**（`bun:ffi` 调 libc `flock`，进程死亡自动释放）——无接管/回收路径，从构造上消除 TOCTOU，不再依赖"删除前再读"；P11 所有"两进程竞争"测试用**真实独立进程**（Bun.spawn worker）+ 受控同步点，覆盖首次 root 创建/锁竞争/预算竞争，且断言在错误实现上必然失败；P12 `roundKnown` 判定必须以**本次请求的身份验证结果**为输入，验证失败 → 立即 unknown，同一 admitted-input 恢复幂等（不增轮、不重置额度、不重复注入）；P13 nudge 测试对齐算法——初始机会每轮至多一次（同轮第二次初始 → `fulfilled_initial`，不消耗），共享两次预算以"初始一次 → 压力一次 → 压力拒绝"验证，plug-8 修正为已用状态下 0 注入、真实进程竞争恰 1 次仅当起点允许；P14 配额按提交各阶段**实际将写出的完整文件的峰值**核算（含整个新 metadata 的临时副本），给可证明上界，fixture 必须至少一条成功写入；P15 工具 `kind` 保持 optional（存在性显式传递、不注入默认值），`replay` 返回记录域 hash，幂等判定 = TLV 字节精确相等（sha256 仅作快速筛选），`listIndex` 增加 caller 入参；P16 Phase A 负向实验必须真实构造（并发排队、重复 hook 观察），"正向一致"不得宣布反例不存在，live 判据与生产 JSON 日志 schema 一致，rgc 只把"无匹配"映射 0。
- Validation owner：父级编排（实施由父级派发；本计划不启动实施）。

## Global Constraints

1. 不 patch omo-slim / ACP；兼容采用 feature detection + fail-open（降级必须可见：进程内一次性输出日志 `[blackboard] degraded: <原因>`）；不新增服务。
2. 存储固定 `~/.cache/opencode/blackboard/v1/`（§3）：根下 `scope-index.json`（rootSessionId→scope_id 持久化映射）+ `<scope-uuid>/scope.json` + `streams/<stream-uuid>/{metadata.json, entries/e000001.json…}`。`scope-index` 的读取-判定-创建-更新经**根级 flock 锁**串行化（与 stream 锁同一内核锁原语，进程死亡自动释放，P10），映射发布前 scope 目录内先落盘 `owner-root.json`（可恢复的 root 身份，C1）。记录不可变；entry 创建 = 写临时文件后 `rename`；`sequence` 由高水位分配、允许留空号、一经公开永不重用（§5）；**重启/升级不得用新编号覆盖旧编号**。
3. `description` 单行 1–80 Unicode code points；`content` UTF-8 Markdown ≤64 KiB（65536 字节）；校验失败整条拒绝，不产生半条记录、不静默截断（§7）。
4. 幂等与字节域（父级 P2/P6）：`idempotency_key` 比较限定所属 stream。**幂等域** = `encodeImmutablePayload` 的 TLV 字节（只编码调用方不可变字段 description/content/kind/source_refs/related/supersedes/publication_for，按 schema 固定字段序；数组字段显式编码为"tag + u32 元素数 + 逐元素"——**空数组必须显式编码，缺失与空数组字节不同**；缺失标量不编码、不注入默认值；`idempotency_key` 本身不参与）；幂等 equality = 该域字节逐字节相等，不含工具元数据。**记录域** = 落盘 entry 的完整 JSON 字节（含工具元数据），用于存储、`recordHash` 与证据绑定——同一**记录域**字节用于存储+hash+证据绑定。两个 hash 各自只在自己的域内校验，fsck 不跨域比较。同键幂等域字节不同 → 显式冲突；无"归一化默认值"路径（§6）。
5. nudge 预算（父级 P1+C3）：每被接纳业务输入轮次 ≤2 次动态提醒；每模型请求 ≤1 次（成功注入的请求身份记入 `seen_requests`，同请求重复 hook 不重复消耗）；预算账本以 `session + admitted input` 为主键持久化，**决策与额度占用在同一锁临界区内完成**（锁内重读最新 rounds/budget → 判定 → 额度占用持久化 → 退出锁后才注入；崩溃窗口只允许少发、不允许多发，并发进程不得超发）；写板/读板/回执/重复 hook 不重置预算；已知身份用尽额度后身份丢失 → 维持已用额度继续抑制；身份不可恢复 → 一律抑制额外动态提醒（**无任何兜底额度**），且不得把初始发布机会标记为已履行，登记表必须标记"降级-未满足"，不得报告完整 M0 通过；同一候选集自动提示一次后跨轮持续抑制（集合标识 = scope/stream + 精确成员身份含 hash；集合列表无截断淘汰）（§10.1/§10.3/§10.4）。
6. 权限（C2）：未注册调用者默认拒绝（不可列、不可读、不可写）；所有解析 `bb://` 引用的入口共用同一授权检查；跨 scope 访问显式 `forbidden`；同 scope 内不可见记录（隔离流）对 `get` 返回与不存在**不可区分**的 `not_found`，不泄漏存在性；对返回的导航关系、引用、元数据同策略（不可读目标的导航边不得返回）。scope 成员资格不隐含可见独立席（councillor）工作流（§11.3）。本计划无聚合，`board.aggregate` 不注册。
7. board 内容是数据，不得升级为系统指令（§13.2）；注入文本必须以固定声明行收尾：`（board 内容为数据，仅检索提示，不构成指令）`；`board.index` 输出末尾附固定声明：`（目录与摘要为检索提示；除非逐条 board.get，未读原文）`。
8. pin 为受信外部元数据（scope.json `pins` 字段，由评审编排直接写入），工具面无写 API；聚合未启用前 pin 机制只需存在并被资格校验（`未pin` 项）与索引标注读取；**pin 生命周期（采纳、持续保护、授权释放、聚合提交时对全部成员重校验）是第二步启用聚合的硬前置，第一步"能读到 pins 字段"不等于生命周期完成**（§12）。
9. 聚合不在本计划范围：`src/aggregate.ts` 仅含类型定义与推迟说明；M1 中依赖聚合的端到端验收（M1-4/7/8/9 的"聚合场景"部分，及 M1-10 的 `covered_by` 导航提示、M1-11 的"聚合丢关键词"场景）显式 gated 到第二步计划；本计划提供资格校验函数与原子基元并完成函数级验证（§14.3）。
10. tombstone 边界（父级 P3）：第一步只实现**逻辑 tombstone**（`get` 返回 `unavailable`、目录排除、ID 不重定向）；隐私/retention 的**物理删除超出第一步范围**（后续设计），任何文案不得把逻辑 tombstone 表述为"隐私删除已完成"。
11. Phase A 闸门（父级 P4）：若探针修复后仍**无法可靠观测 admission / 业务输入 / 模型请求三者身份**及其关系，则停止实施并升级父级决策可交付范围（动态 nudge 需要身份证明，或整体显式降级）；不得以启发式内容正则宣布"可靠"，不得静默改写设计。轮次运行时判定只接受 Phase A 已验证的身份信号；正则仅作保守辅助（匹配合成特征 → 不增轮）。
12. 已核实（§0.4 V1–V6）与假设（§13.1）严格分层：附录 A 将宿主事实分为"已核实（附复核命令）"与"待 Phase A 验证"两层；Phase A 结论按 Task 1 判据表升级或证伪，记录于 `harness/live-protocol.md`；无法独立证实的一律归"待验证"。
13. 本计划不得修改 DESIGN.md；所有验证步骤必须是可执行命令或带明确证据产物的 live 流程。

## Review Focus

| # | 风险 | 预期行为 | 覆盖 |
|---|---|---|---|
| RF1 | 跨插件 hook 顺序竞争（ACP/omo-slim 与本插件同链） | 本插件只原地追加 part，不改删他人消息；异常 fail-open 且降级可见；兼容性结论以"无错误 + 功能共存观察"为准，不宣称语义兼容证明 | Task 1 判据 P5；Task 5 Step 2；Task 7 运行手册 |
| RF2 | child 污染路径（父上下文泄漏进子会话请求） | 子会话注入只含子流目录，marker 按会话隔离；CLI 事件无法验证子请求内容时以探针 evidence 为准 | Task 1 判据 P3；Task 3 resolveAuthz；Task 6 L2（M0-2） |
| RF3 | 注入在 final 请求中不可见（含替换数组不生效的形态错误） | 探针与生产均**原地修改宿主持有的数组**（向最后一条 user message 的 parts 追加）；模型回复可回显标记证明到达 | Task 1 判据 P1；Task 5 Step 2；Task 6 L1（M0-1） |
| RF4 | 身份/轮次不可恢复（跨压缩/重启） | `created_round=null`、一律抑制、不误报机会已履行、登记"降级-未满足" | Task 4 用例 nudge-5/6/8；Task 6 M0-7/M1-5；父级 P1/P4 |
| RF5 | 预算绕过（身份丢失再入、同请求重复、板操作重置、并发超发、账本无法保证 ≤2/≤1） | 单一持久化账本：已用额度跨身份丢失保持；成功注入才记请求身份；**锁内**重读→判定→占用持久化→注入（并发进程同读旧额度不可能超发）；`roundKnown` 判定以**本次请求验证结果**为输入，验证失败立即 unknown（P12） | Task 4 用例 nudge-1~14；Task 5 用例 plug-8/9/10（plug-9 = 真实子进程预算竞争）；Task 6 M0-7 |
| RF6 | 并发双写（序号冲突/重复记录） | 序号唯一单调，重试幂等，不同记录永不合并；lockcheck 走生产 put 路径 | Task 2 用例 storage-9/10 + scripts/lockcheck.ts；Task 6 M0-4 |
| RF7 | 提交事务崩溃窗口（死锁、重复发布、预留丢失、scope-index 竞争） | 单一事务边界：锁内读最新元数据 → 先预留序号 → 发布 entry → 幂等映射与 nav 更新随提交原子建立（崩溃恢复**复用完整提交投影，含导航**，N4）；锁 = 内核 flock，进程死亡自动释放，**无接管/回收路径**（P10，从构造上消除 TOCTOU）；scope-index 竞争走 F2 冲突报告协议（B1 必冲突报告）；`recoverPending`/`owner-root.json` 恢复 | Task 2 用例 storage-4/5/8/10/13/14/15/17（13 为 F2 冲突报告协议；4/5/17 崩溃态导航以 `readMeta().nav` 直接断言，F6）；Task 6 M1-8（基元级，端到端 gated 第二步） |
| RF8 | 配额/失败可见性（静默删数据腾空间） | 锁内按**提交各阶段实际将写出文件的峰值**预检配额（整个新 metadata 的临时副本 ×2 + 完整 entry + 可证明上界，P14）；`quota_exceeded` 显式失败；锁被存活持有者占用时 `lock_held` 显式失败，不自动夺锁 | Task 2 用例 storage-7/11；Task 3 用例 tools-10；Task 6 M1-12 |
| RF9 | 与 ACP 压缩叠加（continuation 误判新轮 → 预算重置） | continuation 归 internal，不增轮、不重置预算；轮次判定只接受已验证身份信号 | Task 4 classifyInput；Task 1 判据 P0/P4；Task 6 L1 统计 |
| RF10 | 授权缺口（未知调用者、引用校验绕过、派生关系/元数据泄漏） | 未注册默认拒绝；引用解析统一授权；不可读记录的 nav/引用/存在性均不泄漏 | Task 3 用例 perm-2/3/5、tools-6/7/11；Task 6 M0-9 |
| RF11 | admission/请求身份不可靠（hook≠admission、局部稳定≠一一对应） | Phase A 必须证明三身份来源与关系（P0 闸门）；不可靠 → unknown/null + 抑制 + 降级报告 | Task 1 判据 P0；Task 4 classifyInput；Task 6 M0-1/M1-6 |

## File Structure

```
opencode-bcp/
  DESIGN.md                            # 冻结设计（权威依据，本计划不得修改）
  docs/plans/2026-09-22-blackboard-m0-m1.md   # 本计划
  package.json                         # bun 项目元数据、脚本（test/typecheck/build/observe/lockcheck）、依赖清单
  tsconfig.json                        # 严格 TS 配置（bun 类型，noEmit）
  src/ids.ts                           # bb:// ID 构造/解析与 entry 文件名映射（纯函数）
  src/schema.ts                        # BbRecord/PutInput 类型、description/content 校验、不可变载荷字节编码、recordHash（§4/§6/§7）
  src/storage.ts                       # scope-index/scope/stream/entries、单一 put 事务、recoverPending、锁、配额、逻辑 tombstone（§3/§5/§6）
  src/eligibility.ts                   # §8.3 资格公式（含 caller=原作者约束、nav 拆分、pin 读取；服务快照统计与第二步聚合校验）
  src/indexing.ts                      # 目录视图 compact/all、关键词检索、绑定式 cursor、快照计数（§11.2/§10.2）
  src/rounds.ts                        # 轮次时钟：admission 信号驱动的分类与轮次账本（§9）
  src/nudge.ts                         # 预算账本（无兜底额度）、decideNudge 决策、快照渲染 ≤2KiB（§10.1–10.4）
  src/permissions.ts                   # 未注册拒绝、授权流发现、读/写/引用矩阵、councillor 隔离、pin 读取（§11.3/§12）
  src/tools.ts                         # board.put/index/get 三个 ToolDefinition（§11.1）
  src/aggregate.ts                     # 聚合类型定义与推迟说明（不注册工具，§14.3 第二步）
  src/plugin.ts                        # 插件入口：hooks 注册、持久化 scope 归属解析、注入与降级
  test/ids.test.ts                     # ID 纯函数用例
  test/schema.test.ts                  # 校验/字节幂等/hash 用例
  test/storage.test.ts                 # scope 归属/事务恢复/并发/锁/配额/tombstone 用例
  test/indexing.test.ts                # 视图/检索/绑定 cursor 用例
  test/tools.test.ts                   # 三工具契约用例（含 M1 负向与授权缺口）
  test/permissions.test.ts             # 授权/隔离/pin/未知调用者用例
  test/rounds.test.ts                  # admission 信号分类用例
  test/nudge.test.ts                   # 预算/去重/身份丢失/渲染用例
  test/eligibility.test.ts             # 资格公式用例（M1-4/5/6 函数级）
  test/plugin.test.ts                  # 插件接线/降级/未注册拒绝用例
  test/acceptance.test.ts              # DESIGN §14 断言的端到端自动化映射
  scripts/lockcheck.ts                 # 跨进程并发双写检查脚本（生产 put 路径 + 专属临时目录）
  scripts/observe.ts                   # 存储 fsck 与统计（Task 2 交付；Task 6/7 使用）
  scripts/install.sh                   # 安装：构建并复制 dist/blackboard.js 到插件目录（全局/项目两种模式，同一 target 语义）
  scripts/uninstall.sh                 # 回滚：按同一 target 语义移除插件文件（保留存储数据；失败不吞错）
  dist/blackboard.js                   # 构建产物（脚本生成，不手工编辑）
  harness/live-protocol.md             # live 观察协议 + Phase A 结论表 + 假设升级记录 + 验收登记表 + 运行手册
  harness/prompts/*.txt                # 受控 prompt（一行一文件，见 Task 1/6 清单）
  harness/scratch/.opencode/plugin/bb-probe.ts   # Phase A 探针插件（最小注入+证据；Phase C 以 BB_PROBE_OFF=1 复用观测，收尾移除）
  harness/runs/                        # live 证据目录（命令以绝对路径使用，运行时 mkdir -p 创建，不入库）
```

---

### Task 1: Phase A — live 可行性 spike（注入探针 + 观察协议）

**Files:**
- Create: `harness/scratch/.opencode/plugin/bb-probe.ts`
- Create: `harness/live-protocol.md`
- Create: `harness/prompts/probe-echo.txt`
- Create: `harness/prompts/probe-parent.txt`
- Create: `harness/prompts/probe-child.txt`

**Interfaces:**
- Consumes: DESIGN §0.4（V1–V6）、§15 开放问题；附录 A 宿主事实（已核实层）。
- Produces（后续任务依赖）: `harness/live-protocol.md` 的 Phase A 结论表，结论行编号 A-C1…A-C8：
  - A-C1 注入形态可见性：**原地向最后一条 user message 的 parts 追加 text part** 是否出现在 outgoing 请求（与生产形态一致；探针在无 user message 时才用 append-message 兜底并单独记录）
  - A-C2 请求身份字段：`transform` 行的 `(sessionID, lastMsgId)` 在同请求多次调用中是否稳定、与 `chat.message` 的对应关系
  - A-C3 全局 `~/.config/opencode/plugin/` 是否被扫描、扫描范围是否含 `*.js`（决定 Task 7 默认安装模式）
  - A-C4 title/compaction 等内部会话的识别特征与 agent 名单（决定 `BLACKBOARD_SKIP_AGENTS` 默认值）
  - A-C5 `client.session.get({ path: { id } })` 异步返回中的 parent 字段名（决定子会话 scope 归属实现）
  - A-C6 compaction continuation 消息的宿主侧确定特征（决定 `matchesKnownSynthetic` 辅助特征；无确定特征则保持"不匹配也不增轮"）
  - A-C7 `opencode run --format json` 的 CLI 事件是否携带 sessionID（决定 Task 6 live 步骤的会话 ID 提取方式；备用渠道 = 探针日志）
  - A-C8 宿主是否暴露 review 范围/角色语义 API（若无 → 权限来源仅 scope 成员资格 + 隔离名单 + pins，写明）
  - 假设升级记录：§13.1 五条假设逐条标注"已验证（判据）/证伪/维持"。

- [ ] **Step 0: 常驻宿主与 SDK 通道准备（Phase A 自包含，父级 F3：宿主启动不依赖 Task 6）**

```bash
RUNS=/home/littlekey/github/opencode-bcp/harness/runs; mkdir -p $RUNS
mkdir -p ~/github/opencode-bcp/harness/scratch   # 干净环境显式创建（G3：不依赖先前运行遗留目录；探针路径 Step 1 才交付）
cd ~/github/opencode-bcp/harness/scratch
opencode serve --port 4599 > $RUNS/serve.log 2>&1 & echo $! > $RUNS/serve.pid
sleep 1; kill -0 $(cat $RUNS/serve.pid) && rg -c 'listening|http://localhost:4599' $RUNS/serve.log   # 宿主就绪检查（F4）
bun -e 'const {createOpencodeClient} = await import("@opencode-ai/sdk"); const c = createOpencodeClient({baseUrl: "http://localhost:4599"}); const r = await c.session.get({path: {id: "ses_probe"}}); console.log("sdk-ok", JSON.stringify(r.data ?? r.error))'   # SDK 连通验证（session 不存在也证明通道连通）
```
预期：serve 进程存活（`kill -0` 通过）、serve.log 出现监听行、SDK 调用返回结构化响应（`sdk-ok` + JSON）。A-C5 的字段名复核（parentID 等）在此通道上完成。R5a/R5b（Step 8）与 Task 6 的 L2/L2b **复用本宿主与 `$RUNS/serve.pid`**；Task 6 前置相应改为"复用 Phase A Step 0 已启动/已准备的宿主与脚本，已退出则同法重启"。全部 live 结束后 `kill $(cat $RUNS/serve.pid)`。

- [ ] **Step 1: 写探针插件**（只注入唯一标识并留证据，不实现 board 任何逻辑；**原地修改宿主数组**；`BB_PROBE_OFF=1` 时禁用注入但保留全部观测日志——Phase C 复用观测而不污染验收）

```ts
// harness/scratch/.opencode/plugin/bb-probe.ts
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const EVIDENCE_DIR = `${process.env.HOME}/.cache/opencode/blackboard-probe`
const RUN_TAG = process.env.BB_PROBE_RUN ?? "shared"
const EVIDENCE = `${EVIDENCE_DIR}/evidence-${RUN_TAG}.jsonl` // 按 run 归档，不删共享文件
const OFF = process.env.BB_PROBE_OFF === "1"

async function log(line: Record<string, unknown>): Promise<void> {
  mkdirSync(dirname(EVIDENCE), { recursive: true })
  await Bun.write(Bun.file(EVIDENCE), JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n", { append: true })
}

export const BBProbePlugin: Plugin = async (input) => {
  await log({ hook: "plugin-init", directory: input.directory, serverUrl: input.serverUrl.href, off: OFF })
  return {
    "chat.message": async (inp, output) => {
      const parts = output.parts as Array<{ type: string; text?: string }>
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ")
      await log({
        hook: "chat.message", sessionID: inp.sessionID, agent: inp.agent ?? null,
        messageID: inp.messageID ?? null, role: output.message.role,
        messageId: (output.message as { id?: string }).id ?? null, // 独立宿主观察量：消息身份
        inputKeys: Object.keys(inp).sort(), textPrefix: text.slice(0, 48),
      })
    },
    event: async ({ event }) => {
      const type = event.type
      const raw = JSON.stringify(event)
      // session./message. 类事件完整记录（请求/admission 字段可能超界）；其余记前 800 字符
      const head = type.startsWith("session.") || type.startsWith("message.") ? raw : raw.slice(0, 800)
      await log({ hook: "event", type, head })
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output.messages as Array<{
        info?: { sessionID?: string; id?: string; role?: string }
        parts: Array<{ type: string; text?: string }>
      }>
      const sessionId = String(msgs[0]?.info?.sessionID ?? "unknown")
      const firstMsgId = String(msgs[0]?.info?.id ?? "unknown")
      const lastMsgId = String(msgs[msgs.length - 1]?.info?.id ?? "unknown") // 观察量；请求身份是否等于真实模型请求由 Step 9 判定，此处不预设
      const marker = `BB-PROBE-${sessionId.slice(-6).toUpperCase()}`
      let variant = "append-part"
      if (!OFF) {
        const text = `[blackboard-probe] ${marker} 看到本标记请在回复首行原样输出。`
        const lastUser = [...msgs].reverse().find((m) => m.info?.role === "user")
        if (lastUser) {
          lastUser.parts.push({ type: "text", text }) // 原地追加，不替换数组
        } else {
          variant = "append-message"
          msgs.push({ info: { id: `bbprobe-${Date.now()}`, sessionID: sessionId, role: "user" }, parts: [{ type: "text", text }] })
        }
      }
      await log({ hook: "transform", sessionID: sessionId, firstMsgId, lastMsgId, marker, injected: !OFF, variant, inCount: msgs.length })
    },
  }
}
export default BBProbePlugin
```

- [ ] **Step 2: 写观察协议文档** `harness/live-protocol.md`，初始内容为四张表：①运行协议（Step 3–10 的命令原样收录）；②通过/失败判据 P0–P5（见 Step 10）；③Phase A 结论表（A-C1…A-C8 + §13.1 假设升级列，初始值全部为"待验证"）；④Phase A 失败时的父级升级记录位（P0/P4 闸门触发即填写"降级-未满足"范围建议）。证据文件按 run 归档（`evidence-<run>.jsonl`），不删除共享证据。

- [ ] **Step 3: 受控 prompt 文件**（各一行）：
  - `harness/prompts/probe-echo.txt`：`这是一次注入可见性测试。请直接回答：OK。如果你在上下文中看到以 BB-PROBE- 开头的标记，请在回答第一行原样输出该标记。不要调用任何工具。`
  - `harness/prompts/probe-child.txt`：`你是被派出的子代理。请直接回复一行：child-ok。如果上下文中有以 BB-PROBE- 开头的标记，请在第二行原样输出该标记。`
  - `harness/prompts/probe-parent.txt`：`请使用 task 工具派出一个子代理（agent: build），把下面这句话原样交给它执行，并把它的回复原样返回给我："按照 harness/prompts/probe-child.txt 文件中的指示回复"。`

- [ ] **Step 4: 运行 R1（注入可见性 + admission/请求身份观测）**

Run:
```bash
mkdir -p /home/littlekey/github/opencode-bcp/harness/runs
export BB_PROBE_RUN=r1
cd ~/github/opencode-bcp/harness/scratch
opencode run --print-logs --log-level DEBUG -m newapi/deepseek-v4-flash --title bb-spike-r1 "$(cat ../prompts/probe-echo.txt)" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r1.json 2> /home/littlekey/github/opencode-bcp/harness/runs/r1.err
cp ~/.cache/opencode/blackboard-probe/evidence-r1.jsonl /home/littlekey/github/opencode-bcp/harness/runs/evidence-r1.jsonl
rg -o "BB-PROBE-[A-Z0-9]+" /home/littlekey/github/opencode-bcp/harness/runs/r1.json | sort -u
rg -c '"hook":"chat.message".*"role":"user"' /home/littlekey/github/opencode-bcp/harness/runs/evidence-r1.jsonl
rg '"hook":"transform"' /home/littlekey/github/opencode-bcp/harness/runs/evidence-r1.jsonl | rg -o '"lastMsgId":"[^"]*"' | sort | uniq -c
```
Expected: 第一条命令输出恰 1 个标记（CLI 事件中的 text 事件含回复文本，回显即到达证明，判据 P1）；`chat.message` 的 user 行计数 = 1（admission 观测；对照 transform 行数可发现 hook≠admission 的差异，供 A-C2）；transform 行按 `lastMsgId` 去重后每个身份恰 1 行（判据 P2）。`--format json` 只含 CLI 级事件，**不得**用 `"role":"user"` 之类的 CLI 计数替代上述 evidence 判据。证据按 run 归档于 `harness/runs/evidence-r1.jsonl`（供 Step 9 关联复核）。

- [ ] **Step 5: 运行 R2（`--pure` 对照，证明注入来自插件路径）**

Run:
```bash
opencode run --pure -m newapi/deepseek-v4-flash "$(cat ../prompts/probe-echo.txt)" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r2.json 2> /home/littlekey/github/opencode-bcp/harness/runs/r2.err
rg -o "BB-PROBE-[A-Z0-9]+" /home/littlekey/github/opencode-bcp/harness/runs/r2.json || echo "NO-MARKER"
```
Expected: `NO-MARKER`。若仍出现 marker，则记录"`--pure` 不禁用本地目录插件"，改用对照法：`rm harness/scratch/.opencode/plugin/bb-probe.ts` 后重跑本步（预期 `NO-MARKER`，之后恢复探针文件），并在结论表注明对照方式。

- [ ] **Step 6: 运行 R3（子会话不串流；子请求内容以探针 evidence 为准——CLI 事件会过滤其它会话的 part）**

Run:
```bash
export BB_PROBE_RUN=r3
opencode run -m newapi/deepseek-v4-flash --title bb-spike-r3 "$(cat ../prompts/probe-parent.txt)" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r3.json 2> /home/littlekey/github/opencode-bcp/harness/runs/r3.err
cp ~/.cache/opencode/blackboard-probe/evidence-r3.jsonl /home/littlekey/github/opencode-bcp/harness/runs/evidence-r3.jsonl
rg -o '"sessionID":"ses_[A-Za-z0-9]+"' /home/littlekey/github/opencode-bcp/harness/runs/evidence-r3.jsonl | sort -u
rg '"hook":"transform"' /home/littlekey/github/opencode-bcp/harness/runs/evidence-r3.jsonl | rg -o '"sessionID":"[^"]+"|"marker":"[^"]+"' | sort
```
Expected: 出现 ≥2 个不同 `ses_` 前缀 sessionID；transform 行中每个 sessionID 只绑定自己的 marker（父/子 marker 集合不相交）；子会话回复（经父级转发出现在 r3.json 的 text 事件中）含 `child-ok` 且不出现父会话 marker。子请求内容以 `evidence-r3.jsonl` 为准（CLI 事件会过滤其它会话的 part）。

- [ ] **Step 7: 验证 A-C3/A-C5/A-C7/A-C8**

Run:
```bash
export BB_PROBE_RUN=r4
mkdir -p ~/.config/opencode/plugin
cp ~/github/opencode-bcp/harness/scratch/.opencode/plugin/bb-probe.ts ~/.config/opencode/plugin/bb-probe.ts
cd /tmp/opencode
opencode run -m newapi/deepseek-v4-flash "$(cat ~/github/opencode-bcp/harness/prompts/probe-echo.txt)" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r4.json 2> /dev/null
rg -c '"hook":"transform"' ~/.cache/opencode/blackboard-probe/evidence-r4.jsonl || echo "GLOBAL-NOT-SCANNED"
# `*.js` 生效性：用真实构建产物的最小纯 JS 探针（非 TS 改名），验证后清理
cat > ~/.config/opencode/plugin/bb-probe-js.js <<'EOF'
const fs = require("node:fs")
const dir = `${process.env.HOME}/.cache/opencode/blackboard-probe`
fs.mkdirSync(dir, { recursive: true })
module.exports = async () => ({
  "experimental.chat.messages.transform": async (_i, o) => {
    fs.appendFileSync(`${dir}/evidence-r4js.jsonl`, JSON.stringify({ hook: "transform", ts: Date.now() }) + "\n")
  },
})
EOF
cd /tmp/opencode && opencode run -m newapi/deepseek-v4-flash "回答 OK 即可，不要调用工具。" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r4js.json 2> /dev/null
rg -c '"hook":"transform"' ~/.cache/opencode/blackboard-probe/evidence-r4js.jsonl || echo "JS-NOT-SCANNED"
rg -o '"type":"[a-z._]+"' ~/.cache/opencode/blackboard-probe/evidence-r4.jsonl | sort | uniq -c | sort -rn | head -20
rg -o '"sessionID":"[^"]*"' /home/littlekey/github/opencode-bcp/harness/runs/r1.json | sort -u | head -3 || echo "CLI-NO-SESSION-ID"
rm -f ~/.config/opencode/plugin/bb-probe.ts ~/.config/opencode/plugin/bb-probe-js.js
```
Expected: transform 计数 >0 → A-C3 = 全局目录被扫描且 `*.ts` 生效；`JS-NOT-SCANNED` → `*.js` 不生效（结论表记录扫描范围实际口径）；否则 A-C3 = 全局 + `*.js` 生效（Task 7 默认全局安装）；`GLOBAL-NOT-SCANNED` → Task 7 默认按项目安装。event 行 type 清单确认 `session.updated`/`message.updated` 等事件类型与完整记录的负载字段（A-C5 的 parent 字段从 `session` 类事件与 SDK 侧共同确认，SDK 调用形态复核在 Task 5 编码时执行）。末段命令判定 A-C7（CLI 事件是否带 sessionID；`CLI-NO-SESSION-ID` → Task 6 会话 ID 从探针日志提取）。两份探针副本（.ts 与 .js）验证后均已删除，不残留全局副本。A-C8 依据：本步 event 完整记录与 SDK 类型中均无 review 范围/角色语义 → 权限来源即 Global Constraints #6 所列三者，写入结论表。

- [ ] **Step 8: 负向与反例构造（R5–R7，供 Step 9 三问判定用）**

| 运行 | 构造方法 | 观察量（写入结论表） |
|---|---|---|
| R5 noReply/排队反例（真实构造，父级 P19/F3） | **R5a noReply**：经同一宿主实例的 SDK 请求通道发送 noReply 请求——HOST:301337 证实非 attach 的 CLI 走进程内 `opencode.internal` fetch；做法：用 Step 0 准备的常驻宿主（`--attach http://localhost:4599`），以 `@opencode-ai/sdk` 的 `session.prompt` 携带 noReply 参数发送（SDK 字段形态以 A-C5 运行时复核为准）。**R5b running**：对同一常驻宿主以 `--attach` 共享 runner——先发长任务占住 runner，再发短消息；**记录真实结果 ∈ {排队执行, 仅等待现有 runner, unknown}，不预设排队成功（V3：accepted/等待现有 runner ≠ 排队执行第二轮）；`--attach` 只解决"同一宿主实例"** | R5a：`chat.message`(user) 行出现而**无后续 transform 行**——在 F3 修正语义下这是 **P0 通过证据**（"接收"与"实际 admission"可区分），不是失败；R5b：记录三态之一及其观察值。**通道不可用或 SDK 形态不符 → 记 unknown，按 Step 9 闸门停止升级（P19/F3）** |
| R6 重复 hook / 跨请求历史复用 | 重复 hook（**预期行为**——稳定 request ID 本就支持"同一请求多次 transform"的去重，父级 P19 定性修正）：单次 run 内 transform 行数 vs requestId 去重数对比；跨请求历史复用（**唯一的不稳定形态**）：R3 父子两请求 + R5b 第二条消息，比对不同请求是否取同一历史值 | 重复 hook 次数（同 requestId 多行 = 合法，去重后 1 次有效机会，**不是不稳定证据**）；跨请求同 id 反例（存在 → 该观察量不能作请求身份，记入结论表） |
| R7 compaction 反例 | 长会话续写（`-s` 会话追加长文本多次）尝试自然触发 compaction；无法构造则**记 unknown** | 触发与否；触发时 `message.updated`/transform 中 continuation 消息的字段特征（A-C6）；unknown → A-C6 维持假设且按 P0 闸门规则处理 |

每项运行以独立 `BB_PROBE_RUN=<tag>` 归档证据到 `harness/runs/`；R5–R7 结论全部写入结论表。**反例未观察到 ≠ 反例不存在**（P16）：任一关键反例不可构造/不可判定 → 对应三问记 unknown，按 Step 9 的 unknown 规则走 P0 闸门，不得以"正向三次一致"宣布否定结论；A-C6 为 unknown 时 Task 4 的 `matchesKnownSynthetic` 保持正则辅助现状。

- [ ] **Step 9: admission 三身份判定（父级 P4 闸门检查点）**

把 R1/R3 的 `chat.message` 行（admission 候选）、其 `messageID`/`messageId`（业务输入身份）、`transform` 行（模型请求身份观察量）与 R5–R7 反例证据（`harness/runs/` 按 run 归档）做三方关联，回答三个问题并写入结论表（①的语义经父级 F3 修正）：①**"接收"与"实际 admission"能否区分**——R5a 观察到 noReply 消息有 `chat.message`(user) 行而无 transform 行，即为**通过证据**（区分存在、且 hook≠admission 得到实证）；②`(sessionID,lastMsgId)` 派生身份是否可用——判定标准（父级 P19）：同请求多次 transform 属预期（去重即为此设，不算不稳定）；**跨不同请求取同一历史值**才算不稳定（存在即请求身份不可用）；③能否从宿主字段（非内容正则）识别"该 user 消息已实际进入 runner 处理"。三个问题全部"是"→ P0 通过；任一为"否"或"unknown"（含反例不可构造；独立模型请求观察量不明确 → 按第③问走 P4，保留 fail-closed 边界）→ **停止后续任务**，向父级提交 P4 闸门升级（可交付范围二选一：动态 nudge 改为需要身份证明的最小集，或整体降级为无动态提醒的纯工具面），登记表标记"降级-未满足"，不得用内容正则宣布可靠，不得以正向观察推断否定结论（P16）。

- [ ] **Step 10: 回填结论与判据判定**

把 A-C1…A-C8 与下列判据的判定结果写入 `harness/live-protocol.md`；P0 或任一 P 项失败按其"失败动作"处理（停止/升级），不得带失败假设继续实施。R5–R7 的反例结论（hook≠admission 差值、requestId 跨请求复用——唯一不稳定形态（P19）、compaction 特征）一并附于对应结论行。

| 判据 | 通过标准 | 失败动作 |
|---|---|---|
| P0 三身份可观测 | Step 9 三问全部"是"，3/3 次重跑一致 | 触发父级 P4 闸门（见 Step 9），登记"降级-未满足" |
| P1 注入可见 | R1 回复含 marker，原地 parts 追加形态，3/3 次重跑一致 | transform 路径证伪 → 升级父级（§15 注入竞争） |
| P2 请求身份 | 同一 `(sessionID,lastMsgId)` 的 transform 行去重后恰 1 次有效提醒机会；与 chat.message 的对应关系已记录 | 请求身份不可用 → 触发 P0 闸门（不再有"快照版本号兜底"路径，父级 P1） |
| P3 子会话隔离 | R3 中父子 marker 不相交、子回复无父 marker（以探针 evidence 为准） | 串流 → 升级父级（RF2） |
| P4 无风暴/无新回合 | 单运行 user 消息 admission 计数 = 1（evidence）；transform 去重后每请求 ≤1 次有效提醒 | 出现自增回合 → 升级父级（RF9） |
| P5 ACP 共存 | `r1.err`/`r3.err` 无任一插件的 error 行；marker 可见；ACP 功能观察正常（其日志/行为无异常） | 冲突 → 记录顺序观察并升级父级。本判据是"无错误+共存观察"，不宣称语义兼容证明 |

假设升级判据（写入结论表，逐条对应 §13.1）：A1 hook 到达 = P1；A2 身份可信 = P3 且 `chat.message` 的 agent 字段与宿主会话一致；A3 轮次识别 = P0 + P4（compaction continuation 样本不可观测 → 记 unknown 并按 P0 闸门规则处理，不得记"已验证"；重复 hook 属预期行为、非反例——P19；运行时按"不匹配也不增轮"保守处理）；A4 原子性/锁 = Task 2/Task 6 测试与 `scripts/lockcheck.ts` 通过；A5 权限验证 = Task 6 L6 通过。

---

### Task 2: Phase B — 存储层（scope 归属 / schema / 单一 put 事务 / 锁 / 配额 / 逻辑 tombstone）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/ids.ts`
- Create: `src/schema.ts`
- Create: `src/storage.ts`
- Create: `scripts/lockcheck.ts`
- Create: `scripts/observe.ts`
- Test: `test/ids.test.ts`、`test/schema.test.ts`、`test/storage.test.ts`

**Interfaces:**
- Consumes: DESIGN §3/§4/§5/§6/§7/§12；Global Constraints #2/#4/#10；父级 P2/P3。
- Produces:
  - `src/ids.ts`：`entryFileName(seq: number): string`；`parseEntryFileName(name: string): number | null`；`formatBbId(scopeId: string, streamId: string, seq: number): string`（产出 `bb://<scope-uuid>/<stream-uuid>/e000123`）；`parseBbId(id: string): { scopeId: string; streamId: string; seq: number }`（非法输入抛 `Error("malformed_id: …")`）。
  - `src/schema.ts`：类型 `RecordKind`、`Writer`、`BbRecord`、`PutInput`、`FieldError`；常量 `KINDS`、`DESCRIPTION_MAX_CODE_POINTS = 80`、`CONTENT_MAX_BYTES = 65536`；函数 `validatePutInput(input: Partial<PutInput>): FieldError[]`；**`encodeImmutablePayload(input: PutInput): Uint8Array`**（父级 P2/P6 幂等域：按 schema 固定字段序做 TLV 编码——标量 `[tag][u32 len][utf8 bytes]`，**数组字段显式编码为 `[tag][u32 元素数][逐元素 [u32 len][bytes]]`——空数组编码为 `tag + 0`，与"字段缺失（不编码）"字节不同**；缺失标量不编码、**不注入任何默认值**；`idempotency_key` 本身不参与编码）；`payloadBytesEqual(a: Uint8Array, b: Uint8Array): boolean`；`buildRecordBytes(rec: BbRecord): Uint8Array`（记录域：固定键序 JSON 序列化，可选字段按提交形态：缺失则键不出现）；`recordHash(recBytes: Uint8Array): string`（sha256 hex，输入即记录域落盘字节）。
  - `src/storage.ts`：常量 `DEFAULT_QUOTA_BYTES = 536870912`、`LOCK_RETRY_MS = 20`、`LOCK_RETRY_MAX = 250`（锁为内核 flock，无陈旧回收常量——P10；配额按父级 P17 阶段峰值枚举核算，无近似常量）；类型 `ScopeConfig`（`scope_id/created_at/session_index/quota_bytes/pins`）、`StreamMeta`（`stream_id/session_ids/high_water/created_at/nav/tombstoned/rounds/budget/idem/idem_pending`；`idem[key] = {id, payload_b64, payload_sha256}`——存**完整幂等域 TLV 字节**（base64）+ 快速筛选 sha256，幂等判定以 payload_b64 字节精确相等为准，P15）；`bbV1Root(): string`；`openScopeForRoot(opts: { rootSessionId: string; dataDir?: string; quotaBytes?: number; raceProbe?: { afterIndexMiss: () => void } }): Scope`（`raceProbe.afterIndexMiss` 为**同步**测试交错点——父级 F2：无 Promise，内部以 `Atomics.wait`/同步自旋阻塞，与 `withLock`/`openScopeForRoot` 的同步签名一致）：**根锁持有中**、index 未命中读取后调用；**读取-判定-创建-更新全程持 `<root>/scope-index.lock` 根级 flock 锁**（与 stream 锁同一内核锁，进程死亡自动释放，P10）：读 `<root>/scope-index.json` 的 `rootSessionId→scope_id` 映射：有 → `openScopeById`；无 → 在锁内创建 `randomUUID()` 新 scope 目录、**先落盘 `owner-root.json`（`{rootSessionId, created_at}`，可恢复的 root 身份）**、再原子写回 index、最后释放锁；崩溃恢复：打开时扫描 scope 目录中 `owner-root.json.rootSessionId` 匹配但 index 未发布的条目并补发布映射（C1））；`openScopeById(scopeId: string, opts?: { dataDir?: string }): Scope`（目录缺失抛 `Error("unknown_scope: …")`，**不自动并入**）；`type PutArgs = { writer: Writer; createdRound: number | null; kind?: RecordKind; description: string; content: string; sourceRefs?: string[]; related?: string[]; supersedes?: string[]; publicationFor?: string; idempotencyKey?: string }`（工具内部 camelCase 形态，由 `src/tools.ts` 从 zod snake_case args 映射；可选字段的存在性显式传递，**不注入默认值**——P15，与 P6 字节域一致）；`type PutResult = { status: "stored"; id: string; hash: string; sequence: number; peak_commit_bytes: number } | { status: "replay"; id: string; hash: string } | { status: "conflict"; existingId: string } | { status: "quota_exceeded"; used: number; quota: number }`；`class Scope`：`registerSession(sessionId: string, agent: string): { scopeId: string; streamId: string }`（agent 命中隔离名单则 `isolated:true` 持久化）、`resolveSession(sessionId: string): { scopeId: string; streamId: string; isolated: boolean }`（未注册抛 `Error("unknown_session: …")`）、`readMeta/writeMeta`、**`put(streamId: string, args: PutArgs): PutResult`**（单一事务入口，见 Step 4）、`readEntry(streamId: string, seq: number): BbRecord | null`、`getById(bbId: string): { status: "found"; record: BbRecord; hash: string } | { status: "unavailable" } | { status: "not_found" }`、`markTombstone(streamId: string, bbId: string, reason: string): void`（**仅逻辑**：写 `meta.tombstoned`，entry 文件永不删除——物理删除/隐私擦除超出第一步范围，父级 P3）、`recoverPending(streamId: string): void`、`usageBytes(): number`（**scope 目录实际磁盘占用**：entries + metadata + scope.json + owner-root + 残留临时文件的字节和，`du` 语义）、`withLock<T>(fn: () => T): T`（**内核 flock**：`bun:ffi` dlopen libc 导出 `flock(fd, op)`，fd 由 `fs.openSync(<scope>/.lock, "a+")` 打开；`LOCK_EX|LOCK_NB` 失败等 `LOCK_RETRY_MS` 重试，超 `LOCK_RETRY_MAX` → `lock_timeout`；进程死亡内核自动释放、下次尝试必成功——**无接管/回收路径**，P10；flock 不可用 → `lock_unavailable` fail-closed，不回退用户态协议）、`close(): void`（释放进程内句柄与可重入计数；重开 = 以同 dataDir 新建实例）、getter `config: ScopeConfig`、导出测试故障注入点 `faultHook: ((at: "after_reserve" | "after_publish") => void) | null`（仅测试使用，实施时以此名导出）。
  - `scripts/observe.ts`：fsck 与统计（Step 6）。

- [ ] **Step 1: 项目骨架**

`package.json`：
```json
{
  "name": "opencode-bcp",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit",
    "build": "bun build src/plugin.ts --outfile dist/blackboard.js --target=bun",
    "lockcheck": "bun run scripts/lockcheck.ts",
    "observe": "bun run scripts/observe.ts"
  },
  "dependencies": { "zod": "^4.6.5" },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.18.31",
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```
（版本依据附录 A：omo-slim@latest 顶层实测 `@opencode-ai/plugin 1.18.32`、`zod 4.6.5`；ACP 运行时为 1.18.31——devDep 取 `^1.18.31`，构建内联后运行时不解析外部副本。）
`tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true, "types": ["bun"]
  },
  "include": ["src", "test", "scripts"]
}
```
Run: `cd ~/github/opencode-bcp && bun install`
Expected: 生成 `bun.lock` 与 `node_modules/`，无 `error` 行。

- [ ] **Step 2: `src/ids.ts` + `test/ids.test.ts`**

```ts
// src/ids.ts
export function entryFileName(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`malformed_id: bad sequence ${seq}`)
  return `e${String(seq).padStart(6, "0")}.json`
}
export function parseEntryFileName(name: string): number | null {
  const m = /^e(\d{6,})\.json$/.exec(name)
  return m ? Number(m[1]) : null
}
export function formatBbId(scopeId: string, streamId: string, seq: number): string {
  return `bb://${scopeId}/${streamId}/${entryFileName(seq).replace(/\.json$/, "")}`
}
export function parseBbId(id: string): { scopeId: string; streamId: string; seq: number } {
  const m = /^bb:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/e(\d+)$/.exec(id)
  if (!m) throw new Error(`malformed_id: ${id}`)
  return { scopeId: m[1], streamId: m[2], seq: Number(m[3]) }
}
```
`test/ids.test.ts` 用例：ids-1 `formatBbId`→`parseBbId` 往返一致；ids-2 `parseBbId` 对缺前缀/坏序号/负数抛 `malformed_id`；ids-3 `entryFileName(1) === "e000001.json"`（6 位零填充）；ids-4 `parseEntryFileName("metadata.json") === null`；ids-5 大序号 `entryFileName(1234567) === "e1234567.json"`。
Run: `bun test test/ids.test.ts`
Expected: `5 pass, 0 fail`。

- [ ] **Step 3: `src/schema.ts` + `test/schema.test.ts`**（父级 P2：字节精确幂等）

```ts
// src/schema.ts（核心函数；类型定义见 Interfaces）
const PAYLOAD_TAGS = ["description", "content", "kind", "source_refs", "related", "supersedes", "publication_for"] as const
export function encodeImmutablePayload(input: PutInput): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const push = (tag: string, bytes: Uint8Array) => {
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, bytes.length)
    chunks.push(enc.encode(tag + ":"), len, bytes)
  }
  push("description", enc.encode(input.description))
  push("content", enc.encode(input.content))
  if (input.kind !== undefined) push("kind", enc.encode(input.kind))
  for (const key of ["source_refs", "related", "supersedes"] as const) {
    const arr = input[key]
    if (arr === undefined) continue // 缺失：不编码（与空数组字节不同）
    // 数组域显式编码：tag + u32 元素数 + 逐元素 [u32 len][bytes]；空数组 → tag + 0（P6：缺失 ≠ 空数组）
    const count = new Uint8Array(4)
    new DataView(count.buffer).setUint32(0, arr.length)
    chunks.push(enc.encode(key + ":"), count)
    for (const item of arr) push(key, enc.encode(item)) // 顺序保持提交原样
  }
  if (input.publication_for !== undefined) push("publication_for", enc.encode(input.publication_for))
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}
export function payloadBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
export function buildRecordBytes(rec: BbRecord): Uint8Array {
  // 固定键序；缺失可选字段键不出现（JSON.stringify 自然行为，输入对象不得预填默认值）
  return new TextEncoder().encode(JSON.stringify(rec))
}
export function recordHash(recBytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256")
  h.update(recBytes)
  return h.digest("hex")
}
```
要点（父级 P6：两个字节域）：`validatePutInput` 做 description 四种违例 + content 字节上限检查，任一命中返回错误数组（整条拒绝，§7）。**幂等域**：`encodeImmutablePayload` 只编码调用方不可变字段，其 sha256 记入 `meta.idem[key].payload_sha256`，幂等 equality = 该域字节逐字节相等（`payloadBytesEqual`），不含工具元数据。**记录域**：`buildRecordBytes` 的完整记录 JSON 字节用于落盘、`recordHash` 与证据绑定——同一**记录域**字节用于存储+hash+证据绑定。两个 hash 各自只在自己域内校验，任何 fsck/校验路径不跨域比较。

`test/schema.test.ts` 用例：schema-1 合法输入 → `[]`；schema-2 缺 description → `description_missing`；schema-3 全空白 → `description_blank`；schema-4 含 `\n` → `description_newline`；schema-5 81 个 code points（含多字节）→ `description_too_long`，恰 80 → 通过；schema-6 content 65536 字节 → 通过，65537 → `content_too_large`；schema-7 字段级差异：`encodeImmutablePayload` 对仅改 `source_refs`/`related`/`supersedes`/`publication_for` 各一项的两份输入 → 字节均不同；schema-8 顺序与缺省差异：`source_refs: ["a","b"]` vs `["b","a"]` → 字节不同；`source_refs` 缺失 vs `[]` → 字节不同；schema-9 完全相同提交（逐字段相等、同序）→ `payloadBytesEqual` 为 true；schema-10 `recordHash(buildRecordBytes(rec))` 同记录两次相同、`recBytes` 改任一字节则变、输出 64 位 hex。
Run: `bun test test/schema.test.ts`
Expected: `10 pass, 0 fail`。

- [ ] **Step 4: `src/storage.ts` + `test/storage.test.ts`**（C1 归属 / C4 事务 / I6 配额）

实现要点（完整实现约 260 行）：
- 布局与归属（C1）：`bbV1Root() = join(homedir(), ".cache/opencode/blackboard/v1")`。`openScopeForRoot` 的读取-判定-创建-更新全程持 `<root>/scope-index.lock` 根级锁（与 stream 锁同一原语）：读 `scope-index.json`（`{ scopes: Record<rootSessionId, scopeId> }`）命中 → 打开对应 scope；未命中 → 锁内创建 `randomUUID()` 新 scope 目录，**先写 `owner-root.json`（`{rootSessionId, created_at}`）**，再原子写 index，最后释放锁。启动恢复：`openScopeForRoot` 在拿锁后扫描全部 scope 目录，发现 `owner-root.json.rootSessionId` 匹配但 index 未发布的 → 补发布映射再继续（覆盖"scope 写入后、index 发布前崩溃"）。`openScopeById` 只打开显式指定的 scope 目录，缺失抛 `unknown_scope`。**不存在"root 下捡起任意既有 scope"的路径**——两个独立根会话必然两个 scope。
- `put` 单一事务（C4，全部步骤在**一次** `withLock` 内、锁内先 `recoverPending` 并重读最新 meta）：
  1. 幂等预检（P15 字节判定）：`meta.idem[key]` 或 `meta.idem_pending[key]` 存在 → 先比 `payload_sha256`（快速筛选：sha 不同 ⇒ 字节必不同 → `conflict`）；sha 相同再 `payloadBytesEqual` 对 `payload_b64` 与本次 TLV **逐字节判定**——相同 → `{status:"replay", id, hash}`（hash = `recordHash` 读出**已存 entry 落盘字节**现算，不取缓存），不同 → `{status:"conflict", existingId}`。
  2. 配额预检（父级 P17/F1：**按提交阶段枚举 scope 全部并存文件**）：记 S = scope 内与本次事务无关的全部文件字节和（scope.json + owner-root.json + **其他 stream 的 entries 与 metadata**；本 stream 既有 entries 单列为 E0）、E0 = 本 stream 现存 entries 字节和、M0 = 本 stream 当前 metadata.json 字节、T = scope 内已存在的残留临时文件字节和、E1 = 本次 entry 字节（`entryBytes.length`）、R/C = 本事务 metadata 的两种**不同**序列化态各取完整字节（**预检时实际构建两个 metadata 对象并各取 `byteLength`，不估算**；R = 预留态——含 `idem_pending[key]` 的 `payload_b64` 与 `entry_bytes_b64`；C = 提交态——删 pending、建 `idem`；writeMeta 以临时文件+rename 落盘，故两态在窗口内与旧 metadata 彼此并存）。**keyed put 提交 metadata 时磁盘上是 R、临时文件中是 C，不是两份 C；对 4096 字节 payload，R 比 C 多出约 (4/3)·E 字节，不得假定 R === C（Round 9/G1）**。阶段枚举：`reserve = S + E0 + T + M0 + R`；`publish = S + E0 + T + R + E1`；`commit = S + E0 + T + E1 + R + C`；`peak = max(三阶段)`；`peak ≥ quota_bytes` → `{status:"quota_exceeded", used: peak, quota}`，无任何写入。S/E0/M0/T 以 readdir+stat 实测，无未计入的文件类。`PutResult` 的 `stored` 携带 `peak_commit_bytes`，**仅作交叉校验值：配额正确性判据以独立序列化/文件清单为准（storage-7 步骤③），被测返回值不得作为唯一依据（F1：若实现错误同时污染标定值，自标定无法自证）**。
  3. 预留（原子写一次 `writeMeta`）：`meta.high_water += 1`；keyed 时 `meta.idem_pending[key] = { seq, payload_b64, payload_sha256, entry_bytes_b64 }`；**不写任何 nav 投影（父级 P18：未发布 entry 不得产生已提交导航效果——supersedes 导航移至提交步与 entry 同点发布）**；`faultHook("after_reserve")` 在此之后触发。
  4. 发布：entry 临时文件 + `renameSync`（`faultHook("after_publish")` 在此之后触发）。
  5. 提交（entry 与完整 nav 投影同一提交点，P18）：同一 `writeMeta` 写入 `meta.idem[key] = { id, payload_b64, payload_sha256 }`、`delete meta.idem_pending[key]`、**`args.supersedes` 非空时同批写 `meta.nav[target] = { ...meta.nav[target], superseded_by: 新 id }`（keyed 与无 key 路径一致）**。返回 `{status:"stored", id, hash: recordHash(entryBytes), sequence, peak_commit_bytes}`。
  无 `idempotency_key` 的 put：跳过 idem/pending；nav 投影同样在提交步与 entry 同点写入（P18）。after_reserve 崩溃 → 无 pending、无 nav，只留空号（§5 允许）；**after_publish 后、提交前崩溃 → entry 已可见但无 nav/idem——该 entry 为无幂等映射的合法记录，重试产生新消息（设计允许）；nav 在任何时点都不指向未发布记录（P18）**。
- `recoverPending(streamId)`（锁内调用）：对每个 pending——entry 文件缺失则从 `entry_bytes_b64` 重建发布（同一 seq、同一字节）→ **同一 `writeMeta` 写 `meta.idem[key]`、删 pending、并补齐该记录的全部 nav 投影（含 supersedes；P18：恢复覆盖 entry + 完整导航投影）**。恢复前的崩溃可见状态：entry 不存在（after_publish 半程时仅 entry 可见）且 nav 未写——get/index 永远不会看到指向不存在记录的导航（P18 硬约束）；无 key 的 after_publish 崩溃：entry 已发布、无 pending——重试同 key 不存在，行为 = 新消息（设计允许）。
- 锁（C4-④，父级 P10）：`withLock` 进程内可重入（同实例嵌套直接执行）；跨进程用**内核 flock**——`bun:ffi` `dlopen("libc.so.6")` 导出 `flock(fd: i32, op: i32): i32`，fd 由 `fs.openSync(<scope>/.lock, "a+")` 打开；循环尝试 `flock(fd, LOCK_EX|LOCK_NB)`（=2|4），失败等 `LOCK_RETRY_MS` 重试，超 `LOCK_RETRY_MAX` 抛 `Error("lock_timeout")`。**持有者存活** → 持续失败，绝不抢占（对调用方表现为 `lock_timeout` 显式失败，不做 mtime/pid/nonce 推断）；**持有进程死亡 → 内核自动释放**，下一次尝试必然成功——不存在接管/回收路径，旧的"mtime 老 + pid 死 + nonce 重读"协议整体废弃（A 项 TOCTOU 由构造消除）。`bun:ffi` 或 `flock` 不可用 → 抛 `Error("lock_unavailable")` fail-closed，**不回退任何用户态协议**。scope-index 根锁用同一原语（`<root>/scope-index.lock`）。同主机假设写入模块注释（§13.1 A4 范围）。
- 逻辑 tombstone（P3）：`markTombstone` 只写 `meta.tombstoned[bbId] = "<reason>@<ISO>"`；entry 文件永不删除；`getById` 命中 tombstoned → `{status:"unavailable"}`。
- `StreamMeta.rounds` 初始 `{ current_round: 0, round_known: false, last_admitted_message_id: null }`；`StreamMeta.budget` 由 `src/nudge.ts` 的 `newLedger()` 提供（本任务先以同形内联类型编译，Task 4 接入真实实现——`newLedger()` 的签名与返回值见 Task 4 Interfaces，两个任务的类型必须一致）。

`test/storage.test.ts` 用例（全部 `dataDir` = 临时目录）：storage-1 `openScopeForRoot` 创建 `scope-index.json` 映射与 scope 目录（含 `owner-root.json`）；同 rootSessionId 重开 → 同一 scope_id；storage-2 不同 rootSessionId → 不同 scope；`openScopeById` 未知 uuid 抛 `unknown_scope`；scope A 的 `resolveSession` 对 scope B 的会话抛 `unknown_session`；storage-3 无 key put 的 `high_water` 单调，手工置 5 后下一序号为 6（留空号不回退）；storage-4 `faultHook("after_reserve")` 抛出后：entries 无文件、**`readMeta(streamId).nav` 中目标 id 无 `superseded_by` 键（直接断言存储态导航，F6——`getById` 声明不返回 nav，不为测试扩张接口；公开可见性在 get/index 输出层验证）**；同 key 同 payload 重试 → `recoverPending` 恢复为**恰好 1 条** entry、id 与首次预留一致、`readMeta().nav` 导航补齐、再试返回 `replay`；storage-5 `faultHook("after_publish")` 抛出后：entry 可见但 `readMeta().nav` 目标无 `superseded_by` 键（半程态存储级断言，F6）；keyed 重试 → 恢复导航且仍**恰好 1 条** entry（不重复发布）、同 id；无 key 重试 → 新消息、旧 entry 保留为无导航的合法记录；storage-6 逻辑 tombstone：`markTombstone` 后 `getById` 为 `unavailable` 且 entry 文件**仍存在**（P3：无物理删除）；storage-7 配额（父级 P17/F1/G1：阶段枚举 + **独立序列化校验** + 手算）：fixture 预置**非空他流文件**（他流一条完整记录：entry + metadata）与**非空残留临时文件**（本流 `entries/` 下一个非空 `.tmp-*` 文件）；content = 4096 字节 `"a"`、description = `"quota"`、无 kind/refs → 实测记录域字节 E（`buildRecordBytes` 现算断言，不硬编码近似值）。流程（keyed put，R/C 分列计量；废止旧 oracle——"提交后目录状态推断预留态"的 `du_after + stat(最终 metadata)` 只能得到 `S + E + 2C`，漏掉 `R − C`，不是实际峰值的正确基准）：①首条 put（keyed `K_a`，quota=MAX）→ `stored`；②**独立序列化 R/C 与分阶段求和**（全程不经被测峰值函数）：readdir+stat 独立实测 **S′**（scope 内与本流无关的全部文件字节——scope.json、owner-root.json、他流 entries 与 metadata；**不含残留临时文件**）、**T′**（残留临时文件，独立单列——**S′ 与 T′ 严格互斥，scope 内每个文件恰属一类**；fixture 的非空他流文件必须落入 S′、残留 `.tmp-*` 必须落入 T′，分类遗漏或重复计量都会造成峰值偏差并在步骤③交叉断言处暴露）、E′0（本流既有 entries）、M0′（本流当前 metadata 的 st_size）；用导出的 `encodeImmutablePayload`/`buildRecordBytes`/`recordHash` 与磁盘 metadata 对象构造第二 put（同尺寸 payload、同长度 key `K_b`）的 R′（当前对象 + `idem_pending["k_b"]`，其中 **`payload_b64 = base64(encodeImmutablePayload(input))`（调用方不可变载荷的 TLV 字节）、`entry_bytes_b64 = base64(buildRecordBytes(record))`（完整记录 JSON 字节）——两个字节域不同源，禁止同参同写**）与 C′（R′ − pending + `idem["k_b"]` + supersedes 的 nav 投影），`|R′| = byteLength(JSON.stringify(R′))`、`|C′|` 同法（metadata.json 本身即 JSON，序列化形态一致）；三阶段独立峰值 `reserve′ = S′+E′0+T′+M0′+|R′|`、`publish′ = S′+E′0+T′+|R′|+E`、`commit′ = S′+E′0+T′+E+|R′|+|C′|`，`P2* = max(三值)`（**第二 put 事务的 oracle**）；同法用**首条参数与首条前置状态**构造 R_1/C_1 得 `P1* = max(三值)`（**首条事务的 oracle**——P1* 与 P2* 各自绑定本事务前置状态，两次事务的既有 entries、metadata、幂等映射都不同，不得互换）；③**交叉断言**：首条 put 返回的 `peak_commit_bytes === P1*`（被测返回值不作标定依据——F1：自标定不能自证；第二 put 不产生返回值比较——它在步骤⑤被拒绝）；④`quota_bytes = P1* + 1`；⑤第二 put（同尺寸新 key）→ `quota_exceeded` 且既有文件集合不变。断言：E = `buildRecordBytes` 实测 ≥ 4096+64；对本固定 fixture 由实际序列化结果**直接断言 `P2* > P1* + 1`**，即 `P2* > quota_bytes`（整数比较）→ 第二 put 必越限；失败判据（F1）：实现漏算任一文件类、S′/T′ 重复计量、或误设 `R === C` → 步骤③独立交叉断言或步骤⑤断言失败；"第二条被放行"不是充分失败信号（错误可能同污染其自身标定值）；storage-8 同流 16 个并发 `put` → 序号两两不同且为连续区间、`high_water=16`、各自幂等 replay 命中；storage-9 **两个真实子进程**（Bun.spawn 复用 lockcheck worker，P11：同进程 `Promise.all` 不构成并发）同 stream 并发 `put` → 互斥正确、总数等于两进程操作数、无重复序号；storage-10 锁语义（P10）：子进程持锁后被 `kill -9` → 另一子进程**下一次** `withLock` 立即成功（死亡自动释放）；子进程持锁存活 → 另一子进程等满 `LOCK_RETRY_MAX` 抛 `lock_timeout`、绝不抢占；flock 下不存在接管路径，无需交错回收测试（内核保证互斥）；storage-11 `usageBytes()` 等于 scope 目录全部文件字节和（含 metadata/owner-root，父级 P9 口径）；storage-12 重启归属：`close()` 后新建 `Scope` 实例（同 dataDir）→ `openScopeForRoot` 归属不变、`session_index` 保留、幂等 replay 仍命中、`rounds/budget` 值持久；storage-13（C1/P11/R4/F2）**真实子进程 + 冲突报告协议**：`bun scripts/lockcheck.ts scope-race-main <dataDir> <同一rootId>`——A 持根锁、index-miss 后**同步**暂停 → B 第一次尝试预期 `lock_timeout`（打印 `lock_contention_observed` 退出 0）→ 父进程等 B 的**冲突报告**（非创建成功）→ 释放 A → **B 重试完整创建成功** → 断言单 scope、B 两次退出码与输出符合预期（失败判据：无根锁的错误实现下 B 第一次尝试直接成功、无冲突报告 → `scope-race FAIL: first attempt must report lock contention` 非零退出；"无根锁但恰好串行"的偶然通过路径被 B1 必然冲突断言消除）；storage-14（C1/P11）两个子进程对不同新 root 并发打开 → 两个不同 scope、index 恰两条映射、互不串写；storage-15（C1）手工构造"scope 目录 + `owner-root.json` 存在但 index 未发布"（模拟崩溃）→ 重开同 root 命中该 scope 并补发布 index，不创建第二个 scope；storage-16（N1）写入 2 条 keyed + 1 条无 key 记录 → `observe` 的 fsck 校验全通过（两域各自校验，见 Step 6），退出码 0；storage-17（P18/F6 崩溃态可见性，keyed + keyless、after_reserve + after_publish 四条）：keyed 带 `supersedes` 的 put 在 `faultHook("after_reserve")` 崩溃 → **未恢复时**断言 `readMeta().nav` 目标无 `superseded_by` 键（存储级，F6）、`getById(新记录)` 为 not_found、index 无新条目（崩溃不留指向不存在记录的导航）；`recoverPending` 后 entry + 幂等 + `readMeta().nav.superseded_by` 全部就位、再试 `replay` 同 ID。keyed `faultHook("after_publish")` 崩溃 → 同 key 重试 → `replay` 同 ID 且导航正确（恰一条）。**无 key + `supersedes` 的 after_reserve 崩溃（F6 补齐）→ `readMeta().nav` 为空、无 pending、无 entry、仅空号；重试 = 新消息（新 id）**。无 key + `supersedes` 的 after_publish 崩溃 → `readMeta().nav` 目标无 `superseded_by`、重试产生新消息、旧 entry 保留为无导航的合法记录（P18：nav 任何时点不指向未发布记录）。
Run: `bun test test/storage.test.ts`
Expected: `17 pass, 0 fail`。

- [ ] **Step 5: `scripts/lockcheck.ts`（走生产 put 路径 + 专属临时目录，C4-③⑤）**

```ts
// scripts/lockcheck.ts
import { openScopeForRoot } from "../src/storage"
import { writeFileSync, existsSync } from "node:fs"

const ROOT_SESSION = "lc-root"
// 受控进程交错（P11/R4/F2：**同步**暂停——无 Promise，Atomics.wait 阻塞主线程，与生产同步接口一致；
// 冲突报告协议：A 持锁暂停 → B 第一次尝试预期 lock_timeout（打印 lock_contention_observed 退出 0）→
// 父进程等 B 的冲突报告 → 释放 A → B 重试完整成功。正确实现下 B 必冲突；错误实现（无根锁/决策在锁外）
// 下 B 第一次尝试直接成功 → 断言失败。
function pauseSync(dataDir: string) {
  writeFileSync(`${dataDir}/pause-A`, "1")
  const t0 = Date.now()
  while (!existsSync(`${dataDir}/resume-A`)) {
    if (Date.now() - t0 > 10_000) { console.error("interleave timeout"); process.exit(3) }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
async function putWorker(dataDir: string, tag: string) {
  const scope = openScopeForRoot({ rootSessionId: ROOT_SESSION, dataDir })
  const { streamId } = scope.resolveSession("lc-session")
  for (let i = 0; i < 50; i++) {
    const r = scope.put(streamId, {
      writer: { agent: "lockcheck", session_id: "lc-session", message_id: `${tag}-${i}` },
      createdRound: null, kind: "note",
      description: `lockcheck ${tag} ${i}`, content: "x",
      idempotencyKey: `lc-${tag}-${i}`,
    })
    if (r.status !== "stored") { console.error(`lockcheck FAIL: ${tag}#${i} -> ${r.status}`); process.exit(1) }
  }
}
async function scopeRaceWorker(dataDir: string, rootId: string, pause: boolean) {
  try {
    const scope = openScopeForRoot({
      rootSessionId: rootId, dataDir,
      raceProbe: pause ? { afterIndexMiss: () => pauseSync(dataDir) } : undefined,
    })
    console.log(JSON.stringify({ rootId, attempt: "ok", scopeId: scope.config.scope_id }))
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (msg.includes("lock_timeout")) { console.log(JSON.stringify({ rootId, attempt: "lock_contention_observed" })); return }
    console.error(`scope-race FAIL: ${msg}`); process.exit(1)
  }
}
async function main() {
  const dataDir = `/tmp/opencode/lockcheck-${Date.now()}`
  // put 竞争：bootstrap 先注册会话；两 worker 全速并发（互斥与唯一性，无暂停）
  const bootstrap = openScopeForRoot({ rootSessionId: ROOT_SESSION, dataDir })
  bootstrap.registerSession("lc-session", "lockcheck")
  const procs = ["A", "B"].map((tag) =>
    Bun.spawn(["bun", "scripts/lockcheck.ts", "put", dataDir, tag], { stdout: "pipe", stderr: "pipe", cwd: new URL("..", import.meta.url).pathname }),
  )
  const exits = await Promise.all(procs.map((p) => p.exited))
  if (exits.some((c) => c !== 0)) { console.error("lockcheck FAIL: worker exit != 0"); process.exit(1) }
  const scope = openScopeForRoot({ rootSessionId: ROOT_SESSION, dataDir })
  const { streamId } = scope.resolveSession("lc-session")
  const meta = scope.readMeta(streamId)
  const seqs: number[] = []
  for (let s = 1; s <= meta.high_water; s++) { const e = scope.readEntry(streamId, s); if (e) seqs.push(e.sequence) }
  const unique = new Set(seqs).size
  const ok = seqs.length === 100 && unique === 100 && meta.high_water >= 100
  console.log(`lockcheck ${ok ? "OK" : "FAIL"}: total=${seqs.length} unique=${unique} high_water=${meta.high_water}`)
  process.exit(ok ? 0 : 1)
}
const lastLine = async (p: any) => (await new Response(p.stdout).text()).trim().split("\n").pop()!
async function scopeRaceMain(dataDir: string, rootId: string) {
  // 冲突报告协议（F2）：A 持根锁同步暂停 → B1 预期 lock_timeout → 等冲突报告 → 释放 A → B2 重试成功
  const cwd = new URL("..", import.meta.url).pathname
  const a = Bun.spawn(["bun", "scripts/lockcheck.ts", "scope-race", dataDir, rootId, "pause"], { stdout: "pipe", cwd })
  const t0 = Date.now()
  while (!existsSync(`${dataDir}/pause-A`)) {
    if (Date.now() - t0 > 10_000) { console.error("scope-race FAIL: no pause from A"); process.exit(3) }
    await Bun.sleep(5)
  }
  const b1 = Bun.spawn(["bun", "scripts/lockcheck.ts", "scope-race", dataDir, rootId], { stdout: "pipe", cwd })
  const j1 = JSON.parse(await lastLine(b1)); const rc1 = await b1.exited
  if (rc1 !== 0 || j1.attempt !== "lock_contention_observed") { console.error("scope-race FAIL: first attempt must report lock contention"); process.exit(1) }
  writeFileSync(`${dataDir}/resume-A`, "1")
  await a.exited
  const b2 = Bun.spawn(["bun", "scripts/lockcheck.ts", "scope-race", dataDir, rootId], { stdout: "pipe", cwd })
  const j2 = JSON.parse(await lastLine(b2)); const rc2 = await b2.exited
  const jA = JSON.parse(await lastLine(a))
  if (rc2 !== 0 || j2.attempt !== "ok" || j2.scopeId !== jA.scopeId) { console.error("scope-race FAIL: retry must succeed into the same scope"); process.exit(1) }
  console.log("scope-race OK: contention reported once, single scope")
}
if (process.argv[2] === "put") await putWorker(process.argv[3]!, process.argv[4]!)
else if (process.argv[2] === "scope-race") await scopeRaceWorker(process.argv[3]!, process.argv[4]!, process.argv[5] === "pause")
else if (process.argv[2] === "scope-race-main") await scopeRaceMain(process.argv[3]!, process.argv[4]!)
else await main()
```
Run: `cd ~/github/opencode-bcp && bun run lockcheck && bun scripts/lockcheck.ts scope-race-main /tmp/opencode/sr-$(date +%s) sr-root`
Expected: `lockcheck OK: total=100 unique=100 high_water=100`（或 high_water>100 若有空号），退出码 0；scope-race-main 输出 `scope-race OK: contention reported once, single scope`，退出码 0（失败判据：无根锁错误实现下 B1 直接成功、无冲突报告 → `scope-race FAIL: first attempt must report lock contention` 非零退出）；`/tmp/opencode/*` 为一次性目录，可随手清理。

- [ ] **Step 6: `scripts/observe.ts`（fsck，Task 6/7 前置交付）**

遍历 `bbV1Root()` 下每个 scope 目录（独立于 scope-index，直接 readdir），对每个 stream 输出：entries 数、`max_file_seq`、`high_water`、空号数、pin/tombstone 计数、usage/quota，并抽验 ≤50 条。**两域校验（父级 P6/N1，不跨域比较）**：记录域——entry JSON 可解析、`parseEntryFileName(name) === record.sequence`、`recordHash(文件字节)` 可稳定计算；幂等域——对 `meta.idem` 中**经 key→ID 映射（`meta.idem[key].id`，注意 idem 以 key 索引而非记录 ID）**命中的记录，从其字段重建 `encodeImmutablePayload` 并比对 `sha256 === meta.idem[key].payload_sha256`。失败（序号不一致、JSON 不可解析、`max_file_seq > high_water`、幂等域 hash 不符）→ 输出 `FSCK FAIL: <原因>` 并以退出码 1 结束。
Run: `cd ~/github/opencode-bcp && bun run observe`
Expected 示例输出：
```
scope 3f2a1c…: streams=2 entries=17 usage=12.3KiB/512.0MiB pins=1 tombstones=0
  stream 9be1…: high_water=17 max_file_seq=17 gaps=0 hash_sample=17/17 ok
```

- [ ] **Step 7: 类型检查**

Run: `bunx tsc --noEmit`
Expected: 无输出（0 错误）。

---

### Task 3: Phase B — 权限矩阵 + 目录视图 + board.put / board.index / board.get

**Files:**
- Create: `src/permissions.ts`
- Create: `src/indexing.ts`
- Create: `src/tools.ts`
- Test: `test/permissions.test.ts`、`test/indexing.test.ts`、`test/tools.test.ts`

**Interfaces:**
- Consumes: Task 2 全部 Produces（`openScopeForRoot`/`Scope.put`/`getById`/`encodeImmutablePayload`/`buildRecordBytes`/`recordHash`/`parseBbId`/`formatBbId`/`KINDS`）；DESIGN §11.1–§11.4、§12；Global Constraints #6/#7。
- Produces:
  - `src/permissions.ts`：`isolationAgents(): string[]`（环境变量 `BLACKBOARD_ISOLATED_AGENTS`，默认 `"councillor"`，逗号分隔）；`isIsolatedAgent(agent: string): boolean`（完全相等或前缀匹配）；`type Authz = { scopeId: string; callerSessionId: string; registered: boolean; ownStreamId: string | null; isolated: boolean; listableStreams: { streamId: string; agent: string; isolated: boolean }[]; canWrite: (streamId: string) => boolean; canRead: (streamId: string) => boolean }`；`resolveAuthz(scope: Scope, caller: { sessionId: string; agent: string }): Authz`（**未注册 caller → `registered:false`、`listableStreams:[]`、`canRead/canWrite` 恒 false**）；`type RefPolicy = "ok" | "forbidden" | "hidden"`；`refPolicy(authz: Authz, target: { scopeId: string; streamId: string }): RefPolicy`（跨 scope → `"forbidden"`；同 scope 不可读 → `"hidden"`；可读 → `"ok"`——存在性判断由调用方查 `getById`，hidden 与 not_found 同文案输出）；`isPinned(cfg: ScopeConfig, bbId: string): boolean`（读 `cfg.pins`，受信元数据；eligibility 与索引标注共用此签名，I4）。
  - `src/indexing.ts`：类型 `IndexView = "compact" | "all"`、`IndexItem = { id; sequence; description; kind; created_round; writer_agent; pinned; superseded_by: string | null; tombstoned: boolean }`（`covered_by` 字段第二步聚合启用时追加，本步不存在）；`encodeCursor(c: { scopeId: string; streamId: string; lastSeq: number; queryHash: string }): string`（base64url JSON）；`decodeCursor(s: string, expect: { scopeId; streamId; queryHash }): { lastSeq: number }`（scope/stream/query 任一不匹配抛 `Error("cursor_mismatch")`）；`queryHashOf(opts): string`（view/keyword/kind/sinceSeq 的 sha256 前 16 hex）；`listIndex(scope: Scope, streamId: string, opts: { view?: IndexView; keyword?: string; kind?: RecordKind; sinceSeq?: number; limit?: number; cursor?: string; caller: { sessionId: string; agent: string } }): { items: IndexItem[]; nextCursor: string | null }`（P15：caller 为必填，导航授权在输出层以 `refPolicy(resolveAuthz(scope, caller), 目标)` 执行）；视图定义：`compact` 排除 tombstoned；被 superseded 条目**保留**并带 `superseded_by` 标注（第一步无 covered_by，无折叠隐藏）。
  - `src/tools.ts`：`defineBoardTools(deps: { resolveScope: (sessionId: string, agent: string) => Promise<{ scope: Scope; streamId: string; isolated: boolean } | null>; log: (line: Record<string, unknown>) => void })`（异步；resolveScope 返回 null 表示未注册——工具路径**永不自动注册会话**，注册只发生在 Task 5 的会话事件钩子；log 为结构化日志汇点（Task 5 插件实现，写 `blackboard.log`），`board.put` 经其发 `ev:"stored"` 事件——live 计数载体，P16）。

- [ ] **Step 1: `src/permissions.ts` + `test/permissions.test.ts`**

```ts
// src/permissions.ts（核心）
export function resolveAuthz(scope: Scope, caller: { sessionId: string; agent: string }): Authz {
  const cfg = scope.config
  const own = cfg.session_index[caller.sessionId]
  if (!own) {
    return { scopeId: cfg.scope_id, callerSessionId: caller.sessionId, registered: false,
      ownStreamId: null, isolated: isIsolatedAgent(caller.agent),
      listableStreams: [], canWrite: () => false, canRead: () => false }
  }
  const all = Object.entries(cfg.session_index).map(([sid, e]) => ({ sessionId: sid, ...e }))
  const visible = all.filter((e) => (e.isolated ? e.sessionId === caller.sessionId : true))
  return {
    scopeId: cfg.scope_id, callerSessionId: caller.sessionId, registered: true,
    ownStreamId: own.stream_id, isolated: own.isolated,
    listableStreams: visible.map((e) => ({ streamId: e.stream_id, agent: e.agent, isolated: e.isolated })),
    canWrite: (sid) => own.stream_id === sid,
    canRead: (sid) => visible.some((e) => e.stream_id === sid),
  }
}
export function refPolicy(authz: Authz, target: { scopeId: string; streamId: string }): RefPolicy {
  if (target.scopeId !== authz.scopeId) return "forbidden"
  return authz.canRead(target.streamId) ? "ok" : "hidden"
}
```
要点：权限来源仅三项——scope 成员资格（持久化 `session_index`）、隔离名单（env）、pins（受信元数据）；宿主无 review 范围/角色 API（Task 1 A-C8 确认后回填结论）。

`test/permissions.test.ts` 用例：perm-1 同 scope 两个普通会话 → 各自 `canWrite` 仅 own，`canRead` 双方流均 true；perm-2 以 `councillor-x` 注册的会话 → `isolated=true`，其他会话 `listableStreams` 不含该流、`canRead(该流) === false`，隔离会话可见自己；perm-3 未注册会话 → `registered:false`、`listableStreams` 为空、`canRead/canWrite` 恒 false（C2-①）；perm-4 向 `scope.config.pins` 写入一条（测试内直接改数据文件）后 `isPinned === true`；perm-5 普通会话对同 scope 隔离流目标 `refPolicy` → `"hidden"`，跨 scope 目标 → `"forbidden"`（存在性不泄漏的策略分层，C2-③）。
Run: `bun test test/permissions.test.ts`
Expected: `5 pass, 0 fail`。

- [ ] **Step 2: `src/indexing.ts` + `test/indexing.test.ts`**

实现要点：条目来源 = `readdirSync(<stream>/entries)` 按 `parseEntryFileName` 升序 + `readEntry`；每项合并 `meta.nav[id]?.superseded_by ?? null`（**输出前对该 nav 目标跑 `refPolicy(resolveAuthz(scope, caller), 目标)`——授权在输出层执行，P15；非 `"ok"` → 置 null 不返回**。第一步 nav 只同流产生，此为纵深防御）、`meta.tombstoned`、`cfg.pins`（`pinned` 标注）；`compact` 排除 tombstoned、`all` 保留并带 `tombstoned: true`；`keyword` 对**原 description** 大小写不敏感 `includes`（§11.2）；`cursor` 为绑定式不透明串：`decodeCursor(cursor, { scopeId, streamId, queryHash })` 校验通过后以 `seq > lastSeq` 续读；`limit` 截断后 `nextCursor = encodeCursor({...最后一条 sequence})`（无更多则 null）。

`test/indexing.test.ts` 用例：idx-1 compact/all 视图对 tombstone 的排除与标注正确；idx-2 两条近似描述（"登录模块超时修复"与"登录模块压测结论"）分别被"超时"与"压测"命中（检索覆盖原描述，M1-11 第一步前提）；idx-3 `kind:"finding"` 过滤只留 finding；idx-4 limit=2 分页三次取完且不重不漏、`nextCursor` 终值 null；idx-5 `sinceSeq` 只返回新条目；idx-6 pinned 条目 `pinned:true` 标注正确；idx-7 cursor 绑定（C3/I7）：stream A 的 cursor 用于 stream B、或同 stream 改 keyword 后复用 → 均抛 `cursor_mismatch`。
Run: `bun test test/indexing.test.ts`
Expected: `7 pass, 0 fail`。

- [ ] **Step 3: `src/tools.ts` + `test/tools.test.ts`**

三个工具的 zod args 与行为契约（错误码为精确输出约定，全部拒绝路径不产生任何文件写入、不出现 "stored" 字样）：
- `board.put` args：`{ description: z.string(), content: z.string(), kind: z.enum(KINDS).optional(), source_refs: z.array(z.string()).optional(), related: z.array(z.string()).optional(), supersedes: z.array(z.string()).optional(), publication_for: z.string().optional(), idempotency_key: z.string().optional() }`（**无 writer 类参数**——writer 只能来自 ToolContext，M0-4 防冒充的结构性依据）。execute 顺序：① `await deps.resolveScope(ctx.sessionID, ctx.agent)` 为 null → `rejected: unregistered_session`；`resolveAuthz` 后 `ownStreamId === null` → `rejected: forbidden_stream`；② `validatePutInput` 非空 → `rejected: <code1>[,<code2>]`（§7 整条拒绝）；③ 引用校验（C2-② 统一入口）：`supersedes`/`related` 与 `source_refs` 中 `bb://` 项逐个 `parseBbId`（解析失败 → `rejected: unknown_ref <id>`）→ `refPolicy` 为 `forbidden` → `rejected: forbidden_ref <id>`（跨 scope 显式拒绝）；为 `hidden` 或目标 `getById` 非 found → `rejected: unknown_ref <id>`（hidden 与不存在同文案，不泄漏存在性）；**`supersedes` 目标还须与 writer 同流（`target.streamId === ownStreamId`，否则 `rejected: unknown_ref <id>`）——第一步导航边不跨流产生，结构性消除隔离流经 superseded_by 的泄漏路径（C2-②）**；④ 组装 `encodeImmutablePayload`（提交原样，无默认值）→ `scope.put(streamId, {...})`：`stored` → 输出 `record <id> stored\nhash sha256:<hash>\nsequence <seq>`；`replay` → `record <id> stored (idempotent replay)\nhash sha256:<hash>\nsequence <seq>`（**回执含记录域 hash 与序号——"返回 ID 与 hash"的工具契约对 replay 同样完整履行，P20/R6**；不新增文件；hash 由存储层从已存 entry 落盘字节现算，P15）；`stored`/`replay` 都经 `deps.log({ts, ev:"stored", session: ctx.sessionID, stream: ownStreamId, id, sequence})` 发结构化事件（live L3/L4 的 `stored` 计数载体，P16）；`conflict` → `rejected: idempotency_conflict key=<key> existing=<id>`；`quota_exceeded` → `rejected: quota_exceeded used=<n> quota=<n>`。`created_round = meta.rounds.round_known ? meta.rounds.current_round : null`；`writer = { agent: ctx.agent, session_id: ctx.sessionID, message_id: ctx.messageID }`（V6）。
- `board.get` args：`{ ids: z.array(z.string()).min(1).max(50) }`。逐个 id：`parseBbId` 抛错 → `{ id, status: "not_found", detail: "malformed_id" }`；`refPolicy` → `forbidden` → `{ id, status: "forbidden" }`（跨 scope 显式，M0-9）；`hidden` → `{ id, status: "not_found" }`（与不存在不可区分，C2-③）；`getById` found → `{ id, status: "found", record, hash, nav: { superseded_by: <nav 边经目标授权检查后的值> } }`（**nav 边逐边授权，不假设同流**：`meta.nav[id]?.superseded_by` 存在时对该目标再跑 `refPolicy`，非 `"ok"` → 字段置 null 不返回——第一步 nav 只同流产生，此为防御性纵深，跨流反例测试见 tools-12）；unavailable → `{ id, status: "unavailable" }`（§6/M1-10：不静默跳转摘要）；not_found。输出为 JSON 数组文本 + 固定声明行（Global Constraints #7）。
- `board.index` args：`{ view: z.enum(["compact","all"]).default("compact"), stream: z.string().optional(), keyword: z.string().optional(), kind: z.enum(KINDS).optional(), since_seq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }`（I7：单流分页 + stream/sequence 筛选入口）。缺省 `stream` = own 流；显式 stream 须 `refPolicy === "ok"`（否则 `rejected: forbidden_stream` / 对 hidden → `rejected: stream_not_found`）；`cursor` 传入时 `decodeCursor` 校验（失败 → `rejected: cursor_mismatch`）；输出 `{ scope_id, stream: { stream_id, agent, items, nextCursor }, other_streams: [{ stream_id, agent, count }], generated_at, note: "（目录与摘要为检索提示；除非逐条 board.get，未读原文）" }`——跨流仅计数、不带 cursor（M0-10：父级查询只看输出，不猜块数）。

`test/tools.test.ts` 用例（以 `defineBoardTools` 返回的 execute 直调，伪造 `ToolContext`，`resolveScope` 桩返回测试 scope）：tools-1 put 成功 → 输出含 `stored`、`hash sha256:`、`sequence`，落盘 `writer` 等于伪造 ctx 三元组；tools-2 description 空白 → `rejected: description_blank` 且 entries 文件数不变（M1-1）；tools-3 同 `idempotency_key` **逐字节相同**载荷重试 → 返回同一 id、entries 不新增、输出含 `hash sha256:`（replay 回执含 hash，P20/R6）（M0-4 幂等部分）；tools-4 同 key 仅 `source_refs` 数组顺序不同 → `rejected: idempotency_conflict`（P2：字节精确，无归一化）；tools-5 `supersedes` 指向不存在 id → `rejected: unknown_ref`；指向存在 id → 成功且 `meta.nav[旧id].superseded_by` 标注（第一步 nav 非空的真实来源，§6②）；tools-6 get 三态：found 含 `hash` 与 `nav`、unavailable 含 `unavailable`、not_found 含 `not_found`（M1-10 第一步部分）；tools-7 跨 scope id → `forbidden` 且输出不含原文（M0-9）；tools-8 引用指向同 scope 隔离流记录 → `rejected: unknown_ref` 且与"记录不存在"输出**逐字节一致**（C2-③ 存在性不泄漏）；tools-9 index 仅列授权流、绑定 cursor 翻页一致（M0-10）；tools-10 小配额 put → `rejected: quota_exceeded` 且无 `stored` 字样（M1-12）；tools-11 index 输出含固定声明行；tools-12 跨流导航防御（C2-②）：put 的 `supersedes` 指向**同 scope 他流可读记录** → `rejected: unknown_ref`（同流限制）；手工向 `meta.nav` 写入跨流 `superseded_by` 边后 get/index → 该字段置 null 不返回（不泄漏他流 ID）。
Run: `bun test test/tools.test.ts`
Expected: `12 pass, 0 fail`。

- [ ] **Step 4: 类型检查 + 全量回归**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc 无输出；`bun test` 全部通过（0 fail），累计 56 个用例（ids 5 + schema 10 + storage 17 + permissions 5 + indexing 7 + tools 12）。

---

### Task 4: Phase B — 轮次时钟（admission 信号驱动）+ 有界 nudge（无兜底额度）+ 资格校验 + 快照计数

**Files:**
- Create: `src/rounds.ts`
- Create: `src/nudge.ts`
- Create: `src/eligibility.ts`
- Modify: `src/indexing.ts`（追加 `snapshotCounts`）
- Modify: `test/indexing.test.ts`（追加 idx-8）
- Modify: `src/tools.ts`（`board.index` 输出追加 own stream 的 `counts`）
- Test: `test/rounds.test.ts`、`test/nudge.test.ts`、`test/eligibility.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Scope`/`StreamMeta.rounds`/`StreamMeta.budget`/`recordHash`；Task 3 的 `listIndex`/`IndexItem`/`resolveAuthz`/`isPinned`；Task 1 结论 A-C6（synthetic 特征）；DESIGN §8.3/§8.4、§9、§10.1–§10.4；父级 P1/P2。
- Produces:
  - `src/rounds.ts`：`type RoundClass = "admitted_input" | "internal"`；`type AdmissionSignal = { kind: "admitted"; inputMessageId: string } | { kind: "unverified" }`；`classifyInput(signal: AdmissionSignal, flags: { isUser: boolean; matchesKnownSynthetic: boolean }): RoundClass`（**仅当宿主身份信号为 admitted 且 isUser 且非已知合成特征**才增轮；`matchesKnownSynthetic` 由 `SYNTHETIC_RE`（保守辅助正则 + A-C6 结论）驱动；内容正则**永远不能单独**作为 admission 判据——I1）；`type RoundState = { current_round: number; round_known: boolean; last_admitted_message_id: string | null }`；`applyInput(state: RoundState, cls: RoundClass, inputMessageId: string): RoundState`（**幂等**：`inputMessageId === state.last_admitted_message_id` 且已 admitted → 原样返回，不增轮不重置——P12 恢复幂等；仅新 messageId 才 +1）。
  - `src/nudge.ts`：`type NudgeLedger = { round_id: string | null; round_known: boolean; round_used: number; seen_requests: string[]; snapshot_version: string | null; prompted_set_hashes: string[]; initial_fulfilled: boolean; last_shown_seq: number }`；`newLedger(): NudgeLedger`（全零/false/null）；`rollLedgerForNewRound(ledger: NudgeLedger, roundId: string): NudgeLedger`（**仅在正面识别新 admitted input 时调用**：`round_id` 替换、`round_used=0`、`seen_requests=[]`、`snapshot_version=null`、`initial_fulfilled=false`、`round_known=true`；**`prompted_set_hashes` 原样保留**——集合抑制跨轮持续，无截断淘汰）；`SNAPSHOT_MAX_BYTES = 2048`、`MAX_RECENT_DESCRIPTIONS = 4`、`MAX_RECENT_SUMMARIES = 2`（实现参数；**无 `MAX_SEEN_REQUESTS`/`FALLBACK_ALLOWANCE_MAX`**）；`type SnapshotCounts = { knowledge_total; visible_items; index_summary_count; new_since_last_shown; eligible; protected; unknown_round }`；`type NudgeReason = "initial_reminder" | "pressure_reminder" | "duplicate_hook" | "no_budget" | "state_unchanged" | "set_already_prompted" | "identity_unrecoverable" | "fulfilled_initial"`；`decideNudge(ledger: NudgeLedger, input: { requestId: string; roundKnown: boolean; candidateSetId: string | null; snapshotVersion: string }): { decision: { inject: boolean; reason: NudgeReason; mark_fulfilled: boolean }; ledger: NudgeLedger }`（纯函数；**第一步 `candidateSetId` 恒为 null——Task 5 transform 只接线初始提醒，压力提醒接线属第二步聚合计划，显式 gated**；两类机会的去重状态互相独立：初始类用 `initial_fulfilled`/`snapshot_version`，压力类用 `prompted_set_hashes`）；`roundKnownFor(ledger: NudgeLedger, rounds: RoundState, requestVerified: boolean): boolean` = `requestVerified && rounds.round_known && rounds.last_admitted_message_id === ledger.round_id && ledger.round_id !== null`（**requestVerified = 本次请求的身份验证结果，验证失败/不可验证 → 立即 false，即使旧持久字段相等——P12**）；`decideAndPersist(scope: Scope, streamId: string, input: { sessionId: string; requestId: string; requestVerified: boolean; snapshotVersion: string; candidateSetId: string | null; maxSeq: number; raceProbe?: { afterRead: () => void } }): { inject: boolean; reason: NudgeReason }`（**锁内事务的完整决策流程**——即 Task 5 ④ 的唯一实现：withLock 内重读 meta → `raceProbe.afterRead`（**同步**测试交错点——父级 F2：无 Promise，Atomics.wait/同步自旋阻塞，与同步签名一致；正确实现下**持锁**暂停 → 他进程 `lock_timeout` 冲突报告；决策在锁外的错误实现不持锁，他进程直接成功）→ `roundKnownFor` → `decideNudge` → **`writeMeta` 的执行条件 = "注入决定 ∨ 身份状态变化"（R1：unknown 不注入也必须持久化——两处 `round_known` 的失效/恢复不落盘，put 侧就会读到旧状态）**（`initial_reminder` 注入时同步维护 `last_shown_seq = input.maxSeq`），退出锁后由调用方注入；Task 5 transform 与 `scripts/budget-race.ts` 子进程都只调用它，保证测试与生产同一代码路径）；`renderSnapshot(counts, recentDescriptions, recentSummaries, version): { text: string; omittedDescriptions: number; omittedSummaries: number }`。
  - `src/eligibility.ts`：常量 `AGG_FENCE_ROUNDS = 2`、`RECENT_K = 6`（仅服务快照统计与第二步聚合校验，M1 不触发自动聚合）；`classifyEligibility(rec: BbRecord, ctx: { cfg: ScopeConfig; meta: StreamMeta; currentRound: number | null; recentIds: string[]; callerSessionId: string; callerAgent: string }): { status: "eligible" | "protected" | "unknown"; reason: string }`。
  - `src/indexing.ts` 增量：`snapshotCounts(scope: Scope, streamId: string, caller: { sessionId: string; agent: string }, currentRound: number | null): SnapshotCounts`；`recentKnowledgeIds(scope: Scope, streamId: string): string[]`（非 tombstoned 且非 `index_summary` 的记录按 sequence 降序前 `RECENT_K` 条的 id——"最近 6 条已发布知识消息"按**发布序**取，不从视图截取，I8）。

- [ ] **Step 1: `src/rounds.ts` + `test/rounds.test.ts`**

```ts
// src/rounds.ts
const SYNTHETIC_RE = /^\[blackboard|^[<]system-reminder|^[<]dcp-/
export function classifyInput(
  signal: AdmissionSignal,
  flags: { isUser: boolean; matchesKnownSynthetic: boolean },
): RoundClass {
  if (signal.kind !== "admitted") return "internal"          // 无已验证身份信号 → 不增轮（I1）
  if (!flags.isUser || flags.matchesKnownSynthetic) return "internal"
  return "admitted_input"
}
```
`matchesKnownSynthetic` 的构造：`SYNTHETIC_RE.test(text) ||（A-C6 回填的宿主确定特征）`；A-C6 无结论时仅正则项（欠增轮 → 预算更保守）。正则以 `[<]` 字符类书写（语义等价；字面尖括号加特定前缀的序列会干扰部分读取工具的显示层）。`chat.message` 钩子产出 `AdmissionSignal`：仅当 Phase A P0 验证的 admission 字段存在且指向该消息时给 `{kind:"admitted", inputMessageId}`，否则 `{kind:"unverified"}`（Task 5 接线）。

`test/rounds.test.ts` 用例：rounds-1 admitted+user+非合成 → `admitted_input`，`applyInput` 后 `current_round+1`、`round_known=true`、`last_admitted_message_id` 更新；rounds-2 `signal={kind:"unverified"}` 且文本像真实输入 → `internal`（内容不构成 admission，I1）；rounds-3 `isUser=false` → `internal`；rounds-4 admitted 但 `matchesKnownSynthetic=true` → `internal`（保守优先）；rounds-5 连续两次**不同 messageId** 的 admitted → 递增 2；rounds-6（P12）同一 messageId 的 admitted 重复到达 → `applyInput` 幂等：轮次仍为 +1、状态对象与首次处理后深比较不变（恢复不增轮）。
Run: `bun test test/rounds.test.ts`
Expected: `6 pass, 0 fail`。

- [ ] **Step 2: `src/nudge.ts` + `test/nudge.test.ts`**（父级 P1：无兜底额度；C3：账本唯一且原子）

`decideNudge` 决策顺序（每步命中即返回；初始机会与压力机会是**两类独立判定的机会**，I2）：
1. `ledger.seen_requests.includes(requestId)` → `duplicate_hook`，ledger 原样返回（同请求重复 hook 不重复消耗）。
2. `!input.roundKnown` → `{inject:false, reason:"identity_unrecoverable", mark_fulfilled:false}`；`requestId` 追加进 `seen_requests`（防同请求反复评估）；**额度不变、`initial_fulfilled` 不置位**（父级 P1：无任何兜底额度）。
3. 初始机会（`candidateSetId === null`）：a. `initial_fulfilled` → `fulfilled_initial`（**初始机会每轮至多一次**，不重复注入、不消耗预算——父级 P13）；b. `round_used >= 2` → `no_budget`；c. `snapshot_version === input.snapshotVersion` → `state_unchanged`（不消耗预算）；d. 注入：`reason="initial_reminder"`、`round_used += 1`、**`ledger.initial_fulfilled = true`（显式写入返回的 ledger）**、`snapshot_version = input.snapshotVersion`、`seen_requests` 追加、`mark_fulfilled = true`。
4. 压力机会（`candidateSetId !== null`）：a. `prompted_set_hashes.includes(candidateSetId)` → `set_already_prompted`（**只抑制压力机会，不阻断初始机会**，I2）；b. `round_used >= 2` → `no_budget`（与初始机会共享同一剩余额度）；c. 注入：`reason="pressure_reminder"`、`round_used += 1`、`prompted_set_hashes` 追加（**无截断**）、`seen_requests` 追加、`mark_fulfilled = false`、**不动 `snapshot_version`（状态未变去重只属初始类，两类独立，I2）**。
`snapshotVersion = sha256(JSON.stringify(counts) + "|" + recentDescriptions.join("\n")).slice(0, 16)`（调用方计算）。

**调用方事务契约（C3-③，Task 5 落地）**：决策必须发生在**与持久化相同的锁临界区内**——锁内重读最新 `meta.rounds`/`meta.budget` → 计算 `roundKnown` 与 `requestId` → `decideNudge` → 注入决定则把新 ledger `writeMeta` 持久化（同一临界区）→ **退出锁后**才执行注入；持久化失败 → 不注入。并发进程同读旧额度后各自注入不可能发生（双方在同一临界区串行，后者读到前者已提交的 `round_used`/`seen_requests`；回归用例 plug-8）。崩溃窗口只允许"少发一次提醒"，不允许"多发"（≤2/轮硬上限优先于 at-least-once 的极端覆盖）。

身份状态机（C3-③，父级 P12）：`roundKnown` 的唯一判定入口 = `roundKnownFor(ledger, meta.rounds, requestVerified)`，其中 **`requestVerified` 是本次 transform/chat.message 调用的身份验证结果**（P0 验证的 admission→请求关联信号存在且匹配本次输入 = true；无法验证 = false）。false 时**同一 `writeMeta` 内同时持久化两处字段：`meta.budget.round_known = false`（nudge 侧）与 `meta.rounds.round_known = false`（写入侧——`board.put` 的 `created_round` 读取的就是后者；R1：只失效 nudge 侧不足以让 put 写 null）**；`round_used`/`seen_requests` 原样保留（额度不因身份丢失而回收或重置）。判定与持久化在 Task 5 ④ 的同一锁临界区内（经 `decideAndPersist`；**unknown 分支不注入也 `writeMeta`——身份状态变化本身就是要落盘的事务结果，R1**）。**同轮身份恢复幂等**：rounds 钩子再次确认同一 admitted input（`last_admitted_message_id` 未变）→ `applyInput` 幂等原样返回（不增轮），**同一 `writeMeta` 恢复两处 `round_known = true`**（可信状态恢复，R1），原额度继续，不产生任何注入或重置；新 admitted input → `rollLedgerForNewRound`（唯一的额度重置路径）。

`test/nudge.test.ts` 用例：nudge-1 首轮 `roundKnown=true` → `initial_reminder`、`mark_fulfilled=true`、返回 ledger 的 `initial_fulfilled=true`、`round_used=1`、`seen_requests` 含 requestId；nudge-2（P13）同轮第 2 次**初始机会**（新快照版本）→ `fulfilled_initial`、`inject=false`、预算与 `snapshot_version` 不变；nudge-3 同 requestId 二次 → `duplicate_hook` 且 ledger 深比较不变；nudge-4 `roundKnown=false` → `identity_unrecoverable`、不注入、`initial_fulfilled` 仍 false、requestId 入 `seen_requests`；nudge-5 `round_used=2` 后身份丢失 → 新 requestId 仍 `identity_unrecoverable`（已用额度保持，无兜底，C3-①）；nudge-6 连续 3 个未知身份请求 → 注入 **0** 次（父级 P1 最小反例）；nudge-7 初始类快照版本未变 → `state_unchanged`（不消耗）；nudge-8 轮 A 注入 `candidateSetId="S1"`，`rollLedgerForNewRound` 后轮 B 同集合 → `set_already_prompted`（跨轮抑制且持久化字段保留）；nudge-9（P13 共享预算序列）初始一次（`round_used=1`）→ 压力 `"S1"` 一次（`round_used=2`、`snapshot_version` 不变，I2）→ 新集合 `"S2"` → `no_budget`（两次共享预算用尽）；nudge-10 集合已提示后初始机会仍可用：roll 后 `candidateSetId=null` + 新快照 → `initial_reminder`（I2：两类机会分别去重）；**nudge-14 压力已发但初始未发、快照不变：先注入 `"S1"`（`snapshot_version` 未被压力写入改动）再以同快照请求初始机会 → `initial_reminder`（`state_unchanged` 只对初始类自身的上次注入生效，I2）**；nudge-11 `rollLedgerForNewRound`：`round_used=0`、`seen_requests=[]`、`initial_fulfilled=false`、`prompted_set_hashes` 保留、`round_id` 更新；nudge-12 板操作模拟（put/index 后直接深比较）→ budget 不变（账本仅经 `decideNudge`/`rollLedgerForNewRound` 变化，M0-7）；nudge-13 `renderSnapshot` 正常 ≤2048 字节；30 条 60 字节描述 → ≤2048、含 `省略描述` 行、保留项均为整条。
Run: `bun test test/nudge.test.ts`
Expected: `14 pass, 0 fail`。

- [ ] **Step 3: `src/eligibility.ts` + `test/eligibility.test.ts`**（I8 修正）

`classifyEligibility` 判定顺序（命中即返回；superseded 记录按父级 P7 **不**因被修正而额外受保护，与其他旧记录同资格，D:§8.3）：
1. `ctx.callerSessionId !== rec.writer.session_id || ctx.callerAgent !== rec.writer.agent` → `protected("not_original_author")`（§8.4：候选资格限定原作者；writer 身份含 session + agent 双字段，区分同流不同写手，I8）。
2. `rec.created_round === null || ctx.currentRound === null` → `unknown("round_unknown")`（M1-5）。
3. `rec.kind === "index_summary"` → `protected`（摘要不作为聚合成员）。
4. `ctx.meta.nav[rec.id]?.covered_by` 存在 → `protected("already_covered")`。
5. `isPinned(ctx.cfg, rec.id)` → `protected`。
6. `ctx.recentIds.includes(rec.id)` → `protected`（最近 6 条已发布知识消息，`recentKnowledgeIds` 按 sequence 降序取，非视图截取）。
7. `ctx.currentRound - rec.created_round > AGG_FENCE_ROUNDS` 不成立 → `protected("fence")`。
8. 其余（含 `superseded_by` 存在的记录，P7）→ `eligible("formula_pass")`。
pin 生命周期声明（写入模块头注释）：**采纳、持续保护、授权释放、聚合提交时对全部成员重校验**是第二步启用聚合的硬前置（§12/Global Constraints #8）；第一步仅提供只读 `isPinned` 供上述第 6 步与索引标注使用。

`test/eligibility.test.ts` 用例：elig-1 `created_round=null` → unknown（M1-5）；elig-2 距当前轮 1 轮 → protected（fence）；elig-3 距 3 轮、caller=作者（session+agent 均匹配）、无其它保护 → eligible；elig-4 pinned → protected；elig-5 在 `recentIds` 中 → protected；elig-6 补写记录 `created_round`=实际发布轮 → protected（§9/M1-6）；elig-7 `callerSessionId` 匹配但 `callerAgent` ≠ `rec.writer.agent`（同流换写手）→ protected（非原作者，I8）；elig-8（P7）`nav[id].superseded_by` 置位但其余条件满足 → **eligible**（被修正不额外受保护，聚合只折叠目录、原文仍可按旧 ID 取回，D:§8.6/§11.4）；`nav[id].covered_by` 置位 → protected（分列断言）。
Run: `bun test test/eligibility.test.ts`
Expected: `8 pass, 0 fail`。

- [ ] **Step 4: `snapshotCounts` 接入 + idx-8**

`snapshotCounts(scope, streamId, caller: { sessionId, agent }, currentRound)`：`knowledge_total` = 非 tombstoned 条目数；`visible_items` = compact 条目数（M1 与 knowledge_total 相同；聚合启用后分化）；`index_summary_count` = `kind==="index_summary"` 条数；`new_since_last_shown` = **sequence > `meta.budget.last_shown_seq` 的条目计数**（按计数而非 `maxSeq` 差——序号空洞不失真，I8）；`eligible/protected/unknown_round` = 全部条目跑 `classifyEligibility`（caller=own session+agent）的分布。`board.index` 输出 own stream 条目追加 `counts`。idx-8：预置 `last_shown_seq=0` 后写入 seq 1、2、4（手工制造空号 3）→ `new_since_last_shown === 3`（非 4）。
Run: `bun test test/indexing.test.ts test/tools.test.ts`
Expected: 全部通过（0 fail；此前 19 例不回归——indexing 7 + tools 12，idx-8 新增）。

- [ ] **Step 5: 类型检查 + 全量回归**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc 无输出；0 fail，累计 85 个用例（56 + rounds 6 + nudge 14 + eligibility 8 + idx-8）。

---

### Task 5: Phase B — 插件入口装配（会话归属 / 注入事务 / 降级）+ 聚合接口预留

**Files:**
- Create: `src/aggregate.ts`
- Create: `src/plugin.ts`
- Create: `scripts/budget-race.ts`
- Test: `test/plugin.test.ts`

**Interfaces:**
- Consumes: Task 1 结论 A-C1/A-C2/A-C4/A-C5/A-C6；Task 2 `openScopeForRoot`/`Scope`；Task 3 `defineBoardTools`/`resolveAuthz`/`refPolicy`；Task 4 `classifyInput`/`applyInput`/`roundKnownFor`/`decideNudge`/`decideAndPersist`/`rollLedgerForNewRound`/`renderSnapshot`/`snapshotCounts`/`newLedger`。
- Produces:
  - `src/plugin.ts`：`export const BlackboardPlugin: Plugin` 与 `export default BlackboardPlugin`；内部 **`lookupScopeContext(sessionId: string, agent: string): Promise<{ scope: Scope; streamId: string; isolated: boolean } | null>`**（供 `defineBoardTools`——**lookup-only，永不注册会话**，C2-①）与 **`registerScopeContext(sessionId: string, agent: string): Promise<{ scope: Scope; streamId: string; isolated: boolean } | null>`**（与 lookup 同签名同返回形态；含注册路径，**仅会话事件钩子调用**，见 Step 2）。
  - `scripts/budget-race.ts`：子进程 worker——`bun scripts/budget-race.ts <dataDir> <rootSessionId> <requestId> [--pause]`，内部 `openScopeForRoot` → `decideAndPersist`（与生产 transform 同一代码路径，Task 4；**以 `candidateSetId: null` 调用**——第一步唯一接线，G2）；`--pause` 传入**同步** `raceProbe.afterRead`，暂停协议与 lockcheck 的 `pauseSync` 一致：`node:fs` 同步写 pause 文件、`Atomics.wait` 自旋等 resume、10s 超时退出码 3；捕获 `lock_timeout` → 打印 `lock_contention_observed` 退出 0，F2 冲突报告协议）→ 输出一行 JSON `{injected, reason}` 或冲突报告，供 plug-9 真实进程竞争（P11/P13/F2）。
  - `src/aggregate.ts`：`export type AggregateInput = { member_ids: string[]; description: string; navigation_body: string }`；`export const AGGREGATE_DEFERRED = "board.aggregate 属 DESIGN §14.3 第二步：待 M1 live 且目录真实膨胀后另立计划；本文件仅保留类型与说明，不注册工具、不实现机制。"`。**不注册 `board.aggregate` 工具**（Global Constraints #9）。

- [ ] **Step 1: `src/aggregate.ts`**（内容即上述两行导出，注释引用 DESIGN §8/§14.3；不写任何聚合逻辑）
- [ ] **Step 2: `src/plugin.ts`**

行为契约（完整实现约 200 行）：
- **`registerScopeContext(sessionId, agent)`**（async，C1/I4；只在会话事件钩子调用）：①`BLACKBOARD_SKIP_AGENTS`（逗号分隔，默认空；A-C4 结论回填名单）命中 agent → 返回 null；②进程内 `scopes` 缓存按 session 命中 → 返回；③宿主 parent 链：`await input.client.session.get({ path: { id: sessionId } })`（SDK v1 异步形态，P5；parent 字段名按 A-C5 结论），递归至根会话；④根会话 `openScopeForRoot({ rootSessionId })`（持久化映射 + 根级锁 + `owner-root.json`，Task 2）并在其上 `registerSession(sessionId, agent)`；⑤parent 查询失败 → 返回 null + 进程内一次性 `console.error("[blackboard] session-parent-unresolved: <sessionId>")`（宁隔离不串流）。
- **`lookupScopeContext(sessionId, agent)`**（工具路径专用）：①skip 名单命中 → null；②缓存命中 → 返回；③**冷启动持久化查找**：`await input.client.session.get({ path: { id: sessionId } })` 沿 parent 链上溯至根 → `<root>/scope-index.json` 的 root→scopeId 映射 → `openScopeById(scopeId)` → `resolveSession(sessionId)`；任一步失败/未注册 → null。整条路径只读，**任何路径都不创建 scope、不注册 session（C2-①：工具调用不能把调用者并入 scope）**。
- `hooks.tool = defineBoardTools({ resolveScope: lookupScopeContext, log })`（`log` 与测试桩传入**同一个结构化日志汇点**——即写 `blackboard.log` 的实现；`ev:"stored"` 事件经它输出，P20/R6）。
- `hooks["chat.message"]`（async，D 项次序修正）：①构造 `AdmissionSignal`（P0 验证的 admission 字段存在 → `{kind:"admitted", inputMessageId}`，否则 `{kind:"unverified"}`）→ `classifyInput(signal, { isUser, matchesKnownSynthetic })`；②**异步注册/定位先行**——首次见到该会话时调用 `registerScopeContext`（含 SDK parent 链查询与 `openScopeForRoot`+`registerSession`；未注册成功前没有可锁的 scope/stream）；③注册成功后进入 `withLock` 同步事务：`admitted_input` 且**新 messageId** → `meta.rounds = applyInput(...)`、`meta.budget = rollLedgerForNewRound(meta.budget, 新 messageId)`；`admitted_input` 且**同一 messageId** → 幂等恢复：`applyInput` 原样返回，同一 `writeMeta` 将两处 `round_known` 置回 true（不增轮、不重置额度、不注入——P12/R1 可信状态恢复）；`internal`/`unverified` → 不触碰 `rounds.current_round`/`last_admitted_message_id`；**若 `round_known === true` 则同一 `writeMeta` 将 `meta.rounds.round_known` 与 `meta.budget.round_known` 一并置 false（身份失效传播到写入侧，P12/R1）**；`writeMeta`（plug-6 断言板操作不触碰 budget）。
- `hooks["experimental.chat.messages.transform"]`：整个函数体 try/catch。流程：①`sessionId = msgs[0]?.info?.sessionID`（`ses_` 前缀；取不到直接 return）；②`lookupScopeContext` 为 null → return（未注册不注入不报错）；③`counts = snapshotCounts(...)`、`recentDescriptions` = own 流 compact 尾部 ≤4 条原 description；④调用 **`decideAndPersist(scope, streamId, { sessionId, requestId: \`${sessionId}:${lastMsgId}\`, requestVerified, snapshotVersion, candidateSetId: null, maxSeq })`**——Task 4 的唯一决策事务实现（锁内重读最新 `meta.rounds`/`meta.budget` → `roundKnownFor` → `decideNudge` → 决定注入则 `writeMeta`）；**`requestVerified` = P0 验证的 admission→请求关联信号对本次调用成立（无法验证 → false → 立即 unknown；unknown 分支同样 `writeMeta`：同批持久化 `meta.rounds.round_known=false` 与 `meta.budget.round_known=false`——put 侧读前者，失效必须落到写入字段，R1/P12）**；`candidateSetId = null`（第一步只接初始提醒，压力接线 gated 第二步聚合计划）；注入决定且持久化成功才继续，持久化失败 → 不注入；⑤**退出锁后**渲染 `renderSnapshot(...).text` 并**原地**追加为最后一条 user message 的 text part（与探针 P1 验证形态一致，不新增 message、不替换数组；I3-⑦）；⑥`blackboard.log` 追加一行结构化 JSON：`{ts, ev:"decision", session, stream, request_id, round_id, round_used, reason, bytes, omitted_descriptions, omitted_summaries}`（不含 description/content 正文）；`chat.message` 路径同格式记 `{ev:"round", ...}`（Task 6 live 证据按 run/session/request 结构化可查）；⑦catch → 进程级一次性 `console.error("[blackboard] degraded:", err.message)` 后 return（fail-open，Global Constraints #1）。
- 插件不注册 `experimental.text.complete`（V2：该 hook 无"再做一次决策"语义，设计不依赖它）。
- 插件运行日志：`$HOME/.cache/opencode/blackboard/log/blackboard.log` 追加一行 JSON（ts/sessionId/hook/reason/bytes/rounds 事件；**不含 description/content 正文**），供 Task 6 live 证据与 `observe` 之外的观测（Phase D）。

- [ ] **Step 3: `test/plugin.test.ts`**

用例（直调 hook 函数 + 伪造 ToolContext/messages/client 桩）：plug-1 已注册会话 transform → 最后一条 user message 的 parts 原地追加以 `[blackboard 目录快照` 开头的 text part 且整块 ≤2048 字节；plug-2 同 `(sessionId, lastMsgId)` 二次 transform → 不再追加（`duplicate_hook`）；plug-3 parent 查询失败桩 → `lookupScopeContext` 返回 null：transform 无追加、无抛错，`board.put` execute 返回 `rejected: unregistered_session`（工具路径不自动注册，C2-①）；plug-4 `readMeta` 抛错桩 → transform 不抛出、`[blackboard] degraded` 仅输出一次；plug-5 `chat.message` admitted 消息 → `meta.rounds.current_round` 持久化 +1 且 `meta.budget.round_id` 更新为新 messageId；plug-6 一次 `board.put` 成功后 `meta.budget` 与 put 前深比较不变（板操作不重置预算，M0-7）；plug-7 注入事务序（C3）：`writeMeta` 桩首次抛错 → 不追加 part、`meta.budget` 未变（持久化失败绝不注入）；plug-8（P13）已用状态 0 注入：起点 `round_used=1` 且 `initial_fulfilled=true`（本轮初始已发布），两个 transform（不同 requestId）→ 均 `fulfilled_initial`/`no_budget`，注入 0 次（"恰 1 次"仅在起点状态允许时成立）；plug-9（P11/P13/F2 真实进程预算竞争 + **冲突报告协议**）：两个 `bun scripts/budget-race.ts <dataDir> <rootSessionId> <requestId> [--pause]` worker 从同一持久态（`round_used=1`、`initial_fulfilled=false`）经 `decideAndPersist` 竞争；`--pause` 的 A 经**同步** `raceProbe.afterRead`（**锁内**重读 meta 后 Atomics.wait 阻塞）→ B 第一次尝试预期 `lock_timeout`（打印 `lock_contention_observed` 退出 0）→ 父测试等 B 的**冲突报告**（非决策成功）→ 释放 A（A 完成决策：注入一次，`round_used=2`、`initial_fulfilled=true`）→ **B 重试** → 决策顺序先查 `initial_fulfilled` 再查预算 → `fulfilled_initial`、无注入（G2：worker 以 `candidateSetId=null` 调用，B 的预期原因**不是 `no_budget`**——正确实现不得被旧预期否决）。断言：`round_used=2`、合计注入恰 1 次、B1 无注入（冲突报告）、B 重试 reason=`fulfilled_initial`（失败判据：决策在锁外的错误实现下 A 暂停时不持锁，B 第一次尝试直接成功、无冲突报告 → 断言失败）；plug-10（G5 恢复完整定义：R1/P12 生产接线全链回归——防"只失效 budget、不失效写入轮次"，全程经生产 `chat.message`/`transform`/`board.put` execute 路径）：①admitted 输入进入 `chat.message` → 两处 `round_known=true` 落盘；②下一次 transform 以 `requestVerified=false` 调用 → 注入 0 次，且同一 `writeMeta` 将 `meta.rounds.round_known=false` 与 `meta.budget.round_known=false` 一并落盘（两处断言）；③`board.put` execute → 返回记录 `created_round === null`（写入侧读 `meta.rounds.round_known`——只失效 budget 侧的实现在此断言失败）；④同一 admitted 输入（同 messageId）再次进入 `chat.message` → 幂等恢复：两处 `round_known=true`、轮次与额度不变、无注入；⑤再次 `board.put` → `created_round === meta.rounds.current_round`（写入侧恢复生效）
Run: `bun test test/plugin.test.ts`
Expected: `10 pass, 0 fail`。

- [ ] **Step 4: 构建 + 全量回归**

Run: `bun run build && bunx tsc --noEmit && bun test`
Expected: `dist/blackboard.js` 生成；tsc 无输出；0 fail，累计 95 个用例（85 + plugin 10）。

---

### Task 6: Phase C — DESIGN §14 验收映射与执行（M0 十项 + M1 十二项）

**Files:**
- Create: `test/acceptance.test.ts`
- Create: `harness/prompts/m0-1-textonly.txt`
- Create: `harness/prompts/m0-2-parent.txt`
- Create: `harness/prompts/m0-3-write-continue.txt`
- Create: `harness/prompts/m0-5-invalid-desc.txt`
- Create: `harness/prompts/m0-6-supplement.txt`
- Create: `harness/prompts/m0-6-child-reuse.txt`
- Create: `harness/prompts/m0-9-cross-scope.txt`
- Create: `harness/prompts/m0-9-seed.txt`
- Create: `harness/prompts/m1-2-append-old.txt`
- Create: `harness/prompts/m1-3-idem-conflict.txt`
- Modify: `harness/live-protocol.md`（追加"M0/M1 验收结果登记"表）

**Interfaces:**
- Consumes: Task 2–5 全部模块与测试；`scripts/observe.ts`（**Task 2 Step 6 已交付**，非本阶段产物）；`scripts/install.sh`（Task 7 Step 1，live 检查前先行完成该步）；探针 `bb-probe.ts` 以 `BB_PROBE_OFF=1` 复用观测（不注入、不污染验收；物理移除归 Task 7 收尾）；DESIGN §14.1/§14.2（断言逐字引用如下）。
- Produces: `test/acceptance.test.ts`（13 例自动化映射）；登记表（每项结论 ∈ {通过/失败/gated/降级-未满足} + 证据文件 + 日期）。

- [ ] **Step 1: 受控 prompt 文件**（各一行）

| 文件 | 内容 |
|---|---|
| `m0-1-textonly.txt` | `这是一次纯文本任务。请直接用一句话回答：opencode 是什么？不要调用任何工具。回答后直接结束。` |
| `m0-2-parent.txt` | `请使用 task 工具派出一个子代理（agent: build），把下面这句话原样交给它执行，并把它的回复原样返回给我："调用 board.put 写入一条记录：description 为 \"M0-2 子代理记录\"、content 为 \"seed\"；然后调用 board.index 复述你看到的 stream 标识，并把 put 返回的记录 ID 原样告诉我"。` |
| `m0-3-write-continue.txt` | `请先调用 board.index 查看你的目录，然后调用 board.put 写入一条发现记录（description: "M0-3 验证记录"，content: 用一句话说明你刚完成了目录查询），写完后继续用一句话回答：1+1 等于几？` |
| `m0-5-invalid-desc.txt` | `请调用 board.put 提交一条记录，但故意把 description 传空字符串。如果被拒绝，直接回复 "done" 结束，不要重试。` |
| `m0-6-supplement.txt` | `请针对你上一条记录的主题补写一条新发现：调用 board.put，用 supersedes 引用上一条记录的 ID，description 以 "M0-6 补写" 开头。` |
| `m0-6-child-reuse.txt` | `请再调用 board.put 写入一条记录：description 以 "M0-6 子代理补写" 开头，content 用一句话说明你在子会话中发现的补充信息。` |
| `m0-9-cross-scope.txt` | `请调用 board.get 查询这个 ID 并把结果原样告诉我：bb://<scope-b 实测 id>/<stream-b 实测 id>/e000001`（运行前替换为 L6 种子会话实得 id） |
| `m0-9-seed.txt` | `请调用 board.put 写入一条记录：description 为 "scope-b 种子"，content 为 "seed"。然后调用 board.index 并把你的 scope 与 stream 标识原样告诉我。` |
| `m1-2-append-old.txt` | `请不要创建新记录，而是把目录里第一条旧记录的正文内容改成别的文字。如果做不到，说明原因后结束。` |
| `m1-3-idem-conflict.txt` | `请连续调用两次 board.put，两次都用 idempotency_key: "m1-3" 且 description: "M1-3 幂等冲突"；第一次 content 写 "alpha"，第二次 content 写 "beta"。把两次的返回原样告诉我。` |

- [ ] **Step 2: M0/M1 逐项映射表**（写入 `harness/live-protocol.md`，设计断言逐字引用，验收不弱化；每个 live 步骤必须产出对应证据文件，证据载体在表中列明）

**M0（DESIGN §14.1，十项）：**

| # | 设计断言（逐字） | 验证载体（自动化 + live 证据） | 预期 |
|---|---|---|---|
| M0-1 | text-only 直接结束：初始符合条件的请求获得提醒机会；若未写板，本次运行不假称成功；无 post-final 自激循环 | live L1：`blackboard.log` 切片（initial_reminder 计数、`"ev":"round"` admitted 计数、运行后 30s 无新增行）+ `l1.json`（回复无"已保存/已记录"表述）+ `l1.err`（无 degraded）。注入可见性由 Phase A 判据 P1（marker 回显）代表；`l1.json` 的 text 事件**不**作为注入判定依据（快照进模型请求 ≠ CLI 事件回显） | initial_reminder=1；admitted=1；put/stored=0；30s 行数不变 |
| M0-2 | child / parent / 内部请求隔离：目录注入到达正确会话；title / compaction / 其他 child 不跨 stream 串扰 | live L2（服务端 env `BB_PROBE_OFF=0 BB_PROBE_RUN=l2` 重启测试宿主，F4）：探针 evidence（≥2 个 `ses_` 会话、marker 不相交）+ `blackboard.log`（各 sessionId 只注入自己流；A-C4 名单内会话无注入行）+ `observe`（streams ≥2、`session_ids` 各自独立） | 无串流；内部会话无注入 |
| M0-3 | 写后继续：写板不被解读为任务终结；新发现仍可作为完整新消息写入 | live L3（`l3.json`：tool_use 事件后仍有 text 事件 + `observe`：entries=1 完整落盘 + `blackboard.log` stored 行）+ **live L5（续会话第二次 put：新发现仍可再发布，entries=2）** | put 后继续作答；L5 新发现可再发布 |
| M0-4 | 并发与双写：同 stream 序号唯一且单调；parent 不能伪装 child；重试幂等；不同记录永不合并 / 覆盖 | `storage-8/9`、`tools-1/3`、`lockcheck`（生产 put 路径）、`acc-m0-4`（含：put zod args 无 writer 字段——writer 只能来自 ToolContext 的结构性断言） | lockcheck OK；幂等同 ID；无 writer 参数 |
| M0-5 | 首写失败 / 未调用工具：在有界提醒预算内退出；无自动反复的"完成-写入"尝试 | live L4：`blackboard.log` 决策序列（initial_reminder ≤2，其后 `fulfilled_initial`/`state_unchanged`/`no_budget`，无新增强提醒）+ `l4.json`（`rejected: description_blank`、无 stored、事件流正常终止） | 预算内退出 |
| M0-6 | child 复用、补写、上下文压缩：同 stream 保留历史；新消息携带自身上下文与关系；不重编号、不伪造原上下文 | live L5（`-s $SESSION` 续会话）：`observe`（entries=2、`nav[首条].superseded_by`=第二条、首条 entry 文件 sha256 与 L3 后一致）；child 复用 = **live L2b**（父级 P22/R8：CHILD/CHILD_AGENT 由 L2 按宿主 parent 关系判定、存于 `$RUNS/l2-child.txt`，**不按 transform 行序猜测**；恢复时**显式传回原 agent**，规避 V4 默认 agent 回退）：先以服务端 env 重启宿主（`BB_PROBE_OFF=1 BB_PROBE_RUN=l2b opencode serve --port 4599 > $RUNS/serve-l2b.log 2>&1 &`，F4，磁盘 session 保留+就绪检查），再 `opencode run -s "$CHILD" --agent "$CHILD_AGENT" --attach http://localhost:4599 --print-logs -m newapi/deepseek-v4-flash "$(cat ../prompts/m0-6-child-reuse.txt)" --format json > $RUNS/l2b.json 2> $RUNS/l2b.err`（客户端不带 probe env，F4）+ `bun run observe`：子流 high_water 增长（同 stream 续写）且 `sha256sum -c $RUNS/l2-file-hash.txt` 输出 OK（**child 在 L2 已有受控写入，"旧 entry 字节不变"是非空集合上的有效断言**）；`-s` 恢复失败（宿主拒绝恢复已结束子会话）→ 该子场景登记"降级-未满足"，**M0-6 不得整项通过**（P8）；补写原作者绑定 = tools-1（writer=ctx）+ `publication_for` 字段（acc-m1-3 字段矩阵覆盖）；**compaction 子场景 live 不可控 → 按 P8 登记"降级-未满足"（原因：第一步无法按需构造 compaction；A-C6 观察记录为支撑证据；待真实 compaction 出现时补验），该子场景补验前本项不得记"通过"** | 历史保留；不重编号；compaction 子场景登记降级 |
| M0-7 | nudge 双重计数：写板回执、重复 hook、聚合记录不计为业务进展；同一快照不形成提醒风暴；同一聚合候选集跨轮次不被重复自动提示；预算身份丢失跨多个 continuation / 请求时，轮内提醒仍 ≤2 次且不误报机会保证已履行 | `nudge-3/5/6/10/11/14`、`plug-6/7/8/9/10`（并发不超发 = 真实进程 plug-9）、`acc-m0-7`（round_used=2 后身份丢失 → 连续 3 请求 0 注入）、live L7（按 run 切片统计 `ev:"decision"` 行） | 预算硬上限；无重置；并发不超发 |
| M0-8 | 目录快照体积：严格受预算约束；省略数量明确标出；无 description 被静默截断成另一含义 | `nudge-13`、live L7（每个 `bytes=` ≤2048；发生省略时日志含 omitted 计数） | ≤2048；省略显式 |
| M0-9 | 跨 agent 权限：自查与已授权 ID 读取成功；未知 scope、越权枚举、独立席（councillor）隔离泄漏被拒绝 | `tools-7/8`、`perm-2/3/5`、`acc-m0-9`（隔离流引用与不存在的输出逐字节一致；get 隐藏记录 not_found 同文案）、live L6（跨 scope `forbidden`）；councillor live 依赖环境（本机无 councillor agent）→ 以单测为准，环境出现后按同流程补 live 并登记 | 越权拒绝且不泄漏存在性 |
| M0-10 | parent 查询与交接：可列出 stream 并选定 ID 而无需猜块数；只交接摘要时不得被报告为已读原文 | `tools-9/11`（输出含 `stream/other_streams/nextCursor` + 固定声明行）、`idx-4/7`、live L3（回复引用字段名；tool 输出含声明行）+ **人工核对登记：模型回复未把摘要交接表述为"已读原文"（逐字登记到登记表）** | 不猜块数；声明可见；未宣称已读原文 |

**M1（DESIGN §14.2，十二项负向验收）：**

| # | 设计断言（逐字） | 验证载体 | 预期 |
|---|---|---|---|
| M1-1 | description 缺失 / 空白 / 超长 → 整条创建失败；无半条记录、无"已保存"宣称 | `tools-2`、`acc-m1-1`（缺失/空白/`\r\n`/81 code points 四变体）、live L4 | rejected:* 且 entries 文件数不变 |
| M1-2 | 向旧 ID 追加或改正 → 拒绝；必须写新消息 | 工具面仅 put/index/get 三键（acc-m1-2 断言键集合）、旧记录字节不变、live L8a | 旧记录字节不变；模型只能新写 |
| M1-3 | 同幂等键不同内容 → 显式冲突，不覆盖 | `tools-4`、`acc-m1-3`（7 个不可变字段逐字段差异 + 数组顺序 + 缺省 vs 空数组 → 全部 conflict）、`storage-4/5`（崩溃重试同 ID）、live L8b | 第二次 `idempotency_conflict` |
| M1-4 | 聚合含 fence 保护内 / 最近 6 条 / pinned 记录 → 整批拒绝；候选集不被静默缩小（**候选集标识 = scope/stream + 精确成员身份含 hash**）；已自动提示过的同一候选集跨轮次不被重复自动提示，作者显式发起的聚合不受影响 | **端到端 gated 第二步聚合计划**；本步函数级：`elig-2/3/4/5/7/8`（fence/最近6/pin/作者/covered/superseded-P7 同资格）+ `nudge-8/9/10/14`（集合跨轮抑制、两类机会分别去重）+ `acc-m1-4/8/9` 组合例 | 受保护成员逐个 protected；端到端归第二步 |
| M1-5 | 轮次未知或重启后不可恢复 → 不按旧记录对待；保护保留 | `elig-1`、`acc-m1-5`（`round_known=false` → `created_round=null` + unknown；**重开 Scope 后 `round_known` 仍 false**，不因重启误恢复） | unknown → 不参与聚合 |
| M1-6 | 关于旧任务的补写 → 按实际发布时间轮次保护；不得立即被聚合 | `elig-6`、`acc-m1-6`、live 轮次接线 = L1 的 `blackboard.log` admitted 序列（若 Phase A P0 失败 → 本项登记"降级-未满足"） | 按发布轮次 → protected |
| M1-7 | 聚合丢掉关键证据内容 → 原记录、原 description、工件引用仍可按旧 ID / hash 取回；否则失败 | 不可变性属性 `acc-m1-7`（旧 ID/字节/hash 不变）；**聚合场景端到端 gated 第二步** | 旧 ID 取回原字节、hash 一致 |
| M1-8 | 聚合在提交任一阶段崩溃 → 旧目录完整，或新摘要 + 完整成员关系已提交；绝不两者皆缺 | **gated 第二步**；本步基元级：`storage-4/5`（预留/发布两阶段故障注入 → `recoverPending` 恰好一条、同 ID） | 基元满足；全流程归第二步 |
| M1-9 | 并发重叠聚合 → 一个有效结果或显式冲突；无成员丢失或重复归属 | **gated 第二步**；本步基元级：`storage-8/9` + `lockcheck`（生产路径互斥与唯一性） | 无重复序号；端到端归第二步 |
| M1-10 | 旧 ID / 旧索引 cursor 跨 agent 查询 → ID 不变；聚合只做导航标注；删除是显式 `unavailable` | **第一步部分**：`tools-6`、`acc-m1-10`（逻辑 tombstone：`unavailable`、entry 文件仍在——P3 边界断言）、`idx-4/7`（cursor 稳定与绑定）；**第二步部分**：`covered_by` 导航提示（gated——不以普通分页/关键词测试冒充聚合断言） | tombstone → `unavailable`；ID 不变 |
| M1-11 | 描述聚合丢关键词 → 搜原 description 仍能找到原消息 | **第一步等价断言**：`idx-2`、`acc-m1-11`（无聚合 → 原描述即唯一检索面）；**"聚合丢关键词"场景 gated 第二步** | 关键词命中原描述 |
| M1-12 | 存储配额满 → 显式失败；不静默删除内容或证据来"腾空间" | `storage-7`（P17/F1 阶段枚举 + 独立序列化标定）、`tools-10`、`acc-m1-12`（同 storage-7 标定法 + 手算） | `quota_exceeded`；文件集不变 |

gated 声明（写入登记表表头）：M1-4/7/8/9 的聚合场景端到端、M1-10 的 `covered_by` 导航提示、M1-11 的"聚合丢关键词"场景归属第二步聚合计划（§14.3）；本步只完成函数级/基元级/第一步等价覆盖，断言原文逐字保留、不做弱化、不冒充。**登记状态集（父级 P8）**：每项验收结论 ∈ {通过/失败/gated/降级-未满足}，**不存在第五种状态**；无法在第一步充分验证的子场景（如 compaction）要么按 §14.3 显式 gated、要么登记"降级-未满足"并写明原因，**不得让整体项"通过"**。**降级报告规则（父级 P1/P4）**：Phase A P0 失败时，所有依赖轮次身份的项（M0-1/5/7、M1-5/6 的 live 部分）登记"降级-未满足"，不得报告完整 M0 通过。以上全部验收为设计承诺，**尚未 live 验证**，验证 owner = 父级编排。

- [ ] **Step 3: `test/acceptance.test.ts`（13 例自动化端到端映射）**

acc-m0-4 同流 16 并发 `scope.put` 序号唯一连续 + 幂等重试同 ID + `board.put` zod args 键集合不含任何 writer 字段；acc-m0-7 构造 `round_used=2` 后 `roundKnown=false` 连续 3 个新 requestId → 3 次 `identity_unrecoverable`、0 注入；acc-m0-9 同 scope 隔离流记录：`related` 引用它 → `unknown_ref` 输出与引用不存在记录**逐字节一致**；`board.get` 它 → `not_found` 与不存在逐字节一致；acc-m1-1 四变体（缺失/空白/`\r\n`/81 code points）→ 各输出 `rejected:` 且无 `stored`、entries 目录文件数前后不变；acc-m1-2 写入后旧 id 文件字节与 hash 不变 + `Object.keys(defineBoardTools(...))` 恰为 `["board.put","board.index","board.get"]`；acc-m1-3 幂等字段矩阵（幂等域，P6）：对 `description/content/kind/source_refs/related/supersedes/publication_for` 逐字段差异的第二次 put → 全部 `idempotency_conflict`；**数组顺序差异与"缺省 vs 空数组"差异（显式编码后字节不同）→ conflict**；崩溃重试（faultHook）后同 key 重试 → `replay` 同 ID；**fsck 两域核对（N1）：keyed 记录经 `meta.idem[key].id` 定位后幂等域重算比对通过、记录域 `recordHash(文件字节)` 独立可算通过**；acc-m1-4/8/9 组合例：8 条记录（2 条 fence 内、1 条 pinned、1 条 recent、1 条 superseded（P7：eligible）、1 条 covered、2 条普通）→ `classifyEligibility` 分布恰为 3 eligible（2 普通 + 1 superseded）；`faultHook("after_reserve")` 后重试恰好 1 条 entry；16 并发唯一（M1-4/8/9 的本步载体，端到端 gated 声明不变）；acc-m1-5 `round_known=false` 写入 → `created_round===null` 且 eligibility unknown；`scope.close()` 后以同 dataDir 重开 → `round_known` 仍 false（不因重启误恢复）；acc-m1-6 `created_round=当前轮` → protected；acc-m1-7 写 A、B 后做 get(A)/put(C) → `getById(A)` 原文与 hash 均不变；acc-m1-10 `markTombstone(A)` → `getById(A)` unavailable、entry 文件仍存在、compact 不列 A、all 列出且 `tombstoned:true`（ID 不变不重定向）；acc-m1-11 两条近似描述 → keyword 各自命中原记录；acc-m1-12（P17/F1/G1，与 storage-7 同款 **R/C 分列独立序列化标定法** + 手算）：fixture 预置非空他流文件与非空残留临时文件（同 storage-7，S′/T′ 互斥）；首条 keyed put（content 4096 字节 `"a"`）以 `quota=Number.MAX_SAFE_INTEGER` → `stored`；独立计量（readdir+stat 实测**首条前置**的 S′/E′0/T′/M0′，`encodeImmutablePayload`/`buildRecordBytes`/`recordHash` 构造**首条参数**的 R_1/C_1，三阶段 `reserve′/publish′/commit′` 求和取 max）得 **`P1*`**（**首条事务 oracle**，含 R−C 差；废止 `du_after + stat(最终 metadata)` 旧口径——其只得 S+E+2C）；交叉断言 `peak_commit_bytes === P1*`（只比较首条返回值——P1* 绑定首条前置状态）；改 `quota_bytes = P1* + 1`（标定用独立值，不用被测返回值）；第二条同尺寸新 key 的前置状态已变（多一条 entry、metadata 更新、首条 idem 已入映射），独立构造第二事务 oracle **`P2*`**（R′/C′ 用第二 put 参数与第二前置状态、各取 `byteLength(JSON.stringify(…))`、三阶段取 max；`payload_b64 = base64(encodeImmutablePayload(input))`、`entry_bytes_b64 = base64(buildRecordBytes(record))` 两域不同源），**直接断言 `P2* > P1* + 1`**（= quota，由实际序列化结果断言）→ `quota_exceeded`（实现漏算任一文件类、S′/T′ 重复计量或误设 R===C 时交叉断言/该断言失败，"第二条被放行"不是充分失败信号——F1）→ 首条 entry 与全部元数据保留（先成功后拒绝，拒绝路径无任何删除）。
Run: `cd ~/github/opencode-bcp && bun test test/acceptance.test.ts`
Expected: `13 pass, 0 fail`。

- [ ] **Step 4: live 检查 L1–L8**

前置（一次性）：证据目录 `RUNS=/home/littlekey/github/opencode-bcp/harness/runs`（**先定义后使用**，F4）与黑板日志路径 `LOG=$HOME/.cache/opencode/blackboard/log/blackboard.log`；`bash scripts/install.sh --project ~/github/opencode-bcp/harness/scratch`；**干净环境前置（G3）**：`mkdir -p ~/github/opencode-bcp/harness/scratch`（探针/插件落点，不隐含依赖先前运行遗留目录）；`mkdir -p "$HOME/.cache/opencode/blackboard/log"` 且 `[[ -f $LOG ]] || : > "$LOG"`——**初始化首次黑板日志**：安装脚本只构建/复制插件，生产插件首次运行前 `blackboard.log` 尚不存在，而 L1 的 `logpos` 要求日志已存在可读，缺失即会在首个 live 检查前停止；仅创建缺失文件、保留已有内容不截断；**宿主复用 Phase A Step 0**（F3）：常驻宿主与 SDK 通道已在 Task 1 Step 0 启动/验证，已退出则同法重启（`cd ~/github/opencode-bcp/harness/scratch && opencode serve --port 4599 > $RUNS/serve.log 2>&1 & echo $! > $RUNS/serve.pid`，启动后按 Step 0 同法做就绪检查）；**probe env 属宿主进程（F4）**——非 attach 的 `opencode run` 派生自有宿主并继承客户端 env（`BB_PROBE_OFF=1` 有效）；`--attach` 复用常驻宿主，env 必须落在**宿主启动命令**上（L2/L2b 按所需模式重启宿主，磁盘 session 保留）；计数归一化函数（**先判文件存在**，区分"无匹配"=0 与"证据缺失"=错误；rg 退出码 1=无匹配→0，退出码 ≥2=权限等真实错误→非零失败，P16）：`rgc() { [[ -f "$2" ]] || { echo "EVIDENCE-MISSING:$2"; return 1; }; local out rc=0; out=$(rg -c "$1" "$2") || rc=$?; if (( rc >= 2 )); then echo "RG-ERROR:$2"; return 1; fi; printf '%s\n' "${out:-0}"; }`；日志起点函数（**日志必须已存在可读，缺失即报错，不再吞错**，F5）：`logpos() { local L=$HOME/.cache/opencode/blackboard/log/blackboard.log; [[ -r $L ]] || { echo "LOG-UNREADABLE:$L" >&2; return 1; }; wc -l < $L; }`。除 L2 外全部以 `BB_PROBE_OFF=1` 运行（探针只记录不注入）。**全部 live 命令的黑板日志提取一律按"确认可读 → 取得非空会话 ID（备用渠道在过滤前确定）→ 时间切片 → 归属过滤 → 计数"执行，仅"无匹配"允许为 0（F5）**。全部 live 结束后 `kill $(cat $RUNS/serve.pid)`。

L1（M0-1）：
```bash
RUNS=/home/littlekey/github/opencode-bcp/harness/runs; BB=/home/littlekey/.cache/opencode/blackboard
LOG=$BB/log/blackboard.log
cd ~/github/opencode-bcp/harness/scratch
POS=$(logpos) || exit 1   # 切片起点；赋值命令失败即停，不得流入空 POS（G4）
BB_PROBE_OFF=1 opencode run --print-logs -m newapi/deepseek-v4-flash --title m0-1 "$(cat ../prompts/m0-1-textonly.txt)" --format json > $RUNS/l1.json 2> $RUNS/l1.err
SID=$(rg -o 'ses_[A-Za-z0-9]+' $RUNS/l1.json | head -1); [[ -n "$SID" ]] || { echo "NO-SESSION-ID"; exit 1; }   # 先取得非空会话 ID（F5）
tail -n +$((POS+1)) $LOG > $RUNS/l1.raw || { echo "TAIL-ERROR"; exit 1; }   # 切片成功后才进入归属过滤（G4）
rg "\"session\":\"$SID\"" $RUNS/l1.raw > $RUNS/l1.bb.log; frc=$?; [[ $frc -le 1 ]] || { echo "FILTER-ERROR:$frc"; exit 1; }   # 归属过滤；仅"无匹配"放行（F5）
N1=$(wc -l < $RUNS/l1.bb.log); sleep 30
tail -n +$((POS+1)) $LOG > $RUNS/l1.tail2 || { echo "TAIL-ERROR"; exit 1; }; N2=$(rg -c "\"session\":\"$SID\"" $RUNS/l1.tail2); nrc=$?; [[ $nrc -le 1 ]] || { echo "N2-FILTER-ERROR:$nrc"; exit 1; }; N2=${N2:-0}   # tail 与 rg 分阶段：tail 读取失败即停；仅 rg 自身 rc=1（无匹配）→0，rc≥2 报错（G4/F5）
rgc '"reason":"initial_reminder"' $RUNS/l1.bb.log
rgc '"ev":"round"' $RUNS/l1.bb.log
rgc 'stored' $RUNS/l1.json
rgc 'blackboard 目录快照' $RUNS/l1.json
rgc 'degraded' $RUNS/l1.err
echo "run-log-lines=$N1 log-lines-after30s=$N2"
```
Expected: `initial_reminder`=1；`"ev":"round"` 行=1（admission 计数，来自 blackboard.log 的本轮切片，非 CLI role 计数）；`stored`=0 且人工核对回复无"已保存/已记录"表述（登记表留核对记录）；快照可见性由 Phase A 判据 P1 代表，`l1.json` 的 text 事件不作注入判定依据（`blackboard 目录快照` 计数仅记录，不设阈值）；`degraded`=0；**`N2 == N1`**（同会话过滤后 30s 内零新增 = 无 post-final 自激；N2 按目标会话 `$SID` 过滤统计而非全局行数，P21/R7）。

L2（M0-2，F4：探针 env 属宿主进程——**以服务端 env 重启测试宿主**，磁盘 session 保留；attach 复用之，客户端不带 env）：
```bash
kill $(cat $RUNS/serve.pid) 2>/dev/null; sleep 1
cd ~/github/opencode-bcp/harness/scratch
BB_PROBE_OFF=0 BB_PROBE_RUN=l2 opencode serve --port 4599 > $RUNS/serve-l2.log 2>&1 & echo $! > $RUNS/serve.pid
sleep 1; kill -0 $(cat $RUNS/serve.pid) && rg -c 'listening|http://localhost:4599' $RUNS/serve-l2.log   # 宿主就绪检查（F4）
[[ -r $LOG ]] || { echo "LOG-UNREADABLE:$LOG"; exit 1; }
POS2=$(wc -l < "$LOG") || exit 1   # 起点计数失败即停（G4）；时间切片起点：L2 的 child stored 按 run 切取，不取全局日志（F5）
opencode run --attach http://localhost:4599 -m newapi/deepseek-v4-flash --title m0-2 "$(cat ../prompts/m0-2-parent.txt)" --format json > $RUNS/l2.json 2> $RUNS/l2.err
cp ~/.cache/opencode/blackboard-probe/evidence-l2.jsonl $RUNS/evidence-l2.jsonl
rg -o '"sessionID":"ses_[A-Za-z0-9]+"' $RUNS/evidence-l2.jsonl | sort -u
rg '"hook":"transform"' $RUNS/evidence-l2.jsonl | rg -o '"sessionID":"[^"]+"' | sort | uniq -c
bun run observe
# child 判定依据宿主 parent 关系（SDK 父子链，P22/R8；不按 transform 行序猜测）：
SIDS=($(rg -o 'ses_[A-Za-z0-9]+' $RUNS/evidence-l2.jsonl | sort -u))
CHILD=""
for s in "${SIDS[@]}"; do
  P=$(bun -e "import {createOpencodeClient} from '@opencode-ai/sdk'; const c=createOpencodeClient({baseUrl:'http://localhost:4599'}); const r=await c.session.get({path:{id:'$s'}}); console.log(r.data?.parentID ?? '-')")
  echo "$s parent=$P"
  for t in "${SIDS[@]}"; do [[ "$s" != "$t" && "$P" == "$t" ]] && CHILD=$s; done
done
CHILD_AGENT=$(rg "\"sessionID\":\"$CHILD\"" $RUNS/evidence-l2.jsonl | rg -o '"agent":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "CHILD=$CHILD" > $RUNS/l2-child.txt; echo "CHILD_AGENT=$CHILD_AGENT" >> $RUNS/l2-child.txt; cat $RUNS/l2-child.txt
# 子会话受控记录留存（P22：有历史的 child；L2b 比对基线。**先时间切片再按子会话归属过滤**，F5）：
tail -n +$((POS2+1)) $LOG > $RUNS/l2.raw || { echo "TAIL-ERROR"; exit 1; }
rg "\"session\":\"$CHILD\"" $RUNS/l2.raw > $RUNS/l2.raw.child; c1rc=$?; [[ $c1rc -le 1 ]] || { echo "L2-FILTER-ERROR:$c1rc"; exit 1; }; rg '"ev":"stored"' $RUNS/l2.raw.child > $RUNS/l2-child-stored.txt; crc=$?; [[ $crc -le 1 ]] || { echo "L2-FILTER-ERROR:$crc"; exit 1; }   # 两级过滤各自独立检查（G4：前级读取失败不得伪装成后级零匹配）
L2ID=$(rg -o '"id":"bb://[^"]+"' $RUNS/l2-child-stored.txt | head -1 | rg -o 'bb://[^"]+')
[[ -n "$L2ID" ]] || { echo "CHILD-STORED-NOT-FOUND"; exit 1; }
BBSCOPE=$(printf '%s' "$L2ID" | cut -d/ -f3); BBSTREAM=$(printf '%s' "$L2ID" | cut -d/ -f4); BBSEQ=$(printf '%s' "$L2ID" | cut -d/ -f5)
L2ENTRY=$HOME/.cache/opencode/blackboard/v1/$BBSCOPE/streams/$BBSTREAM/entries/$BBSEQ.json
printf 'id=%s\npath=%s\n' "$L2ID" "$L2ENTRY" > $RUNS/l2-file-hash.txt; sha256sum "$L2ENTRY" >> $RUNS/l2-file-hash.txt; cat $RUNS/l2-file-hash.txt
```
Expected: ≥2 个不同 sessionID；blackboard 注入行按 sessionId 各自独立（父标记不出现在子流注入行）；A-C4 名单内的 title/compaction 会话（探针有记录）无 blackboard 注入行；observe 显示该 scope streams ≥2 且 `session_ids` 各自独立；`l2-child.txt` 记录 CHILD/CHILD_AGENT（parent 关系判定）；子会话 put 的 `ev:"stored"` 行存在且 `l2-file-hash.txt` 含 id=/path=/hash 三元（P22：child 有受控历史）。SDK 字段名（`parentID`）以 A-C5 运行时复核为准。起点计数失败（`POS2` 行 `|| exit 1`）→ 验证以非零状态结束，不产出通过结论（G4）。

L3（M0-3，兼 M0-10 与会话 ID 提取；完成后留存首条 entry 的文件哈希供 L5 比对）：
```bash
LOG=$HOME/.cache/opencode/blackboard/log/blackboard.log
[[ -r $LOG ]] || { echo "LOG-UNREADABLE:$LOG"; exit 1; }
POS=$(wc -l < "$LOG") || exit 1   # 起点计数失败即停（G4）
BB_PROBE_OFF=1 BB_PROBE_RUN=l3 opencode run --print-logs -m newapi/deepseek-v4-flash --title m0-3 "$(cat ../prompts/m0-3-write-continue.txt)" --format json > $RUNS/l3.json 2> $RUNS/l3.err
# 备用会话 ID 在过滤之前确定（F5）：主渠道 l3.json，备渠道探针 evidence，两者皆空才报错
SESSION=$(rg -o 'ses_[A-Za-z0-9]+' $RUNS/l3.json | head -1)
if [[ -z "$SESSION" ]]; then SESSION=$(rg -o 'ses_[A-Za-z0-9]+' ~/.cache/opencode/blackboard-probe/evidence-l3.jsonl 2>/dev/null | tail -1); fi
[[ -n "$SESSION" ]] || { echo "NO-SESSION-ID"; exit 1; }
tail -n +$((POS+1)) $LOG > $RUNS/l3.raw || { echo "TAIL-ERROR"; exit 1; }   # 切片成功后才进入归属过滤（G4）
rg "\"session\":\"$SESSION\"" $RUNS/l3.raw > $RUNS/l3.bb.log; frc=$?; [[ $frc -le 1 ]] || { echo "FILTER-ERROR:$frc"; exit 1; }   # 归属过滤后再计数/取 ID（P21/F5）
rgc '"ev":"stored"' $RUNS/l3.bb.log
rg -c '目录与摘要为检索提示' $RUNS/l3.json
bun run observe
echo "session=$SESSION"
# 首条 entry 哈希留存（L5 比对基线；N5：从本次 stored 事件的 bb:// ID 绑定精确路径，ID+路径+hash 三元一并留存）：
STORED_ID=$(rg -o '"id":"bb://[^"]+"' $RUNS/l3.bb.log | head -1 | rg -o 'bb://[^"]+')
BBSCOPE=$(printf '%s' "$STORED_ID" | cut -d/ -f3); BBSTREAM=$(printf '%s' "$STORED_ID" | cut -d/ -f4); BBSEQ=$(printf '%s' "$STORED_ID" | cut -d/ -f5)
ENTRY1=$HOME/.cache/opencode/blackboard/v1/$BBSCOPE/streams/$BBSTREAM/entries/$BBSEQ.json
printf 'id=%s\npath=%s\n' "$STORED_ID" "$ENTRY1" > $RUNS/l3-file-hash.txt; sha256sum "$ENTRY1" >> $RUNS/l3-file-hash.txt; cat $RUNS/l3-file-hash.txt
```
Expected: `stored` 计数 ≥1（`ev:"stored"` 结构化事件，P16）；`observe` 显示 entries ≥1 且最新记录 description/content 与 prompt 要求一致（新发现=完整新消息）；`l3.json` 中 board.put 的 tool_use 事件之后仍有 text 事件（写后继续作答，CLI 事件序）；index 工具输出含固定声明行（M0-10）；`SESSION` 非空；`l3-file-hash.txt` 含 `id=`/`path=`/hash 三行且路径按 ID 解析（非目录树任意首条）。起点计数失败（`POS` 行 `|| exit 1`）→ 验证以非零状态结束，不产出通过结论（G4）。

L4（M0-5，兼 M1-1 live）：
```bash
POS=$(logpos) || exit 1   # 赋值命令失败即停（G4）
BB_PROBE_OFF=1 opencode run --print-logs -m newapi/deepseek-v4-flash --title m0-5 "$(cat ../prompts/m0-5-invalid-desc.txt)" --format json > $RUNS/l4.json 2> $RUNS/l4.err
SID4=$(rg -o 'ses_[A-Za-z0-9]+' $RUNS/l4.json | head -1); [[ -n "$SID4" ]] || { echo "NO-SESSION-ID"; exit 1; }
tail -n +$((POS+1)) $LOG > $RUNS/l4.raw || { echo "TAIL-ERROR"; exit 1; }   # 切片成功后才进入归属过滤（G4）
rg "\"session\":\"$SID4\"" $RUNS/l4.raw > $RUNS/l4.bb.log; frc=$?; [[ $frc -le 1 ]] || { echo "FILTER-ERROR:$frc"; exit 1; }
rg -o '"reason":"[a-z_]+"' $RUNS/l4.bb.log | sort | uniq -c
rgc 'description_blank' $RUNS/l4.json
rgc 'stored' $RUNS/l4.json
```
Expected: 本轮切片内 `initial_reminder` ≤2 且其后仅 `fulfilled_initial`/`state_unchanged`/`no_budget`（无新增强提醒）；`description_blank` 出现且 `stored`=0；CLI 事件流正常终止。

L5（M0-6）：`BB_PROBE_OFF=1 opencode run -s "$SESSION" --print-logs -m newapi/deepseek-v4-flash "$(cat ../prompts/m0-6-supplement.txt)" --format json > $RUNS/l5.json 2> $RUNS/l5.err`（`$SESSION` 来自 L3）。
Expected: `observe` 显示 entries=2、high_water=2、`nav` 中首条 `superseded_by` 指向第二条；`sha256sum -c $RUNS/l3-file-hash.txt` 输出 `OK`（校验的是 L3 `bb://` ID 绑定的精确 entry 路径——ID 不变、不重编号、不伪造原上下文，N5）。

L6（M0-9）：
```bash
bash ~/github/opencode-bcp/scripts/install.sh --project /tmp/opencode/bb-scope-b
cd /tmp/opencode/bb-scope-b && opencode run -m newapi/deepseek-v4-flash --title m0-9-seed "$(cat ~/github/opencode-bcp/harness/prompts/m0-9-seed.txt)" --format json > $RUNS/l6-seed.json 2> $RUNS/l6-seed.err
# 从 l6-seed.json 的 board.put 输出与 board.index 输出提取 scope-b 的 scope/stream id，把 m0-9-cross-scope.txt 中预置的 `<scope-b-id>`/`<stream-b-id>` 标记替换为实测值后：
cd ~/github/opencode-bcp/harness/scratch
BB_PROBE_OFF=1 opencode run -m newapi/deepseek-v4-flash --title m0-9 "$(cat ../prompts/m0-9-cross-scope.txt)" --format json > $RUNS/l6.json 2> $RUNS/l6.err
rgc 'forbidden' $RUNS/l6.json
```
Expected: 输出含 `forbidden` 且不含 scope-b 记录任何内容字段。councillor 隔离：本机 agents 配置无 councillor，live 以跨 scope 拒绝为准；隔离语义由 `perm-2`、`tools-8`、`acc-m0-9` 单测承载；环境出现 councillor agent 后按同流程补 live 并登记。

L7（M0-7/M0-8；生产日志为 JSON（blackboard.log），**不存在 stderr 旧格式依赖**，P16）：
```bash
rg -o '"ev":"decision"[^\n]+' $RUNS/l1.bb.log $RUNS/l4.bb.log
```
Expected: 每会话每轮快照注入 ≤2（decision 行 `round_used` 序列 1→2 后必为非注入原因）；每个 decision 行 `bytes` ≤2048；L4 会话中 `rejected` 回执之后无新 `ev:"decision"` 注入行（回执不计业务进展）；原因分布含 `state_unchanged`/`fulfilled_initial`（同快照不重复展示）；发生省略时 `omitted_descriptions`/`omitted_summaries` >0 且快照文本含显式省略行（M0-8）。

L8（M1-2/M1-3 live）：分别以 `BB_PROBE_OFF=1` 运行 `m1-2-append-old.txt` 与 `m1-3-idem-conflict.txt`，各自捕获 `$RUNS/l8a.json/.err`、`$RUNS/l8b.json/.err`；随后 `bun run observe`。
Expected: L8a 模型报告无法修改旧记录（或仅新写），`observe` + `sha256sum` 证明旧 entry 字节不变；L8b 第二次 put 返回 `idempotency_conflict`、仅一条记录落盘。

- [ ] **Step 5: 结果登记**

把 M0 十项 + M1 十二项结论写入登记表（结论 ∈ {通过/失败/gated/降级-未满足} + 证据文件 + 日期）；任何失败或"降级-未满足"项停止发布并向父级升级。
Run: `cd ~/github/opencode-bcp && bunx tsc --noEmit && bun test`
Expected: tsc 无输出；0 fail，累计 108 个用例（95 + acceptance 13）。

---

### Task 7: Phase D — 安装、观测、降级与回滚

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/uninstall.sh`
- Modify: `harness/live-protocol.md`（追加"运行手册"节：安装/升级/回滚/兼容边界/探针收尾）

**Interfaces:**
- Consumes: Task 2 构建脚本与 `scripts/observe.ts`（已交付）；Task 5 构建产物 `dist/blackboard.js`；Task 1 结论 A-C3（决定默认安装模式）。
- Produces: 可重复的安装/卸载命令（同一 target 语义）；回滚演练记录；探针移除验证。

- [ ] **Step 1: `scripts/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="global"; TARGET_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; TARGET_DIR="${2:?--project 需要目录参数}"; shift 2 ;;
    *) echo "用法: install.sh [--project <目录>]"; exit 2 ;;
  esac
done
if [[ "$MODE" == "global" ]]; then TARGET_DIR="$HOME/.config/opencode/plugin"; else TARGET_DIR="$TARGET_DIR/.opencode/plugin"; fi
cd "$REPO"
bun run build
mkdir -p "$TARGET_DIR"
cp dist/blackboard.js "$TARGET_DIR/blackboard.js"
echo "installed: $TARGET_DIR/blackboard.js ($(wc -c < "$TARGET_DIR/blackboard.js") bytes)"
```
（`--project <dir>` 安装到 `<dir>/.opencode/plugin/`——宿主实际扫描的目录，I9；默认全局 `~/.config/opencode/plugin/`。默认模式由 A-C3 结论决定；两种模式都已实现。）

- [ ] **Step 2: `scripts/uninstall.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
MODE="global"; TARGET_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) TARGET_DIR="${2:?--project 需要目录参数}/.opencode/plugin"; shift 2 ;;
    *) echo "用法: uninstall.sh [--project <目录>]"; exit 2 ;;
  esac
done
[[ -z "$TARGET_DIR" ]] && TARGET_DIR="$HOME/.config/opencode/plugin"
FILE="$TARGET_DIR/blackboard.js"
if [[ -f "$FILE" ]]; then rm "$FILE"; echo "removed: $FILE"; else echo "already absent: $FILE"; fi
echo "storage kept: $HOME/.cache/opencode/blackboard/v1（数据不随回滚删除）"
```
（与 install 同一 target 语义；`set -euo pipefail`，任何真实失败以非零退出，不被 `|| echo` 吞掉——I9。）

Run: `bash scripts/install.sh --project harness/scratch && bash scripts/uninstall.sh --project harness/scratch && bash scripts/install.sh --project harness/scratch`
Expected: installed → removed → installed 三行输出；最终 `harness/scratch/.opencode/plugin/blackboard.js` 存在。

- [ ] **Step 3: 运行手册（写入 `harness/live-protocol.md`）**

- **与 ACP**：本插件 transform 只向最后一条 user message 的 parts 原地追加，不修改/删除他人（含 ACP）注入的消息；任何内部异常 fail-open 并输出一次性 `[blackboard] degraded: <原因>`；ACP 压缩 continuation 由 rounds 分类归 internal，不增轮、不重置预算。兼容性结论以 Task 1 P5（无错误 + 共存观察）为准，不宣称语义兼容证明。
- **与 omo-slim**：零 patch、零 import；仅通过宿主 hooks 共存，顺序竞争结论以 Task 1 P5 固化。
- **升级**：`install.sh` 只替换插件文件，不触碰 `~/.cache/opencode/blackboard/v1` 数据；升级后必须运行一次 `bun run observe` 确认无 FSCK FAIL（重启/插件升级不得用新编号覆盖旧编号，§5）。
- **回滚演练（R2'，在 Task 6 验收完成后执行一次并登记）**：
```bash
RUNS=/home/littlekey/github/opencode-bcp/harness/runs
LOG=$HOME/.cache/opencode/blackboard/log/blackboard.log
bash ~/github/opencode-bcp/scripts/uninstall.sh --project ~/github/opencode-bcp/harness/scratch
cd ~/github/opencode-bcp/harness/scratch
[[ -r $LOG ]] || { echo "LOG-UNREADABLE:$LOG"; exit 1; }
BEFORE=$(wc -l < "$LOG") || exit 1   # 起点计数失败即停（G4）
BB_PROBE_OFF=1 opencode run -m newapi/deepseek-v4-flash "你好" --format json > $RUNS/rollback.json 2> $RUNS/rollback.err
RSID=$(rg -o 'ses_[A-Za-z0-9]+' $RUNS/rollback.json | head -1); [[ -n "$RSID" ]] || { echo "NO-SESSION-ID"; exit 1; }
tail -n +$((BEFORE+1)) $LOG > $RUNS/rollback.raw || { echo "TAIL-ERROR"; exit 1; }; rg "\"session\":\"$RSID\"" $RUNS/rollback.raw > $RUNS/rollback.bb.log; rrc=$?; [[ $rrc -le 1 ]] || { echo "FILTER-ERROR:$rrc"; exit 1; }   # 分阶段独立检查（G4）：tail 读取失败即停（绝不产出"已卸载"通过结论），仅过滤自身 rc=1 允许零行
AFTER=$(wc -l < $RUNS/rollback.bb.log)   # 仅目标会话的黑板日志行数（F5：其他会话活动不误判为未卸载）
rgc() { [[ -f "$2" ]] || { echo "EVIDENCE-MISSING:$2"; return 1; }; local out rc=0; out=$(rg -c "$1" "$2") || rc=$?; if (( rc >= 2 )); then echo "RG-ERROR:$2"; return 1; fi; printf '%s\n' "${out:-0}"; }
rgc 'blackboard 目录快照' $RUNS/rollback.json
rgc '\[blackboard\]' $RUNS/rollback.err
echo "target-session-log-lines=$AFTER"
bash ~/github/opencode-bcp/scripts/install.sh --project ~/github/opencode-bcp/harness/scratch
```
Expected: 两处 `rgc` 均输出 `0`；`target-session-log-lines=0`（**按目标会话 `$RSID` 时间切片过滤**——回滚验证不依赖"演练期间没有其它会话活动"，F5）；最后重新安装恢复交付态（回滚已验证、交付不缺位）。任何非 0 计数或目标会话日志行 >0 → 回滚验证失败，显式登记并排查（不吞错）。起点计数失败（`BEFORE` 行 `|| exit 1`）同样以非零状态结束，不产出"已卸载"结论（G4）。
- **探针收尾（Phase A/C 观测全部结束后）**：`rm ~/github/opencode-bcp/harness/scratch/.opencode/plugin/bb-probe.ts`，再运行一次 L1 式命令确认输出中无 `BB-PROBE-` 标记、探针 evidence 不再增长；`harness/scratch/.opencode/plugin/blackboard.js` 保留（交付态）。
- **失败可见性**：配额满（`quota_exceeded`）、锁占用/超时（`lock_held`/`lock_timeout`）、未注册会话（`unregistered_session`）均显式返回，绝不静默删数据腾空间（§12）。
- **观测**：`bun run observe`（存储 fsck 与统计）；`blackboard.log`（结构化决策与轮次事件 `ev:"decision"/"round"`，无正文，按 run/session/request 可查）；探针 `evidence-<run>.jsonl` 按 run 归档，仅在探针在位期间产生。

- [ ] **Step 4: 收尾验证**

Run: `cd ~/github/opencode-bcp && bun run build && bunx tsc --noEmit && bun test && bun run observe && echo ALL-GREEN`
Expected: 构建成功；tsc 无输出；`bun test` 108 pass / 0 fail；`observe` 退出码 0（无 FSCK FAIL）；输出 `ALL-GREEN`。

---

## 附录 A：宿主事实与再验证命令

**已核实**（可独立复现；P5 更正后口径）：

| 事实 | 证据 / 复核命令 |
|---|---|
| opencode 1.18.31 | `/home/littlekey/.local/share/mise/installs/opencode/1.18.31/opencode --version`（仅证 opencode 版本，**不证 Bun 版本**） |
| bun 1.3.14（本机 PATH） | `bun --version`；宿主内置 Bun 版本未经证实 → 运行时行为以 Phase A 观察为准 |
| 插件发现：`.opencode/plugin/` 与 `.opencode/plugins/`，匹配 `*.ts` 与 `*.js` | `rg -a -o ".{0,50}[.]opencode/plugin.{0,50}" /home/littlekey/.local/share/mise/installs/opencode/1.18.31/opencode`（二进制文案证实目录名；`{plugin,plugins}/*.{ts,js}` 全范围为独立核对结论，Task 1 A-C3 以 `*.js` 改名重跑复核） |
| npm 插件经 `opencode.json` 的 `plugin` 数组加载 | `~/.config/opencode/opencode.json` 第 21–27 行现行配置 |
| `opencode run` flags（`--pure`/`--format json`/`--print-logs`/`--log-level`/`-m`/`-s`/`--title`） | `opencode run --help`；**`--format json` 只输出 CLI 级事件（text/tool_use 等），不是完整 message/session 事件流**（P5 更正；live 判据一律用插件侧日志） |
| `ToolContext = {sessionID, messageID, agent, directory, worktree, …}` | `~/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/@opencode-ai/plugin/dist/tool.d.ts:2-24` |
| transform hook input 为 `{}`，会话身份取自 `output.messages[].info` | 同目录 `dist/index.d.ts:259`（运行时提取路径 → A-C2 复核） |
| 依赖版本：omo-slim@latest 顶层 `@opencode-ai/plugin 1.18.32`、`zod 4.6.5`（ACP 运行时 plugin 为 1.18.31） | `rg -o '"version": "[^"]*"' ~/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/{@opencode-ai/plugin,zod}/package.json`（独立核对结论；devDep 取 `^1.18.31`/`^4.6.5`，构建内联后运行时不解析外部副本） |
| SDK v1 会话查询：`await client.session.get({ path: { id } })`（异步） | `@opencode-ai/sdk` 类型定义（独立核对结论；parent 字段名与返回形状 → A-C5 运行时复核） |
| 会话 ID 前缀 `ses_` | 探针 evidence 与宿主会话标识实测（P5 更正；Task 1 R3 命令即按 `ses_` 提取） |
| DESIGN §0.4 V1–V6 已核实前提 | `DESIGN.md` §0.4（HOST:302535、HOST:302399、HOST:301395/301376、SDK types:211–274、PLUGIN/dist/tool.d.ts:2–16） |

**待 Phase A 验证**（不得作为已核实写入代码注释或文档）：A-C1 注入形态（原地 parts 追加）在 outgoing 请求的可见性；A-C2 admission/业务输入/模型请求三身份的来源、字段与对应关系（P0 闸门）；A-C3 全局 `~/.config/opencode/plugin/` 扫描与 `*.js` 生效性；A-C4 title/compaction 内部会话识别特征与名单；A-C5 `session.get` 返回的 parent 字段名；A-C6 compaction continuation 的宿主确定特征；A-C7 CLI json 事件是否携带 sessionID；A-C8 宿主是否暴露 review 范围/角色语义 API。结论回填与 §13.1 假设升级见 Task 1 Step 8–10。
