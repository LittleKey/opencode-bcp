# BCP v1.20 编排集成（交付引用回执与 Council 宿主原文装配）

> 版本说明：v1.20 在 [v1.19 目录发现契约](catalog-discovery-v1.19.md) 基线上新增两项 v1 宿主核验能力：交付引用回执（`result_reference`）与 Council 宿主原文装配（`council.v1` 桥）。本文只写稳定契约、适用范围与限制；设计来源为决策记录 bb://c233777e-dafa-4e6a-b3df-8d8d09578292/3430e3ff-f2ca-4d18-a34a-7feb05b10ec7/e000053，首审记录 bb://c233777e-dafa-4e6a-b3df-8d8d09578292/56aafa31-cc4f-4a63-8c7a-c15e2c17163f/e000001（REJECT，两项阻塞：多席位并发新鲜度、显式别名静默丢弃）。两项阻塞已修复，并经独立首轮复审 PASS（bb://c233777e-dafa-4e6a-b3df-8d8d09578292/84f0cb7d-933f-440f-bfd7-eac18ad82a9c/e000001，仅覆盖两项原阻塞、实际修正增量及受影响边界，不重开其他设计或验收范围）；完整验收记录由主角色另行编写并链接。

## 范围与前提

- 适用对象：OpenCode v1 宿主适配（`src/adapters/v1/index.ts` 按项目目录注册 `Symbol.for("opencode.bcp.delivery.v1")` 与 `Symbol.for("opencode.bcp.council.v1")` 进程内调用），以及 OMO 2.2.25 本地补丁（`integrations/omo-slim/omo-delivery.mjs`、`omo-council.mjs`、`omo-patch.mjs`）。
- 构建方式：三个 helper 由 `~/.config/opencode/local-plugins/build.mjs` 从 BCP 仓库 `integrations/omo-slim/` 同步复制（`OPENCODE_BCP_SOURCE` 可覆盖源目录）后统一构建；不再手工维护 local-plugins 内的副本。
- 职责边界不变：BCP 提供证据与关联事实；OMO 保持执行权威；语义验收与评审判定归属仍由作者、接收者与 Council 参与者承担。本文机制不是自动语义验收。
- v2 不声称等同：两项能力均为 v1 宿主适配，v2 adapter 未实现对应集成，[DESIGN.md](../DESIGN.md) 的 v2 边界条款继续适用。

## 交付引用回执（result_reference）

### 生成条件

仅当以下条件全部满足时，检查结果才携带 `result_reference`；任一不满足即没有回执字段（源码 `src/delivery.ts`）：

1. 作者终结答复是**单段完整终态 body**：单个 text part 且为 publicReply 终态（`exactSinglePart`）。
2. `currentResult(taskID, inputMessageID)` 成立。注意边界：v1 的 `currentResult` 只核任务会话仍停在产生该结果的**同一已准入输入**上，不是对最新终结消息的独立证明；终结消息的代次与版本由 OMO 的代次/终态闸门另行管理。capture 记录状态为 stored/replay，且 capture id 与结果 id 一致。
3. writer 三字段匹配：`writer.session_id` = 子任务 ID、`writer.message_id` = 终结消息 ID、`writer.agent` = 终结消息作者 agent。
4. 归属为 `host_final` 且 `input_message_id` 与该输入一致。
5. 持久记录 `content` 与答复 `content` 逐字节相等，且 `text_sha256` 与答复 SHA-256 相等。
6. `inspectDelivery` 返回前的最终复查通过：`canReadResult(调用该检查的会话)` 与 `currentResult` 同时成立，任一失败即不生成回执字段。`canReadResult` 的真实条件：调用者已解析的 agent 已知且未被隔离、其当前输入存在且未禁用 `board_get`（`tools.board_get` 与 `tools["*"]` 均非 false）、profile 与 session 权限均允许 `board_get`（`permissionAction` 判定为 allow）且该输入仍被准入。

### 呈现替换（omo-delivery.mjs）

- 阈值：终态 body **≥ 8192 字节**（`REFERENCE_MIN_BYTES`）才以 `<bcp_result_reference>` 回执替换呈现；更短输出保留原文。
- 字节精确：待替换文本必须与记录 body 的字节与 SHA-256 完全一致，或为原生 `<task …>` / `task_id: ses_… (for resuming…)` 包装内唯一的 `<task_result>` body；多重包装、字节不匹配一律保留原文。
- 回执必须小于原 body，否则保留原文。回执 JSON 内 `<` 转义为 `\u003c`，并附 `required_action`：接收者须先用 `board_get` 取回原文，回执只是检索凭据、不是验收。
- 检查时点：权限与输入复查发生在 `inspectDelivery` **返回之前**（异步读取 `canReadResult` 并复查 `currentResult`），之后没有第二次全量权限检查；OMO 呈现替换时另行做**版本 CAS**（同代次/终结版本/活动版本比对，`isCurrent`），呈现层不重新读取权限。

### 与交付元数据的关系

`<bcp_delivery_metadata>` 逐项检查契约（[delivery-integration-v1.12.md](delivery-integration-v1.12.md)、[final-capture-v1.14.md](final-capture-v1.14.md)）保持不变：候选最多 8 个 board ID（超出标 `truncated`）、来源检查最多 16 项（`sources_truncated`）、`version_check` 为 `per_source_only` / `no_artifact_reference`、`coverage` 与 `applicability` 恒为 `not_evaluated`、无综合 accepted。v1.20 只改变**返回呈现**（超长精确原文可替换为回执），不改变元数据语义，不改写、不冒充作者。

回执不证明覆盖或验收；不可读或已变更时按原文契约处理，不伪造引用。接收者可读性以 `canReadResult` 为准，其真实条件见「生成条件」第 6 条。

## Council 宿主原文装配（council.v1）

### 触发与别名

- Council 问题中显式出现的 `ses_*` token 与别名 token（`ses_*` 正则及通用别名模式 `\b[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,6}\b`）视为候选来源引用。解析结果分三类：
  - 无法解析的标准 `cou-N`（`/^cou-[0-9]{1,6}$/`）保留为 `excluded / not_found` 条目，不静默丢弃；
  - 无法解析的 `ses_*` 同样保留为 `excluded / not_found`；
  - 其余不匹配任务引用的普通含连字符词（如 `sha-256`、`utf-8`）不生成任何条目，不制造假缺口。
- 实际解析成功的别名（不论形态）照常进入资格检查与宿主读取；同一 token、同一任务只处理一次。

### 准入与资格（每个显式引用）

按序检查，失败即 `excluded` + reason，不携带正文：

| reason | 条件 |
| --- | --- |
| `not_owned` | 任务父会话不是 Council 调用者 |
| `not_councillor_seat` | agent 不以 `councillor-` 开头或未配置席位 |
| `not_completed` | 任务未稳定完成（含取消请求、状态不确定） |
| `no_terminal_identity` | 宿主未记录 input + terminal 消息身份 |
| `seat_limit` | 解析成功的席位超过 4（`COUNCIL_SEAT_LIMIT`），超出部分排除 |
| `bcp_unavailable` / `inspection_timeout` / `inspection_unavailable` | 桥缺失、单席位宿主等待超过 2 秒、桥调用异常 |
| `identity_mismatch` / `text_size_limit` / `digest_mismatch` | 身份三元组不符、正文超 32 KiB（`COUNCIL_TEXT_LIMIT`，UTF-8 字节）、SHA-256 不符 |
| `changed_after_read` / `changed_before_delivery` | 读取后或交付组装前代次/终结修订/活动修订/完成状态/归属变动 |

### 读取、验证与并发新鲜度

1. 每席位经宿主读取终结消息与输入消息，核验身份（session/ID/role/parentID）、publicReply 终态、作者席位与请求 agent 一致、正文 ≤ 32 KiB、SHA-256 摘要；单席位宿主等待 ≤ 2 秒。
2. 读取后立即做同代次复查（generation、terminalRevision、activityRevision、completed、归属、origin）。
3. **统一最终复查**：全部席位读取与并发准入等待完成后、交付组装前，对已收录席位再次核对记录状态；变动席位整体转为 `excluded`（`changed_before_delivery`），不带正文。此为首审阻塞①的修复。

### 装配形态

- 问题文本中已存在的 `<council_host_sources>` 标签先做 HTML 转义，防止与宿主装配混淆。
- 装配为 `<council_host_sources>` 包裹的 JSON：`schema_version 1`、`origin "host_verified"`、`generated_for` 调用者、`coverage`/`applicability` 恒为 `not_evaluated`；载荷条目状态为 `included` 或 `excluded`（桥内部 `src/council.ts` 的 `verified` 是桥返回值，不进入载荷）。`included` 条目含 `task_id`、`alias`、`agent`、`model`（modelID/providerID）、`input_message_id`、`terminal_message_id`、`text`、`text_sha256`、`text_bytes`；`excluded` 条目保留相应身份字段、状态及 reason，不含正文。问题文本中的同名标签不是宿主证据。JSON 内 `<` 转义为 `\u003c`。
- Council 调度、并发、准入等待与取消保护沿用 OMO 既有机制，宿主不重构调度。

### 边界

宿主装配提供的是经核验的原文与排除原因。工具隔离与评审判定归属保留：装配不是评审判定，更不是自动语义验收；各席结论仍由 Council 与用户裁量。宿主不读取隔离黑板绕过权限。

## 验证状态

- 自动化检查：run-4（/tmp/opencode/orchestration-refresh/checks/run-4.json）包含 `node build.mjs`（local-plugins）、`node --test`（acp-export / omo-council / omo-delivery / vibeguard，42 例通过）与 `bash scripts/install.sh`，全部通过。`bun test`、`tsc` 与两仓库 `git diff --check` 来自更早的 run-2 记录；相关文件此后未变化，该证据按未变文件复用。二者都是作者侧自检记录。
- 独立首轮复审：bb://c233777e-dafa-4e6a-b3df-8d8d09578292/84f0cb7d-933f-440f-bfd7-eac18ad82a9c/e000001，PASS。范围仅限首审两项原阻塞、实际修正增量及受影响边界：确认统一最终复查位于全部席位读取与并发准入等待之后（部署产物中 finalizer 后无后续 await）、无法解析的标准 `cou-N` 保留为 `excluded / not_found`；三项定向回归与 13 个内存场景通过；run-4 与实现指纹一致。该结论不证明模型必然正确理解或综合来源，不构成语义接受，不授予发布或执行授权；未重跑全套测试。
- 实况观察样本（作者侧，/tmp/opencode/orchestration-refresh/live/）：`council/`（四席并发 + 综合席）、`council-final/`（四席位原文逐字核对）、`planning/`（orchestrator + 只读 oracle 复审）、`reference/`（引用回执呈现，任务 metadata `association: host_message_identity`）。`planning-wide/` 首次观察在 720 秒超时；随后以同一 root 只读续接完成（`planning-wide-finish/`），两个子会话原文逐字未变——该案例存在观察超时与受控续接限制，不作为一次完整无干预成功的记录；其最终报告在快照之外的过宽概括已在验收记录中修正，亦不构成完整引用交付成功的记录。
- 验收归属：本文登记机制、限制与证据位置；完整限定验收记录（含静态一致性断言结果与实际部署 hash）见 [../harness/acceptance/v1.20.0.md](../harness/acceptance/v1.20.0.md)。观察样本中的模型回答内容不在本文档转录范围。

## 相关文档

- 完整限定验收记录：[../harness/acceptance/v1.20.0.md](../harness/acceptance/v1.20.0.md)（静态一致性断言与实际部署 hash 以该记录为准，本文不转录）
- 交付元数据与生命周期：[delivery-integration-v1.12.md](delivery-integration-v1.12.md)、[final-capture-v1.14.md](final-capture-v1.14.md)
- 公开来源与引用：[public-source-v1.17.md](public-source-v1.17.md)、[reference-first-v1.16.md](reference-first-v1.16.md)
- 部署与构建：[INSTALL.md](../INSTALL.md)、[omo-slim/README.md](../integrations/omo-slim/README.md)
- 设计总契约：[DESIGN.md](../DESIGN.md)
