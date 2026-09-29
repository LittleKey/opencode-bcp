# BCP v1.18：正文优先发现

## 工具接口与兼容性

`board_index({query: "cancelled 优先"})` 在当前 scope 内所有已授权流中搜索已发布正文和工件原始路径。`range: "own"` 限定本流，`stream` 明确指定一个可见流；跨 scope 和隔离流不因此开放。`description` 保持原值，仅作为展示名称，不参与本模式召回或打分。没有额外模型调用，也没有改写旧记录。

不传 `query` 时维持原来的单流目录浏览，容许附带 `range: "own"`；`range: "authorized"` 必须提供 query，不能隐式展开全板目录。`keyword` 是兼容用的 description 子串过滤，与 `query` 互斥；新发现流程使用 `query`。`since_seq` 在检索模式必须同时明确 `stream` 或 `range: "own"`，避免将不同流的序号视为全局时间。

检索返回 `search.items`，包含完整 ID、流、作者、原始 description、分类（若存在）、分数、命中词、原文片段及导航状态；目录模式仍返回 `stream.items`。检索默认 10 条、最多 50 条；目录默认 50 条、最多 200 条。片段至多 240 个 Unicode 字符，`start/end` 是原始字段的 UTF-16 偏移。片段和分数不是结论或版本验收，使用前仍需 `board_get`。

## 匹配、排序与范围

- 中文连续文本取双字片，单汉字保留；英文、数字和下划线标识符保留完整词并忽略大小写，同时拆出字母、数字和下划线片段，兼容 `HTTP500` 与 `HTTP 500` 等写法。空白分隔的查询组都必须命中；含汉字的组至少覆盖 60% 词片，其他组要求全部词项。查询最多 200 个 UTF-16 单元、32 个不同词项。
- 仅处理正文和已发布路径，不读链接文件内容、原始用户请求、编辑缓存或隐藏推理。已知 BCP 协议标记不参与检索；本 scope 留存缓存的物理地址不冒充业务路径。
- 使用词频、可见语料中的逆文档频率和正文长度归一化，额外提高确切正文短语与确切路径匹配的排名；同分按完整 ID 稳定排序。描述和 agent 名称不影响分数。分数只在本次查询内比较。
- 授权过滤先于读取、统计和排序；隐藏流不参与分数、命中数、片段或快照指纹。正文查询可穿透目录折叠找到原记录；默认排除撤回项，`view: "all"` 可查询并标明撤回状态。没有默认分类过滤；显式 `kind` 仍严格筛选已有分类，不推测未分类记录。
- 当前是确定性词法检索，不做同义词、跨语言翻译或语义推断。否定、引用、过时结论也可能包含查询词，接收者应读取原文及适用范围。

## 边界与分页

第一版在查询时从规范记录构建结果，不引入持久化索引。持有原有 scope 锁恢复已授权流并读取一致视图。单次最多检查 5000 个条目、读取 32 MiB；单条上限 512 KiB。预算耗尽、记录损坏或流不可读时返回 `coverage: "incomplete"` 及原因；空结果不能证明资料不存在，可限定流或增加 `since_seq` 缩小范围。`complete` 仅指本模式扫描完成，不代表语义覆盖或检索必然正确。

游标绑定调用者、scope、查询、授权流集合、过滤条件、页大小及可见语料指纹。可见记录写入/改变、导航变化或权限变化会拒绝旧游标，而不是混合不同结果页；调用方重新发起查询。跨调用者、目录游标或不同查询不能复用。分页重新验证语料，不是持久化搜索会话。

## 默认 v1 的常驻说明

```text
Discover unknown source IDs with query: search published content and artifact paths across authorized streams in this scope. Use a few focused terms; inspect ranked original snippets, then board_get selected records. Descriptions are display labels, not search evidence. range=own or stream narrows search. Without query, list the own-stream catalog; keyword is its legacy description filter. Incomplete coverage or a miss is not proof of absence; report gaps. A stale search cursor requires a fresh query. Avoid speculative searches and full-board dumps.
```

旧手动模式及 v2 保留旧说明；底层 `board_index` 同样接受显式的新查询参数。构建通过不等于已在真实 v2 宿主验证。
