# 最终正文自动留存（v1.13）

历史版本契约。当前首尾标记、原生编辑版本绑定和引用交接规则见 [v1.14](final-capture-v1.14.md)。

## 目的与分工

作者在获准留存的最终答复首行写 `<!-- bcp:store -->`，随后一次写出结果、依据、限制和确切版本。宿主保存这份正文，OMO 携带引用，后续评审者或修改者读取原文。作者无需为同一结果再生成 `board_put` 参数，也无需在工具完成后再生成一次收尾答复。标记是单次输出内的授权约定，缺失就不保存。

BCP 保证可核验的正文、作者、输入关联和来源字节。OMO 仍负责代次、取消、恢复、通知租约和任务状态；接收者判断结果是否合格。存下错误结论不会使其正确，宿主终结消息也不等于整个逻辑任务完成。澄清答复可能被留存，但不会被机械标成任务验收通过。

## v1 接入与幂等

- 默认启用；插件选项 `autoCapture: false` 使用旧手动发布契约。v2 尚未接入自动留存，继续使用旧契约。
- v1 `message.updated` 事件只尝试留存已完成的 `finish=stop` 助手消息；重新读取宿主消息并验证作者、输入和当前准入关系。错误、摘要、未完成工具、空正文或身份不足均不成功留存。OMO 仅在已有有效终态的交付检查中调用同一留存函数，弥补事件与读取的时序差异。
- 正文只含公开 `text` parts，按顺序用一个换行连接；忽略 reasoning、tool、synthetic 和 ignored parts，不裁剪或改写作者文字。此规范化正文的 SHA-256 单独保存；它不同于整个 board 记录的 hash。
- `bcp:final:<session>:<message>` 为宿主幂等键。记录可选 `origin` 保存 `kind=host_final`、输入消息 ID、正文 hash 及来源失败信息，写入来源不能由 `board_put` 参数伪造。旧记录无此字段仍可读取。
- 同消息并发事件、交付检查和重启后的重复读取复用首次留存，不重新抓取已变化的文件。新输入对应新消息与记录；不会把旧作者或旧输入改成当前版本。`origin` 属于不可变载荷及记录 hash 域。
- 自动留存不猜测 `kind=review`、采纳状态或自然语言 `supersedes` 关系；需要显式分类、主动保存中间决定或目录整理时，四个工具继续可用。

## 授权与退出

自动留存必须满足作者角色与会话合并后的 `board_put` 权限为 `allow`，且该输入未通过 `tools.board_put=false` 禁止写入。`ask`、未知权限与缺失宿主能力均不视为授权，不自动弹出授权请求。

只有最终正文首个非空白行精确等于 `<!-- bcp:store -->` 才请求留存；输入中的正向标记、引用、代码示例和行内标记均不足以授权。输入或最终正文含 `<!-- bcp:no-store -->` 时禁止优先。没有标记返回 `capture_not_requested`，不保存、不续聊。自然语言限制仍依赖模型遵循，但遗漏标记的失败方向是缺来源，不是未经明确请求保存。文件不可编辑不自动等于禁止保存答复。

早期“默认保存、负向标记退出”的候选在真实禁止留存测试中失败，已撤回；不能把该候选的闭环验证直接视为本版授权规则的验证。

已有隔离流和接收者 ACL 保持。OMO 元数据不会额外泄漏接收者不可见的自动记录 ID。捕获失败只记录缺口并在可用时提示，不重新唤醒模型、补写原作者结论或阻断回答。2 秒桥接预算到期不撤销已经开始的宿主留存；结果可能稍后可检索，此时本次交付元数据仍为未知。

## 工件版本

最终正文可以包含明确的 `file://` URI。BCP 在作者的既有 `read` / `external_directory` 授权内，沿用真实路径再授权、普通文件限制、快照、hash 和配额检查。添加 `#sha256=<64 hex>` 可拒绝与指定版本不一致的文件。引用后紧随的中文括号或句读作为分隔，路径内这些字符应百分号编码。普通散文路径不自动读取。

最多检查前 16 个去重的显式 `file://` / `bb://` 引用，其中本地快照仍限 8 文件、每文件 4 MiB。超出、不可读或版本不符时，正文仍忠实留存，但 `origin.source_errors` 披露缺口；不声称来源验证成功。来源检查和语义核对责任不变：抓到了当前文件不代表它就是实际被审版本。外部 URL 和未抓取内容保留在原文中，不宣称验证。

每条正文保持原有 256 KiB 上限；超出不截断冒充完整来源。scope 配额仍有效。若快照已写而记录配额提交失败，快照可能保留占用空间，但没有成功记录，也不返回成功引用。

## 分发文案

以下两段分别对应 v1 自动模式的 `board_put` 与 `task` 描述；`board_get`、`board_index` 和聚合压力规则继续沿用。`DESIGN.md` §11.6 四段旧文案限定用于手动模式与 v2。已准入输入的公共 system 提示单次注入 `AUTO_CAPTURE_INSTRUCTION`，集中说明首行标记、禁止优先及无需工具调用；工具说明不再重复该约定。此提示仍依赖模型遵循，不能据此保证每份结果都被保存。

```text
Write the final result once with outcome, basis, limits and exact versions; follow the host's capture convention. Use file:// URIs for local snapshots; #sha256=<64 hex> requires matching bytes, not semantic acceptance. Use board_put only for a distinct source needed before completion or an explicitly requested record. Never duplicate the final result in board_put, including just to assign a kind. source_refs must be exact files or references, not directories or commentary.
```

```text
Pass original constraints and exact source/artifact versions, including bb:// IDs, in task.prompt. The author writes the result once; the host retains the final text and returns its reference. Do not require a publication tool call or restate the author's findings. Check referenced author text, limits and input versions under board_get's rules before reuse. Forward the same references for review or revision. Host capture proves retained text, not sufficient evidence or acceptance; report missing or restricted sources. Publication restrictions must be passed through; file-edit limits alone do not prohibit capture.
```

主角色不再索取手动发布或要求作者生成尚未存在的 ID。writer、fixer 和 reviewer 保留成果质量、版本、限制及原始引用要求，删除最终强制发布句。原始记录可用于定位被审版本和作者已声明的限制；作者自检与其他评审的结论不替代独立评审依据。
