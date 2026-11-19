# 安装指南

当前默认入口是独立 V2 快照归档 `src/file-archive.ts`（`bcp_save`），不依赖 OMO，不合并现有配置，也不创建任何留存或读取授权。新版 `bcp_save` 与旧 Blackboard 是两个完全独立的入口：安装默认 V2 快照归档**不要运行 `scripts/install.sh`**（该脚本只安装历史兼容的旧 Blackboard `plugin/blackboard.ts`）。

## 默认入口：独立 V2 快照归档（`bcp_save`）

### 1. 构建默认 V2 快照归档产物

```bash
bun run build
# 等价于：bash scripts/build-file-archive.sh
```

`bun run build`（`scripts/build-file-archive.sh`）仅在仓库内生成 `dist/file-archive/file-archive.js`，不安装、不注册插件，也不发起宿主或模型调用。

### 2. 独立 OpenCode V2 配置安装

使用 OpenCode 2.3.0、Bun 和 Node。安装器创建完全隔离的运行配置，不合并现有配置，不依赖 OMO，不创建归档授权：

```bash
bun run build
node scripts/install-file-archive.mjs \
  --target /absolute/private-parent/new-bcp-profile \
  --project /absolute/private-worktree --port 4096
```

（可选传入 `--options /absolute/private-operator/options.json`；路径必须为位于项目工作树之外的规范化绝对路径，其祖先目录均须为非符号链接的当前用户或 root 受控无其他用户写权限（或 root 粘滞位）目录，而 `options.json` 文件本身须为当前用户私有的非符号链接普通文件（`0600`、`nlink === 1`）。）

- **路径与隔离要求**：`--target` 必须不存在且位于 `--project` 之外；`--target` 父目录、`--project` 工作树及各自祖先目录均须为当前用户私有（或 root 受控粘滞目录），无其他用户写权限。工作树可有 `.opencode/work`，但工作树及其祖先路径不能带冲突的 OpenCode 配置或插件/工具发现入口（`opencode.json`、`opencode.jsonc`、`.opencode/opencode.json`、`.opencode/opencode.jsonc`、`.opencode/plugin`、`.opencode/plugins`、`.opencode/tool`、`.opencode/tools`）。
- **启动与连接**：先用目标目录中的 `serve.txt` 启动显式回环服务（`127.0.0.1`），再用 `launch.txt` 连接；连接时通过 `OPENCODE_PASSWORD` 环境变量提供服务密码，不写入启动脚本。
- **授权与动态重载**：初始状态下 `bcp_save` 工具可见但一律拒绝保存（fail closed）。宿主启动并建立会话后，操作员才能根据实际服务 PID 和会话身份原子替换私有 `options.json`，并在项目外提供精确的短期策略文件（`bcp.operator-handoff-policy.v1`）。每次调用都会重新打开并核验 `options.json` 与外部策略文件的当前 inode，更新或撤销授权无需重启。字段与信任边界见[实现说明](docs/file-archive-implementation.md#isolated-configuration-contract)。
- **不迁移旧状态**：该入口不迁移现有活跃会话、模型配置、旧 Blackboard 数据或独立安装的 OMO。

### 3. OpenChamber 2.7.2 GitHub URL 扩展（根包 `2.1.0`，主选扩展通道）

仓库根 `package.json`（`version: "2.1.0"`）直接声明 OpenChamber 2.7.2 扩展元数据（固定 `panel.id: "bcp-file-archive"`，`opencodePlugin: "openchamber/plugin"`），并随仓库提交预构建的 `openchamber/plugin/`（无 `postinstall` 或在线构建钩子）：

- **构建与新鲜度校验**：
  ```bash
  bun run build:openchamber   # 生成/更新 openchamber/plugin/file-archive.js
  bun run check:openchamber   # 校验已提交的 openchamber/plugin/file-archive.js 与当前源码构建一致
  ```
- **GitHub URL 安装（提交并推送发布版本后远端可用）**：
  - 将包含根 `package.json` 与 `openchamber/plugin/` 的发布版本提交并推送到 GitHub 后，在 OpenChamber 2.7.2 中使用仓库根 Git URL 安装（仅支持仓库根与可选 `#<branch-or-tag>` 分支/标签引用，**不支持子目录语法**；在未推送至远端前，远端 URL 尚不可用）：
    `https://github.com/littlekey/opencode-bcp.git`（或 `https://github.com/littlekey/opencode-bcp.git#<branch-or-tag>`）
- **运行态依赖与外部算子环境变量（`BCP_OPERATOR_OPTIONS`）**：
  - OpenCode V2 插件运行态需在 Linux/glibc Bun 下执行（归档锁核心依赖 `bun:ffi`）。扩展入口 `openchamber/plugin/index.mjs` 在 Bun 运行态加载预构建的 `file-archive.js`，并委托 Node 兼容的 `openchamber/plugin/operator-options.mjs`（与独立安装器/离线打包器共用 `openchamber/plugin/private-options.mjs`）读取进程环境变量 `BCP_OPERATOR_OPTIONS`。
  - 未设置 `BCP_OPERATOR_OPTIONS` 时，`loadOperatorOptions()` 返回 `{}`（默认禁用 / fail closed，任何宿主侧普通插件 options 均无法绕过该加载器）。
  - 设置 `BCP_OPERATOR_OPTIONS=/absolute/private-operator/options.json` 时，该路径必须是位于扩展包目录及所有 `taskScopes[].directory` 任务树之外的规范化绝对路径，父目录须为当前用户私有（`0700` / 无组或其他用户权限）且所有祖先目录通过非符号链接的当前用户或 root 受控粘滞目录检查，`options.json` 本身须为当前用户私有单硬链接普通文件（`0600`、`nlink === 1`、非符号链接、≤ 1 MiB），且其中必填的 `taskScopes` 数组与规范化绝对路径 `policyFile` 也必须位于扩展包目录及所有 `taskScopes[].directory` 之外。
- **上游更新语义（OpenChamber 2.7.2）**：
  - 宿主更新检查仅在远端根 `package.json` 的 `version`（semver）高于当前已安装版本时提示更新（不按普通 git commit 变化触发），检查结果带 1 小时缓存，且必须由用户单独执行更新应用操作（不提供自动静默更新）。

### 4. OpenChamber 2.7.2 离线扩展打包（独立保留的固定路径变体）

针对已安装的 OpenChamber 2.7.2（`@openchamber/web`），仍可离线生成绑定固定外部 `--options` 路径的未安装扩展目录，并通过宿主内置的 `inspectGuestPackage` 校验：

```bash
bun run build
node scripts/package-openchamber.mjs \
  --target /absolute/private-parent/new-extension \
  --host /absolute/path/to/installed/@openchamber/web \
  --options /absolute/private-operator/options.json
```

- **离线打包边界**：`scripts/package-openchamber.mjs` 只生成未安装的扩展包目录（`package.json` 与 `plugin/`，`deliveryRequired: "file"`），**不安装或启用扩展，不修改 OpenCode 配置，不创建授权，也不重启服务**。
- **外部私有 `options.json` 要求**：`--options` 必须是扩展包目录之外的规范化绝对路径，其父目录及祖先目录须为当前用户私有；**打包时 `--options` 路径不得已存在（包括符号链接）**，以防打包过程读取或复制现存算子授权。打包生成的加载器固定绑定该稳定外部路径：文件不存在时返回 `{}`（默认禁用 / 拒绝保存）；算子后续创建的 `options.json` 必须为当前用户私有（`0600`、单硬链接 `nlink === 1`、非符号链接、≤ 1 MiB）。
- **部署与安全限制**：通过 Local Path 挂载或 ZIP 上传时，二者在该宿主上均指向同一个规范化外部 `--options` 路径；**严禁将 `options.json`、策略文件或凭据放入任何对外提供的扩展目录内**，且**不要使用全局 `Install into OpenCode` 回退路径**。同 UID 下的文件权限不能隔离同一用户的恶意并发进程，原生宿主权限检查（`read` / `bcp_save` / 具体归档路径的 `edit`）仍然必需；该原生 `edit` 检查是叠加在算子留存策略上的附加约束（实际强制行为依宿主实现而定），而非专属写入者隔离，授予归档路径的 `edit` 权限也可能允许对该路径执行常规编辑。

---

## 旧 Blackboard 安装（历史兼容，非快照）

> 以下 `bun run build:legacy`（`bash scripts/build.sh`）与 `bash scripts/install.sh` 仅用于维护历史兼容的旧 Blackboard（`bb://` 记录与 `board_*` 工具），**不安装默认 V2 `bcp_save` 快照归档，也不推荐作为当前快速开始**。

### 前置要求

- [bun](https://bun.sh)（旧版构建脚本 `bun run build:legacy` / `scripts/build.sh` 与 `scripts/install.sh` 用它构建 `dist/blackboard.ts`）
- 旧入口历史最低版本为 OpenCode 1.18.29（V1）或 2.0.20（V2）；同一产物提供 `server` 和 `setup`。历史验收见 [2.0.0 验收](harness/acceptance/v2.0.0.md)，不适用于默认 V2 快照归档入口。

### 安装（旧 Blackboard `scripts/install.sh`）

#### 全局安装（按宿主检测，仅旧 Blackboard）

```bash
git clone <本仓库>
cd opencode-bcp
bun run build:legacy           # 或直接运行下方 install.sh（默认调用旧版构建）
bash scripts/install.sh
```

脚本构建产物，用 PATH 中的 `opencode` 检测宿主 major（`--host v1|v2|<可执行文件路径>` 可显式指定，`--artifact` 指定产物文件），写入唯一 canonical 文件 `~/.config/opencode/plugin/blackboard.ts`。该文件同时提供 v1 `server` 与 v2 `setup` 入口，两种宿主按各自协议加载同一个文件；显式单文件插件配置路径会被 v2 宿主忽略，因此固定使用目录自动发现。重启 opencode 生效。

安装器保存原文件并对可捕获的失败执行进程内回滚（含符号链接拓扑恢复；不承诺断电或 SIGKILL 下的跨文件事务保证），写入安装清单 `~/.config/opencode/bcp-install.json`（schema `opencode-bcp.install/1`，记录版本、宿主、入口形态与产物摘要）。黑板数据目录 `~/.cache/opencode/blackboard` 永不改动。退出码：`0` 已安装或已是最新 · `2` 用法错误、宿主不受支持、冲突或所有权拒绝 · `3` `--project` 目标不是已存在目录 · `1` 未预期失败。

### 项目级安装

```bash
bash scripts/install.sh --project /path/to/project
```

产物装入 `<project>/.opencode/plugin/blackboard.ts`，仅对该项目生效；目标目录必须已存在，否则 **exit 3**。

### 单入口与旧文件所有权

同一有效配置栈（全局、祖先与项目范围）只能有一个 BCP 入口，写入前统一检查：

- 安装根之外发现本插件管理名文件（冲突）→ 拒绝并 **exit 2**，列出路径，不做任何改动。
- 安装根内被用户修改过的管理文件（与清单摘要不符）→ 拒绝，不覆盖。
- 旧版入口文件名（`plugin/blackboard.ts`、`plugin/blackboard.js`、`plugins/blackboard-v2.ts`）：匹配已知历史发布摘要时自动迁移；否则只有显式 `--adopt <file>=<sha256>` 给出其真实摘要才被采用——文件名与注释不是所有权证据。
- 完整个人组合（dotfiles runtime 流程管理）使用自己的管理清单，见 [2.0.0 升级说明](docs/upgrade-v2.0.md)；从独立安装入口迁移时必须明确备份并交接旧入口，不能混用两套文件所有权。

### 跳过构建（开发迭代）

```bash
BB_INSTALL_SKIP_BUILD=1 bash scripts/install.sh   # 等价 --skip-build
```

## 验证

重启 opencode 后：

```bash
opencode run "Reply OK"
rg decision ~/.cache/opencode/blackboard/log/blackboard.log
```

日志出现 `decision` 事件即插件已接线。默认 auto 模式（v1/v2 同口径）可见 `board_store`、`board_get`、`board_index`、`board_aggregate`，没有 `board_put`。显式 `autoCapture: false` 的手动模式在两宿主上都额外注册 `board_put`（与 `board_store` 并存）。

### 历史版本记录：v1.20.0 编排集成（已移除的引用回执与 Council 宿主取证）

> **历史归档说明**：BCP 已不再包含或维护 OMO 补丁、投递桥或 Council 桥（原 `integrations/omo-slim/` 目录及 `local-plugins` 补丁构建说明已从当前活跃安装路径移除）。本节仅作为 v1.20 历史设计契约与验收记录的索引保留，**不再作为当前可执行安装或构建指令**。历史契约见 [docs/orchestration-v1.20.md](docs/orchestration-v1.20.md)，历史限定验收见 [harness/acceptance/v1.20.0.md](harness/acceptance/v1.20.0.md)，2.0.0 历史组合说明见 [docs/upgrade-v2.0.md](docs/upgrade-v2.0.md)。

### 历史版本记录：v1.19.0 作者标题与授权目录

构建安装旧 Blackboard 后，新进程的自动留存说明包含可选 description 属性，`board_index` 允许不带 query 的 `range="authorized"`。旧标记及省略 range 的本人目录继续可用。解析与覆盖字段见 [契约](docs/catalog-discovery-v1.19.md)，真实多 agent 作者、受控读者对照和自主选择目录的证据见 [验收](harness/acceptance/v1.19.0.md)。验证使用独立新进程；正在运行的会话不会热加载安装后的插件。

### 历史版本记录：v1.18.0 正文检索

安装旧 Blackboard 后新进程的 `board_index` 包含 `query` 和 `range` 参数。`query` 默认搜索当前 scope 内已授权流的公开正文及工件路径；没有 query 时维持旧单流目录。扫描和词法检索限制见 [契约](docs/content-search-v1.18.md)，实际命中、时延及空历史读者验证见 [v1.18 验收](harness/acceptance/v1.18.0.md)。运行中的进程不会热加载，独立新进程可用于验证而不要求用户先重启当前会话。

### 历史版本记录：v1.17.0 公开正文与消息发现

旧 Blackboard 保存前必须已有用户可读的公开正文。自己的会话省略 `session_id`；不知道真实消息 ID 时先调用 `board_store action=list`。`ses_main`、未定消息 ID 或其他占位符不是有效来源，失败反馈会给出查询指引，不能用隐藏推理或工具参数补造报告。普通最终答复按旧协议自动留存；有中间交接时，先公开结论、依据和限制，再保存已完成阶段并传引用。

工具和 Task 的常驻说明由旧版插件统一提供，安装脚本不会替换用户角色配置。公开来源契约见 [v1.17 说明](docs/public-source-v1.17.md)，真实协作及只读场景的结果和限制见 [v1.17 验收](harness/acceptance/v1.17.0.md)。（注：已退役的 `integrations/omo-slim/` 角色策略片段不再随仓库分发。）

### 历史版本记录：v1.16.0 原消息留存与引用派发

旧版默认 v1 用 `board_store` 统一留存最终答复和已稳定的公开阶段正文。已有记录直接复用；否则在本会话或其他有权限的 agent 会话中发现原消息、留存后传完整记录引用。Task 描述包含操作说明，接收者仍须读取并核对原文、版本和限制。阶段正文必须完成，且同条消息内所有工具调用都已结束；流式正文、未结束工具和隐藏推理不能作为阶段来源。

发布授权以 `board_store` 为准，同时保留已有针对 `board_put` 的显式拒绝、询问和输入工具禁令，避免旧的禁发布角色因移除工具而获得权限。需要旧自由正文接口时，显式插件选项 `autoCapture: false` 保留 v1 手动模式。契约见 [v1.16 说明](docs/reference-first-v1.16.md)，历史验收见 [v1.16 验收](harness/acceptance/v1.16.0.md)。

### 历史版本记录：v1.15.0 既有答复补存

旧版 v1 安装新增 `board_store`。已知来源会话和消息 ID 时使用 `action=store`；未知消息 ID 时使用 `action=list` 发现。调用者可以不是作者，但双方发布权限和来源可见性都必须通过。原作者正文和编辑版本由宿主取得，调用者不提交正文、作者或 `source_refs`。详情见 [补存契约](docs/message-store-v1.15.md)，历史验收见 [v1.15 验收](harness/acceptance/v1.15.0.md)。

已授权原生编辑的证据按作者会话和输入持久保存，正文标记与补存共用这些快照。该本地证据缓存计入 scope 配额，不以最终正文是否带正向标记为采集条件；已知禁止输入和权限限制会阻止采集。安装前没有观察过的编辑不能凭当前文件补成历史证据。手动模式（`autoCapture: false`）在旧版 v1/v2 上都提供该工具。

### 历史版本记录：v1.14.0 自动留存与自然交接

旧版默认 v1 安装在最终正文顶层独占行含 `<!-- bcp:store -->` 且授权通过时自动留存（仅适用于旧 Blackboard，默认 V2 `bcp_save` 无自动留存且不要求该标记）。同一准入输入中已观察的原生编辑与显式 `file://` 引用可经作者既有文件权限留存快照；自然语言禁止发布要求须由上游或作者传递 `<!-- bcp:no-store -->` 或省略正向标记。权限为 deny/ask 或未知时不自动授权。详细边界见 [docs/final-capture-v1.14.md](docs/final-capture-v1.14.md)，历史验收见 [v1.14 验收](harness/acceptance/v1.14.0.md)。

如需旧版手动模式，可在单一显式插件注册中传入 `autoCapture: false`；不要同时保留同一插件的自动发现副本。旧版自动模式日志为 `final_capture`，应核对 stored/replay/skipped/unconfirmed 及 reason，而不是把插件已加载当成功。

### 历史版本记录：v1.11.0 本地工件与交付观测（手动模式）

旧版 v1 宿主可在 `source_refs` 提交获准发布的本地绝对路径，BCP 通过调用者文件权限保留快照并计算 SHA-256。接收方检查 `board_get.artifact_check`，其中 `verified_bytes_only` 仅证明文件字节。每次最多 8 个文件、每文件 4 MiB，快照计入 scope 配额；旧版 v2 经共享核同口径处理此类请求：仅当权限规则明确 allow 时保留快照，否则明确拒绝。历史实验见 [harness/acceptance/v1.11.0.md](harness/acceptance/v1.11.0.md)。

### 历史版本记录：v1.12.0 OMO 交付元数据（已移除补丁）

> **历史归档说明**：v1.12 时代的 `<bcp_delivery_metadata>` 依赖已退役的 OMO 本地补丁，BCP 当前不再提供或指导安装任何 patched OMO / `local-plugins` 构建。历史接口说明见 [docs/delivery-integration-v1.12.md](docs/delivery-integration-v1.12.md)，历史验收见 [harness/acceptance/v1.12.0.md](harness/acceptance/v1.12.0.md)。

### 历史版本记录：v1.9.1 来源核对复用与 2026-09-26 快照

v1.9.1 撤回 v1.9.0 候选的查询豁免，仅保留有条件的同版本来源核对复用，不修改工具参数、存储或授权。历史测试、安装指纹和已知交接缺口见 [harness/acceptance/v1.9.1.md](harness/acceptance/v1.9.1.md)，2026-09-26 历史行为电池快照（commit `1cf6c08`、opencode 1.18.31、`fixer_append.md` 驻留核验）见 [harness/acceptance/results.md](harness/acceptance/results.md)。

### 卸载（旧 Blackboard `scripts/uninstall.sh`）

使用所有权校验式卸载脚本清理旧 Blackboard 安装，不要手工删除后置之不理：

```bash
bash scripts/uninstall.sh                          # 全局
bash scripts/uninstall.sh --project /path/to/project
```

脚本按安装清单核对 SHA-256 后删除 canonical 文件与清单本身；无清单时按已知历史发布摘要清理旧版入口（`plugin/blackboard.ts`、`plugin/blackboard.js`、`plugins/blackboard-v2.ts`）；无法证明所有权的文件一律拒绝（exit 2），核实归属后可用 `--adopt <file>=<sha256>` 显式授权删除。安装根之外的 BCP 文件只报告不删除；`~/.cache/opencode/blackboard` 数据永不删除。卸载后重启 opencode 生效。

### 故障排查（旧 Blackboard）

旧版自动模式按 [v1.14 契约](docs/final-capture-v1.14.md)接受顶层独占行授权标记，并绑定本轮已观察的原生编辑。验证可独立启动新的 `opencode serve` 进程并检查驻留配置，无需依赖现有 UI 会话重启；旧进程不会因此热加载新代码。历史验收指纹见 [v1.14 验收](harness/acceptance/v1.14.0.md)。

- **宿主不加载旧版插件**：安装后必须重启 opencode；确认文件位于旧 Blackboard 安装节所列路径。
- **行为异常、疑似两个旧版本同时在跑**：跨配置根混装或旧入口残留所致。用 `scripts/uninstall.sh`（必要时加 `--adopt`）清理旧文件后重新安装一次；同一配置栈只能有一个 BCP 入口。
- **安装脚本拒绝（exit 2）**：按输出列出的路径清理或恢复对应文件（旧版入口核实摘要后可用 `--adopt`）；安装根之外的冲突需先在相应配置根卸载。当前安装器没有 `--force`。
- **怀疑数据或代码问题**：运行 `bun test` 与 `bun run typecheck` 核对当前源码；具体通过数和真实宿主覆盖以对应版本的验收记录为准。
