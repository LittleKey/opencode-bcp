# opencode-bcp

Blackboard Coordination Protocol（黑板协作协议）——opencode 的多 agent 持久化记录与决策插件。

## 解决什么问题

多个 agent 协作时，关键信息靠对话转述逐跳传递：每转一手，原文就失真一分。任务约束被简化、结论被意译、来源被丢掉，几跳之后没有人能说出"这个决定依据的原文在哪"。

BCP 把需要留存的信息写成**持久记录**：原文可取回、来源可溯源、修订可导航。任何 agent（以及人类）都能通过完整 ID 直接读回最初写下的内容，而不是依赖链条中间某一环的记忆或复述。

## 状态（如实声明）

| 宿主 | 状态 |
|---|---|
| opencode 1.x（v1 插件 API） | 已部署；公开正文边界、真实消息 ID 查询及无保存提示的多 agent 交接见 [v1.17 验收](harness/acceptance/v1.17.0.md)，历史阶段版本绑定、跨作者补存与续接闭环分别见 v1.16、v1.15、v1.14 验收 |
| opencode 2.0.16+（v2 插件 API） | 适配层已实现，41 项 adapter 测试通过；**真实 v2 宿主端到端验收尚未执行**，v2 安装属尝鲜性质 |

「独立插件」与「已验证集成」是两种不同的承诺：前者在默认 v1 提供四工具及最终正文留存，后者额外固定 OMO 的终态、通知和引用交付接线。工具可见、安装成功或记录存在均不等于完整行为通过。v2 保持旧版四工具接口，真实加载与行为尚未验收；各版本的测试配置、适用范围和遗漏以对应验收记录为准。OMO 集成与安装边界见 [INSTALL.md](INSTALL.md)。

设计契约见 [DESIGN.md](DESIGN.md)；当前 [v1.17 公开来源规则](docs/public-source-v1.17.md)要求先有用户可读的公开正文，再按真实消息 ID 留存。隐藏推理、工具参数、尚未写出的报告和纯协议标记都不能充当正文。默认 v1 不再暴露 `board_put`。已有记录直接复用；尚未留存的原消息通过 `board_store` 留存后，只传完整引用和新增要求。宿主保留真实作者与原编辑版本，接收者核对原文。历史验收只适用于其标注版本，既有冻结配置的 82 项检查见 [v1.14 验收](harness/acceptance/v1.14.0.md)。

默认 v1 从原作者的编辑证据和正文中的确切文件引用自动生成 `source_refs`；`board_store` 不接收调用者重写的正文、作者或文件清单。每次最多 8 个文件、每文件 4 MiB，计入 scope 配额。手动模式保留 `board_put` 的本地来源参数。`board_get` 的 `verified_bytes_only` 只证明快照字节，结论和覆盖范围仍需核对。当前 v2 缺少文件授权接口，自动快照请求会被拒绝；其他引用渠道保持可用。

## 核心模型速览

- **scope**：授权隔离单元。跨 scope 读取一律返回统一的 `forbidden`，与"记录不存在"逐字节一致——无存在性泄漏。
- **stream**：会话流。每个会话的记录归属各自的 stream，父子会话隔离；fork 源与委派父是两种不同的 parent 关系。
- **record**：持久记录，通过 `bb://<scope>/<stream>/<entry>` 完整 ID 定位。写入后不可变；更正通过 `supersedes` 建立导航边，旧 ID 恒可取回。
- **kind** 六值：`note` / `finding` / `change` / `review` / `decision` / `index_summary`。
- **source_refs**：来源定位。记录应携带可核验的来源引用；"引用字符串"本身不构成证据。
- **covered_by**：聚合产生的导航边——目录被折叠进摘要后，原条目仍按 ID 完整可取。

## 工具

| 工具 | 职责 |
|---|---|
| `board_store` | v1：发现已完成最终答复或已稳定公开阶段正文，按真实作者原样留存，自动带入可核验的历史编辑版本 |
| `board_get` | 按 ID 读回确切记录；原文和版本仍在当前上下文中且无变更信号时，可复用已完成的核对 |
| `board_index` | 检索发现：按 stream / kind / 关键词定位相关 ID |
| `board_aggregate` | 把多条旧目录项折叠为一条索引摘要：只缩目录，原文恒可 `board_get` |

v1 手动模式（`autoCapture: false`）仍提供 `board_put`；v2 保持包含 `board_put` 的旧版四工具，不提供 `board_store`。

## 记录生命周期示例

一个典型的多跳协作场景：

1. **作者生成一次**：评审 agent 在最终答复中给出结论、依据、限制和被审版本；v1 宿主忠实留存并把 ID 附加到委派结果。缺失记录时可按原消息补存。自动记录不猜测分类，已有记录的补存也不改变其分类。
2. **下游按 ID 取回**：实施 agent 收到的是 ID 而非转述——`board_get` 读回评审原文与结论，不依赖中间人的复述。
3. **用户裁定后链式引用**：orchestrator 在公开阶段正文表达决定及其依据、限制，正文和同条消息的工具调用结束后，用 `board_store` 首次留存为 `decision`；下游收到原记录 ID 并只实施获批范围。
4. **新版本保留旧来源**：修订正文引用旧记录与新工件版本，旧 ID 永不消失。已有 `supersedes` 导航边和手动模式接口仍保留；默认留存工具不增加关系编辑参数。
5. **目录增长后折叠**：压力信号提示后 `board_aggregate` 把旧目录项折成 `index_summary`，`covered_by` 边保留导航；需要原文时仍按旧 ID `board_get`。

## 设计哲学

**一次表达，原文交接。** v1 默认由宿主留存最终正文，失败时报告缺口，不触发模型补发或阻断回答。接收者仍核对来源、版本和限制。目录增长保留有预算的聚合压力提醒；手动模式保留旧发布观察。委派输入中格式错误的 SHA-256 声明仍提示版本未核验。

**授权是硬边界。** 跨 scope 读取不区分"存在但无权"与"不存在"，统一 `forbidden`，不泄漏存在性。

**聚合不删数据。** `board_aggregate` 只做目录折叠并建立 `covered_by` 导航边；被折叠的原条目按原 ID 永久可取。没有静默丢弃。

**身份保守。** 无法证明消息边界的轮次归属时保持 unknown：不注入、不推进轮次预算、不生成随机 ID 补齐，并同步落盘保守失效状态。宁可少提醒，不超预算。

**共享核心，分开声明宿主能力。** v1/v2 共用 scope、stream、文件锁和事务。v1.13 通过可选 `origin` 字段保留旧记录兼容，自动留存只在 v1 接入；v2 继续手动发布，不把双构建成功解释为运行能力等同。

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
bash scripts/install.sh        # v1 宿主（opencode 1.x），全局安装
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
  adapters/v2/      # opencode 2.x 适配层（真实宿主验收待执行）
test/               # 单元、契约及插件接线测试
scripts/install.sh  # 安装脚本（v1/v2 双模式）
harness/            # 验收记录与工具
integrations/omo-slim/ # 锁定 OMO 2.2.25 的适配自有源码
DESIGN.md           # 设计契约全文（v1.17.0）
```

## License

TBD（仓库尚未确定许可证字段）。
