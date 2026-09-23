# Phase A live 观察协议（Task 1）

探针：`harness/scratch/.opencode/plugin/bb-probe.ts`（只注入唯一标识并留证据，不做 board 逻辑）。
证据按 run 归档：`~/.cache/opencode/blackboard-probe/evidence-<run>.jsonl` → 复制到 `harness/runs/evidence-<run>.jsonl`，不删共享证据。

**执行状态：Step 0–10 全部完成（2026-09-23）。P0 判定：通过（三问全部"是"）。无闸门触发，不升级。**

## ① 运行协议（Step 3–10 命令原样收录）

### Step 0: 常驻宿主与 SDK 通道准备

```bash
RUNS=/home/littlekey/github/opencode-bcp/harness/runs; mkdir -p $RUNS
mkdir -p ~/github/opencode-bcp/harness/scratch
cd ~/github/opencode-bcp/harness/scratch
opencode serve --port 4599 > $RUNS/serve.log 2>&1 & echo $! > $RUNS/serve.pid
sleep 1; kill -0 $(cat $RUNS/serve.pid) && rg -c 'listening|http://localhost:4599' $RUNS/serve.log
bun -e 'const {createOpencodeClient} = await import("@opencode-ai/sdk"); const c = createOpencodeClient({baseUrl: "http://localhost:4599"}); const r = await c.session.get({path: {id: "ses_probe"}}); console.log("sdk-ok", JSON.stringify(r.data ?? r.error))'
```

预期：serve 进程存活（`kill -0` 通过）、serve.log 出现监听行、SDK 调用返回结构化响应（`sdk-ok` + JSON）。

**实际执行记录**：
- serve 存活、监听行确认；SDK 通道返回 `sdk-ok {}`（通道可达）。
- 偏差 D1：opencode 1.18.31 的 serve 对 HTTP 强制 Basic 认证（realm "Secure Area"，用户名固定 `opencode`，密码取进程 env `OPENCODE_SERVER_PASSWORD`）。初始 serve 无该 env，直连 HTTP/SDK 一律 401。后以 `OPENCODE_SERVER_PASSWORD=probe42` 重启 serve（`harness/runs/serve.pid` 已更新）；SDK 侧需显式 `headers: {Authorization: "Basic ..."}`（`createOpencodeClient` 无 username/password 参数）。
- 偏差 D2：为使 serve 侧请求（R5a/R5b 的 SDK 驱动）能加载探针，serve 最终以 cwd=`harness/scratch` 启动（与 CLI 运行同目录），R5a 证据含 `plugin-init` 行证实 serve 侧插件加载成功。R5a/R5b 各以 serve 进程 env `BB_PROBE_RUN=r5a|r5b` 独立归档。

### Step 4: R1（注入可见性 + admission/请求身份观测）

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

预期：恰 1 个标记回显；`chat.message` user 行计数 = 1；transform 行按 `lastMsgId` 去重后每个身份恰 1 行。

**实际执行记录（P0/P1 按 3/3 重跑协议：R1 共跑 3 次，tag = r1a / r1b / r1c）**：

| run | 回显 marker（恰 1 个） | chat.message user 计数 | transform 去重后计数 | 变体 |
|---|---|---|---|---|
| r1a | BB-PROBE-AY5O9K | 1 | 1（lastMsgId 恰 1 行） | append-part, inCount=1 |
| r1b | BB-PROBE-O2JUES | 1 | 1 | 同上 |
| r1c | BB-PROBE-IJHQZI | 1 | 1 | 同上 |

3/3 一致。`r1*.err` 仅 INFO/WARN（无插件 error 行）。

### Step 5: R2（`--pure` 对照）

```bash
opencode run --pure -m newapi/deepseek-v4-flash "$(cat ../prompts/probe-echo.txt)" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r2.json 2> /home/littlekey/github/opencode-bcp/harness/runs/r2.err
rg -o "BB-PROBE-[A-Z0-9]+" /home/littlekey/github/opencode-bcp/harness/runs/r2.json || echo "NO-MARKER"
```

预期：`NO-MARKER`。若仍出现 marker → 记录"`--pure` 不禁用本地目录插件"，改用删除探针文件对照法重跑（预期 `NO-MARKER`，之后恢复探针文件），并在结论表注明对照方式。

**实际执行记录（偏差 D3）**：`--pure` 运行本身在本宿主报错：`{"type":"error",...,"UnknownError","data":{"message":"Unexpected server error. Check server logs for details."}}`（×2/2，见 `harness/runs/r2.json`/`r2.err`）→ 对照为空洞（无法判 marker 有无）。按计划既定替代对照法执行：`rm harness/scratch/.opencode/plugin/bb-probe.ts` → 重跑（无 `--pure`）→ `NO-MARKER`（exit=0）→ 从备份 `/tmp/opencode/bb-probe.ts.bak` 恢复探针。**对照方式 = 删除探针文件法**；结论：注入确来自项目插件路径。

### Step 6: R3（子会话不串流）

```bash
export BB_PROBE_RUN=r3
opencode run -m newapi/deepseek-v4-flash --title bb-spike-r3 "$(cat ../prompts/probe-parent.txt)" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r3.json 2> /home/littlekey/github/opencode-bcp/harness/runs/r3.err
cp ~/.cache/opencode/blackboard-probe/evidence-r3.jsonl /home/littlekey/github/opencode-bcp/harness/runs/evidence-r3.jsonl
rg -o '"sessionID":"ses_[A-Za-z0-9]+"' /home/littlekey/github/opencode-bcp/harness/runs/evidence-r3.jsonl | sort -u
rg '"hook":"transform"' /home/littlekey/github/opencode-bcp/harness/runs/evidence-r3.jsonl | rg -o '"sessionID":"[^"]+"|"marker":"[^"]+"' | sort
```

预期：≥2 个不同 `ses_` sessionID；父子 marker 集合不相交；子回复含 `child-ok` 且无父 marker。

**实际执行记录**：父 `ses_f3409207cffeDm8jfUN170zN7B`（marker BB-PROBE-70ZN7B）、子 `ses_f3408b8c4ffeSPxo0bh4nLP8gk`（marker BB-PROBE-NLP8GK，经 `task` 工具派出，subagent_type=build）。4 行 transform（父 2 请求 / 子 2 请求），每会话只绑定自己的 marker；子回复 = `child-ok` + 子 marker，无父 marker。父第 2 请求 lastMsgId 出现合成后缀 `-background-job-board`。

### Step 7: A-C3/A-C5/A-C7/A-C8

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
cd /tmp/opencode && opencode run -m newapi/deepseek-v4-flash "回答 OK 即可，不要调用工具。" --format json > /home/littlekey/github/opencode-bcp/harness/runs/r4js.json 2> /home/littlekey/github/opencode-bcp/harness/runs/r4js.err
rg -c '"hook":"transform"' ~/.cache/opencode/blackboard-probe/evidence-r4js.jsonl || echo "JS-NOT-SCANNED"
rg -o '"type":"[a-z._]+"' ~/.cache/opencode/blackboard-probe/evidence-r4.jsonl | sort | uniq -c | sort -rn | head -20
rg -o '"sessionID":"[^"]*"' /home/littlekey/github/opencode-bcp/harness/runs/r1.json | sort -u | head -3 || echo "CLI-NO-SESSION-ID"
rm -f ~/.config/opencode/plugin/bb-probe.ts ~/.config/opencode/plugin/bb-probe-js.js
```

预期：transform 计数 >0 → 全局目录被扫描且 `*.ts` 生效；`JS-NOT-SCANNED` → `*.js` 不生效；`GLOBAL-NOT-SCANNED` → Task 7 默认按项目安装。两份全局副本验证后删除，不残留。

**实际执行记录**：`GLOBAL-NOT-SCANNED` 未出现（evidence-r4 transform 计数 = 1，从 /tmp/opencode 运行、探针仅在全局目录 → 全局扫描 + `*.ts` 生效）；`JS-NOT-SCANNED` 出现（evidence-r4js.jsonl 从未创建，`r4js.err` 0 字节 → `*.js` 被静默忽略，非加载报错）。event type 清单含 `session.created`/`session.updated`/`message.updated`/`message.part.updated`/`message.part.delta`/`session.diff`/`session.idle` 等；`session.created` 载荷含 `parentID` 字段（A-C5 事件侧）。A-C7：`r1a.json` 恰含 1 个 `sessionID` → CLI 事件携带 sessionID。两份全局副本已 `rm`，`~/.config/opencode/plugin/` 验证为空。

### Step 8: R5–R7（负向与反例构造）

| 运行 | 构造方法 | 观察量 |
|---|---|---|
| R5a noReply | 经 Step 0 常驻宿主（`--attach http://localhost:4599`）以 `@opencode-ai/sdk` `session.prompt` 携带 noReply 发送 | `chat.message`(user) 行出现而无后续 transform 行 → P0 通过证据（"接收"与"实际 admission"可区分）；通道不可用/SDK 形态不符 → unknown，按 Step 9 闸门 |
| R5b running | 同一常驻宿主 `--attach` 共享 runner：先发长任务占住 runner，再发短消息 | 记录真实结果 ∈ {排队执行, 仅等待现有 runner, unknown}，不预设 |
| R6 重复 hook / 跨请求历史复用 | 单次 run 内 transform 行数 vs requestId 去重数对比；R3 父子两请求 + R5b 第二条消息，比对不同请求是否取同一历史值 | 重复 hook 次数（合法，去重后 1 次有效机会）；跨请求同 id 反例（存在 → 该观察量不能作请求身份） |
| R7 compaction | 长会话续写（`-s` 会话追加长文本多次）尝试自然触发 compaction；无法构造则记 unknown | 触发与否；触发时 continuation 消息字段特征（A-C6）；unknown → A-C6 维持假设并按 P0 闸门规则 |

反例未观察到 ≠ 反例不存在（P16）。每项独立 `BB_PROBE_RUN=<tag>` 归档到 `harness/runs/`。

**实际执行记录**：
- **R5a（evidence-r5a.jsonl）**：SDK `session.prompt(body.noReply=true)` 对常驻宿主发送成功（797ms 返回 user message info）。证据：`chat.message` user 行 :4 存在，**transform 行 0 条**（全文件仅 7 行）→ ①"接收"与"实际 admission"可区分 = 通过证据。
- **R5b（evidence-r5b.jsonl）**：会话 A（长任务 8000 字作文）02:09:50.182 发出（chat.message :5，transform :14）；3 秒后会话 B（短消息）02:09:53.096 发出（chat.message :53，transform :74）。B 于 ~9.9s 完成、A 于 ~100.9s 完成 → **B 在 A 运行期间被 admission 并执行**。真实结果 = **立即执行（未等待现有 runner；跨会话并发）**。
- **R6**：全部 7 个 evidence 文件合计 10 个 `(sessionID,lastMsgId)` 对，**全部唯一**（编程比对：重复对 = NONE）。同请求多次 transform 一次未出现（0 次；去重按设计兜底）。跨请求同 id 反例**未观察到**；补充观察：R3 父#2 的 lastMsgId 带合成后缀 `-background-job-board`，R7 压缩轮出现合成 id `msg_dcp_summary_*` → lastMsgId 语义 = "该请求最后一条消息 id"（可能为合成值），须按 transform 原样取值、不可自行重建。
- **R7（evidence-r7.jsonl + r7-t1..t11）**：会话 `ses_f33f5773bffe4jm5DvJnpKkvUW` 续写 10 轮长文本（24K~30K 汉字/轮）。上下文峰值 ~223K tokens（input+cache.read）；**自然触发 compaction**：后一请求 transform `lastMsgId = msg_dcp_summary_3a383bf5116bbbb3`（合成 id，:1757），下一请求 `inCount` 由 20 塌缩至 7（:3184）；`message.list` 存储的 21 条消息中**无** dcp_summary id → 合成消息只存在于请求载荷，不落盘；压缩后 marker 注入仍然生效（`injected:true`）。偏差 D4：单轮 12 万汉字 inline prompt 因 OS 单参数上限（MAX_ARG_STRLEN 128KB）失败（`r7-t7.err`，exit 127），改为 4×3 万字轮次（t8–t11）达成。

### Step 9: admission 三身份判定（P4 闸门检查点）

三方关联 R1/R3 的 `chat.message` 行（admission 候选）、`messageID`/`messageId`（业务输入身份）、`transform` 行（模型请求身份观察量）与 R5–R7 反例证据：

- ① **"接收"与"实际 admission"能否区分**——R5a noReply 消息有 `chat.message`(user) 行而无 transform 行 = 通过证据。
- ② **`(sessionID,lastMsgId)` 派生身份是否可用**——同请求多次 transform 属预期（去重即为此设）；**跨不同请求取同一历史值**才算不稳定（存在即不可用）。
- ③ **能否从宿主字段（非内容正则）识别"该 user 消息已实际进入 runner 处理"**。

三问全部"是"→ P0 通过；任一"否"或"unknown" → **停止后续任务**，向父级提交 P4 闸门升级，登记"降级-未满足"，不得用内容正则宣布可靠。

**实际判定：① = 是；② = 是；③ = 是 → P0 通过，闸门未触发。**
- ① = **是**：R5a 实证（`chat.message` 有 / transform 无，evidence-r5a.jsonl:4）。
- ② = **是**：10 个 (sessionID,lastMsgId) 对全唯一、零跨请求复用；合成值（后缀/`msg_dcp_summary_*`）按原样取值即可，不构成跨请求同 id。
- ③ = **是**：`chat.message.messageId`（宿主字段）与 transform 行 lastMsgId/firstMsgId 在正常请求上一致（r1a：messageId == lastMsgId；r3 双会话同构）→ 非内容正则、纯宿主字段可判定"已进入 runner 请求"。

### Step 10: 回填结论与判据判定

把 A-C1…A-C8 与 P0–P5 判定写入本文件下述表格；P0 或任一 P 项失败按其"失败动作"处理。**已回填，见 ②③④。**

## ② 通过/失败判据 P0–P5（判定记录）

| 判据 | 通过标准 | 失败动作 | 判定 |
|---|---|---|---|
| P0 三身份可观测 | Step 9 三问全部"是"，3/3 次重跑一致 | 触发父级 P4 闸门，登记"降级-未满足" | **PASS**——三问全部"是"（见 Step 9 判定）；R1 3/3 一致（r1a/r1b/r1c） |
| P1 注入可见 | R1 回复含 marker，原地 parts 追加形态，3/3 次重跑一致 | transform 路径证伪 → 升级父级（§15 注入竞争） | **PASS**——3/3 回显各自唯一 marker（r1a.json:2；r1b/r1c 同构）；transform variant=`append-part`、`injected:true`（evidence-r1a.jsonl:10）；R7 压缩后注入仍生效 |
| P2 请求身份 | 同一 `(sessionID,lastMsgId)` 的 transform 行去重后恰 1 次有效提醒机会；与 chat.message 的对应关系已记录 | 请求身份不可用 → 触发 P0 闸门（父级 P1） | **PASS**——每对恰 1 行（R1×3 各 1；R3 4 行 4 对）；对应关系：`chat.message.messageId` == 初始请求 transform `lastMsgId`（evidence-r1a.jsonl:4↔:10；evidence-r3.jsonl:4↔:10、:872↔:882） |
| P3 子会话隔离 | R3 中父子 marker 不相交、子回复无父 marker（以探针 evidence 为准） | 串流 → 升级父级（RF2） | **PASS**——父子 marker 集合不相交（evidence-r3.jsonl:10/:882/:924/:1009 各绑定自己的 marker）；子回复仅 `child-ok` + 子 marker（r3.json:6），无父 marker |
| P4 无风暴/无新回合 | 单运行 user 消息 admission 计数 = 1（evidence）；transform 去重后每请求 ≤1 次有效提醒 | 出现自增回合 → 升级父级（RF9） | **PASS**——R1×3 user admission 均 = 1；全 7 个 run 的注入未产生额外 user admission（R3 2 条 = 父+子各 1，R7 10 条 = 10 轮 CLI 输入各 1）；每请求 transform 去重后 ≤1 |
| P5 ACP 共存 | `r1.err`/`r3.err` 无任一插件的 error 行；marker 可见；ACP 功能观察正常 | 冲突 → 记录顺序观察并升级父级 | **PASS**——r1a/b/c.err 仅 INFO/WARN（WARN 为既有 paseo-plugin skill 重名警告，与插件无关）、r3.err/r4.err 0 字节；marker 可见；task 子代理、SDK、CLI 功能观察正常。（仅"无错误+共存观察"，不宣称语义兼容证明） |

假设升级判据：A1 hook 到达 = P1；A2 身份可信 = P3 且 `chat.message` 的 agent 字段与宿主会话一致；A3 轮次识别 = P0 + P4（compaction 样本不可观测 → 记 unknown 并按 P0 闸门规则处理；重复 hook 属预期——P19）；A4 原子性/锁 = Task 2/6 测试与 lockcheck 通过；A5 权限验证 = Task 6 L6 通过。

## ③ Phase A 结论表（A-C1…A-C8 + §13.1 假设升级）

| # | 问题 | 结论 | 证据（file:line） | §13.1 假设升级 |
|---|---|---|---|---|
| A-C1 | 原地向最后一条 user message 的 parts 追加 text part 是否出现在 outgoing 请求 | **已验证**——append-part 注入出现在 outgoing 请求且模型可见（回显），3/3 一致 | harness/runs/evidence-r1a.jsonl:10（transform variant=append-part injected=true）；harness/runs/r1a.json:2（回显） | **A1 hook 覆盖与注入到达：已验证**（A1 = P1，P1 PASS） |
| A-C2 | transform 行的 `(sessionID,lastMsgId)` 在同请求多次调用中是否稳定、与 `chat.message` 的对应关系 | **已验证（含口径备注）**——同请求零重复（10 对全唯一）；初始请求 `chat.message.messageId` == transform `lastMsgId`；lastMsgId 可为合成值（父#2 后缀 `-background-job-board`；R7 `msg_dcp_summary_*`），须按 transform 原样取值 | harness/runs/evidence-r1a.jsonl:4↔:10；evidence-r3.jsonl:4↔:10、:872↔:882、:924、:1009；evidence-r7.jsonl:1757 | **A2 身份可信度：已验证**（A2 = P3 PASS + agent 字段一致：child `chat.message.agent=build` == `session.get.agent=build`；备注：CLI 首条 admission 的 `inp.messageID/agent` 为 null，取值以 transform 为准） |
| A-C3 | 全局 `~/.config/opencode/plugin/` 是否被扫描、扫描范围是否含 `*.js` | **已验证**——全局目录被扫描，`*.ts` 生效；`*.js` 不生效（静默忽略，无报错）。Task 7 默认全局安装可行但须交付 `.ts` | harness/runs/evidence-r4.jsonl:10（从 /tmp/opencode 运行、探针仅在全局目录仍触发）；harness/runs/r4js.err（0 字节）+ evidence-r4js.jsonl 不存在 | — |
| A-C4 | title/compaction 等内部会话的识别特征与 agent 名单 | **已验证**——task 派生的子会话：`session.get.parentID` 指向父会话、`agent=build`、title 带 `(@build subagent)` 后缀；CLI 运行会话 agent=`orchestrator`。合成身份补充：R3 父#2 lastMsgId 后缀 `-background-job-board`（后台任务派生请求）、R7 `msg_dcp_summary_*`（压缩续写） | harness/runs/evidence-r3.jsonl:872（child agent=build）；serve HTTP `GET /session/<child>` → `parentID`+`agent:"build"`+`title:"Probe child reply (@build subagent)"`；evidence-r3.jsonl:1009；evidence-r7.jsonl:1757 | — |
| A-C5 | `client.session.get({path:{id}})` 异步返回中的 parent 字段名 | **已验证（宿主侧）**——字段名 = `parentID`（子会话指向父 sessionID；顶层会话 parentID=null）。SDK v1.18.32 包装层 `.data` 取值为空（形态不符）→ 按计划 SDK 调用形态复核留待 Task 5 编码时执行 | serve HTTP `GET /session/ses_f3408b8c4ffe…` → `"parentID":"ses_f3409207cffe…"`；harness/runs/evidence-r3.jsonl（session.created 事件载荷含 `parentID`）；父会话 parentID=null | — |
| A-C6 | compaction continuation 消息的宿主侧确定特征 | **已验证（初版样本）**——自然触发于 ~223K tokens；特征：① transform 载荷出现合成 id `msg_dcp_summary_<40hex>`（不落盘，`message.list` 无此 id）；② 请求内消息数塌缩（inCount 20→7）；③ `firstMsgId` 不变（仍为会话首条 user msg）；④ 压缩后注入仍生效。运行时保留"不匹配也不增轮"保守规则 | harness/runs/evidence-r7.jsonl:1757（msg_dcp_summary_*）、:3184（inCount=7）；会话 `ses_f33f5773bffe4jm5DvJnpKkvUW` message.list（21 条，无 dcp id） | **A3 轮次识别跨压缩/重启稳定：已验证（压缩侧样本已取得；重启侧未采样）**（A3 = P0+P4 均 PASS；运行时保守规则保留） |
| A-C7 | `opencode run --format json` 的 CLI 事件是否携带 sessionID | **已验证**——CLI json 事件携带 sessionID（r1a.json 恰 1 个 ses_ id；r3.json 事件含父 sessionID） | harness/runs/r1a.json:2；harness/runs/r3.json:3/:6 | — |
| A-C8 | 宿主是否暴露 review 范围/角色语义 API | **已验证（否定）**——完整 event 记录（session.*/message.* 全型）与 SDK 类型中均无 review 范围/角色语义 → 权限来源即 Global Constraints #6 所列三者 | harness/runs/evidence-r4.jsonl（event 全型清单）；`@opencode-ai/sdk@1.18.32` types.gen.d.ts（无 review/scope 相关字段） | **A5 工具侧 scope/权限验证能力：维持假设**（A5 = Task 6 L6，非 Phase A 可判） |
| — | — | — | — | **A4 持久化原子性与跨进程锁：待验证**（判据 A4 = Task 2/6 测试 + lockcheck，非 Phase A 范围，维持原状） |

**R5–R7 反例结论附注**：R5a hook≠admission 差值实证（有 chat.message 无 transform）；R6 同请求重复 hook 0 次（合法形态、去重兜底），跨请求同 id 反例未观察到——`(sessionID,lastMsgId)` 是目前唯一稳定的请求身份观察量；R7 compaction 特征见 A-C6。反例未观察到 ≠ 反例不存在（P16）：运行时身份判定始终以 transform 原值为准并保留去重与"不匹配不增轮"兜底。

**执行偏差汇总**：D1 serve 强制 Basic 认证（需 `OPENCODE_SERVER_PASSWORD`，SDK 需显式 Authorization 头）；D2 serve 以 cwd=harness/scratch 重启以加载探针（R5a/R5b 按 serve env tag 归档）；D3 `--pure` 在本宿主报 UnknownError → 对照改用"删除探针文件法"（计划既定替代）；D4 R7 单轮 12 万字 inline prompt 超 OS 单参数上限 → 拆为多轮；D5 探针 logger 由并发不安全的 `Bun.write(append)` 改为 `appendFileSync`（Phase A 偏差修正，已在源码注释标注）；D6 R1 按 3/3 协议拆为 r1a/r1b/r1c 归档；D7 `evidence-r4js.jsonl` 不存在（JS 探针从未触发，无物可归档）。

## ④ Phase A 失败时的父级升级记录

（P0/P4 闸门触发即填写"降级-未满足"范围建议）

| 字段 | 内容 |
|---|---|
| 触发判据 | 未触发（P0 三问全部"是"，P0–P5 全部 PASS） |
| 降级-未满足范围建议 | —（无需降级） |
| 时间 | 2026-09-23（Phase A 完成） |
