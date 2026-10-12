# opencode-bcp

Blackboard Coordination Protocol（黑板协作协议）——opencode 的多 agent 持久化记录与决策插件。

## 解决什么问题

多个 agent 协作时，关键信息靠对话转述逐跳传递：每转一手，原文就失真一分。任务约束被简化、结论被意译、来源被丢掉，几跳之后没有人能说出"这个决定依据的原文在哪"。

BCP 把需要留存的信息写成**持久记录**：原文可取回、来源可溯源、修订可导航。任何 agent（以及人类）都能通过完整 ID 直接读回最初写下的内容，而不是依赖链条中间某一环的记忆或复述。

## 状态（如实声明）

| 宿主 | 状态 |
|---|---|
| opencode 1.x（v1 插件 API） | 2.0.0 组合已安装到生产配置，声明最低 1.18.29。实际宿主现为 1.18.35：2026-10-09 随 OMO 3.0.3 升级在该二进制重做隔离检查并完成生产进程核验（见 [OMO 3.0.3 记录](integrations/omo-slim/README.md)）。v2.0.0 验收时点为 1.18.33：独立新进程核对配置、文件模式及认证来源，通过服务端 API 完成一次实际模型冒烟。见 [v2.0.0 验收](harness/acceptance/v2.0.0.md) |
| opencode 2.0.20+（v2 插件 API） | 与 v1 共用同一 dual-entry 构建产物。2.0.20 的作者—评审—返修闭环、HTTP/SSE 隐私和安装回滚验证通过；生产 CLI 未迁移到 v2。双宿主闭环各 27 项检查使用脚本响应，核心 426 项测试通过；不据此宣称自然模型质量。见 [v2.0.0 验收](harness/acceptance/v2.0.0.md) |

「独立插件」与「已验证集成」是两种不同的承诺：前者在默认 v1/v2 提供四工具及最终正文留存，后者额外固定 OMO 的终态、通知和引用交付接线。工具可见、安装成功或记录存在均不等于完整行为通过。2.0.0 发布复审已通过，实际范围与剩余限制以验收记录为准；独立 CLI `run` 的额外真实模型探针未通过，服务端 API 探针通过。OMO 集成与安装边界见 [INSTALL.md](INSTALL.md)。

设计契约见 [DESIGN.md](DESIGN.md)；当前 [v1.17 公开来源规则](docs/public-source-v1.17.md)要求先有用户可读的公开正文，再按真实消息 ID 留存。隐藏推理、工具参数、尚未写出的报告和纯协议标记都不能充当正文。默认 v1 不再暴露 `board_put`。已有记录直接复用；尚未留存的原消息通过 `board_store` 留存后，只传完整引用和新增要求。宿主保留真实作者与原编辑版本，接收者核对原文。历史验收只适用于其标注版本，既有冻结配置的 82 项检查见 [v1.14 验收](harness/acceptance/v1.14.0.md)。

默认 v1 从原作者的编辑证据和正文中的确切文件引用自动生成 `source_refs`；`board_store` 不接收调用者重写的正文、作者或文件清单。每次最多 8 个文件、每文件 4 MiB，计入 scope 配额。手动模式保留 `board_put` 的本地来源参数。`board_get` 的 `verified_bytes_only` 只证明快照字节，结论和覆盖范围仍需核对。文件证据快照是 v1/v2 共享核能力：仅当作者当轮权限规则明确 allow 相应路径时才留存，deny/ask/未知一律不快照（fail closed）。

不知道记录 ID 时，小 scope 优先使用 `board_index({range: "authorized"})` 浏览跨授权流的紧凑目录，再以 `board_get` 读取原文。自动留存支持 `<!-- bcp:store description="主题、结论与重要限制" -->`，标题与正文同次生成，不增加摘要模型请求；旧标记继续支持。语法、目录覆盖及预算见 [v1.19 详细设计](docs/catalog-discovery-v1.19.md)。

查找具体细节或目录较大时，使用 `board_index({query: "cancelled 优先"})` 搜索公开正文和工件路径，按相关性返回原文片段。description 不参与 query 评分；省略 range 的本人目录与旧 keyword 标题过滤保持兼容。词法检索限制见 [v1.18 契约](docs/content-search-v1.18.md)。

委派返回的呈现与 Council 取证：作者超长且字节精确的完整终态原文可呈现为 `<bcp_result_reference>` 检索回执（接收者须先 `board_get` 取回原文；回执不是验收），未知、更短或不匹配的输出保留原文——该交付引用回执契约经共享核在 v1 与 v2 宿主均接入（v2 侧由 OMO 3.0.1 交付 helper 对原生 subagent 包装做严格字节/身份校验后替换）。Council 问题中显式的 `ses_*` / `cou-N` 宿主原文装配是 2.2.25 部署基线的历史行为，仅存在于 v1 历史集成；3.0.1 起 Council 使用上游自身实现，主角色不再组织私人席位，宿主不再做该取证拼接。历史契约与限制见 [v1.20 编排集成](docs/orchestration-v1.20.md)。

## 核心模型速览

- **scope**：授权隔离单元。跨 scope 读取一律返回统一的 `forbidden`，不区分目标是否存在——无存在性泄漏；同 scope 内隐藏目标与不存在目标统一返回 `not_found`，二者逐字节一致。
- **stream**：会话流。每个会话的记录归属各自的 stream，父子会话隔离；fork 源与委派父是两种不同的 parent 关系。
- **record**：持久记录，通过 `bb://<scope>/<stream>/<entry>` 完整 ID 定位。写入后不可变；更正通过 `supersedes` 建立导航边，旧 ID 恒可取回。
- **kind** 六值：`note` / `finding` / `change` / `review` / `decision` / `index_summary`。
- **source_refs**：来源定位。记录应携带可核验的来源引用；"引用字符串"本身不构成证据。
- **covered_by**：聚合产生的导航边——目录被折叠进摘要后，原条目仍按 ID 完整可取。

## 工具

| 工具 | 职责 |
|---|---|
| `board_store` | 发现已完成最终答复或已稳定公开阶段正文，按真实作者原样留存，自动带入可核验的历史编辑版本 |
| `board_get` | 按 ID 读回确切记录；原文和版本仍在当前上下文中且无变更信号时，可复用已完成的核对 |
| `board_index` | 无 query 的 `range="authorized"` 浏览跨流紧凑目录；`query` 搜索正文和路径；省略两者浏览本人目录 |
| `board_aggregate` | 把多条旧目录项折叠为一条索引摘要：只缩目录，原文恒可 `board_get` |

v1/v2 默认 auto 模式都不提供 `board_put`（自动留存 + `board_store`）；显式 `autoCapture: false` 的手动模式在两宿主上都额外注册 `board_put` 旧契约（与 `board_store` 并存），兼容既有禁发布角色配置。

## 记录生命周期示例

一个典型的多跳协作场景：

1. **作者生成一次**：评审 agent 在最终答复中给出结论、依据、限制和被审版本；v1 宿主忠实留存并把 ID 附加到委派结果。缺失记录时可按原消息补存。自动记录不猜测分类，已有记录的补存也不改变其分类。
2. **下游按 ID 取回**：实施 agent 收到的是 ID 而非转述——`board_get` 读回评审原文与结论，不依赖中间人的复述。
3. **用户裁定后链式引用**：orchestrator 在公开阶段正文表达决定及其依据、限制，正文和同条消息的工具调用结束后，用 `board_store` 首次留存为 `decision`；下游收到原记录 ID 并只实施获批范围。
4. **新版本保留旧来源**：修订正文引用旧记录与新工件版本，旧 ID 永不消失。已有 `supersedes` 导航边和手动模式接口仍保留；默认留存工具不增加关系编辑参数。
5. **目录增长后折叠**：压力信号提示后 `board_aggregate` 把旧目录项折成 `index_summary`，`covered_by` 边保留导航；需要原文时仍按旧 ID `board_get`。

## 设计哲学

**一次表达，原文交接。** 默认模式（v1/v2 同口径）由宿主留存最终正文，失败时报告缺口，不触发模型补发或阻断回答。接收者仍核对来源、版本和限制。目录增长保留有预算的聚合压力提醒；手动模式保留旧发布观察。委派输入中格式错误的 SHA-256 声明仍提示版本未核验。

**授权是硬边界。** 跨 scope 读取不区分"存在但无权"与"不存在"，统一 `forbidden`，不泄漏存在性。

**聚合不删数据。** `board_aggregate` 只做目录折叠并建立 `covered_by` 导航边；被折叠的原条目按原 ID 永久可取。没有静默丢弃。

**身份保守。** 无法证明消息边界的轮次归属时保持 unknown：不注入、不推进轮次预算、不生成随机 ID 补齐，并同步落盘保守失效状态。宁可少提醒，不超预算。

**共享核心，分开声明宿主能力。** v1/v2 共用 scope、stream、文件锁和事务，自动留存、目录/聚合与文件证据快照经共享核在两宿主接入，各自按宿主权限面复核。v1.13 通过可选 `origin` 字段保留旧记录兼容；行为等同仍以各宿主验收记录为准，不把双构建成功解释为运行能力等同。

## 明确不做的事

以下是设计契约（[DESIGN.md](DESIGN.md) §1）中经评审明确放弃的方向，避免使用者对其产生错误期待：

- 不代写：插件不替 agent 生成记录内容，只提供记录、检索与导航。
- 不以缺 ID 阻断回答或触发模型补写；自动留存只保存作者既有正文。文件权限、大小、配额和显式哈希错误会形成明确缺口，语义合规仍须接收者判断。
- 不做模型白名单或按模型禁用功能。
- 不修改用户的全局配置（如 AGENTS.md），不注入长篇常驻 prompt。
- 关键词触发的入口提醒已退役（v1.6.0）：实测未见独立改善行为的证据，且覆盖与维护成本不划算；规范句只是普通任务措辞。
- 聚合不删除任何原文：只做目录折叠。

## 快速开始

安装步骤见 [INSTALL.md](INSTALL.md)。最小路径：

```bash
git clone <本仓库>
cd opencode-bcp
bash scripts/install.sh        # 检测 PATH 中的 opencode 并按宿主 major 安装（全局）
# 重启 opencode 后生效
```

## 开发

```bash
bun install
bun test          # 当前源码的单元、契约及插件接线验证
bunx tsc --noEmit # 类型检查
```

## 目录结构

```
src/
  tools.ts          # 四工具定义（宿主无关 core）
  message-store.ts  # v1 原消息发现与留存
  reply.ts          # 最终答复和已稳定阶段正文的资格与边界
  edit-evidence.ts  # 按作者与输入保留原生编辑证据
  permissions.ts    # scope/stream 授权语义
  storage.ts        # 数据目录、文件锁、锁内事务
  indexing.ts       # 目录与关键词检索
  aggregate.ts      # 目录折叠与 covered_by 导航
  rounds.ts         # 轮次时钟
  nudge.ts          # 提醒决策与预算事务（decideAndPersist）
  ids.ts            # 稳定 ID 生成
  schema.ts         # 消息 schema（Zod 4）
  eligibility.ts    # 目录压力资格判定
  constants.ts      # 常量单源
  adapters/v1/      # opencode 1.x 插件入口与 hook 接线
  adapters/v2/      # opencode 2.x 适配层（2.0.20；限定验收见 harness/acceptance/v2.0.0.md）
test/               # 单元、契约及插件接线测试
scripts/install.sh  # 按宿主检测的事务性安装（单一 canonical 文件 + 安装清单）
scripts/uninstall.sh # 所有权校验式卸载
harness/            # 验收记录与工具
integrations/omo-slim/ # OMO 适配自有源码（2.2.25 部署基线 + 3.0.1 双入口构建）
DESIGN.md           # 设计契约全文
```

## License

TBD（仓库尚未确定许可证字段）。
