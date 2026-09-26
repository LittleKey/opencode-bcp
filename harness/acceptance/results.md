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

## 2026-09-24 事件驱动提醒架构（DESIGN v1.4.5–v1.4.7）——单元级

范围：实施计划 T0–T4（契约修订 v1.4.7 → 常量单源 → 词法引擎 → nudge/plugin 重构 → 测试与验收迁移）。本章只登记**单元级**结论；live 验收（T5）pending 清单见末尾。历史章节（M0/M1 表、live 一览、Task 6/7、聚合 Task D/E、收尾复跑）一字不动——其中 L1–L6 的 decision 分布（initial_reminder/fulfilled_initial）属**旧快照架构基线**，事件驱动后的对应语义由本章映射表与 pending 清单承接。

### 基线变迁

150（聚合 Task E 收尾）→ 159（T1/T2 并行波次：constants golden + signals 词法套件）→ 186（T3 nudge/plugin 重构 + T3 收尾）→ **189**（本轮 T4：全量语义审计零删零改 + 补 3 条模板 golden）。全程 `bunx tsc --noEmit` 干净。

### T1–T3 交付摘要

- **T1 常量单源**：`src/constants.ts` 承载 ENTRY/PRESSURE 提醒模板、NORMATIVE_SENTENCE、TASK_DESC_APPEND、TOOL_DESCRIPTIONS；`test/constants.test.ts` 以 DESIGN §11.6 逐字节 golden 防漂移 + `src/` 规范句字面量防双源扫描。
- **T2 词法引擎**：`src/signals.ts` 纯函数判定（A1 反引号围栏 / A2 `~~~` 完整扫描撤销 / A3 列 0 引用排除；信号①=`bb://` 存在性、信号②=规范句整行精确匹配，LF/CRLF 与行尾空白口径）；27 用例 = §10.4-C 示例①–⑤（7）+ D 边界表逐行（14）+ oracle 补充（6）。
- **T3 重构**：`src/nudge.ts` 事件驱动（NudgeReason 10 枚举、六字段账本、roll/restore/预算身份，decideNudge 纯决策 + decideAndPersist 锁内落盘）；`src/plugin.ts` transform 接线（准入关联验证推进、入口信号检测、压力常量模板直驱）；缺陷②修复与方案 A 读侧容忍（normalizeBudget 旧字段、last_shown_seq 休眠）。T3 收尾修复 3 失败（plug-8/p-red-2/n-old-1，均测试侧语义错位，源码零改动）。

### 迁移映射表（T4 全量审计：plug-*/acc 五文件旧语义残留 = 0；下表登记 T3 已完成的迁移）

| 旧用例（HEAD 基线名） | 现状 | 依据 |
|---|---|---|
| nudge「首轮 roundKnown=true → initial_reminder，mark_fulfilled，ledger 置位」 | nudge-1「入口信号① → entry_signal_1，一次预算，entry_prompted_message_ids 置位」 | §14.1 M0-1 注记（无信号零注入/有信号获得机会） |
| nudge「同轮第二次初始机会 → fulfilled_initial 不重注入」 | nudge-2「同 admitted id 新请求 → entry_already_prompted」 | §14.1 M0-7 注记（同一事件信号不重复注入） |
| nudge「快照版本未变 → state_unchanged」 | DELETED（等价承载：nudge-2 事件去重 + nudge-3 同请求去重） | §10.7 快照状态去重废除（§10.3 去重范围条） |
| nudge「初始优先注入；同轮压力；roll 后初始再次优先；… → set_already_prompted」 | nudge-8「入口优先注入；…roll 后入口新事件再次注入；已提示集合持续抑制」 | §10.4 入口优先（I3）；§10.3 I2 |
| nudge「初始+压力共享预算用尽 → no_budget」 | nudge-9「入口+压力共享预算用尽 → no_budget」 | §10.3 预算身份（≤2/轮共享） |
| nudge「roll 后初始机会独立于压力类去重 → initial_reminder」 | DELETED（roll 后新入口事件再注入语义由 nudge-8 承载） | §10.7 每轮初始下限废除 |
| nudge「候选集存在时初始优先注入…已履行后候选消失 → fulfilled_initial」 | DELETED（入口优先语义由 nudge-11 承载） | §10.7 fulfilled 状态机废除 |
| nudge「rollLedgerForNewRound：重置轮内字段，prompted_set_hashes 保留」 | nudge-12（+ entry_prompted_message_ids 跨轮保留断言） | §10.3 I2 入口事件跨轮持久 |
| nudge「renderSnapshot ≤2048 字节；省略行 + 保留整条」 | DELETED（≤512B 常量模板断言由 plug-1/p-agg-1 + constants golden 承接） | §10.7 快照形态移除；§10.2 / §14.1 M0-8 注记 |
| plug-1「transform appends snapshot text part in place ≤2048」 | plug-1「signal prompt injects entry reminder once, in place ≤512B」 | §10.2；§14.1 M0-8 注记 |
| plug-8「round_used=1 且 initial_fulfilled=true → 零注入」 | plug-8「round_used=2 → no_budget（同预算身份内耗尽，入口亦不破例）」 | §10.3 预算依附 admitted 输入（新 admitted = 新预算身份，nudge-8/12 单测承载） |
| p-agg-1「A 初始优先注入 → B 同轮压力/集合抑制 → C 新轮初始再次优先…」 | p-agg-1「A 压力注入（模板②，无板数据）→ …无每轮初始下限」 | §10.4③；§10.7 |
| plug-2/3/4/6/7/10、nudge-13、n-red-1/2、n-agg-1、acc-m0-*/m1-*/acc-agg-*、storage/indexing 既有断言 | UNCHANGED（语义不变项，全程绿） | §14.1：M0-2/4/9/10、M1 全部保持 |
| plug-9 | 已修复回归（oracle I4）——下行原将 plug-9 列入 UNCHANGED，不准确：旧形态两进程均 s1:s2:false/candidate:null，仅测锁冲突不测预算 | 现两进程携带不同压力候选集（S1/S2）、起点 round_used=1：A 持锁消费最后额度注入 pressure_reminder，B 锁超时 lock_contention_observed、重试 no_budget；持锁暂停机制保留 |
| （新增）n-old-1 旧账本读容忍/写回迁移；plugin decision-log 留痕用例；indexing last_shown_seq 休眠用例 | NEW | §10.3 账本迁移容忍；§10.6 决策日志；§10.7 废除字段读侧容忍 |

**T4 增量：删除 0、语义改写 0、新增 3**（见下节）。§14.4-2 产出—识别一致性四子项既有覆盖核对（未重复造）：规范句字节=识别器常量（constants「含规范句子串 === NORMATIVE_SENTENCE」+ 单源扫描）、实际分发文案=§11.6 task 段全文（constants「TASK_DESC_APPEND 与 §11.6 task 块逐字节相等」）、无标题仅规范句触发②（signals D3）、推荐模板触发①②合并（signals C①，①②分开断言贯穿 D14）。

### 本轮新增（§14.4 可单测补缺，test/constants.test.ts）

1. PRESSURE_REMINDER_TEMPLATE ≤512B golden（原仅 ENTRY 有字节上限断言）；
2. 两模板均不含 `bb://` 板数据引用（§10.2 常量性：模板不拼接任何记录内容，目录发现一律由 agent 主动 `board_index` 完成）；
3. 两模板均含第三句保护文案「adds no obligations and never overrides this task's restrictions」（§14.4 场景 7 反例的单测层断言：提醒不新增读写义务；「检测不产生工具调用路径」由 signals.ts 纯函数构造满足——判定面仅返回 s1/s2 布尔，无工具调用 API，行为级反例归 T5）。

### nudge reasons 全集矩阵（10 枚举均有产生路径与断言，无缺口，未新增用例）

entry_signal_1（nudge-1/8、n-old-1）· entry_signal_2（nudge-8）· entry_signal_merged（nudge-10）· entry_already_prompted（nudge-2）· pressure_reminder（nudge-8/11、p-agg-1 A）· duplicate_hook（nudge-3、n-red-1、plug-2）· no_budget（nudge-9、plug-8、p-agg-1 D）· set_already_prompted（nudge-8、p-agg-1 B/C）· identity_unrecoverable（nudge-4/5/6、n-red-2、acc 身份链用例）· no_signal（nudge-7、plug-10④、plugin decision-log 用例）。

### 最终验证

- `bun test` → **189 pass / 0 fail**（964 expect / 15 files）；`bunx tsc --noEmit` → 无输出 rc=0
- 无 skip、无 TODO 残留；本轮增量写域：test/constants.test.ts（+3 golden）、harness/acceptance/results.md（本章）

### live 验收 pending（归 T5，需宿主环境，未做单测模拟）

1. **L 系列复跑**：L1–L6 重跑后 decision reason 分布按新枚举断言（旧 initial_reminder/fulfilled_initial 分布作废；L1 判据改为「无信号零注入」；L3/L4 reason 分布按 §10.6 枚举）；L2 隔离不回归。
2. **缺陷② live 复测**：真实膨胀目录会话触发信号③（候选集非 null → pressure_reminder 注入模板②）——上文已知发现②「live 聚合 nudge 恒不激活」的闭环验证。
3. **§14.4-3 中英自然委派四环节**：中文含 `bb://` 场景覆盖①；≥1 场景不含 `bb://` 单验②；task.prompt 由模型按**实际分发 description** 生成（禁人工塞句）；逐段记录 description 分发 → 模型产出 → ②检测 → 接收者行为。
4. **VP-1 / VP-4 复验**：task.description 追加文案在真实分发中逐字节可见；ACP 共存不干扰。
5. **§14.4 场景 1–7 行为级回归**（live 层），含场景 7「明确不读写黑板」误提醒任务的行为观察（单测层保护文案断言已过，接收者行为待 live）。

## 2026-09-24 T5 live 验收——事件驱动提醒架构（新构建 811014 B，sha d7e52000…）

环境：全局插件重装后全新 `opencode run` 进程（规避宿主内旧实例）；日志 `~/.cache/opencode/blackboard/log/blackboard.log`；工件 `/tmp/opencode/t5/`（smoke/deleg-zh/canary/pressure/seed/vp4 各 .json/.err/.bb.log）。

| # | 项 | 判据 | 结果 | 关键证据 |
|---|---|---|---|---|
| 1 | L1 新口径冒烟 | 无信号零注入、0 degraded | **通过** | ses_f30d01f2dffe…：`round_observed`→`round`→`decision no_signal bytes:0`；旧构建此处为 `initial_reminder bytes:236` |
| 2 | 自然委派四环节（中文） | description 追加→模型自产委派（bb://+规范句）→识别→接收者提醒 | **通过** | fixer 会话 `entry_signal_merged bytes:362`（①②同时命中=规范句被模型逐字写入委派——VP-1 强化证据，全程无人工塞句）；委派方自身 `entry_signal_1`+`entry_already_prompted`×2（去重 live） |
| 3 | Canary 全链路 | 写入→委派→跨流读→发布→ID 转告 | **通过** | orchestrator `no_signal`（自身 prompt 无 bb://，正确零注入）；fixer 读取 1d6c893b 流记录、发布 76bd1309 流 e000001.json（磁盘实证）；ID 逐字转告。附带反例：自然中文委派无规范句→仅①命中（A1 宁漏勿误 live 确认，模板仍引导了发布） |
| 4 | 缺陷②复测（压力路径） | 候选集非 null→模板②注入 | **通过** | seed 29 条后续接：`pressure_reminder bytes:278`（模板②原尺寸）+次请求 `set_already_prompted`；模型 board_index 报「目录共 29 条」 |
| 5 | VP-4 共存 | 同进程 acp_*+board_* 可见 | **通过** | 探针单进程列出 acp_status/acp_context_recap/board_put/get/index/aggregate/compress/decompress |

范围裁定（L2–L6 协议复跑）：**未逐项重跑**。理由：本轮变更面（plugin 接线/nudge/signals）已被 1/2/3/4 覆盖 live；未变更面（board 工具/存储/权限/聚合语义）由 189 单测承载，且 live 顺带印证——跨 scope `board_get`=forbidden（L6 型保护）、同 scope 跨流读成功（L2/L3 型）、board_put/get 生产路径可用（canary）。如 T6 复审判定需补协议级重跑，再执行。

### errata（oracle 复审 2026-09-24）

- **plug-9「UNCHANGED」标注修正（I4）**：T4 映射表曾将 plug-9 列为「UNCHANGED（语义不变）」——不准确。plug-9 旧形态（两进程 s1:s2:false/candidate:null）只覆盖锁冲突报告协议，未覆盖预算竞争语义；已修复为真实预算竞争回归（A 注入/B no_budget，持锁暂停机制保留），见事件驱动章节映射表 plug-9 行。
- **I1 口径分叉缺陷（同轮修复）**：live 样本「board_index.counts eligible:0/protected:29 而聚合候选产出 pressure_reminder」根因为两处资格判定的 caller 身份源不同（counts 用 ToolContext.agent——live 常空串；聚合用注册验证身份）。已统一为注册路径验证身份（tools.ts 资格 caller + plugin 刷新链），i1-5 测试钉死。

## 2026-09-24 T5 补验与更正（oracle T6 复审 I1/I5 之后；构建链 811014→813031→813134）

**更正一（首轮压力样本无效——oracle I1 判定成立）**：首轮样本 writer/caller 皆空串，压力触发走的是空串冒充路径且 counts（eligible:0）与候选并存。P2b 复验（真身份 fixer 会话）暴露 I1 残余：无 agent 的 CLI 续接把进程内身份缓存钝化为 null、遮蔽 session_index 已注册 "fixer"（数据侧核实 callerAgent=fixer 时 29/29 可判 eligible）。修复=i1-6 三级回退（hook agent→已注册身份→null）。**P2c 终验通过**：`pressure_reminder bytes:278` + 次请求 `set_already_prompted`；模型报「29 条，eligible 23、protected 6」（recent 窗口保护）；caller=注册 fixer 身份对齐。缺陷②（live 压力恒不激活）至此以真实身份路径闭环。

**更正二（canary 反例归类——oracle I5 判定成立）**：首轮「中文委派无规范句→仅①」记载为"A1 宁漏勿误确认"不准确，改为 **§15①(d) 产出侧漏报样本**。补验新增同类两例：E（英文自然发布委派）与 Z（中文）的模型自产委派均未含规范句（②不命中、接收者 no_signal）——产出侧合规率随机，属 §15①(d) live 观察项，非契约缺陷。

**新增通过证据**：
- **②only 自然委派**（Z2）：fixer 子会话 `entry_signal_2 bytes:362`——模型经 description 指引自产规范句、委派不含 bb://，仅②命中（四环节：分发→产出→检测→行为完整）。
- **零行为反例**（N）：prompt 含 bb:// 字面 + 显式禁令 → `entry_signal_1` 注入但模型 **零 board 工具调用**、正确答题——保护句（提醒不新增义务/不覆盖任务限制）live 生效。
- **L4 拒绝路径**（L4b）：description 两空格 → `description_blank` 拒绝、模型未重试、无提醒循环、正常退出。（附注：L4 首轮误测空 content 轴——空 content 写入成功；DESIGN §6/§11 校验轴为 description，无 content 非空要求，故该写入合规非缺陷，记录备查。）
- **散文否定式误中样本**（Z orchestrator 自身）：我的指令原文含 "no bb://" 字样 → orchestrator `entry_signal_1`（§15① 预测的残余误报类 live 实证），行为无害（未读板，仅按任务要求自行发布了一条评审记录）。
- **L2 身份隔离**：委派子会话注册身份 fixer/orchestrator 正确；CLI 无身份会话保守沉默不冒充（多会话交叉验证）。
- **L5 续接身份/预算**：P2b/P2c 跨进程续接（roll 49→50→51、预算正确重置与去重）；I2 重放回归为单元级 i2-replay/i2-ring。
- **VP-4**（首轮已录）+ m3 单测断言 tool.definition 交付面（task/非 task、段落分隔）。

**仍开放（诚实登记）**：ACP 实际压缩/transform 干扰观察未自然发生（未观察/未完成对抗验证；工具共存与 m3 单测不等于实际压缩通过），保留为 §15② 观察项；英文自然发布委派的规范句命中样本（E 未命中）待后续自然积累，以 Z2（半自然：指令模型遵循其 task 工具指引）与首轮 deleg-zh（纯自然命中）为现存证据。

## 2026-09-24 T6-R2 缺陷修复与补验（构建 813972 B；T6-R3 输入）

**代码修复（204 pass / 0 fail / 1013 expect；tsc 干净）**：
- **I2-R**：`admitted_seen` 移除 8 项环形 cap 改无界集合（`normalizeBudget` 对旧数据天然兼容；src/nudge.ts:206-216 注释明确「缓存未命中不构成新颖性证明」）；`i2-ring` 改写为淘汰位次重放回归——M1→M10 后重放 m1+新压力集合：不 advanced、不重置预算、不注入、round 不虚增。
- **I1-R**：skip 判定施加于三级回退后的最终解析身份（src/plugin.ts:165-174）；skip 事件驱动缓存失效+会话 taint（:146-151 scopes.delete；:32 skipTainted）；空 agent 对 tainted 会话在 lookup/register 两处硬阻断 return null（:99-135）；显式有效身份重新登记解除（:91,:173）。新增 `i1-7`（冷启动借道反例，断言落实际可见性/board_index 拒绝）、`i1-8`（缓存残留反例：失效后空 agent 不再注入 parts=1，显式 build 恢复后注入恢复 parts=2）。

**E2 英文自然发布链路（通过——§14.4 中英双链齐备）**：scope 291d6920：orchestrator（流 adba043f）board_put 基线记录 → 自然委派（runE2.json 归档 prompt 原文：含 bb://、无规范句，①-only 路径，同归 §15①(d) 产出侧样本）→ fixer（流 62b91c9e）`entry_signal_1 bytes:362` + `entry_already_prompted`×2 → board_get 读原文 → board_put 发布结论（磁盘双 e000001.json 实证）→ 两个 board ID 均转告。orchestrator 自身 no_signal ×3（指令文本无 bb:// 字样）。中文链 = 首轮 deleg-zh（纯自然 entry_signal_merged）+ canary。

**Z2 补档更正（诚实撤回）**：runZ2.json 仅含起始事件，前文「四环节完整」超出归档证据——撤回该表述，仅保留 fixer 子会话 `entry_signal_2 bytes:362` 事实；完整链路证据由 E2 承担（prompt 原文回执 + 双记录 + 转告）。

**L4r 带提醒拒绝样本（通过）**：会话 ses_f307ac2e4ffeRpfIl6uWXSR3vC：prompt 含必读 bb:// + 指令 description=单空格 → 首请求 `entry_signal_1 bytes:362 used:1` → `board_put` 返回 `rejected: description_blank` → 次请求 `entry_already_prompted bytes:0`（无循环、无二次注入）→ 模型原文转述拒绝结果、正常退出；全 scope entries 扫描确认探针记录未落盘（拒绝真实生效，非仅模型转述）。

## 2026-09-24 E3/E4——英文②产出侧验收补齐（T6-R3 I3 处置；工件 /tmp/opencode/t5b/runE3.json、runE4.json）

**更正**：前文「§14.4 中英双链齐备」（E2 时点）表述过宽——E2 为①-only 链路，当时英文②未证。现按下表口径修正并由 E4 补齐。

| 链路 | 中文 | 英文 |
|---|---|---|
| ① 必读命中（自然委派含 bb://） | deleg-zh 首轮（纯自然，merged 362B）+ canary | E2（纯自然，prompt 原文归档）+ E3 |
| ② 发布命中（模型自产规范句） | deleg-zh 首轮（纯自然，merged）+ Z2（②only 362B） | **E4（②only 362B）** |
| 无 bb:// ②only 场景 | Z2 | **E4** |

- **E3（未命中样本，归 §15①(d)）**：英文指令明示「follow your task tool's guidance exactly」仍意译未含规范句（fixer 会话 no_signal×2）；链路功能仍成立（fixer 按任务文本发布、orchestrator board_get 验证、跨流短 ID 不解析/全限定 ID 可解析的 live 观察）。
- **E4（命中）**：指令仅指向 task 工具 description 中「推荐的请求发布结果英文句」要求逐字拷贝（**未提供句子原文**）→ 模型从分发的 description 拷贝规范句入委派 → fixer 会话（ses_f306fe608ffe）`entry_signal_2 bytes:362` + `entry_already_prompted`×2；orchestrator 自身 no_signal；echo 归档含逐字句。构成「description 分发→模型产出→②检测→接收者行为」完整半自然链路（§14.4「模型按实际分发的 description 生成」口径）。
- **产出侧合规率观察（§15①(d) 累计）**：自然/弱指引 0/4（E、E2、E3、Z 首轮）；强指引 1/1（E4）；纯自然命中 1 例（deleg-zh 首轮，中文）。结论：description 传播机制有效但合规率随机；本批强指引样本成功，是否稳定改善合规率仍需观察（T6-R4 Minor 更正：小样本不支持「显著提升」表述）。
- 附带实证：fix-3 会话在本宿主进程（旧构建驻留）决策仍为 `fulfilled_initial` 旧枚举——新构建仅对新进程生效（安装不热载），与 VP-4 共存观察一致。

## 2026-09-24 T6-R3 I1/I2 修复（构建 815150 B；206 pass / 0 fail / 1023 expect；tsc 干净）

> errata（T6-R4）：本节「已闭环」口径过宽——R4 复审发现证据合并仍限非空判定、重放仍可消费现轮入口额度、taint 冷入口/热缓存/持久化失败三路径可绕过；完整修复见后文 T6-R4 修复章节。

- **I1 旧账本保守迁移**：`normalizeBudget`（src/nudge.ts:169）admitted_seen 缺失/为空时用 `去重(round_id, …entry_prompted_message_ids)` 播种——已知已处理证据不丢弃，缺失历史≠从未处理，无法证明的新颖性不发额度。回归 `i2-legacy`：旧账本 {round_id:M1, round_used:2, entry_prompted:[M1]} → 处理 M2（roll 正常）→ 重放 M1+新压力集 → 不 advanced、预算不重置、零注入（入口去重 entry_already_prompted 先行）、round 不虚增（oracle 复现的第三次注入被阻断）。
- **I2 skip taint 持久化**：`session_index[].skip_tainted` 持久标记（src/storage.ts:47-48,307-313 幂等落盘）；4 个 taint 写点统一 markSessionSkipTainted + 清残留 admitted 关联（oracle 建议）+ 缓存失效；冷路径判定=内存∨持久（持久权威，src/plugin.ts:132）；空 agent+tainted→硬阻断 null；显式非空 agent 登记/刷新时清除标记（storage.ts:276-302，空串不清除——与身份不覆盖语义一致）。取舍：无 Scope 实例的纯入口拒绝不落盘（不为标记建 Scope，注释明示）。回归 `i1-9` 两实例：A 注册 build→spy 到达→B（同 dataDir 全新状态）空 agent 续接被阻断（不注入/工具 rejected: unregistered_session）；显式 build 再登记恢复注入与工具。
- 附注：i2 系列夹具 round_id:"seed" 进入播种集合为预期；i2-legacy 重放 reason=entry_already_prompted（入口去重先行，同为抑制）。

## 2026-09-24 T6-R4 I1/I2 终轮修复（构建 816627 B；211 pass / 0 fail / 1049 expect；tsc 干净）

- **I1-A 证据无条件合并**：normalizeBudget（src/nudge.ts:170-171）改为 `去重(admitted_seen…, entry_prompted…, round_id)`——非空≠完整；顺序 seen→entry→round_id（round_id 置末：避免 roll 后当前 id 翻队首破坏 seed-first 语义）。回归 `i2-legacy2`（非空缺项夹具+重放 M1→entry_already_prompted/零注入/不虚增）。诚实注记：合并在**判定时**即时生效，落盘随下次账本写完成（重放路径 changed=false 不写盘）。
- **I1-B 重放不偷现轮入口额度**：`replayedEntryUnproven = replayed ∧ id∉entry_prompted` → 入口输入清零、入口与压力一并保守抑制（注释引 DESIGN:317,323）。回归 `i2-replay-entry`（M2 现轮+重放缺历史 M1+s1→零注入、round_used 保持 0）。
- **I2-A 冷入口只查不建**：新增 `probeExistingScope()`（scope-index 反查，不创建）——skip 到达时命中既有 Scope 则落盘+内存双标记；确无 Scope 才纯内存拒绝。回归 `i1-10`（已注册会话冷入口显式 skip→持久 skip_tainted=true）。
- **I2-B① 热缓存遵守他实例持久 taint**：缓存命中∧空 agent → 读 `isSessionSkipTainted()`（IO 如实说明（T6-R5 Minor 更正）：getter 每次调用重读并解析**整份** scope.json，热路径因此新增真实文件读；transform 本身以空 agent 调 lookup 也会触发，非仅 CLI 续接；不缓存读取结果是为保持与他实例写盘一致性——正确性优先的有代价取舍）。命中即阻断+失效缓存。回归 `i1-11`。
- **I2-B② 同名显式身份到达也清 taint**：`refreshSessionAgent` 早退条件改 `e.agent===agent && !e.skip_tainted`（src/storage.ts:301-302，本组最深根因——上轮只修了 registerSession 漏了 refresh）。`i1-11` 恢复段诚实注记：恢复后 board 工具可用+round_used 不变即断言（同压力候选集受 prompted_set_hashes 去重，不断言二次注入）。
- **I2-C 持久化失败不保留放行**：统一 `taintAndInvalidate`（src/plugin.ts:101-110）**先**本实例保守失效（缓存删除+内存 taint+清 admitted）**再** try 持久化，catch 记 `skip_taint_persist_failed` 降级（本实例仍阻断，仅丢跨重启保护）。回归 `i1-12`（chmod 0555 注入写盘故障→本实例仍 rejected；恢复后显式身份清除）。
- errata 两处（T6-R4 Minor）已同步：:254 合规率措辞降级；T6-R3 章节闭环口径加更正指引。

## 2026-09-24 T6-R5 两 taint 漏口修复（构建 816881 B；212 pass / 0 fail / 1054 expect；tsc 干净）

- **漏口1 非空 agent 工具热路径绕过持久 taint**：lookup 缓存命中分支的持久 taint 检查去掉 `!agent` 前置（src/plugin.ts:158-166）——工具路径只查不刷新，非空 ctx.agent 不得绕过他实例落盘 skip 标记；合法恢复仅经注册路径（chat.message 显式 agent→refreshIdentity→refreshSessionAgent，未动）。i1-11 阶段2 扩展：Q 落盘标记后 P 以非空 agent="build" 直接调 board_index → rejected。
- **漏口2 冷探测失败吞掉本地失效**：新增 `coldSkipReject`（src/plugin.ts:133-149）——先 `taintAndInvalidate(id, null)`（零 IO 零可失败点）→ 再 `probeExistingScope()`（可抛，抛出时本实例已失效）→ 命中则 markSessionSkipTainted（内联 catch 降级）；lookup:171/register:230 两冷调用点改走该 helper。i1-13：注册会话+冷插件+显式 spy+scope-index.json 临时损坏后恢复 → 同实例空 agent 续接仍 rejected+不注入+skip_tainted 未落盘（探测失败只丢跨重启标记）；显式身份恢复（:637 断言口径：同名早退不重写条目，skip_tainted ?? false 合法缺省）。
- **IO 注释如实化**（storage.ts:308-312 及 plugin.ts 两调用点）：getter 每次调用重读并解析**整份** scope.json；不缓存读取为正确性优先取舍（保持他实例写盘一致性）；transform 空 agent lookup 与任意 agent 工具缓存命中路径均触发——results.md :270 已同步更正（T6-R5 Minor）。

## 2026-09-24 T6 复审循环收官（构建 8171xx B；213 pass / 0 fail / 1057 expect；tsc 干净）

- **T6-R6 判决：IMPLEMENTATION-APPROVE-WITH-FINDINGS**（无 Critical/Important；两 Minor：return await 吞异常回执不对称 + 未落盘断言时点）。
- **Minor 收尾（fix-3）**：plugin.ts:171,230 `return await coldSkipReject`（工具冷入口探测异常现回执正常 rejected: unregistered_session）；新增 i1-14（冷工具入口+scope-index 损坏→正常回执断言）；i1-13 未落盘断言前移至显式恢复前（真正可证）。213 pass 零删改。
- **收尾核验**：orchestrator 独立复跑+抽读（两处 await、断言位置）；机械修改按 oracle 给定规格执行，无需再启 R7——R6 已授予通过，最小收尾清单逐项落实。
- **六轮循环总账**：R1 REJECT（I1 身份链三缺陷+I2 重放+I3 参数+I4 race 退化+I5 证据口径+M1-3）→ R2 REJECT（I2-R/I1-R/L4/E2/Z2 四必办）→ R3 REJECT（旧账本迁移丢证据/taint 不跨重启/E2 冒充②）→ R4 REJECT（证据合并非空判定/重放偷额度/taint 三路径）→ R5 REJECT（非空 agent 工具热路径/冷探测序）→ R6 APPROVE-WITH-FINDINGS。实现复审闭环。
- **遗留观察项（转 T7 §15①）**：产出侧规范句合规率（自然/弱指引 0/4、强指引 1/1、纯自然中文 1）；散文否定式①误报（行为无害已证）；ACP 实际压缩交互未自然发生（pending）；hook 顺序竞态——晚到的 skip 探测可重新 taint 刚恢复身份（保守过拒绝，非放行）；IO 放大——T 次 transform+B 次热板调用≈T+B 次整份 scope.json 重读（正确性优先，瓶颈再测）。

## 2026-09-24 v1.5.1（C+D′）live 验收——六场景

环境：全新 CLI 进程（安装构建 817906B，v1.5.1 常量）；工件 /tmp/opencode/t5b/{s1*,s2,s3,s4,s5a*,s6a,p}.*。

| 场景 | 结果 | 关键证据 |
|---|---|---|
| ① D′ 无标记自然评审交付 | **FAIL（2/2）** | S1(flash)/S1b(glm-5.3)：仅要求评审结论，无任何发布/来源/标记要求→两模型均零发布（磁盘 entries=0）；工具面探针 P 证明 board 四工具可见→排除工具缺失，为真实 description 合规失败（ora-3 预告风险的实证）。「未发现问题须版本绑定交付」子项同未发生 |
| ①c 显式条件发布请求（义务来源#1） | PASS | S1c：任务文本含行内规范句（行中非独占→②不触发=词法正确阴性对照）→ 发布 kind=review（磁盘 c3c05148/0fa97fbe/e000001，desc 正确）+ 返回完整 ID |
| ② 中继读源+限定词保真 | PASS | novel 轮既有证据（v1.4.5+ 路径 v1.5.1 未变更）；本轮 S2：①信号 438B 触发→尝试读取→forbidden 时显式报告并给出选项，零编造 |
| ③ 已有合格来源引用去重 | 未决 | S3 因跨 scope forbidden 干扰：agent 拒绝盲引（行为合理但非本场景断言）；待同 scope 环境补测 |
| ④ 简单实现零记录 | PASS | S4：结果全落产物，entries=0，no_signal×3 |
| ⑤a 噪声提醒下零调用 | PASS | S5a2：无关 bb:// 触发 entry_signal_1 438B（新模板生效实证）→ 回复 READY、零 stored |
| ⑥a 来源不可读→显式缺口 | PASS（forbidden 变体） | S6a：e000099（不存在）→ forbidden（auth 先于存在性，不泄漏）→ 报告缺口+完成可行部分 |
| ⑥b/⑥c | 先例/观察 | ⑥b 由 v1.4.9 L4r 先例覆盖；⑥c 未自然发生转 §15 |

**环境观察**：(1) CLI 单发（非 git 目录）每 run 新建 scope→跨 run 中继被权限正确拒绝——测试限制而非缺陷，生产委派同 scope（小说轮实证）；(2) put 事件名实为 `stored`；(3) `--agent` 标志疑似未生效（S1c writer_agent=orchestrator），行为证据不受影响（工具+描述在场）；(4) S1d 的字面 `\n`（bash 双引号）致规范句未独占行→②不触发——词法契约再次阴性对照正确。

**核心结论**：义务来源#1（明确任务要求）路径全链可用（①c/②/⑥a）；**D′ 独立生效（无标记自然交付）在 CLI 单发形态双模型失败**——构成 §15 B 方案（子会话一次性入口提醒）重触发条件的首个实证数据组；生产委派形态（task() 子会话+新模板）待宿主重启后补测。

### 生产形态补测（宿主重启至 v1.5.1 构建后）

- **宿主构建**：探针子会话 `entry_signal_1 bytes:438`（v1.5.1 新模板；旧 362B 消失）；READY 零调用。PASS。
- **① D′ 生产形态（task() 委派、零标记零要求）**：**发布侧 PASS**——oracle 子会话自然交付 kind=review（bb://f1f795b7…/528ff791…/e000001）：版本绑定（v1）+范围声明（仅第2章）+工件行号引用（novel.md:15-23）+writer 归属正确；父会话 board_get found 可读（交付环闭合）。**返回通报 MISS**——终稿未提及 board ID（靠日志发现）。与 CLI 单发形态（FAIL 2/2）的分化点=委派上下文使「评审交付边界」可被识别。
- **结论修订**：D′ 在生产形态实质生效（1/1）；B 重触发条件（生产形态持续漏交）未成立，维持暂缓。C+D′ 分工实测：C（明确要求）得发布+ID 回流；D′（无要求兜底）得发布、缺回流——与设计意图一致（D′ 保持久性，C 保路由）。
- **环境观察**：子会话 scope 解析为 f1f795b7（非父 scope 7dc68da1），跨 scope 读经全 ID 仍 found（授权按 lineage 而非 scope 同一）；机制待后续核对 src/permissions.ts 归因，不影响验收结论。

## 2026-09-24 v1.6.x 入口词法提醒退役（契约 v1.6.0→v1.6.2 指纹 c5a5718…；实现 183 pass / 995 expect / tsc 净）

- **方向**（用户批准，oracle 裁决）：取消①②关键词触发入口提醒，保留③压力；完整决策规则常驻三工具描述（board_put 1155B/board_get 361B/task 996B，§11.6 逐字节 golden）；B1 有条件兜底；B 重触发改「完整交付失败」口径。
- **实现**（fix-2）：signals.ts+测试整删；ENTRY_REMINDER_TEMPLATE/NORMATIVE_SENTENCE 删；nudge reasons 收窄 6 值、seen_requests 改评估即登记（oracle 裁定接受：已评估≠已成功提醒）；旧账本 entry_prompted 合并保留（§10.7）；budget-race 同步。
- **复审循环**：ora-6 契约 REJECT（3I+3M：外部合格来源/生产者职责/B1-验收互斥）→ v1.6.1 修正 → APPROVE-WITH-FINDINGS（4 Minor 说明同步）→ v1.6.2；实现复审 REJECT（唯一项：v16-3 夹具证据旁路）→ 夹具重做+双向击穿证明（删合并→FAIL 轮次 7→8/预算 2→1/注入；恢复→PASS）→ 本轮关闭。
- **迁移安全**：v16-3（entry-only 账本重放三不）+i2-legacy2 双覆盖；reg-1/reg-2（旧词法标记零注入/仅压力）。
- **live 观察**：宿主重启后入口提醒应整体消失（含唤醒注入）；压力提醒（278B）保留。遗留：working tree 累积未提交（v1.4.9→v1.6.2 多轮），待用户指示提交。

## 2026-09-24 v1.6.2 真实场景 E2E：零 board 词汇三跳委派（实现→审核→修复）

- **条件**：三跳委派正文 100% 无 board 词汇（无 bb://、无发布要求、修复跳转述式传达不带 ID）；宿主 v1.6.2 构建（815564B）。
- **信号层**：17/17 决策全 `no_signal bytes:0`——全程零提醒零注入（退役符合预期）。
- **R 边界（决定性结果）**：ora-8 仅凭常驻 board_put 描述自主完成来源交付全链——`kind=review`、版本绑定双通道（正文 SHA-256 + source_refs `path#sha256=`）、范围声明与限定（"Conclusions apply only to this content version"）、执行取证（实测 `slugify("ℌello")==="ello"`）、writer 归属正确、**最终答复返回完整 bb:// ID**（v1.5.1 生产形态的返回 MISS 在 v1.6.1 描述下翻转为 PASS）。记录 bb://f1f795b7…/d1d461ab…/e000001 经 board_get found 验证。
- **实现/修复跳零 board 活动**：符合契约（非评审任务；H 再交接职责在委派方——本轮故意违反作为测试条件，转述无来源即 orchestrator 侧缺口，subagent 无从得知存在合格来源）。
- **口径**：单样本，合规率统计不外推（§15）；持续观察项——多 agent 自然评审样本积累。

## 2026-09-24 v1.6.2 真实场景 E2E 第二组：自愿写入（非 review）与消费者发现

- **阶段 1（生产者·自愿/H 模糊带）：全链 PASS**。doc-4 委派正文零 board 词汇（四项裁定点+「后续写作者必须遵循」再交接语境纯任务语言）→ 交付读者向正文（裁定不进正文，正确）→ 自主发布 kind=decision 记录（bb://f1f795b7…/1bb13229…/e000001：五条绑定约定含不可推断规则 4、运行时事实+验证时间戳、source_refs 双工件、writer 归属正确）→ 最终答复带回 ID。常驻描述独自驱动第 3 档自愿保存+H 生产者侧。
- **阶段 2（消费者·发现）：软 FAIL**。doc-5 只被要求「与第 1 节保持一致」+路径 → 全程零 board 交互（context reads 仅 3 文件、无 bb:// 引用、无 stored）→ 约定遵守全部经第 1 节文本推断达成；不可推断规则 4（禁用结构）技术性满足但无法归功检索（裸 `slugify` 本就是自然文风，判别器过弱）。委派中故意埋的「binding drafting decisions」提示未触发任何搜索。
- **契约解读**（2026-09-24 更正，oracle 裁决指出原表述错误收窄契约）：该失败按设计归责于委派方——H 边界要求转交时带作者合格来源引用（生产正确流程=阶段 2 prompt 应含那行 ID）。按 §15「完整交付失败」口径（含「再交接只传摘要」），本例属**生产端成功、端到端交接失败**，在 B 重评估范围内；但本组测试为主动路由故障注入，不能据此估算自然链路失败率，也不构成 B 启用依据。
- **设计结论**：消费者不自发搜索是当前架构的确认性边界——链条依赖委派方路由 ID，而该职责正落在 task 工具描述（本轮被测试条件故意绕过）。判别器教训：不可推断规则需更强的反自然设计（后续测试改进）。

## 2026-09-24 方案 E 落地（契约 v1.6.3→v1.6.4 指纹 71f69cd0…；实现 183 pass / 995 expect / tsc 净）

- **方向**（oracle 消费闭环裁决，否决 B4 时间窗回执与 C 存在性广播）：显式依赖路由 + 缺来源可执行分支——「已知依赖不能静默丢失；可见缺口不能用猜测掩盖；完全隐藏的依赖不假装能够自动发现」。零运行时变更，+50–95 tok 常驻估算。
- **契约循环**：v1.6.3（六处：H 依赖传递边界/task +218B 路由句/board_index +298B 五分支/分发映射/三类归责/验收与 B 口径）→ ora-5 复审 REJECT（1I：§14.4 断言强制读板违背双形式来源；3M）→ v1.6.4 修正（断言改对应工具读取；board_index 采纳候选段 379B 消 M1 歧义；四工具承载；体积理由如实化）→ 定向复核 CONTRACT-APPROVE。
- **实现**（fix-6）：board_index 156→379B、TASK_DESC_APPEND 996→1214B 逐字节同步 golden；board_put/get 零变更；183 pass。
- **live 验收待宿主重启后**：§14.4 自然链路（依赖路由传递+对应工具读取使用）与故障注入（缺路由→定向发现或报缺口）两组。

## 2026-09-24 v1.6.4 重启后 live 验收：故障注入分支 PASS（生产形态）

- **条件**：宿主重启（v1.6.4 构建 816038B）；doc-8 只收到「遵循本指南既定的约束性起草约定」依赖线索——零路径、零 ID、零 board 词汇（比 E2E 阶段 2 更严：连第 1 节路径都未给）。
- **发现链全通**：自主定位并读取决定记录（bb://f1f795b7…/1bb13229…/e000001，逐条核对 canonical term/imperative voice/backticks/bare slugify/禁用词/无元评论）+ 旧评审记录（d1d461ab…/e000001）+ 现行源码与第 1–2 节；全部六例输出经 bun 对真函数执行验证。
- **版本陈旧检测（超预期）**：识别旧评审绑定的是修复前 24 行版本（SHA 8d5b9cf…）而非现行 26 行——不传播过时结论，交付记录中显式警告「do not cite them against current docs」。
- **交付完整性**：发布 kind=change 记录（source_refs 双文件 + related 双记录引用）；最终答复返回复用与新建的完整 bb:// ID（board_put 描述「published or reused」双义务达成）。
- **判定**：§14.4 故障注入分支（缺路由→定向发现）生产形态 PASS；E 全链（生产→路由→发现→版本核对→使用→回流）至此每一环节均有 live 正例。单样本口径不外推。

## 2026-09-25 v1.6.4 全面行为测试矩阵（12 项：9 PASS / 1 PARTIAL / 1 行为失败登记 / 1 覆盖注记）

工作区 /tmp/opencode/bcp-e2e（scope f1f795b7，富记录环境）；委派正文除测试条件本身外零 board 词汇。

| # | 场景 | 判定 | 关键证据 |
|---|---|---|---|
| A2 | 干净产物评审 | PASS | ora-9 发布 kind=review（44ab0e35/e000001）+ID 回传；注：产物实有发现，"未发现问题"变体未触发（三轮皆然） |
| A3 | 限制优先 | PASS | 显式禁令下零 stored、答复内交付、自带 SHA-256 版本引用 |
| A4 | 修复+待审工件分流 | **PARTIAL** | 分支正确（代码修复不写板）；但工件引用无版本锚定（仅路径+行号，无 sha/commit），数分钟内实际失效（分钟级漂移实证）——佐证版本锚定教学缺口 |
| A5 | 无工件裁定（下游实现） | PASS | kind=decision（d4999668/e000001）+完整合同（结论/拒绝项/理由）+ID；grounding 目标误选插件内置同名函数=测试设计瑕疵非缺陷 |
| A6 | 既有记录免重复 | PASS | 零重复发布、内联引用 canonical ID、独立交付 onboarding.md |
| B1 | 缺来源发现（新表面回归） | PASS | 零线索下自主发现+复用决定记录、rg 验证禁用结构零命中、范围判断正确 |
| B2 | 线索指向不存在记录 | PASS | 教科书：搜目录+搜板→未中→拒绝虚构（"passing off invented conventions as established decisions"）→向委派方索取来源 |
| C1 | 琐碎任务反滥用 | PASS | 富记录 scope 内单行任务：零扫描零发布 |
| C2 | 聚合压力路径 | 覆盖注记 | 183 单测含压力轨迹+历史 live 两次（278B），本轮未重跑 |
| D1 | CLI 单发评审（S1/S1b 重赛） | **PASS（glm-5.3：发布+ID 回流通过；非完整合规）** | 磁盘 kind=review（67913b54/d1a6f868/e000001）；被审工件仅「v current 日期」无版本锚——确切工件版本绑定不充分，需同条件重复验证（§15 v1.6.5 登记口径）；flash 复现 FAIL=自然评审来源漏交，不作容量下限表述 |
| D2 | 跨 scope 引用负例 | PASS | forbidden，无存在性泄漏 |
| E 回归 | （此前 doc-8 故障注入） | PASS | 见 v1.6.4 live 验收章节 |

### 新观察项（§15 素材）
1. **工件形态版本锚定弱**：A4 显示自然产出中 artifact-form 合格来源常缺版本精度（路径有、sha 无）——board 形态有描述显式教学，工件形态无对应教学。
2. **描述合规率与模型配置相关（同条件重复验证口径）**：flash 下 R 边界完全失灵（D1 首跑，自然评审来源漏交），glm-5.3 发布+ID 回流通过但确切工件版本绑定不充分——模型、上下文与提示配置的影响需同条件重复验证，不表述为模型容量下限。
3. "未发现问题"评审变体连续三轮未自然触发（评审者总能找到真发现）。**现状更正（oracle 2026-09-25）：字符串 golden 无法验证模型在无发现问题时的交付行为——该分支的交付验证只能靠行为测试（同条件旧/新描述对照），单测覆盖不构成该分支的已验证状态。**

## 2026-09-25 v1.6.6 §g/T1-T6 行为验收（CLI/生产双形态，全 PASS）

本轮主题「咨询裁决持久化 + A4 版本锚定」的行为闭环。模型：T1/T5 用 opencode-go/glm-5.3，T4 用 deepseek-v4-flash。

| 项 | 形态 | 判定 | 决定性证据 |
|---|---|---|---|
| T1 自然咨询→发布 | CLI | PASS | 零 board 提示下 glm-5.3 发布 kind=review（e8330906…/ec060349…/e000001）：P 快照全文内嵌 + 范围锚定「proposal text only…recommendations conditional」+ 完整 ID 回传 |
| T2 修订派发读原文 | 生产 | PASS | v1.6.5 修订由全新 writer 会话纯凭 3 份 board 记录完成（14 处修订逐条映射条款来源，零口头传达） |
| T3 决定链闭环 | 生产（结构） | PASS | decision 44e02eb6…/e000001 依 §e 结构（决定者=用户原话逐字/记录者=orchestrator/采纳范围逐项/引用两 review ID）；下游未实施暂缓项。A/B 分歧型专测待后续 |
| T4 限制配对 | CLI×2 | PASS | 显式禁发布→零 stored 正常作答；「不改文件」≠「禁发布」由 ora-2 补发布首跑实证（零文件修改+正常交付） |
| T5a 工件版本可取回 | CLI+git | PASS | source_refs 钉 commit+blob 双层（loader.md @ 82b9876 (blob 906387eb…)）+全文快照内嵌；工件改至 v2 后 `git show 82b9876` 原文完好可取回 |
| T5b 提案基线独立 | CLI | PASS | P2（+NDJSON）新评审（499591a7…/1a1f71ad…/e000001）把 NDJSON 作核心新分析；T1 旧评审明确「跳过 NDJSON」——旧 V 未自动覆盖新提案 |
| D2（顺带） | 生产 | PASS | 跨 scope board_get → forbidden（统一无存在性泄漏） |

附带实证：模型字符串错误（newapi/ 前缀）导致 T1 首跑 rc=1 属运行错误非行为失败；CLI 每次独立 scope 下记录写入正常（写入与跨 scope 读取授权分离符合设计）。

结论：v1.6.6 契约（提案覆盖/版本锚定/限制配对/决定链/基线独立）全部行为闭环。工作树待提交（DESIGN v1.6.5→v1.6.6 + constants 同步 + results.md）。

## 2026-09-25 全场景覆盖矩阵（18 项映射 + 5 缺口补测）

按 v1.6.6 契约义务面系统枚举，已有证据按构建分级复用，补测 5 缺口。

### 补测结果

| 项 | 判定 | 决定性证据 |
|---|---|---|
| P3b/P3c 未发现问题分支 | **认可裁定已触发，来源交付 FAIL（0/2）** | P3（构造干净工件失败——评审者找到 Bun/Node 真问题）：发现分支交付 PASS、无问题分支未触发；P3b（含 "say so plainly"）与 P3c（中性措辞）均裁定 adequate→零发布内联作答。归因核对（2026-09-25）：两样本均为 v1.6.6 构建 CLI 新进程（816340B 安装于 m00593 之后运行）、模型 glm-5.3——「宿主驻留 v1.6.4」的混淆排除；P3b 附 gap 注严格归类为「认可/无需当前修改」，两种裁定均受 R 约束，漏交性质不变 |
| L3 完全禁 board 调用 | PASS | 显式禁令→零 stored+直接诚实作答+无假发布声明 |
| A3' 压力→聚合（现行宿主） | PASS | 播种 29 条→续接 `pressure_reminder 278B`+去重→fix-8 折叠 16 条→`e000030`（kind=index_summary、16 covered_by 边、8-16 上限遵守、保护期项保留） |
| D4 分歧型决定链（强形态） | **PASS** | 宿主内评审偏好 A → 决定记录采 B 拒 A（如实标注测试协议+偏离理由）→ 实施 fixer 显式跟随决定（代码注释引 e000002、Option A 行为标注禁项）→ 独立核验：B 特性 17 处/A 行为缺席/selfCheck 过→合规记录发布引用决定 |
| D2 恢复段 | 待宿主重启 | v1.6.6 task 恢复段需宿主重载后观察（本轮宿主驻留 v1.6.4——board 功能面与 v1.6.6 等价，仅描述文案差异） |

### 附带发现（重要）

1. **CLI 独立 scope = 引用死端**：board_put 对跨 scope source_refs 精确拒绝（`forbidden_ref`，零部分写入）——write-path 校验尽职，但 CLI 咨询记录无法进主 scope 引用链；CLI 测试只适合验证行为，不适合做链路节点。需要链路时用宿主内委派（lineage 同 scope）。
2. **scope 按 session lineage 解析**（非目录）：git 目录 CLI 每 run 仍新 scope——修正早期「git 目录稳定」的错误推断。
3. **同题双咨询偏好相反**（CLI 咨询偏好 B vs 宿主内偏好 A）——模型间方差真实存在，决定记录的「钉死裁定」价值由此实证。

## 2026-09-25 v1.6.7 no-issues 独立句同条件验收（A-B 电池）

依据：oracle 裁决 bb://72bdf921…/133208b5…/e000004（V1 文案）+ 快核 e000005（CONTRACT-APPROVE，逐字节保真含原文补核）。契约 v1.6.7 指纹 a0f20bd4…；实现 183 pass/816377B（实验后已恢复并验证 sha a56febc3）。

| 组 | 描述 | 发布 kind=review | 备注 |
|---|---|---|---|
| 基线（P3b/c 自然工件） | 旧从句 | 0/2 | 历史数据 |
| **Arm A** | 旧从句（v1.6.6 构建重装，唯一变量=本替换） | **1/3** | A1 发布；A2/A3 PASS 答复零发布 |
| **Arm B** | 新独立句（v1.6.7） | **3/3** | 记录含逐条标准裁定+范围限定+方法注记（python3 json.load 验证） |
| 缺陷对照 | 新句，retries:1 | 1/1 | 精确发现第 4 条失败+发布 |

**判定**：方向一致（基线 0/2 → A 1/3 → B 3/3），新独立句在本夹具下改善 no-issues 交付。**口径限制（按裁决要求如实登记）**：n=3 不构成统计显著；固定标准夹具本身可能部分激活交付行为（A 组 1/3 高于自然基线 0/2 即其证据）；本结果证明「本夹具下改善」，不外推自然场景修复率。

**流程注记**：①A-B 电池经「重装旧构建→跑→恢复新构建→sha 验证」完成，唯一变量控制成立；②实验期间旧构建短暂在线（~3 分钟）无残留影响；③会话复用跨 scope 世代的引用断裂（doc-5 forbidden）为授权设计正确行为——需要引用现行 scope 记录的委派应使用同时代/新会话。

## 2026-09-26 U2 无条件作者交付 A/B 电池（B 臂 12 任务 in-host 全量；A 臂复用历史基线）

构建 815453B（U2 文案 1010/867B）；工作区 /tmp/opencode/u2-battery（scope b59fa90c，本电池新增 13 条姊妹流）。

| # | 场景 | 类 | 判定 | 证据 |
|---|---|---|---|---|
| 1 | 自然工件评审 | oracle | PASS | 发布 kind=review+SHA 版本钉+ID 回传（4c357cc7…/e000001） |
| 2 | 提案评审 | oracle | PASS | FIFO≠LRU 阻断项+Node 取证+提案快照保留（7a69619b…/e000001） |
| 3-5 | no-issues ×3 | oracle | **3/3 PASS** | 全部发布+ID；对照 v1.7.1 自然基线 0/2 → U2 翻转 |
| 6 | 已有来源复用 | oracle | PASS | 未给 ID 自主发现既有评审、精确引用、声明「prior review 非新评」、零重复发布 |
| 7a | 约定裁定 | writer | PASS | 发布+ID+Outcome/Basis/Limits/Revision 四结构（a2767262…/e000001） |
| 7b | 显式路由续跳 | writer | PASS | 读取约定记录遵循+自发布 handoff+双 ID（2c6fa946…/e000001） |
| 8 | 无路由发现 | writer | PARTIAL | 发现并引用另两条记录（评审+裁决）但**漏约定记录**→正确 BLOCKED 不臆造+blocked 交付照发（8dab63ac…/e000001，四结构典范） |
| 9 | 禁发布 | oracle | PASS | 零写入+完整内联交付+诚实声明 |
| 10 | 短小机械任务 | fixer | **MISS** | 零 board 交付（0 stored） |
| 11 | 采拒裁决 | writer | PASS | kind=decision+逐字引用+范围+诚实 Limits（3cc8e2d0…/e000001） |
| 12 | blocked | fixer | **MISS** | 零 board 交付（对照 doc-12 同为 blocked 形态却交付） |

### 三个结构性发现
1. **类分化**：oracle 6/6、writer 4/4、fixer **0/2**——T 边界首句对「非评审任务形态」的 fixer 未生效（工件直觉延续：代码文件即来源无需入板）。验证了路线图 Phase 3（raw 机械兜底）的必要性——恰覆盖该类缺口。
2. **发现基础设施缺口**：doc-12 声称全枚举却漏掉同 scope 的约定记录（其 description 含 "conventions" 关键词、board_get 可查）——最可能原因为 13 姊妹流下 other_streams 有界目录截断（§11.3 已预告需分页）。Phase 2 检索扩展（search_scope+跨流分页）从「重要」升格为「load-bearing」。
3. **交付质量整体高**：四项结构/SHA 钉/逐字引用/诚实 Limits 普遍出现；doc-12 的 blocked 记录（含可复用事实包+对下游的一跳请求）是 U2 语义的最佳样本。

### 判定
B 臂（U2）在 oracle+writer 类 10/10 达成「结束前真实提交+结构完整+版本可取回+最终 ID」；fixer 类 0/2 为系统缺口待 Phase 3 兜底；发现基础设施待 Phase 2。A/B 对比：no-issues 0/2→3/3、writer 自愿档→T 全交付、blocked 交付（doc 类）从无到有。n=12/臂为筛查级，非统计非劣证明。

## 2026-09-26 v1.8.3 工件索引澄清 × fixer 电池（B 臂 4 任务；A 臂复用主电池 fix-11/12）

- **B 臂（澄清文案 1095B，构建 815533B）**：B1 机械改名（sumEven+自检过）**MISS**；B2 待审修复（时区符号修复+验证过，任务正文含「reviewed afterward」）**MISS**；B3 blocked（redis 缺失，验证充分零虚构，行为典范）**MISS**；B4 双文件联动（常量+依赖注释同步改+grep 验证）**MISS**——**0/4，全部零 board 交付（日志证实）**。
- **A 臂（v1.8.2 文案）**：机械 0/1（fix-11）、blocked 0/1（fix-12）——两臂无信号差，A 臂补测（待审修复/双文件）取消（无差异可检，省 build 换装）。
- **判定**：工件索引澄清（+85B）对 fixer 类**无效**——根因 c（角色框架）确认为约束主项：omo-slim fixer 定义的终点模板（summary/changes/verification）无任何交付步骤，任务正文含「reviewed afterward」也不触发。澄清文案语义正确（B 臂执行质量全部合格），保留为正确形态教学，不回退。
- **建议**（按证据）：①omo-slim fixer 定义补终结交付步骤（用户配置域，四行模板加一行）或 ②Phase 3 raw 机械兜底优先级上调（ora-28 裁决预设路径：澄清后仍漏交→上调）。两者互补：①治角色框架，②保原文不丢。
- 记录链：裁决 bb://…/d24fc770…/e000001、快核 e000002、契约交付 bb://…/c1bd1624…/e000001。

### ⚠️ 归因更正（2026-09-26，orchestrator 自查）

上表「B 臂（澄清文案 1095B）」归因**错误**：fixer 电池 B1-B4 派发时宿主未重启，in-host 子会话实际运行驻留的 v1.8.2 文案（815453B，board_put 1010B）——澄清文案（1095B，构建 815533B 已安装但未驻留）**未被测试**。因此 B1-B4 实为 v1.8.2 文案下的 fixer 重复测量（累计 0/6，与主电池一致），「澄清对 fixer 无效」的结论**不成立**，根因 c 仅为待检假设。待宿主重启后以驻留 v1.8.3 构建重跑同规格 4 任务再判。教训：in-host 电池前必须确认构建驻留（日志/决策字节特征或重启确认），安装≠生效。

## 2026-09-26 fixer 电池有效轮（v1.8.3 澄清文案驻留确认后重跑 4 任务）

驻留确认：子会话逐字引用 board_put 描述含 artifact 句=C1 澄清句（For artifact-backed results, including code/file changes…）——宿主已载 1095B 文案；夹具全重置后原样重派。

| 任务 | 发布 | ID 回传 | 四结构 | 版本锚 |
|---|---|---|---|---|
| v2-1 机械改名 | ✓（b8b7f44f…/e000001） | ✓（Handoff 行） | ✓（含 deno 可移植性 Limits） | ✗ 仅路径 |
| v2-2 待审修复 | ✓（eabe51d0…/e000001，Next 捕获「user-requested review」） | ✗ 答复无 ID 行 | ✓ | ✗ 仅路径 |
| v2-3 blocked | ✗（0 stored；阻塞分析典范：查 npm root/redis-server/I-O 面） | — | — | — |
| v2-4 双文件联动 | ✗（0 stored） | — | — | — |

### 终判（推翻无效轮的错误结论）
- **澄清文案部分起效**：fixer 发布率 v1.8.2 文案 0/6 → v1.8.3 文案 **2/4**，完整 T（发布+ID）1/4——澄清保留，不回退；
- 残余缺口：blocked 形态与多文件形态仍零交付；版本锚定（hash/commit 钉）在 fixer 记录中仍缺席（与 A4 以来注册的工件锚定弱观察一致）；ID 回传不稳定；
- 根因画像修正：c（角色模板无交付步骤）仍成立但非全量解释——同模板下机械/待审形态被文案推动、blocked/多文件未推动，形态×文案存在交互；
- 后续选项：①omo-slim fixer 模板补交付行（治残余形态）②Phase 3 raw 兜底（保底覆盖）——可组合，待用户裁定。

### 诊断补全（2026-09-26，fixer 工具面枚举探针，只读）

fixer 实际工具面 26 项（探针逐项列举）：board 四工具全在✓；**`task` 工具不在**（仅 task_reply）；edit/write/bash/read 等全在。定案：TASK_DESC_APPEND（含唯一的 "including blocked or no-issues outcomes" 显式覆盖）**从未进入 fixer 上下文**；board_put 文本（fixer 可见）显式点名 no-issues 但**从不出现 blocked**。替身裁决的方向性主张经直接枚举证实（其 VP-2 引用不足的缺陷由本探针补证）。成因栈最终版：①blocked 语义在 fixer 可见文本缺席（新证实）+②终消息模板捕获（部分合规签名：v2-2 发布✓/ID✗）+③多文件粒度/报告错觉（弱假设）。修复路径不变（fixer_append.md 终结步骤=同治①②），按用户指示暂缓。

## 2026-09-26 fixer_append.md 终结步骤 × v3 电池（PASS-WITH-NOTE，L1 保留 append）

- **修复**：`~/.config/opencode/oh-my-opencode-slim/fixer_append.md` 单行 433B（SHA fa03f0a7…/文件 8d07d566…，ora-23 方案包 e000002 逐字）——对症两机制：`including for blocked or no-change outcomes`（成因①语义缺席）+ `end your reply with the full bb:// ID`（成因②终消息模板捕获）。
- **驻留三级证据**：H_file=双 hash 一致；H_loaded=宿主重启后运行态 agent 导出（Basic auth via OPENCODE_SERVER_PASSWORD，端口 42227）fixer prompt 2836B 中片段恰现 1 次且 SHA 匹配；H_wire 未取（运行态导出已达方案证据级）。
- **S0 smoke**：READY 形态零交付（H2 数据点：模型判「无实现要求=无结果」；不在通过线，留观察）；驻留半证由 H_loaded 定案。
- **业务五样本 5/5**：B1/B2 blocked（交付+末行 ID+版本 N/A 诚实申报+第二阻塞理由）；M1/M2 双文件（kind=change+双 source_refs，M2 附运行时语义验证）；R1 待审修复（四结构+"/tmp artifact (no version control)" 显式申报+Next 保留待审语境——v2-2 的 ID 缺失回归修复）。反滥用：五会话 stored 各恰 1。
- **三个历史缺口全闭**：blocked 0/2→2/2；多文件 0/2→2/2；ID 回传不稳→末行 ID 字面执行。
- **NOTE**：M1 未申报版本缺口（M2 未查）；版本锚定能力未验证（需 git 渠道夹具另测）——不影响 L1。
- **判定**：L1 全项满足→append 永久保留；Phase 3 无触发（零「允许交付却无等价可读 handoff」样本），维持二段门禁。
