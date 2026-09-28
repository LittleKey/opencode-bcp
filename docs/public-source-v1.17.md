# v1.17：先公开表达，再留存原消息

本版本在 [v1.16 引用优先契约](reference-first-v1.16.md) 上收紧使用指引和失败反馈，不扩大可发布来源。默认 v1 仍只有 `board_store`、`board_get`、`board_index`、`board_aggregate`；旧手动模式和 v2 兼容边界不变。

## 公开来源边界

板上正文必须来自宿主已经存在、用户可读的公开答复。原作者、原输入和消息 ID 均由宿主核验。内部推理、工具参数、工具输出、未来准备写出的报告以及调用者填写的标题，都不能替代原正文。只有不可见留存标记的消息也不构成可留存结果。

“分析完毕，接下来给出解释”只是公开进度。即使保存它，记录也只能包含这句话，不能因为标题写了“完整评审”就补出评审结论。工具不判断所有自然语言标题与正文的语义是否一致；接收者仍须读取原文，不能把留存成功当作报告完整或验收通过。

## 可执行的使用顺序

1. 已有公开来源时，优先复用其记录。没有记录则 `action=list` 查询真实消息身份，再保存选定原消息；自己的 session 可以省略，其他 agent 使用宿主返回的真实 session/task ID。
2. 尚未公开的结论先在正常答复中表达结论、依据和限制。没有中间依赖时，完整结束答复，由既有自动留存处理，无需先调用保存工具。
3. 有后续依赖时，使用已完成的公开阶段消息；正文和关联工具须已结束，再保存并派发完整引用。不能通过空操作、编造 ID 或反复重试正在运行的消息制造一个可保存阶段。
4. 调用者与原作者的权限、原输入禁令和文件访问边界继续优先。对不可见来源不通过换 session、复制或转述绕过限制。

## 失败反馈

未知或不可见 session 统一返回 `source_not_found_or_not_visible`，不泄露其是否存在，并提示当前会话查询应省略 session 参数。已获准访问 session 内不存在的消息返回 `message_not_found`，附该 session 的 `action=list` 调用参数。缺消息 ID 同样引导查询。

查询窗口内无可留存答复，或指定消息仍未完成、没有公开正文时，提示先完成公开答复。查询始终有窗口上限，空结果不证明整个历史都没有来源。工具不自动改选消息、不从推理补文、不新增后台补交或模型调用。

## 常驻描述（与实现逐字校验）

```text
Final-answer format: unless publication is prohibited, append a separate line containing <!-- bcp:store --> to EVERY final reply. Keep this invisible protocol line even when the user asks for only a short answer. Do not put it in code or quotes. The host saves the original reply without another publication call. If publication is prohibited, omit it; <!-- bcp:no-store --> in input or reply always prevents capture. This format applies to final answers, not titles or internal summaries.
```

```text
Retain existing user-readable public replies, not reasoning, tool arguments or an unwritten report. First express conclusions, evidence and limits publicly; store only an earlier completed reply/stage with settled tools. Reuse its record, or action=list to discover real message IDs; never invent IDs. Omit session_id for your session; use the actual child task_id for another agent. Then action=store with message_id and a short title, no body/author. Task metadata also supplies terminal_message_id. Ordinary final answers use automatic retention; do not call dummy tools just to create a stage. Before dependent dispatch, retain a new public decision as kind=decision; pass full references and require board_get. Host verifies author, permissions and historical edits; storage is not acceptance.
```

```text
References over retelling: rely on user-readable public messages from your session or another authorized agent. Reuse an existing record; otherwise board_store action=list finds real message IDs, then action=store retains the original. Omit session_id for your own session; task metadata supplies child session/message IDs. Never invent IDs or store an unwritten report: first state conclusions, evidence and limits publicly, then retain the completed source before dependent dispatch. Ordinary final replies use automatic retention. Pass objective, allowed scope, full source IDs/versions, only new instructions and acceptance questions; require board_get of originals, not your retelling. Read under board_get's same-version rule. Preservation is not acceptance; publication restrictions still apply.
```
