# opencode-bcp

Blackboard Coordination Protocol（黑板协作协议）——opencode 的多 agent 持久化记录与决策插件。

## 解决什么问题

多个 agent 协作时，关键信息靠对话转述逐跳传递：每转一手，原文就失真一分。任务约束被简化、结论被意译、来源被丢掉，几跳之后没有人能说出"这个决定依据的原文在哪"。

BCP 把需要留存的信息写成**持久记录**：原文可取回、来源可溯源、版本可核验。

## 当前默认入口：独立 V2 快照归档（`bcp_save`）

当前默认入口是独立 V2 快照归档 `src/file-archive.ts`（插件 ID `opencode-bcp-file-archive`），只依赖 OpenCode V2，不依赖 OMO，不加载旧 Blackboard 工具，也不改写提示与会话历史。

### `bcp_save` 快照语义

`bcp_save({ sessionId, messageId? })` 只保存调用者本会话或获准直属子会话中**已存储的已完成（`finish: "stop"`）助理回复快照**：

- **参数与候选选择**：`sessionId` 必填（来源会话 ID，限本会话或 `parentID === 调用者会话` 的非 fork 直属子会话）；`messageId` 可选。提供 `messageId` 时精确读取该条消息；省略时只读取该会话最新一条助理消息（`limit: 1`）并要求来源会话当前非活跃，不回退到更早的成功回复。
- **不接受正文或标签**：不接受 `text`、`description` 等自由正文或摘要参数，不要求 `<!-- bcp:store -->` 等正文标记；若正文中含 `<!-- bcp:no-store -->` 则跳过保存。生成中（in-flight / `pending`）或非 `stop` 结束的回复不能保存。
- **无自动捕获**：**没有后台自动捕获。** 保存快照不证明该回复是某次派发的最终结论，也不复现父会话通知。
- **按确切版本文件交接**：发布前在任务锁内按消息 ID 重新读取并校验快照未变，写入 `.opencode/work/<task-id>/archive/`，返回项目相对的 `meta.json`（及单段文本的 `body.txt`）路径与 64 位 SHA-256 `version`。后续任务直接传递这些可访问的确切版本文件路径，无需 `board_get` / `board_export`，也不注册 export 工具。交接约定见 [docs/file-handoff.md](docs/file-handoff.md)。
- **工作目录与权限边界**：任务材料统一放在 `.opencode/work/<task-id>/{reports,archive,scratch/<run-id>}`；按协作约定 `archive/` 留给 BCP 写入（非文件系统或宿主 ACL 强制独占），正式交付物仍留在受版控项目路径，既有 Deepwork（`.slim/deepwork/`）路径不变。任务根通过普通派发传递，无需加载专用 skill。目录存在、`.gitignore` 或工具可见均不构成留存或读取授权；缺少显式配置、算子策略或宿主 `read` / `bcp_save` / `edit` 权限时一律 fail closed。原生权限断言的实际强制行为取决于宿主实现；`bcp_save` 对相对归档路径的 `edit` 断言是叠加在算子留存策略上的附加检查而非专属写入者隔离，向调用者授予归档路径 `edit` 权限也可能允许其对该路径执行常规编辑（不宣称 2.3.2 等宿主的独立运行态等价证明）。SHA-256 哈希仅用于校验经可信路径写入时的快照与文件自洽性，不提供带密钥/签名的来源证明（keyed/signed provenance），也不防具备写权限者或同 UID 进程同时改写正文与清单（`body` + `meta.json` / `index.jsonl`）。范围、配置契约与索引语义见 [docs/file-archive-implementation.md](docs/file-archive-implementation.md)。

## 快速开始（默认 V2 快照归档）

构建独立 V2 快照归档产物（仅生成仓库内 `dist/file-archive/file-archive.js`，不安装或激活插件，也不触发宿主/模型请求）：

```bash
bun run build
# 等价于：bash scripts/build-file-archive.sh
```

完整安装与离线打包步骤见 [INSTALL.md](INSTALL.md)：

- **独立 OpenCode V2 配置（不合并现有配置、不创建归档授权）**：
  ```bash
  bun run build
  node scripts/install-file-archive.mjs \
    --target /absolute/private-parent/new-bcp-profile \
    --project /absolute/private-worktree --port 4096
  ```
- **OpenChamber 2.7.2 离线扩展打包（仅生成未安装扩展目录，不写入授权文件或修改宿主配置）**：
  ```bash
  bun run build
  node scripts/package-openchamber.mjs \
    --target /absolute/private-parent/new-extension \
    --host /absolute/path/to/installed/@openchamber/web \
    --options /absolute/private-operator/options.json
  ```

构建或打包成功不代表已获留存授权，也不代表已通过真实宿主、权限和最终请求的完整验收。

---

## 旧 Blackboard 模式（历史兼容：`build:legacy` / `scripts/install.sh`）

> 以下 `bb://` 黑板工具链（`board_store` / `board_get` / `board_index` / `board_aggregate` / `board_export`）、双宿主 `dist/blackboard.ts` 构建（`bun run build:legacy` / `bash scripts/build.sh`）及 `bash scripts/install.sh` 属于旧 Blackboard 模式，仅供既有配置维护与历史验收追溯，**不推荐作为当前快速开始**。

### 历史宿主状态（如实声明）

| 宿主 | 状态 |
|---|---|
| opencode 1.x（v1 插件 API） | 旧 Blackboard 入口的历史最低版本声明为 1.18.29；见 [2.0.0 验收](harness/acceptance/v2.0.0.md)。此记录不适用于新的 V2 快照入口。 |
| opencode 2.0.20+（v2 插件 API） | 与 v1 共用同一 dual-entry 构建产物。2.0.20 的作者—评审—返修闭环、HTTP/SSE 隐私和安装回滚验证通过；生产 CLI 未迁移到 v2。双宿主闭环各 27 项检查使用脚本响应，核心 426 项测试通过；不据此宣称自然模型质量。见 [v2.0.0 验收](harness/acceptance/v2.0.0.md) |

旧版验收记录仅供追溯。BCP 不再维护 OMO 补丁、投递桥或 Council 桥。工具可见、安装成功或记录存在均不等于完整行为通过；当前安装入口见 [INSTALL.md](INSTALL.md)。

设计契约见 [DESIGN.md](DESIGN.md)；当前 [v1.17 公开来源规则](docs/public-source-v1.17.md)要求先有用户可读的公开正文，再按真实消息 ID 留存。隐藏推理、工具参数、尚未写出的报告和纯协议标记都不能充当正文。默认 v1 不再暴露 `board_put`。已有记录直接复用；尚未留存的原消息通过 `board_store` 留存后，只传完整引用和新增要求。宿主保留真实作者与原编辑版本，接收者核对原文。历史验收只适用于其标注版本，既有冻结配置的 82 项检查见 [v1.14 验收](harness/acceptance/v1.14.0.md)。

默认 v1 从原作者的编辑证据和正文中的确切文件引用自动生成 `source_refs`；`board_store` 不接收调用者重写的正文、作者或文件清单。每次最多 8 个文件、每文件 4 MiB，计入 scope 配额。手动模式保留 `board_put` 的本地来源参数。`board_get` 的 `verified_bytes_only` 只证明快照字节，结论和覆盖范围仍需核对。文件证据快照是 v1/v2 共享核能力：仅当作者当轮权限规则明确 allow 相应路径时才留存，deny/ask/未知一律不快照（fail closed）。

不知道记录 ID 时，小 scope 优先使用 `board_index({range: "authorized"})` 浏览跨授权流的紧凑目录，再以 `board_get` 读取原文。自动留存支持 `<!-- bcp:store description="主题、结论与重要限制" -->`，标题与正文同次生成，不增加摘要模型请求；旧标记继续支持。语法、目录覆盖及预算见 [v1.19 详细设计](docs/catalog-discovery-v1.19.md)。

查找具体细节或目录较大时，使用 `board_index({query: "cancelled 优先"})` 搜索公开正文和工件路径，按相关性返回原文片段。description 不参与 query 评分；省略 range 的本人目录与旧 keyword 标题过滤保持兼容。词法检索限制见 [v1.18 契约](docs/content-search-v1.18.md)。

委派通知由宿主或其编排插件负责。原先的引用回执替换与 Council 取证属于已移除的历史集成，见 [v1.20 编排集成记录](docs/orchestration-v1.20.md)。

ACP 外部代理（omo-slim `acpAgents` 的 `acp_run`，如 claude 顾问）：宿主确认的成功结果默认留存原文并逐份返回回执（`Retained: <ID>` 或 `Retention failed|skipped: <原因>`，随附固定指引行）；标题由任务首行 `Task:` 确定性生成（`ACP result: <代理> | <任务标题>`）；作者身份取 wrapper 会话的宿主确认身份，同一输入轮的 wrapper 转述自动去重。已在真实 claude 链路完成冒烟与重启后验证（含中文派发被前置守卫零触达拒绝）。契约见 [v1.21 ACP 工具结果留存](docs/acp-tool-result-v1.21.md)（v1 宿主专属）。

### 旧版核心模型速览

- **scope**：授权隔离单元。跨 scope 读取一律返回统一的 `forbidden`，不区分目标是否存在——无存在性泄漏；同 scope 内隐藏目标与不存在目标统一返回 `not_found`，二者逐字节一致。
- **stream**：会话流。每个会话的记录归属各自的 stream，父子会话隔离；fork 源与委派父是两种不同的 parent 关系。
- **record**：持久记录，通过 `bb://<scope>/<stream>/<entry>` 完整 ID 定位。写入后不可变；更正通过 `supersedes` 建立导航边，旧 ID 恒可取回。
- **kind** 六值：`note` / `finding` / `change` / `review` / `decision` / `index_summary`。
- **source_refs**：来源定位。记录应携带可核验的来源引用；"引用字符串"本身不构成证据。
- **covered_by**：聚合产生的导航边——目录被折叠进摘要后，原条目仍按 ID 完整可取。

### 旧版工具（`bb://` 黑板入口）

| 工具 | 职责 |
|---|---|
| `board_store` | 发现已完成最终答复或已稳定公开阶段正文，按真实作者原样留存，自动带入可核验的历史编辑版本 |
| `board_get` | 按 ID 读回确切记录；原文和版本仍在当前上下文中且无变更信号时，可复用已完成的核对 |
| `board_index` | 无 query 的 `range="authorized"` 浏览跨流紧凑目录；`query` 搜索正文和路径；省略两者浏览本人目录 |
| `board_aggregate` | 把多条旧目录项折叠为一条索引摘要：只缩目录，原文恒可 `board_get` |
| `board_export` | 按 `bb://` ID + 期望 sha256 把记录 JSON 逐字节导出到项目内 `.opencode/bcp/exports/`；可见性复用 `board_get` 可读路径，单次 1–8 条、≤512 KiB，原子发布且不覆盖既有文件。v1 与提供 `permission.assert` 的 v2 宿主支持；v2 无此能力时不注册工具。 |

v1/v2 默认 auto 模式都不提供 `board_put`（自动留存 + `board_store`）；显式 `autoCapture: false` 的手动模式在两宿主上都额外注册 `board_put` 旧契约（与 `board_store` 并存），兼容既有禁发布角色配置。

V2 导出在执行时读取会话的当前目录，并调用宿主 `permission.assert` 检查 `board_export` 权限；拒绝原样传播，目录未知则不导出。该权限能力由 OpenCode 2.1.1 提供，2.0.20 的类型接口尚无此能力。记录可读性、期望哈希、配额与原子写入继续由共享导出实现检查。

### 旧版记录生命周期示例

一个典型的旧版 `bb://` 多跳协作场景：

1. **作者生成一次**：评审 agent 在最终答复中给出结论、依据、限制和被审版本；v1 宿主忠实留存并把 ID 附加到委派结果。缺失记录时可按原消息补存。自动记录不猜测分类，已有记录的补存也不改变其分类。
2. **下游按 ID 取回**：实施 agent 收到的是 ID 而非转述——`board_get` 读回评审原文与结论，不依赖中间人的复述。
3. **用户裁定后链式引用**：orchestrator 在公开阶段正文表达决定及其依据、限制，正文和同条消息的工具调用结束后，用 `board_store` 首次留存为 `decision`；下游收到原记录 ID 并只实施获批范围。
4. **新版本保留旧来源**：修订正文引用旧记录与新工件版本，旧 ID 永不消失。已有 `supersedes` 导航边和手动模式接口仍保留；默认留存工具不增加关系编辑参数。
5. **目录增长后折叠**：压力信号提示后 `board_aggregate` 把旧目录项折成 `index_summary`，`covered_by` 边保留导航；需要原文时仍按旧 ID `board_get`。

### 旧版设计哲学

**一次表达，原文交接。** 旧版默认模式（v1/v2 同口径）由宿主留存最终正文，失败时报告缺口，不触发模型补发或阻断回答。接收者仍核对来源、版本和限制。目录增长保留有预算的聚合压力提醒；手动模式保留旧发布观察。委派输入中格式错误的 SHA-256 声明仍提示版本未核验。

**授权是硬边界。** 跨 scope 读取不区分"存在但无权"与"不存在"，统一 `forbidden`，不泄漏存在性。

**聚合不删数据。** `board_aggregate` 只做目录折叠并建立 `covered_by` 导航边；被折叠的原条目按原 ID 永久可取。没有静默丢弃。

**身份保守。** 无法证明消息边界的轮次归属时保持 unknown：不注入、不推进轮次预算、不生成随机 ID 补齐，并同步落盘保守失效状态。宁可少提醒，不超预算。

**共享核心，分开声明宿主能力。** 旧版 v1/v2 共用 scope、stream、文件锁和事务，自动留存、目录/聚合与文件证据快照经共享核在两宿主接入，各自按宿主权限面复核。v1.13 通过可选 `origin` 字段保留旧记录兼容；行为等同仍以各宿主验收记录为准，不把双构建成功解释为运行能力等同。

### 明确不做的事

以下是设计契约（[DESIGN.md](DESIGN.md) §1）中经评审明确放弃的方向，避免使用者对其产生错误期待：

- 不代写：插件不替 agent 生成记录内容，只提供记录、检索与导航。
- 不以缺 ID 阻断回答或触发模型补写；旧版自动留存只保存作者既有正文（默认 V2 `bcp_save` 则完全不做自动留存）。文件权限、大小、配额和显式哈希错误会形成明确缺口，语义合规仍须接收者判断。
- 不做模型白名单或按模型禁用功能。
- 不修改用户的全局配置（如 AGENTS.md），不注入长篇常驻 prompt。
- 关键词触发的入口提醒已退役（v1.6.0）：实测未见独立改善行为的证据，且覆盖与维护成本不划算；规范句只是普通任务措辞。
- 聚合不删除任何原文：只做目录折叠。

### 旧版构建与安装（历史兼容，不推荐作为当前快速开始）

旧版双宿主构建脚本为 `bun run build:legacy`（等价于 `bash scripts/build.sh`），安装脚本为 `bash scripts/install.sh`（只安装旧 Blackboard `plugin/blackboard.ts`，不安装默认 V2 `bcp_save` 快照归档）。既有部署维护与卸载细节见 [INSTALL.md](INSTALL.md#旧-blackboard-安装历史兼容非快照)。

## 开发

```bash
bun install
bun run build        # 默认构建：bash scripts/build-file-archive.sh -> dist/file-archive/file-archive.js
bun run build:legacy # 旧 Blackboard 构建：bash scripts/build.sh -> dist/blackboard.ts
bun test             # 当前源码的单元、契约及插件接线验证
bunx tsc --noEmit    # 类型检查
```

## 目录结构

```
src/
  file-archive.ts             # 默认独立 V2 快照归档入口（bcp_save，不依赖 OMO）
  work-layout.ts              # 统一任务工作目录 .opencode/work/<task-id> 初始化
  archive/                    # 任务级快照归档核、固定 inode 锁与 index.jsonl 派生索引
  adapters/v2/file-archive.ts # V2 bcp_save 插件接线、权限/策略复核与会话快照投影
  adapters/v2/handoff-source.ts # 算子私有策略文件 bcp.operator-handoff-policy.v1 读取校验
  tools.ts                    # 旧版四工具定义（宿主无关 core）
  message-store.ts            # 旧版 v1 原消息发现与留存
  reply.ts                    # 旧版最终答复和已稳定阶段正文的资格与边界
  edit-evidence.ts            # 旧版按作者与输入保留原生编辑证据
  permissions.ts              # 旧版 scope/stream 授权语义
  storage.ts                  # 旧版数据目录、文件锁、锁内事务
  indexing.ts                 # 旧版目录与关键词检索
  aggregate.ts                # 旧版目录折叠与 covered_by 导航
  rounds.ts                   # 旧版轮次时钟
  nudge.ts                    # 旧版提醒决策与预算事务（decideAndPersist）
  ids.ts                      # 稳定 ID 生成
  schema.ts                   # 旧版消息 schema（Zod 4）
  eligibility.ts              # 旧版目录压力资格判定
  constants.ts                # 常量单源
  delivery.ts                 # 旧版交付引用可见性过滤与 board_export 导出
  adapters/v1/                # 旧版 opencode 1.x 插件入口与 hook 接线
  adapters/v2/index.ts        # 旧版 opencode 2.x 黑板适配层（限定验收见 harness/acceptance/v2.0.0.md）
test/                         # 单元、契约及插件接线测试
scripts/build-file-archive.sh # 默认构建脚本（独立 V2 快照归档 bundle）
scripts/install-file-archive.mjs # 默认 V2 快照归档的独立配置安装器
scripts/package-openchamber.mjs  # OpenChamber 2.7.2 离线扩展打包器
scripts/build.sh              # 旧版双宿主 Blackboard 构建脚本（build:legacy）
scripts/install.sh            # 旧版 Blackboard 按宿主检测安装（历史兼容）
scripts/uninstall.sh          # 旧版 Blackboard 所有权校验式卸载
harness/                      # 验收记录与工具
DESIGN.md                     # 旧版 Blackboard 设计契约全文
```

## License

TBD（仓库尚未确定许可证字段）。
