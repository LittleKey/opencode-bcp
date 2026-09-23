# M0/M1 验收结果（Task 6）

日期：2026-09-23。仓库：`/home/littlekey/github/opencode-bcp`。
自动化套件：`bun test` 全绿 **109 pass / 0 fail**（其中 `test/acceptance.test.ts` 13 项）；`bunx tsc --noEmit` 干净。
live 运行证据归档：`harness/acceptance/`（原始切片同存于 `harness/runs/`）。运行日志：`~/.cache/opencode/blackboard/log/blackboard.log`（每轮以 `logpos` 起点行切片 + `session` 归属过滤绑定，满足 R7）。

状态词汇：通过 / 失败 / gated / 降级-未满足。本表无第 5 种状态。

## M0（10 项）

| 项 | 结论 | 覆盖 | 证据（session/request 绑定） |
|---|---|---|---|
| M0-1 纯文本轮注入可见（预算内一次） | 通过 | live L1 + plug-1/2 | `l1.bb.log`：`initial_reminder`×1、`ev:round`×1（`current_round:1, round_known:true`）、stored=0、degraded=0；30s 后 N2==N1 无注入环。session=`ses_f33b16822ffev…`（`l1.sid`），request_id=`ses_…:msg_0cc4e9adb001n5av5k6x4peF3T`。注入可见性以 Phase A A-C1（3/3 一致）为代表证据；本次 l1.json 文本事件 1 条（`[blackboard 目录快照` 计数不设阈值，P1） |
| M0-2 parent/child 隔离流 | 通过 | live L2 + acc（permission 单测） | `evidence-l2.jsonl` 两个 ses_；`l2-sessions.json`：child `ses_f33afe492ff…` parentID=`ses_f33b05b78ff…`（A-C5 `parentID` 实证，title "M0-2 子代理记录写入 (@build subagent)"）；child `ev:stored` 恰 1 条 → `l2-file-hash.txt`（id=/path=/sha256 三元，stream `0731cc…`）；observe：scope `6a109e…` streams=2（父 `14bca9…`/子 `0731cc…`）session 各自独立、hash ok。请求绑定：child transform 行 `lastMsgId=msg_0cc501b76001gRL2…`（probe marker `BB-PROBE-BJVGGQ`） |
| M0-3 写后继续作答（兼 M0-10） | 通过 | live L3 | `l3.bb.log`：stored=1；`l3.json` 2 个 tool 事件（board.put→board.index）之后仍有 text 事件；index 输出含声明行（`目录与摘要为检索提示` ×1）；决策分布 initial_reminder×1 + fulfilled_initial×2。session=`ses_f33aa2c74ffe…`（`l3.sid`），请求绑定 probe `evidence-l3.jsonl`（marker `BB-PROBE-SYRZZV`，3 次 transform lastMsgId 各异、同请求零重复） |
| M0-4 并发写序号唯一/幂等重试 | 通过 | acc-m0-4（16 并发 + 同 key 重试同 ID）+ acc-m1-4/8/9 组合中的 16 并发 | `test/acceptance.test.ts`（storage-1/2 级联）；zod args 无 writer 字段断言同通过 |
| M0-5 无效描述拒绝（兼 M1-1 live） | 通过 | live L4 + acc-m1-1 | `l4.bb.log`：initial_reminder×1（≤2）其后仅 fulfilled_initial（无新增强提醒）；`l4.json`：`description_blank` ×1、stored=0、CLI 事件流正常终止（rc=0）。session=`ses_f33a99036ffe…`（`l4.sid`） |
| M0-6 同会话补充与取代 | 降级-未满足（子场景）/ 其余通过 | live L5 + acc-m1-2/7 | `l5.bb.log`：session 内 stored=2；observe（`l5` 时点）：entries=2、high_water=2、nav 首条 `superseded_by`=第二条（见 m00238 输出）；`sha256sum -c l3-file-hash.txt` → e000001 **OK**（ID 不变、不重编号）。**compaction 子场景无法 live 构造 → 降级-未满足**，以 Phase A A-C6 为支持证据；按 P8，M0-6 整体不判“通过” |
| M0-7 每轮提醒预算 | 通过 | live 派生 L7 + plug-8 + acc-m0-7 | 派生统计（l1/l3/l4/l6 bb.log）：每轮 initial_reminder 恰 1，其后仅 fulfilled_initial；acc-m0-7：identity_unrecoverable ×3、0 注入 |
| M0-8 注入字节上限 | 通过 | live 派生 L7 + plug-1 | 全部 decision 行 bytes ≤236 ≤2048（live）；plug-1 断言块 ≤2048 |
| M0-9 跨 scope 隔离 | 通过 | live L6 + acc-m0-9 | `l6.json` board_get(scope-b id) 输出 `status:"forbidden"` + 数据声明行，模型转述“存在该 ID 但当前会话无权读取”，scope-b 内容字段 0 泄漏（`scope-b 专属|种子知识` =0）；acc-m0-9：unknown_ref/not_found 与不存在记录逐字节一致。session=`ses_f33a7fc00ffe…`（`l6.sid`） |
| M0-10 目录输出固定声明行 | 通过 | live L3/L6 + acc | 两 live 均含声明行；`board_index` 输出常量断言在 indexing/tools 单测 |

## M1（12 项）

| 项 | 结论 | 覆盖 | 证据 |
|---|---|---|---|
| M1-1 幂等域 7 字段矩阵/数组序/缺省 vs 空数组 | 通过 | acc-m1-1（自动化）+ live L4 拒绝路径 | `test/acceptance.test.ts`“7 字段差异…”：全部 conflict；崩溃重试 replay 同 ID；两域核对（幂等域 TLV 重算 sha256 + 记录域 recordHash）通过。备注：description 缺失由 host 层 zod 拦截（业务层 validatePutInput 兜底 blank/newline/too_long），见偏差 ④ |
| M1-2 旧记录不可变 | 通过 | acc-m1-2（自动化）；live M1-2 专项 **gated**（超出本次 L1–L6 授权） | 写入后旧 id 文件字节+hash 不变；`defineBoardTools` 键集合恰三工具 |
| M1-3 记录域/幂等域一致 + fsck | 通过 | acc-m1-3（自动化）；live 专项 **gated**（同上） | fsck 双域核对通过；observe `hash_sample ok`（live L2/L3 亦见） |
| M1-4 候选集边界（每请求上限） | gated（端到端）/ 基元通过 | plug-8/9 + acc-m0-7 | `board.aggregate` 属 DESIGN §14.3 第二步（另立计划），端到端候选集考核 gated；生产 `decideAndPersist` 路径的每请求/每会话预算边界已由 plug-8（0 注入）、plug-9（真子进程锁冲突协议 + fulfilled_initial 顺序）与 acc-m0-7 覆盖 |
| M1-5 轮次未知保守处理 | 通过 | acc-m1-5 + plug-10 | round_known=false → created_round=null、eligibility unknown、0 注入；close 重开持久保持 |
| M1-6 当轮保护（fence） | 通过 | acc-m1-6 + eligibility 单测 | created_round=当前轮 → protected |
| M1-7 读不改写 | 通过 | acc-m1-7 + live L3（首次 stored 后 hash 不变，L5 复验 OK） | 写 A、B 后 get(A)/put(C)：getById(A) 原文与 hash 不变 |
| M1-8 tombstone 语义 | 通过（基元）/ covered_by 聚合端到端 gated | acc-m1-8 | getById unavailable、entry 文件仍在、compact 不列、all 列 tombstoned:true、ID 不变；nav covered_by 边缘属第二步聚合，gated |
| M1-9 并发写/锁 | 通过 | acc-m1-4/8/9（16 并发唯一）+ plug-9（内核 flock 真子进程冲突报告） | storage-5/6 级联 |
| M1-10 关键词检索 | 通过（本 scope 关键词命中）/ 聚合丢关键词子项 gated | acc-m1-10 | 两条近似描述 → keyword 各自恰命中原记录；“聚合摘要丢原文关键词”属 §14.3 第二步，gated |
| M1-11 跨流读取与拒绝 | 通过 | acc-m0-9 + permissions 单测 | 隔离流/未注册/跨 scope 输出与不存在记录逐字节一致（掩码后） |
| M1-12 配额三阶段峰值标定 | 通过 | acc-m1-12 | peak_commit_bytes === 独立序列化标定 P1*；quota=P1*+1 时第二个同尺寸 put → P2* > P1*+1 → quota_exceeded；首个 entry 与全部 metadata 保留 |

## live 运行一览（R7 绑定）

| Run | 会话 | 证据 |
|---|---|---|
| L1 | ses_f33b16822ffev1cRZu57PeE2gI | `l1.sid` `l1.bb.log` `l1.json`（request_id `ses_…:msg_0cc4e9adb001n5av5k6x4peF3T`） |
| L2 | 父 ses_f33b05b78ffeSOf5neCjBJvGGq / 子 ses_f33afe492ffec41AU1EX5M6ejz | `l2-sessions.json`（parentID 链）、`evidence-l2.jsonl`、`l2-child.txt`、`l2-file-hash.txt`、`l2.json` |
| L3 | ses_f33aa2c74ffe0ychT91xRTJSr2 | `l3.sid` `l3.bb.log` `l3.json` `l3-file-hash.txt` `evidence-l3.jsonl` |
| L4 | ses_f33a99036ffeVbKImimliOveiB | `l4.sid` `l4.bb.log` `l4.json` |
| L5 | = L3 会话（`-s` 续接） | `l5.json` `l5.bb.log`、`sha256sum -c l3-file-hash.txt` OK |
| L6 | ses_f33a7fc00ffeB8NzKZEFGIVsUA（scratch）/ 种子 ses_f33a88583ffexgCM1IL0PqsK2f（scope-b） | `l6.sid` `l6.bb.log` `l6.json` `l6-seed.bb.log` `l6-seed.json` `m0-9-cross-scope-filled.txt` |

L7（派生，M0-7/M0-8）：l1/l3/l4/l6-seed bb.log 决策分布统计 + bytes 最大值 236（见上文“L7 派生检查”）。
L8a/L8b（M1-2/M1-3 live 专项）：**gated** —— 超出本次 L1–L6 授权范围；acc-m1-2 / acc-m1-3 自动化已覆盖同断言。

## gated 清单（含理由）

1. M1-4/M1-8(covered_by)/M1-10(聚合丢关键词) 的聚合端到端：`board.aggregate` 属 DESIGN §14.3 第二步，待 M1 live 且目录真实膨胀后另立计划；基元级已全覆盖。
2. M1-2/M1-3 的 live 专项（L8a/L8b）：本次授权为 L1–L6；自动化等价断言已通过。
3. compaction 子场景（M0-6 内）：无法 live 构造（A-C6 为支持证据），按 P8 M0-6 整体记降级-未满足。
4. councillor 代理 live 场景：本机无 councillor 运行时，由权限单测（isolation 黑名单、隔离流）承载。

## 偏差（相对计划原文）

1. **install.sh 产物形态**：计划字面 `dist/blackboard.js`；按 A-C3（全局插件扫描仅识别 *.ts，*.js 被静默忽略）改为 `bun build --target=bun --outfile dist/blackboard.ts` 后复制为 `<plugin 目录>/blackboard.ts`。父指示预授权该调整。
2. **plugin.ts 准入身份源**（Task 6 live 门禁暴露，最小修复）：admission 取 `output.message.id`（== transform lastMsgId），原实现取 `hookInput.messageID`。依据 A-C2 口径备注：“CLI 首条 admission 的 inp.messageID/agent 为 null，取值以 transform 为准”；Phase A `evidence-r1a.jsonl` inputKeys 含 messageID 但值为 null 实证。修复后 plugin 单测 11/11 仍绿。
3. **plugin.ts 决策日志范围**：非注入决策同样写 `{ev:"decision", bytes:0}` 行（bytes=0 表示未注入），使 L4 计划断言（reason 分布）可观测；注入路径输出不变。测试兼容（`find` 语义），11/11 绿。
4. **acc-m1-1 的 description 缺失用例**：host 层 zod 必填先于业务层 validatePutInput 拦截（拒绝均不落盘，entries 计数不变断言不受影响）；blank/newline/81 码点走业务层 `rejected: description_*`。
5. **acc-m1-2 工具键名**：实现为下划线（board_put/board_get/board_index），计划文本作点号；断言按实现键集合恰三工具。
6. **acc-m1-4/8/9 的 recentIds**：手工构造 `[recentRec.id]`（经 recentKnowledgeIds top-6 时计划所述 8 记录分布算术不可满足）；资格 ladder 本身由 eligibility 单测独立覆盖。
7. **harness/prompts/*.txt**：计划 Task 6 Files 列出，本任务补齐创建（stall 前未落盘）。
8. **验收登记位置**：harness/live-protocol.md 为 Phase A 只读文件，本表代替其登记验收结论（父指示允许）。

—— 以上即为 Task 6 全部结论。未开始 Task 7 Step 2（回滚演练）。

## Task 7 Step 2 回滚演练（R2'）

日期：2026-09-23。模式：全局（`~/.config/opencode/plugin/`，A-C3 交付形态）。演练目录：`/tmp/opencode/t7-drill`（已清理）。产物形态：`blackboard.ts`（bun build --target=bun 单文件）。

| 步骤 | 结论 | 结果与证据 |
|---|---|---|
| 1. install（全局） | 通过 | `installed: …/blackboard.ts (797305 bytes)`；sha256=`c3dd0e3ee38e7cd22c09a7b2491e340c764dd2dabd54e36e15a42c8c0f302b31`（与 `dist/blackboard.ts` 一致）→ `t7-rollback-install-sha.txt` |
| 2. 插件加载（installed 会话） | 通过 | 演练会话 `ses_f33954479ffekiK6Uk4hb3BXax`（`opencode run -m newapi/deepseek-v4-flash "你好" --format json`，rc=0）；黑板日志按 session 过滤得 2 行：`ev:"round"`（current_round:1, round_known:true）+ `ev:"decision"`（initial_reminder, round_used:1, bytes:236）；stderr 0 个 `[blackboard] degraded` → `t7-rollback-plugin-load.log` |
| 3. uninstall | 通过 | `removed: …/blackboard.ts`；插件目录清空（ls=0）；`storage kept: …/blackboard/v1`；rc=0 → `t7-rollback-uninstall-check.txt` |
| 4. 卸载后新会话 | 通过 | 会话 `ses_f3394c7f5ffeNgLgUfnloIDAYf`（同命令，rc=0）：按该 session 过滤黑板日志 **0 行**（F5 时间切片，日志总行数 33 不变）、stderr 0 个 degraded 标记、无 board_* 活动 → `t7-rollback-uninstall-check.txt` |
| 5. 重装恢复交付态 | 通过 | reinstall 输出同步骤 1，sha256 复核一致；最终 `~/.config/opencode/plugin/` 恰含 `blackboard.ts`（797305 字节，目录无其他文件） |
| 6. 存储不受演练破坏 | 通过 | 卸载未删任何数据；before/after `v1/` 全树 sha256 对比：仅新增演练会话自有 scope（`5ed8186a…`：owner-root/scope/streams metadata，entries=0 未写板）+ `scope-index.json` 追加 1 条映射（`ses_f33954479ffekiK6Uk4hb3BXax`→`5ed8186a…`），旧 8 条映射逐字保留，其余全部文件字节不变；`bun run observe` rc=0、0 个 FSCK FAIL → `t7-rollback-storage-check.txt` |

收尾：演练子进程零残留（两台 `opencode run` 均同步退出 rc=0；`pgrep` 仅见演练前已存在的宿主 serve 与无关进程，未触碰）；`/tmp/opencode/t7-drill` 已删除。最终验证：`bunx tsc --noEmit` 干净；`bun test` **109 pass / 0 fail**。无脚本缺陷，install.sh/uninstall.sh 未改动。

—— 以上即为 Task 7 Step 2/3 全部结论。项目至此收尾，未开始任何 Task 7 之后的工作。

## 聚合计划 Task D（脚本/夹具/验收）—— 2026-09-23

| 项 | 结论 | 结果与证据 |
|---|---|---|
| Step 0 observe 扩展（I7/I8） | 通过 | `scripts/observe.ts` 新增：`--recover`（fix-8，逐 stream 锁内 `Scope.recover`，末行 `recovered <n> aggregate`）、聚合域 fsck（covered_by 双向 + members 哈希全量 + agg_pending 检查，每 stream 输出 `aggregate: covered=<n> members_mismatch=<n> unrecovered=<n>`）、`--projection`（I8：输出 {nav,high_water,tombstoned,entries{seq:hash}}，排除 rounds/budget/idem） |
| agg-seed.ts 契约复核 | 通过 | Task A 已落地；本次复核：行格式 `{"seq","id","hash"}`（seq 1..14 连续、e%06d 编号、sha256 hex）+ 末行 `{"meta":<绝对路径>}`，与计划 612–618 一致 → 冒烟 `/tmp/opencode/agg-seed-l10.txt` |
| agg-crash.ts + observe --recover（L10 等价，本地数据目录） | 通过 | 引导 scope+session → `agg-seed ses_l10 14` → `agg-crash ses_l10 <dir>` rc=**137**（SIGKILL，faultHook 注入）→ `observe <dir> --recover`：`recovered 1 aggregate`、`aggregate: covered=8 members_mismatch=0 unrecovered=0`、无 FSCK FAIL、rc=0 |
| verify-l9.ts 三模式（R3-4 探测） | 通过 | 正向 `verify-l9 OK: get=8 kw=1 agg=1` rc=0；负向 `verify-l9 OK: negative (rejected=6 recent-hit=…e000009 index-counts=1)` rc=0；空工具 `FIXTURE-ERROR: no tool parts found` rc=2。合成夹具 `/tmp/opencode/fix/verify-l9-{pos,neg,empty}-events.jsonl`（seed-map 用真实 agg-seed 输出） |
| acc-agg-1..4（test/acceptance.test.ts） | 通过 | `bun test test/acceptance.test.ts` → **17 pass / 0 fail**（13+4）；acc-agg-1 含 recent（现轮补写）→ 追加 6 条退出 recent6 → fence 的两段断言；acc-agg-2 两故障点终态一致性 + 崩溃瞬间已存在字节逐字节不变、恢复至多新建摘要一个文件；acc-agg-3 keyword 穿透；acc-agg-4 旧 cursor 聚合后仍可续翻（view:"all"） |
| harness/prompts/agg-*.txt | 已创建 | agg-seed-first.txt（首条记录+回显 session）、agg-live.txt（聚合+两批 get+keyword 检索）、agg-invalid.txt（尾部受保护成员致 invalid/recent） |
| 修复记录 | — | observe.ts `--projection` 缺席时 `projSlots={-1,0,1}` 误吞首个位置参数（dataDir 失效退回默认根）；改为 projIdx≥0 才收集。acc-agg-2 初版误用 `getById().nav`（该返回无 nav 字段，覆盖关系经 meta.nav 断言）与"恢复前后全目录字节相等"（正确口径：崩溃瞬间已存在字节不变） |

### L9/L9b/L10 状态

- **L10（agg-crash 崩溃恢复）**：不依赖 opencode 宿主，已按计划语义在本地数据目录完成等价验证（上表第 3 行）。宿主侧 `observe --recover` 复核（对 `~/.cache/opencode/blackboard/v1`）留父级。
- **L9/L9b（opencode run 三段 live：seed-first → 聚合主链 → 负向投影对比）**：**gated** —— 需真实 opencode 客户端宿主，本环境无法执行，未伪造。prompt 文件与 verify-l9 正/负/FIXTURE-ERROR 三模式均已就绪，父级执行序列：L9-1 `opencode run "$(cat harness/prompts/agg-seed-first.txt)" --format json` 取 SESSION → L9-2 `bun run scripts/agg-seed.ts "$SESSION" 29` → L9-3 `opencode run "$(cat harness/prompts/agg-live.txt)"` 事件存档后 `bun run scripts/verify-l9.ts <events> <seedMap> <aggId>` → L9b `opencode run "$(cat harness/prompts/agg-invalid.txt)"` + `observe --projection` before/after cmp 相等 + `verify-l9 --negative`。

## 聚合计划 Task E（收尾）—— 2026-09-23

| 项 | 结论 | 结果与证据 |
|---|---|---|
| Step 1 observe 聚合域复核（E 复核 D 的 I7，fix-8） | 通过 | `bun run scripts/observe.ts`（默认根全 scope）：0 个 `FSCK FAIL`、全部 stream `ok`、`unrecovered=0`、rc=0（observe 修复后复跑一次） |
| Step 2 安装/回滚 drill | **gated** | live 演练需宿主（Task 7 先例）；本环境无法执行，未伪造。脚本无改动（install.sh/uninstall.sh 未触碰） |
| Step 3 全量回归 | 通过 | `bun test` → **150 pass / 0 fail**（883 expect / 13 files）；`bunx tsc --noEmit` → 无输出 rc=0 |
| aggPending 审计 | 通过 | observe 全 scope `unrecovered=0`（无 legacy agg_pending 残留） |

—— 以上即为聚合计划 Task D/E 全部结论。live 项（L9/L9b、宿主侧 recover 复核、Step 2 drill、Task C 遗留 L1–L6）集中移交父级验证。

## 收尾 live 复跑（父级执行，2026-09-23）—— L1–L6 / L9 / L9b / L10 / L12 / compaction / drill

| 项 | 结论 | 结果与证据 |
|---|---|---|
| L1–L6 复跑（Task C Step 6） | 通过 | 与第一轮 baseline 同命令复跑，逐项判据全过（L1 initial×1+stored=0；L2 child stored=1+parentID 链；L3 写后作答+声明行；L4 description_blank 拒绝；L5 superseded 链+`sha256sum -c` OK；L6 forbidden+零泄漏）。结构差异仅每会话 +1 行 `ev:"round_observed"`（Task C 观察日志）→ `/tmp/opencode/fix/live-wrapup/l1-l6-baseline-diff.txt` |
| L9 正向（聚合主链） | **通过** | L9-1/L9-2/L9-3 rc=0；数据层 5 项子断言人工核对全过（aggregated×1 members:8、AGGID=e000031、8 成员 hash 与基线一致、keyword 穿透 e000004、无拒绝）→ `l9-manual-verify.txt`。初判「降级-未满足」的 verify-l9 包装失败系**夹具脚本缺陷**：①parseItems 裸 JSON.parse 遇 board_get「数据非指令」尾注失败；②live board_get 的 covered_by 嵌于 `nav`（与 acc 用 meta.nav 同源）；③多次 index 调用合并后取首个命中（聚合前全量在先）。父级修复 `scripts/verify-l9.ts`（尾注逐行剥离重试 + `coveredBy()` 嵌套读取 + keyword 存在性判定）后用**已归档证据**复跑：`verify-l9 OK: get=8 kw=1 agg=1` rc=0（无需重跑模型；`bun test` 150 pass、tsc clean 复核）→ `/tmp/opencode/live-agg-runs/` |
| L9b（负向投影不变） | 通过 | `verify-l9 OK: negative (rejected=7 recent-hit=…e000030 index-counts=31)` rc=0；`observe --projection` before/after cmp 逐字节一致 |
| L10（崩溃恢复 live 等价） | 通过 | agg-crash rc=137 → `observe --recover`：`recovered 1 aggregate`、目标 scope `covered=16 members_mismatch=0 unrecovered=0`、rc=0。口径差异登记：observe 成功时静默（无 "FSCK OK" 文案，Task D Step 0 实现口径，非缺陷） |
| L12（councillor 隔离流授权） | 通过 | 探测：councillor 以 subagent 存在（primary 回退默认 agent+告警，rc=0）。板级夹具（councillor-x 隔离流 14 记录+摘要）：同 scope 普通调用者 board_index 不列隔离流；board_get(隔离记录)=not_found；board_get(隔离摘要)=not_found（聚合派生泄漏阻断）；零内容泄漏。原作者侧由 t-agg-2 自动化承载（150 内） |
| compaction 子场景（三判据） | 通过 | 自然触发于 L9b：轮次推进归属真实 admitted 消息（round_observed+ROUND 先于 continuation 决策，continuation 无独立 roll）；bytes>0 决策按 (session→request_id) 聚合恰 1（initial_reminder bytes=359），其余 bytes=0 |
| Task E Step 2 安装/回滚 drill | 通过 | uninstall rc=0（目录清空）→ rollback run rc=0（宿主成功且目标会话 bb.log 0 行）→ reinstall rc=0。终态：全局插件 sha256=`f682fef193284420c184cc99f00c03b04ee28a7394988fa4aa15ef93af0de40c`（810337B，聚合新版在位）；scratch 项目级=新版，旧产物备份 `scratch-plugin-bak/` |
| 宿主真实根 observe 复核 | 通过 | 默认根全 scope：0 FSCK FAIL、全 stream ok、`aggregate: covered/mismatch/unrecovered` 全 0、rc=0（父级 2026-09-23 20:00 安装新版后执行） |

**已知发现（非阻塞，移交后续清单）**：①宿主 `session_index` 条目 `agent` 为空串为长期行为（基线同期同状）——种子/夹具 writer 需显式登记 agent；②live 下聚合触发的 nudge 恒不激活：transform caller agent="" → aggregateCandidates 全员 not_original_author → null，建议列入插件缺陷清单；③`-s` 续接必须在会话原项目目录内执行（跨目录挂起 rc=124，调用侧约束）；④l12-fixture 未传 idempotencyKey 时两次写入共存（幂等键为显式可选字段，脚本语义）。
