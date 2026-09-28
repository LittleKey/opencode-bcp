# v1.16：原文留存与引用优先交接

## 工具与兼容边界

默认 v1 提供 `board_store`、`board_get`、`board_index`、`board_aggregate`，不注册 `board_put`，其描述和参数也不进入工具目录。自动最终答复留存仍然优先，已存在记录直接复用。`autoCapture:false` 的旧手动模式保留 `board_put`；v2 保留原四工具接口。底层记录存储、既有记录、关系及索引语义不删除。

默认发布权限以 `board_store` 为准，仍尊重有效的显式旧 `board_put` 禁止及原输入禁令。通用默认拒绝加明确 `board_store` 授权可以发布；隐藏旧工具本身不等于禁止发布。手动模式继续使用旧权限。文件读取、来源可见性、原作者与补存者权限仍分别核验。

## 可留存的公开阶段正文

最终答复沿用 v1.15。显式 `board_store` 额外接受宿主已完成的 `finish=tool-calls` 阶段：必须有非空公开文本、原作者、原输入、完成时间；每个公开文本片段有结束时间和 ID，每个工具调用有 ID、名称、结束时间并已完成或明确报错。当前仍运行的消息、流式草稿、推理、工具输出不进入正文。阶段显式保存不等于任务完成，自动终态桥仍只处理最终答复。

阶段记录使用独立幂等键与 `host_stage` 来源类型，保留公开片段及已结束工具调用的边界。提交前重读原消息，正文、作者、输入和边界必须一致。保存原话不验证其判断正确，失败工具也不因记录存在而变为成功。

OpenCode 1.18.31 可以先结束模型响应，再结束工具及快照钩子。因此阶段编辑证据按本阶段原生工具 call ID 选择已观察日志前缀；不以补存时间或当前工作文件替代历史版本。无原生编辑的阶段使用消息创建时点之前的观察。未完成、缺失、损坏或超限证据明确报缺口；已知并发覆盖仍不产生独占作者证明。

## 统一来源登记

自动保存与补存都登记可读的原作者来源。只有记录原作者为当前 session 且原输入与当前准入输入一致，才登记为本轮依赖来源；重放旧输入不进入本轮决定集合。来源登记不把历史快照视为当前编辑完成证明。

重要新决定先输出一次公开阶段结论，包含选择、理由和限制；对应消息及工具结束后，通过 `board_store kind=decision` 留存，再启动依赖工作。已有自己或其他 agent 的答复优先用其记录；未存时按消息身份补存。派发只需目标、允许范围、完整引用、真正新增的指令和验收问题，接收者读取原文。禁止发布和不允许读取的来源继续报告缺口，不通过转述绕过限制。

`supersedes` 等通用手写关系字段未迁入 `board_store`；默认留存记录依然不可变，旧模式保留原关系接口。本次不引入新的正文写入工具、阶段代理、模型补交循环或任务状态数据库。

## 常驻描述（与实现逐字校验）

自动最终答复：

```text
Final-answer format: unless publication is prohibited, append a separate line containing <!-- bcp:store --> to EVERY final reply. Keep this invisible protocol line even when the user asks for only a short answer. Do not put it in code or quotes. The host saves the original reply without another publication call. If publication is prohibited, omit it; <!-- bcp:no-store --> in input or reply always prevents capture. This format applies to final answers, not titles or internal summaries.
```

`board_store`：

```text
Retain original public text from your session or another authorized agent: completed final replies or completed stages with settled tools, never drafts or reasoning. Prefer references over retelling. Reuse an existing record; otherwise use action=store with session_id, message_id and a short description, no body or author. Task metadata supplies terminal_message_id; action=list discovers recent eligible messages and existing record IDs (session defaults to yours). Save a new governing decision as kind=decision before dependent dispatch, then pass its full ID and ask the receiver to read it. Host verifies author, permissions and historical edits. Retention is not acceptance.
```

任务派发追加说明：

```text
References over retelling: when depending on an existing message in your session or another authorized agent's session, reuse its record ID. If unretained, use board_store action=store with session_id/message_id and a short title; action=list discovers eligible messages when IDs are unknown. Task metadata provides terminal_message_id for completed children. Retain governing decisions before dispatch. Pass objective, allowed scope, full source IDs/versions, only new instructions and acceptance questions; ask the receiver to board_get the originals. Do not copy source bodies or reconstruct findings. The author answers once; the host retains final text and native edit versions. Read sources under board_get's same-version rule. Preservation is not acceptance; publication restrictions still apply.
```
