# v1.15：既有答复补存与编辑证据

## 保存入口与身份

v1 新增 `board_store`，可由来源作者、orchestrator 或其他有权限的 agent 调用。自动正文留存和补存共用同一个消息幂等键；同一答复只形成一条记录，重试返回原记录，不改写原分类、标题或快照。v2 保持原有四工具接口。

- `action=list`：`session_id` 默认当前调用者；返回最近已完成答复的消息 ID、输入 ID、真实作者、时间、短预览及已存在的记录 ID。`limit` 默认 10、上限 20，检查窗口最多 200 条最近消息；同时提供最多 20 个可访问会话的位置。这不是全历史检索。
- `action=store`：传入 `session_id`、确切 `message_id` 和短 `description`，可选 `kind`。不接受正文、作者或来源引用参数。宿主读取消息，不要求调用者转述结果。
- `record.writer` 始终是原消息作者；`origin.requested_by` 单独记载补存调用者。`origin.message_completed_at` 保留原消息完成时间，避免旧答复晚补存后覆盖交接中较新版本的排序。
- 只有宿主确认已完成的公开 assistant 正文可以补存；工具输出、推理内容、用户输入、未完成或出错的答复不作为最终正文留存。没有正向标记的已完成答复可通过显式工具授权补存。

调用者必须有发布权限并能读取来源 stream；来源作者及其原输入也必须允许发布。同 scope 的可见来源可以补存，未注册、跨 scope 或隐藏来源统一返回 `not_found`。输入或正文中的 `<!-- bcp:no-store -->` 仍优先于补存。工具权限不能覆盖来源限制；记录存在也不代表验收通过。

补存是宿主按确切消息身份执行的受限写入，不扩大 `board_put` 的写流权限。接收者仍须读取原文、版本与限制。已知消息 ID 可直接保存；未知 ID 时先使用同一工具发现，不要求模型重新执行作者任务。

## 编辑证据与 source_refs

在已授权的原生编辑工具开始前，宿主先记录待完成操作；结束后按作者会话和准入输入保留已知路径的快照。支持当前 v1 钩子可定位路径的 `write`、`edit`、`apply_patch`。正文标记和补存都从同一证据日志取得截止原答复完成时的版本，并自动形成含 SHA-256 的 `source_refs`。

证据日志持久化在对应 stream 的 `edits/` 下，重启后仍可使用。它是本地编辑证据缓存，不是已发布 board 记录；正向正文标记不作为编辑缓存的开关。已知禁止留存的输入或不允许发布、读取的权限会阻止采集。事后正文中的禁止标记阻止发布，但不追溯删除此前已经获准建立的本地缓存。自然语言限制须由权限或禁止标记传达，插件不声称能自动理解任意禁令。

证据快照计入既有 scope 配额，单文件上限 4 MiB，一次最多绑定 8 个文件，每个输入最多记录 256 次编辑观察。文件按内容寻址复用；证据元数据采用受限文件权限和原子写入。未完成操作、跨完成时点的迟到观察、配额或磁盘失败、损坏记录及日志超限会产生明确缺口，不能悄悄退回更早版本。

文件当前内容可以与历史快照不同。补存时不会用今天的文件冒充过去的编辑；缺少历史证据时可以保留原答复，但必须在 `source_errors` 声明版本缺口。原正文中已带确切 SHA-256 的其他文件引用仍须通过实际权限与字节校验。无版本的历史路径不能补拍成历史证据。

观察结果只表示工具结束后在该路径读到的内容。共享路径的无协调并发写入不产生独占作者证明；shell、远端修改、未知路径和安装前历史不自动获得完整编辑证据。内容哈希不证明结论正确，也不证明所有改动均已覆盖。

## 常驻工具描述

下面的描述由 v1 工具注册统一提供，适用于工具权限允许的主角色与子角色；不向每个角色另加一段系统提示。

```text
Retain an existing completed assistant reply verbatim, including another authorized agent's reply. No body or author arguments. With a known session_id/message_id (Task metadata has terminal_message_id), use action=store and a short description. Otherwise action=list lists recent replies, IDs, authors and previews; session_id defaults to yours and limit bounds the search. Use this to recover a useful unretained result, not duplicate it. Host verifies the real author, permissions and original edit snapshots; old files are never replaced with today's bytes. A record is evidence, not acceptance. Publication restrictions still apply.
```

## 与既有机制的关系

自动保存仍遵循 [v1.14 正文规则](final-capture-v1.14.md)，但编辑来源改用本契约的持久历史证据。`board_put` 用于新产生的阶段决定等独立内容，`board_store` 用于已经说过的完整答复，`board_get` 读取已经保存的记录。工具不会自行决定重要性、补写缺失结论、唤醒作者或触发模型补交循环。
