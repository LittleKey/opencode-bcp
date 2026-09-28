# 自然交接与工件绑定（v1.14）

本契约替代 v1.13 的首行限定和仅正文 URI 绑定方式；身份、权限、当前输入、取消、幂等、配额和语义验收边界继续适用。v2 与 `autoCapture: false` 保持手动契约。

## 作者授权与原文

最终答复可用顶层、独占一行的 `<!-- bcp:store -->` 明确请求留存，推荐放在末尾；其前后的说明文字不使明确授权失效。引用、行内、缩进代码、fenced code 和 HTML pre/code 中的标记不授权。`<!-- bcp:no-store -->` 在输入或答复中出现仍优先禁止。缺失标记不保存；不得以“缺少退出标记”推断授权。宿主原样保存公开正文，不移动或删除标记。

## 原生编辑与版本

沿用已有本轮编辑观察器。原生 `write`、`edit`、`apply_patch` 的开始观察与结束观察必须属于同一准入状态；旧操作的迟到结果不得变成新输入的工件。终结时将本轮已知编辑路径放在显式 URI 前面，经原有文件权限与大小检查保存快照。普通散文路径不会被扫描。

不可变 `origin.file_bindings` 将原路径关联到保留引用；`native_edit: true` 只表示宿主观察到该输入中的原生写操作，不证明文件内容正确。已知路径可留存时，其他拒绝或缺失的来源单独记录错误，不使已验证来源丢失。输入或编辑代次在读取期间变化时拒绝此次捕获；重放沿用首次记录和快照。

仍限 16 个来源引用、8 个本地文件、每文件 4 MiB。未知编辑路径、超限和权限拒绝是显式缺口；shell、外部服务写入和插件重启前的未留存编辑不由该观察器保证。只读评审通过明确 URI 绑定其实际读取的输入版本。文件快照不是语义验收。

## 引用交接

v1 针对含有 `prompt` 参数的 Task 派发和恢复，检查当前进程为派发者观察到的最近最多 8 个记录。子会话完成留存后，经父子身份和读取权限核对，也将引用放入父会话的有界观察缓存。候选按不可变创建时间排序，同流同时间按序号排序；重读旧记录不会把旧快照提升为新版本。仅在任务包含完整原路径、记录对派发者可读且原生作者快照可校验时附加作者引用，最多 8 项工件。不遍历全板，不推断自然语言依赖；冷启动或不匹配时由模型按通常发现规则定位来源。使用 `message` 字段的 `task_message` 不在这个适配范围。

只读评审记录不作为新评审的作者工件自动注入。仅当接收者是宿主核对的现有子会话、且曾原生写入同一路径时，附加候选集中引用该文件的其他作者只读记录，最多 4 条，供原作者修订时直接读取。未知接收者和首次独立评审不获得这种附加内容。记录仍须由接收者核对，不把旧快照声明成当前工作文件。完全相同的 256–65,536 字节工件正文副本可机械替换为其原始引用；差异、问题、版本声明和周围指令保持。非逐字相同内容不改写。这减少下游重复上下文，不能追回模型已经生成参数的 token。

自动模式识别已核对的 OpenCode 1.18.31 Task 帮助中的三条旧文案：高度详细重建新会话上下文、主角色总结子任务结果、一般信任作者输出。三条必须全部精确匹配才一起替换为读取原始来源、返回简洁结果和核对证据的契约；调度生命周期规则、参数和动态角色列表不变。未知宿主文案保持原样，不能宣称适配过未经核对的版本。手动模式仍仅追加旧契约。

## 原生续接与终态身份

原生续接本身可以确认父会话已消费此前注入的该条终态：只对宿主已注入给当前父会话、角色一致且执行代次和终态修订号完全相同的记录，进入既有确认路径。不确认尚未注入、其他会话、其他角色、旧代次或仍运行的任务，也不顺带确认其他任务。

OMO 2.2.25 原生 `task(task_id=...)` 在收到输出时才登记新代次。观察窗口必须采用该次派发的开始时间；采用输出后的时间会把刚完成的作者消息误判为历史消息，丢失其输入身份。锁定源码补丁只修正这个时间来源，保留原有重新发起租约和代次登记位置。

前台输出若得到 `stale` 或 `deferred`，仅在同一调用、同一执行代次、仍运行且未请求取消时，最多再进入原终态闸门两次。若原因是已有证据读取尚未结束，等待该次读取的既有完成信号，每次最多 2 秒，然后重新核对代次；不通过盲目轮询或新增模型轮次等待。改变执行代次、取消或无法确认调用时停止；不直接改写终态，不伪造消息身份。交付元数据仍受终态、活动和执行代次的写前复核保护。原生 Task、恢复、查询和通知共用原有交付桥。

## 阶段决定与角色

主角色在后续执行者依赖一个只存在于临时上下文中的新决定或约束前，保留一次独立来源；已有合格作者记录则复用。普通进度不形成记录。正式文档作者采用 document-writer，独立技术语义评审采用 Oracle。主角色的 Task 权限拒绝直接选择 Council 内部顾问；Council 自身权限保持。

派发时同步附带本准入输入中观察到的新建、派发者自己拥有且可读的 `kind=decision` 引用，最多 4 条。旧输入的迟到回调和仅重放旧记录不作为新决定。这些引用要求接收者读取原文及限制，不推断每条决定对当前子任务都适用，也不把转述当作替代。

以上主动选择仍需要模型遵循。验收须检查自然任务的实际读写顺序、引用、来源版本及无冗余发布；规则存在本身不是行为通过。

## 自动模式常量

以下依次为公共 system 约定、`board_put` 描述和 Task 追加描述；由测试逐字校验。

```text
Final-answer format: unless publication is prohibited, append a separate line containing <!-- bcp:store --> to EVERY final reply. Keep this invisible protocol line even when the user asks for only a short answer. Do not put it in code or quotes. The host saves the original reply; do not call board_put for it. If publication is prohibited, omit it; <!-- bcp:no-store --> in input or reply always prevents capture. This format applies to final answers, not titles or internal summaries.
```

```text
Write the final result once with outcome, basis, limits and exact versions; follow the host's capture convention. Known native edits are snapshotted by the host. Cite file:// URIs for other local sources; #sha256=<64 hex> requires matching bytes, not semantic acceptance. Before dependent work, retain a new material decision or constraint once if no adequate source exists. Reuse existing author records. Never duplicate final results or routine progress in board_put. source_refs must be exact files or references, not directories or commentary.
```

```text
Handoff = objective, constraints, complete source IDs, exact versions, delta and questions. Do not paste full artifact bodies or restate author findings. The author answers once; the host retains the reply and known native edits. Read the original author record before relying on it, under board_get's same-version reuse rule. Forward complete references for review and revision; never abbreviate IDs or hashes. Capture proves retained bytes, not acceptance. Pass publication restrictions through; file-edit limits alone do not prohibit capture.
```
