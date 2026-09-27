# opencode-bcp

Blackboard Coordination Protocol（黑板协作协议）——opencode 的多 agent 持久化记录与决策插件。

## 解决什么问题

多个 agent 协作时，关键信息靠对话转述逐跳传递：每转一手，原文就失真一分。任务约束被简化、结论被意译、来源被丢掉，几跳之后没有人能说出"这个决定依据的原文在哪"。

BCP 把需要留存的信息写成**持久记录**：原文可取回、来源可溯源、修订可导航。任何 agent（以及人类）都能通过完整 ID 直接读回最初写下的内容，而不是依赖链条中间某一环的记忆或复述。

## 状态（如实声明）

| 宿主 | 状态 |
|---|---|
| opencode 1.x（v1 插件 API） | 生产验证完整：单元 + 验收 + 多轮 live 验收（详见 [harness/acceptance/results.md](harness/acceptance/results.md)） |
| opencode 2.0.16+（v2 插件 API） | 适配层已实现，41 项 adapter 测试通过；**真实 v2 宿主端到端验收尚未执行**，v2 安装属尝鲜性质 |

「独立插件」与「已验证集成」是两种不同的承诺：前者只提供四工具与决策规则描述及安装接线检查（工具可见 + decision 日志；**接线检查不等于描述分发或行为验证**；v2 为实验性质，真实加载与行为未验收，不承诺任意宿主行为实效），后者附带经行为电池验证的集成快照（插件构建、宿主、模型、fixer 工具面与角色桥接 hash、驻留验证方法）。已验证 omo-slim 集成配置与承诺边界见 [INSTALL.md](INSTALL.md)「已验证 omo-slim 集成配置」。

设计契约见 [DESIGN.md](DESIGN.md)（v1.12.0）；宿主身份与独立交付元数据见 [docs/delivery-integration-v1.12.md](docs/delivery-integration-v1.12.md)。已有快照、有限观察和默认发布义务保持；历史验收只适用于其标注版本。

v1 可直接在 `source_refs` 提交获准发布的本地绝对路径；工具经文件权限检查后保留快照、计算 SHA-256，并返回可核验引用。每次最多 8 个文件、每文件 4 MiB，计入 scope 配额。`board_get` 的 `verified_bytes_only` 只证明快照字节，结论和覆盖范围仍需核对。当前 v2 缺少文件授权接口，自动快照请求会被拒绝；其他引用渠道保持可用。

## 核心模型速览

- **scope**：授权隔离单元。跨 scope 读取一律返回统一的 `forbidden`，与"记录不存在"逐字节一致——无存在性泄漏。
- **stream**：会话流。每个会话的记录归属各自的 stream，父子会话隔离；fork 源与委派父是两种不同的 parent 关系。
- **record**：持久记录，通过 `bb://<scope>/<stream>/<entry>` 完整 ID 定位。写入后不可变；更正通过 `supersedes` 建立导航边，旧 ID 恒可取回。
- **kind** 六值：`note` / `finding` / `change` / `review` / `decision` / `index_summary`。
- **source_refs**：来源定位。记录应携带可核验的来源引用；"引用字符串"本身不构成证据。
- **covered_by**：聚合产生的导航边——目录被折叠进摘要后，原条目仍按 ID 完整可取。

## 四个工具

| 工具 | 职责 |
|---|---|
| `board_put` | 发布或复用一份任务交付（终结交付，含 blocked / no-issues）：精确约束、结论、适用范围与必要来源；返回完整 `bb://` ID |
| `board_get` | 按 ID 读回确切记录；原文和版本仍在当前上下文中且无变更信号时，可复用已完成的核对 |
| `board_index` | 检索发现：按 stream / kind / 关键词定位相关 ID |
| `board_aggregate` | 把多条旧目录项折叠为一条索引摘要：只缩目录，原文恒可 `board_get` |

## 记录生命周期示例

一个典型的多跳协作场景：

1. **评审产出记录**：评审 agent 完成后 `board_put` 一条 `review`，正文区分"所审原文"与"分析结论"，附 `source_refs` 指向被审工件的确切版本，返回 `bb://...` 完整 ID。
2. **下游按 ID 取回**：实施 agent 收到的是 ID 而非转述——`board_get` 读回评审原文与结论，不依赖中间人的复述。
3. **用户裁定后链式引用**：orchestrator 写入 `decision`，引用所采纳的 `review` ID 与版本；下游只实施获批范围。
4. **修订而非改写**：契约修订时新记录用 `supersedes` 指向旧记录；旧 ID 永不消失，任何时点的结论都可回溯。
5. **目录增长后折叠**：压力信号提示后 `board_aggregate` 把旧目录项折成 `index_summary`，`covered_by` 边保留导航；需要原文时仍按旧 ID `board_get`。

## 设计哲学

**规则常驻，按具体缺口提示。** 交付、路由及限制规则由工具描述承载。目录增长时保留有预算的聚合压力提醒。v1 按当前已准入输入观察原生文件编辑与发布；无关路径、旧记录重放或旧输入回调不能替代新的版本证明。日志区分缺口与未确认状态，缺口另发界面通知；正确快照不代表语义验收。委派输入中格式错误的 SHA-256 声明仍附加一次版本未核验提示。检查不自动发布、触发模型重试或阻断回答。

**授权是硬边界。** 跨 scope 读取不区分"存在但无权"与"不存在"，统一 `forbidden`，不泄漏存在性。

**聚合不删数据。** `board_aggregate` 只做目录折叠并建立 `covered_by` 导航边；被折叠的原条目按原 ID 永久可取。没有静默丢弃。

**身份保守。** 无法证明消息边界的轮次归属时保持 unknown：不注入、不推进轮次预算、不生成随机 ID 补齐，并同步落盘保守失效状态。宁可少提醒，不超预算。

**v1 行为零变更承诺。** v2 适配层不改动存储布局（数据目录、文件锁、锁内事务原样）、不改记录 schema、不改授权语义——两个宿主版本共享同一 core，只有接线方式不同（[DESIGN.md](DESIGN.md) §16）。

## 明确不做的事

以下是设计契约（[DESIGN.md](DESIGN.md) §1）中经评审明确放弃的方向，避免使用者对其产生错误期待：

- 不代写：插件不替 agent 生成记录内容，只提供记录、检索与导航。
- 不以缺 ID 阻断回答或自动发布；文件权限、大小、配额和显式哈希错误可使本地工件发布请求被拒绝。语义合规仍须执行 agent 判断。
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
integrations/omo-slim/ # v1.12 OMO 适配自有源码
DESIGN.md           # 设计契约全文（v1.12.0）
```

## License

TBD（仓库尚未确定许可证字段）。
