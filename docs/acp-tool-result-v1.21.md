# v1.21 ACP 工具结果留存与记录导出

## 目标与边界

宿主确认的 `acp_run` 成功返回结果默认尝试原文留存：留存意图来自宿主配置（`autoCapture` + 新增插件选项 `acpCapture`，默认开启），不要求结果携带保存标记。发布权限、发布禁止指示、来源身份校验和体积限制继续有效。wrapper 只承担传输：返回宿主提供的正文副本与回执，不决定留存、不调用板工具、不生成或修正记录 ID。

留存走与普通终稿捕获同一条代码路径（`src/capture.ts` 的授权/幂等/写盘机制）；作者身份一律取 wrapper 会话的宿主确认身份，绝不写 orchestrator，绝不信任工具参数中的身份声明。`args.agent` 仅作信息性的 `external_agent` 记录。

## 行为表

- 无标记的正常返回 → 默认留存原文；带标记 → 同样留存（标记行不影响内容）。
- 输入或结果含既有 `NO_STORE` 完整字面量 → 跳过，返回 `Retention skipped: publication_restricted`。
- 发布权限不允许 → 跳过，返回 `Retention skipped: publication_not_authorized`。
- 无法读取或确认对应用户输入 → 失败关闭：不落盘、无假回执、不让 wrapper 兜底；返回 `Retention failed: <reason>`。
- 空白结果或超过 262144 字节 → 明确失败，不截断保存。
- 同一 callID 重入 → 幂等键 `bcp:tool-result:<session>:<callID>` 判定：同原文复用记录，不同原文报冲突。
- 工具抛出或取消 → 不伪造顾问记录，只记诊断。

## 回执与展示副本

记录内容保存完整原文（含标记）。返回给 wrapper 的展示副本仅移除解析器承认的顶层有效保存标记行（代码块内示例不动），然后追加两行：回执/状态行与固定指引行，例如 `Retained: <record id>` 后随 `Preserve the retention line above in your reply.`；失败/跳过使用固定格式 `Retention failed: <reason>` / `Retention skipped: <reason>`，同样后随同一指引行。该指引随每次工具结果逐份下发，不常驻系统提示词。自动留存关闭时原样返回结果，不作任何声明、不追加指引。留存成功后走与终稿捕获相同的子会话通知与权限核验后的父会话可见性逻辑；父通知失败只记诊断，不回滚记录、不改回执。

## 标题

标题唯一来源是关联用户输入的可选首行 `Task: `（非空可打印 ASCII，≤160 字节），模板 `ACP result: <外部代理> | <任务标题>`，否则回退 `ACP result: <外部代理>`；元数据按 80 Unicode 字符截断。标题缺失不阻断留存；无法确认来源消息属于失败关闭，不以中性标题掩盖。

## 同输入轮去重

某输入轮含宿主确认的 `acp_run` 调用时：终稿事件路径不再捕获该轮 wrapper 转述；board_store 拒绝重复入库该轮 wrapper 消息，有原始终记录则引用之，否则明确说明未留存。判定依据为宿主消息工具部件与幂等键，不依赖内存缓存，不建新状态文件，无永久封禁——下一用户输入轮自动恢复。

## board_export

BCP 通用导出工具，与 board_get/board_store 并列注册。按 `bb://` ID 与期望 sha256 把记录 JSON 逐字节导出到 `<项目根>/.opencode/bcp/exports/`（目录由宿主上下文派生，不可经参数改变；ACL 复用 board_get 的可读路径）。单次 1–8 条，单条与累计均 ≤512KiB；整批校验先于发布，临时文件原子发布且不覆盖既有文件；成功输出不含正文。这是数据交付，不是 ACL 重实现。

## 常驻协议文字（逐字校验）

```text
Final-answer format: unless publication is prohibited, append <!-- bcp:store description="topic; result; important limit" --> on a separate line to every final reply, including short answers. Write a specific title of at most 80 characters, faithful to the public body; use &quot; for embedded quotes. The plain <!-- bcp:store --> remains valid. Keep the marker outside code and quotes. The host retains the original without another publication call. If publication is prohibited, omit it; <!-- bcp:no-store --> in input or reply prevents capture. A title or marker alone is not a public result.
```

v1.21 起对 acp_run 结果不再追加常驻例外段：回执指引改为随每次工具结果的展示副本逐份下发（见「回执与展示副本」）。

## 验证计划

1. 确定性测试覆盖：默认留存与哈希、NO_STORE 与权限跳过、失败关闭、幂等与冲突、同轮去重与下一轮恢复、标题来源与回退、回执格式、代码块标记保留、board_export 的 ACL/限额/原子发布/并发不覆盖。
2. 授权对照：默认部署经既有权限路径留存成功；显式拒绝 board_store 仍跳过。
3. 多外部代理与多轮咨询：各自独立成记录与回执，无跨用复用。
