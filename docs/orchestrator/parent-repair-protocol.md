# Parent 补写编排协议（G2）

适用场景：parent（编排方）在 child 会话结束后，判断某段工作值得保存到黑板，需要请求**原作者**补写记录。
依据：DESIGN v1.3 §10.5（"parent 显式决定 → 请求原作者补写"是 child 结束后 parent 介入的**唯一允许路径**）；
计划 `docs/plans/2026-09-23-blackboard-nudge-restore.md` Task 3。
本仓库无独立编排器运行时：协议以本文档 + 检查脚本 `scripts/parent-repair-check.ts` 落地；派发复用既有 task 能力与
`board_put` 的 `publication_for` 传参（src/tools.ts），**不新增插件工具**。D3 后 `board_status` 为 self-only
（只查自身 stream），不能替代本协议 C6 的跨流授权检查。

## 1. 协议要点（逐条对应 DESIGN §10.5）

1. **触发**：仅当 parent 判断值得保存时启动；child 必须已结束，且生命周期满足已终结、未复用（对应"不自动重开已结束 child"）。
2. **身份/权限**：派发前确认 scope 成员资格与 board 权限（复用既有 resolveSession / isolation 路径）；
   请求对象必须是**原 child**——session 身份在派发参数中显式给出，不得省略 agent。
3. **请求内容**：明确**原作者**（child session）+ **目标**（原执行/原消息引用，即 `target_ref`）+ 补写理由；
   补写记录的 `publication_for` 由**原作者在写板时显式传入**（`board_put` 的 `publication_for` 参数），不由 parent 代填。
4. **禁止**：不代写（DESIGN §10.5 / §V4 风险表：parent 缺少原执行上下文，代写无法真实自包含且归属失真）；
   不回退默认 agent（对照 V4：不显式传 agent 会用 `defaultInfo()`，不继承 child agent）；
   不走重开已终结 child 的 runner 状态之外的任何路径。
5. **parent 侧留痕**：补写请求动作须留存证据——**实际派发参数快照**（含显式 agent 参数与观察时点）与
   **board 上补写记录 id**（`published_record_id`），供本协议检查与验收使用。

## 2. 检查清单（C1–C6，六条生命周期检查）

| 检查 | 内容 | PASS 条件 | FAIL | UNVERIFIABLE（不得假 PASS，也不武断 FAIL） |
|---|---|---|---|---|
| C1 | 已终结 | `original_execution` 与 `lifecycle` 字段完整 ∧ `terminal===true` | `terminal!==true` | 任一字段缺失（含 `observed_via`/`at`） |
| C2 | 未复用 | `lifecycle.reused===false` | `reused===true` | `reused` 缺失 |
| C3a | 派发前权限确认 | `authorization.scope_member===true ∧ board_permission_ok===true` | 任一为 false | 任一缺失 |
| C3b | 原作者确认 | 记录 `writer.session_id===child_session ∧ writer.agent===child_agent` | writer 与原作者不符 | 声称的记录不存在/不可读/不可解析 |
| C4 | 目标一致 | 记录 `publication_for` 归一化后 `===` `target_ref` | 不等（含记录缺 `publication_for`） | 记录不可读或 `target_ref` 缺失 |
| C5 | 不回退默认 agent | `dispatch_proof.explicit_agent_given===true ∧ agent_param===child_agent` | 未显式传（即使默认 agent 恰为原 agent 也不允许）；空串等同省略；参数不匹配 | 字段缺失 |
| C6 | 不代写 | 范围内（见 §4）不存在 `writer.session_id===parent.session` 的记录 | 查到即 FAIL | 遍历未完成/证据不可读（输出缺口清单） |

A 阶段 = C1、C2、C5、C3a（**两种模式都执行，不读记录**）；B 阶段 = C3b、C4、C6（仅 postflight，读板）。
验收口径：**权限/生命周期证据不完整即不得判通过**——任何 FAIL/UNVERIFIABLE 都使退出码为 1。

## 3. 双模式与退出码

| 模式 | 时点 | 输入 | 执行 | 退出码 |
|---|---|---|---|---|
| `preflight` | 派发前（dry-run） | **拟派发参数快照**；`published_record_id` 不要求存在（应省略） | 仅 A（不读板） | A 全 PASS → 0（允许派发）；任一 FAIL/UNVERIFIABLE → 1（不派发） |
| `postflight` | 补写后 | **实际派发参数** + `published_record_id`（必填） + scope 绑定 | A + B | A+B 全 PASS → 0；任一 FAIL/UNVERIFIABLE → 1 |

## 4. C6 查询边界（三段式）

1. **scope 绑定**：绑定 = `original_execution.child_session` 所属 scope，由调用方解析后经输入
   `scope.scope_id` 传入；**脚本不跨 scope 枚举**。`scope-index.json` 仅是 root session → scope ID 的映射
   （src/storage.ts:516-519），解析是调用方的职责。
2. **stream 枚举**：= 该 scope 的 `scope.json.session_index[*].stream_id` **去重集合**
   （src/storage.ts:37-43、207-209；DESIGN §3：stream 注册关系在 scope.json，不在 scope-index.json）。
3. **范围与遍历**：范围 = `publication_for` 归一化后 `===` `target_ref` 的记录 ∪ `source_refs`/`related`
   包含 `target_ref`（归一化相等）的记录；遍历 = 每条 stream 按 `metadata.json` 的 `high_water` 顺序扫
   `e000001…e<high_water>` 全部读完且无读取错误（合法序号空洞跳过，不虚增计数）。
   - FAIL：范围内存在 `writer.session_id===parent.session` 的记录（parent 身份 = 输入 `parent.session`；查到即 FAIL）。
   - UNVERIFIABLE：`scope.json`/`session_index` 不可读、任一 stream 的 metadata/entries 不可读、遍历未完成、
     枚举为空集、声称的补写记录所在 stream 不在注册集合、`parent.session`/`target_ref`/scope 绑定缺失——
     一律输出**缺口清单**，不假 PASS，不武断 FAIL。

## 5. 归一化函数（C4/C6 共用）

```text
normalizeTargetRef(s) = s.trim().replace(/\s+/g, " ")
```

即：去首尾空白，连续空白折叠为单个空格。`description_ref` 形态的目标引用由**调用方先解析为规范化字符串**
再传入 `target_ref`；脚本只做归一化后的字符串相等比较，不做二次解析。

## 6. 输入契约（最小受信输入；每字段来源与观察时点由调用方声明）

```json
{
  "mode": "preflight | postflight",
  "scope": { "scope_id": "<child session 所属 scope，调用方解析后传入；仅 postflight 需要>", "data_dir": "<存储根，省略 = 默认 bbV1Root()>" },
  "original_execution": { "child_session": "...", "child_agent": "...", "target_ref": "..." },
  "parent": { "session": "...", "agent": "..." },
  "dispatch_proof": { "explicit_agent_given": true, "agent_param": "...", "at": "<ISO8601>" },
  "lifecycle": { "terminal": true, "reused": false, "observed_via": "<如 session.get>", "at": "<ISO8601>" },
  "authorization": { "scope_member": true, "board_permission_ok": true },
  "published_record_id": "bb://<scope>/<stream>/eNNNNNN（仅 postflight 必填）"
}
```

## 7. 用法

```sh
bun run scripts/parent-repair-check.ts --file check.json   # 或从 stdin 传入 JSON
echo $?   # 0 = 通过；1 = 存在 FAIL/UNVERIFIABLE 或输入不可用
```

输出逐项检查结果（`C1 PASS …`）与 `exit=`。脚本只读板（既有公开 API：openScopeById / readMeta / readEntry，
锁内一致读），不派发、不写板、不触碰 src/。
