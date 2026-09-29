# 安装指南

BCP 以单个 TypeScript 插件文件装入 opencode，无运行时依赖安装。前置要求与步骤如下；设计背景见 [README.md](README.md) 与 [DESIGN.md](DESIGN.md)。

## 前置要求

- [bun](https://bun.sh)（安装脚本用它构建产物）
- opencode，二选一：
  - **opencode 1.x**：安装 v1 产物（默认；实际覆盖与限制见各版本验收）
  - **opencode 2.0.16+**：安装 v2 产物（`--v2`；适配层已实现、41 项 adapter 测试通过，**真实 v2 宿主端到端验收尚未执行**，尝鲜性质）

## 安装

### 默认：v1 全局（opencode 1.x）

```bash
git clone <本仓库>
cd opencode-bcp
bash scripts/install.sh
```

产物装入 `~/.config/opencode/plugin/blackboard.ts`（v1 宿主自动发现该目录）。重启 opencode 生效。

### v2 宿主（opencode 2.x）

```bash
bash scripts/install.sh --v2
```

产物装入 `~/.config/opencode/plugins/blackboard-v2.ts`（v2 宿主按目录自动发现；显式单文件插件配置路径会被 v2 宿主忽略，因此固定使用自动发现）。

### 项目级安装

```bash
bash scripts/install.sh --project /path/to/project
```

产物装入 `<project>/.opencode/plugin/`（v1）或 `<project>/.opencode/plugins/`（v2 配合 `--v2`），仅对该项目生效。

### major 互斥语义

v2 宿主会同时扫描 `plugin/` 与 `plugins/` 两个目录。为避免同一宿主混装两个 major：

- 同目录内装一个 major 会先移除另一 major 的既有插件文件（仅限本插件的两个规范文件名，不动你的其他插件）。
- `--project` 模式下，安装前会检测目标目录全部祖先及全局配置根中另一 major 的存在；发现即**拒绝并 exit 2**，列出冲突路径，不做任何改动。
- 确认要跨根混装时可用 `--force` 强制继续（会逐路径打印 WARNING），不推荐。
- `--project` 目标不是已存在的目录时 **exit 3**。

### 跳过构建（开发迭代）

```bash
BB_INSTALL_SKIP_BUILD=1 bash scripts/install.sh
```

## 验证

重启 opencode 后：

```bash
opencode run "Reply OK"
rg decision ~/.cache/opencode/blackboard/log/blackboard.log
```

日志出现 `decision` 事件即插件已接线。默认 v1 应可见 `board_store`、`board_get`、`board_index`、`board_aggregate`，没有 `board_put`。v1 手动模式仍提供 `board_put`；v2 保持旧版四工具。

## v1.18.0 正文检索

安装后新进程的 `board_index` 应包含 `query` 和 `range` 参数。`query` 默认搜索当前 scope 内已授权流的公开正文及工件路径；没有 query 时维持旧单流目录。该实现不依赖模型摘要服务或新增依赖，也不修改旧记录。扫描和词法检索限制见 [契约](docs/content-search-v1.18.md)，实际命中、时延及空历史读者验证见 [v1.18 验收](harness/acceptance/v1.18.0.md)。运行中的进程不会热加载，独立新进程可用于验证而不要求用户先重启当前会话。

## v1.17.0 公开正文与消息发现

保存前必须已有用户可读的公开正文。自己的会话省略 `session_id`；不知道真实消息 ID 时先调用 `board_store action=list`。`ses_main`、未定消息 ID 或其他占位符不是有效来源，失败反馈会给出查询指引，不能用隐藏推理或工具参数补造报告。普通最终答复按协议自动留存；有中间交接时，先公开结论、依据和限制，再保存已完成阶段并传引用。

工具和 Task 的常驻说明由插件统一提供。已验证的主角色策略片段见 [公开来源策略](integrations/omo-slim/public-source-policy.md)，安装脚本不会替换用户角色配置。公开来源契约见 [v1.17 说明](docs/public-source-v1.17.md)，真实协作及只读场景的结果和限制见 [v1.17 验收](harness/acceptance/v1.17.0.md)。

## v1.16.0 原消息留存与引用派发

默认 v1 用 `board_store` 统一留存最终答复和已稳定的公开阶段正文。已有记录直接复用；否则在本会话或其他有权限的 agent 会话中发现原消息、留存后传完整记录引用。Task 描述包含操作说明，接收者仍须读取并核对原文、版本和限制。阶段正文必须完成，且同条消息内所有工具调用都已结束；流式正文、未结束工具和隐藏推理不能作为阶段来源。

发布授权以 `board_store` 为准，同时保留已有针对 `board_put` 的显式拒绝、询问和输入工具禁令，避免旧的禁发布角色因移除工具而获得权限。需要旧自由正文接口时，显式插件选项 `autoCapture: false` 保留 v1 手动模式。契约见 [v1.16 说明](docs/reference-first-v1.16.md)。

独立新进程的实际工具目录、自然阶段留存与派发、跨作者历史阶段快照见 [v1.16 验收](harness/acceptance/v1.16.0.md)。这证明测试进程加载了新版本，不表示已有 UI 会话会热加载。

## v1.15.0 既有答复补存

v1 安装新增 `board_store`。已知来源会话和消息 ID 时使用 `action=store`；未知消息 ID 时使用 `action=list` 发现。调用者可以不是作者，但双方发布权限和来源可见性都必须通过。原作者正文和编辑版本由宿主取得，调用者不提交正文、作者或 `source_refs`。详情见 [补存契约](docs/message-store-v1.15.md)。

独立测试进程验证了跨作者补存、重启后的旧版本快照、普通自动留存和子角色发现消息，见 [v1.15 验收](harness/acceptance/v1.15.0.md)。这些验证不依赖现有 UI 会话重启；现有进程不会热加载，退出并重启 OpenCode 后才能在该进程使用新工具。

已授权原生编辑的证据按作者会话和输入持久保存，正文标记与补存共用这些快照。该本地证据缓存计入 scope 配额，不以最终正文是否带正向标记为采集条件；已知禁止输入和权限限制会阻止采集。安装前没有观察过的编辑不能凭当前文件补成历史证据。工具描述统一注册，不需向各角色重复添加补存提示。手动 v1 模式也提供该工具，v2 暂不提供。

## v1.14.0 自动留存与自然交接

默认 v1 安装在最终正文顶层独占行含 `<!-- bcp:store -->` 且授权通过时自动留存，推荐放在末尾；代码和引用中的标记不授权。缺少标记不保存；角色仍只生成一次结果。采用下方 OMO 适配时，交付元数据包含 `capture` 状态和自动记录引用。独立根会话的记录可通过 `board_index` 查找，宿主不会让模型续写一个尚未生成的 ID。

请同步删除角色 prompt 中“结束前必须调用 `board_put` / 返回作者新生成 ID”的旧句，保留结果、依据、限制、确切版本和接收者读取原文的要求。同一准入输入中已观察的原生编辑与显式 `file://` 引用可经作者既有文件权限留存快照；自然语言禁止发布要求须由上游或作者传递 `<!-- bcp:no-store -->` 或省略正向标记。权限为 deny/ask 或未知时不自动授权。详细边界见 [docs/final-capture-v1.14.md](docs/final-capture-v1.14.md)。

如需手动模式，可在单一显式插件注册中传入 `autoCapture: false`；不要同时保留同一插件的自动发现副本。v2 继续手动发布。自动模式日志为 `final_capture`，应核对 stored/replay/skipped/unconfirmed 及 reason，而不是把插件已加载当成功。安装与 prompt 调整后均须重启 OpenCode。

## v1.11.0 本地工件与交付观测（手动模式）

安装方式不变。v1 宿主可在 `source_refs` 提交获准发布的本地绝对路径，BCP 通过调用者文件权限保留快照并计算 SHA-256。接收方检查 `board_get.artifact_check`，其中 `verified_bytes_only` 仅证明文件字节。每次最多 8 个文件、每文件 4 MiB，快照计入 scope 配额；当前 v2 没有文件授权接口，此类请求会明确拒绝。

v1 的 `delivery_observation` 日志关联本进程已准入输入，按编辑路径和发布修订区分已观察快照、普通发布与未确认状态；其中 `missing_handoff` / `manual_version_check` 另记 `delivery_gap` 并在可用时通知。无关路径或幂等重放不能提供新版本证明，所有状态都不是语义验收。只读复用、身份未关联、未知写入、重启前历史等仍需接收者核验；不补写作者记录、不自动续聊、不阻断最终回答。新版实验见 [harness/acceptance/v1.11.0.md](harness/acceptance/v1.11.0.md)。重新启动 OpenCode 后生效。

## v1.12.0 OMO 交付元数据

单独安装 BCP 提供当前模式的工具和留存行为；默认 v1 的四工具已用 `board_store` 替代 `board_put`。OMO 结果引用关联需要同时加载 OMO 适配；本次安装使用 `~/.config/opencode/local-plugins/` 中锁定 OMO 2.2.25 的可重建补丁，配置入口为 `file:///home/littlekey/.config/opencode/local-plugins/dist/omo.js`。适配自有源码已纳入 [integrations/omo-slim](integrations/omo-slim/README.md)。本地构建、依赖锁及回退说明见部署目录的 README.md；上游升级须重新核对补丁锚点和源文件哈希。

退出并重启 OpenCode 后生效。新宿主应在前台返回、`task_result`、后台完成通知与恢复结果中提供独立 `<bcp_delivery_metadata>`。原生后台通知的元数据只附于模型上下文，不回写通知原文。没有 BCP、身份不明或检查失败时返回未确认，不能把空候选理解为全局没有记录。接口见 [docs/delivery-integration-v1.12.md](docs/delivery-integration-v1.12.md)，验收见 [harness/acceptance/v1.12.0.md](harness/acceptance/v1.12.0.md)。

## v1.9.1 来源核对复用（历史）

v1.9.1 撤回 v1.9.0 候选的查询豁免，仅保留有条件的同版本来源核对复用，不修改工具参数、存储或授权。当前会话仍使用已加载的旧描述，重新启动 OpenCode 后生效。测试、安装指纹和已知交接缺口见 [harness/acceptance/v1.9.1.md](harness/acceptance/v1.9.1.md)。下方历史快照不替代本次验证，也不证明所有角色都完整执行交付契约。

## 已验证 omo-slim 集成配置（2026-09-26 快照）

上述「验证」只证明**接线**（工具注册与日志）。以下是经行为电池验证的**集成快照**（DESIGN.md v1.8.4「规则所有权与配置版本化」；v3 电池 5/5 证据见 [harness/acceptance/results.md](harness/acceptance/results.md):489–501）：其中磁盘与配置数值可直接核验（H_file），运行态驻留按下方「可复现步骤」执行（omo-slim 角色 profile 未保留不可变快照，此前**不称「完整可复现快照」**）。超出本快照的宿主 / 模型 / 角色配置**不自动继承**行为结论。

| 项 | 已验证值 |
|---|---|
| 插件 commit | `1cf6c08`（feat+docs: sync U2 descriptions (board_put 1095B, task 867B); U2/fixer battery evidence） |
| 构建产物 | `dist/blackboard.ts` 815533 B，SHA-256 `761ca36fdbc1d3ab9976e7a841119182fc9e797d7e334c675ff8dda2ba6c8293` |
| 已安装文件 | `~/.config/opencode/plugin/blackboard.ts`——与构建产物逐字节一致（双 hash 相同） |
| 宿主 | opencode 1.18.31（v1 插件 API，`opencode serve` 运行态；运行态导出走 Basic auth） |
| 模型变体 | fixer = `newapi/glm-5.3-flash`（variant `max`，`oh-my-opencode-slim.json` presets/newapi/fixer） |
| fixer 工具面 | 实测 26 项：board 四工具全在；**`task` 不在**（仅 task_reply）——results.md:487 只读探针 |
| fixer 角色桥接 | `~/.config/opencode/oh-my-opencode-slim/fixer_append.md`：内容 433 B（无末尾 LF）SHA-256 `fa03f0a7be6b918ccc5d480212c36d57c297f1d1d373d4ccc45ce212b608859d`；文件含 LF 434 B，SHA-256 `8d07d56681fae8aa5642a0733cd06caa59b4f918f4903aab1825d0032b810ffc` |
| 驻留验证方法 | H_file = 磁盘双 hash 一致；H_loaded = 宿主**重启后**运行态 agent 导出，fixer prompt 2836 B 中桥接片段恰现 1 次且 SHA 匹配（results.md:492）；H_wire 未取 |

**教训注记（安装 ≠ 驻留）**：v1.8.3 澄清文案构建已安装但宿主未重启时，in-host 电池实际运行的是旧驻留文案（815453 B），结论被误归因后经重启重跑纠正（results.md:466）。任何行为断言前必须先确认驻留：重启宿主，或以日志 / 决策字节特征确认当前运行文本。

### 承诺边界

- **独立插件承诺**（接口与接线）：插件提供四工具 `board_put` / `board_get` / `board_index` / `board_aggregate` 及其决策规则描述，并附带安装接线检查（`decision` 日志事件 + 会话内四工具可见）。**接线检查 ≠ 描述分发或行为验证**（DESIGN.md §11.8 覆盖合同：不能以「插件注册过工具」代替实际分发证明）；实际描述分发须另以加载 / 请求证据验证（H_loaded 类方法，见「可复现步骤」）。v2 为**实验性质**——适配层已实现，但真实 v2 宿主加载与行为验收尚未执行（与上方安装注记及 README 状态表一致），不承诺任意宿主行为实效。
- **已验证集成承诺**（仅限本快照配置）：omo-slim + fixer_append 桥接下，fixer 角色的终结交付（T）行为全绿——v3 电池 5/5：交付 + 末行完整 `bb://` ID + blocked / no-change 显式交付。**不保证**：版本锚定维度（v3 电池 M1 未申报版本渠道缺口，results.md:501——补齐电池为 F1 版本夹具电池，DESIGN.md §14.4 待执行验收）；其他宿主 / 模型 / 角色配置下的同等行为。

### 可复现步骤

```bash
# H_file：磁盘 hash 校验（构建产物 vs 已安装 vs 角色桥接）
sha256sum dist/blackboard.ts \
          ~/.config/opencode/plugin/blackboard.ts \
          ~/.config/opencode/oh-my-opencode-slim/fixer_append.md

# fixer_append.md 内容口径（433 B，去末尾 LF）及其 hash
python3 -c "import hashlib;d=open('$HOME/.config/opencode/oh-my-opencode-slim/fixer_append.md','rb').read().rstrip(b'\n');print(len(d), hashlib.sha256(d).hexdigest())"
# 期望：433 fa03f0a7be6b918ccc5d480212c36d57c297f1d1d373d4ccc45ce212b608859d
```

**H_loaded（运行态驻留）**——按 results.md:492 记录的方法参数化的步骤；导出端点与凭据随宿主部署而异，**未随本稿重验**（历史运行：opencode serve HTTP API + Basic auth，凭据经 `OPENCODE_SERVER_PASSWORD` 环境变量提供，不硬编码）：

```bash
# 1) 重启宿主后导出运行态 agent（端点/端口按你的部署填充；凭据取自环境变量）
curl -s -u ":${OPENCODE_SERVER_PASSWORD}" \
     "http://127.0.0.1:${OC_PORT}/agent" -o /tmp/agents_export.json
# 2) 从导出中取出 fixer 的运行态 prompt 文本，存为 /tmp/fixer_prompt.txt
#    （历史运行导出为 2836 B——比对对象是 433 B 桥接片段，不是整份 prompt 的 SHA）

# 3) 桥接片段驻留比对（本段脚本文法已验证：恰现 1 次 + SHA 匹配方 PASS）
python3 - /tmp/fixer_prompt.txt <<'EOF'
import hashlib, sys
frag = open(f"{__import__('os').path.expanduser('~')}/.config/opencode/oh-my-opencode-slim/fixer_append.md","rb").read().rstrip(b'\n')
prompt = open(sys.argv[1], "rb").read()
n = prompt.count(frag)
print("fragment bytes:", len(frag))
print("sha256(frag)  :", hashlib.sha256(frag).hexdigest())
print("occurrences   :", n)
assert n == 1 and hashlib.sha256(frag).hexdigest() == "fa03f0a7be6b918ccc5d480212c36d57c297f1d1d373d4ccc45ce212b608859d"
print("H_loaded PASS: bridge fragment resident exactly once, SHA matches")
EOF
```

## 卸载

删除对应插件文件后重启 opencode：

```bash
rm ~/.config/opencode/plugin/blackboard.ts       # v1 全局
# 或
rm ~/.config/opencode/plugins/blackboard-v2.ts   # v2 全局
# 或
rm <project>/.opencode/plugin/blackboard.ts      # 项目级（v2 同理，plugins/ 目录）
```

## 故障排查

当前自动模式按 [v1.14 契约](docs/final-capture-v1.14.md)接受顶层独占行授权标记，并绑定本轮已观察的原生编辑。验证可独立启动新的 `opencode serve` 进程并检查驻留配置，无需依赖现有 UI 会话重启；旧进程不会因此热加载新代码。主角色 Task 权限中的 `councillor*` 拒绝规则只用于主角色，不能应用为 Council 的全局权限。原生续接须同时安装当前 OMO 补丁；其修复和最终运行指纹见 [v1.14 验收](harness/acceptance/v1.14.0.md)。

- **宿主不加载插件**：安装后必须重启 opencode；确认文件位于上表路径。
- **行为异常、疑似两个版本同时在跑**：跨配置根混装所致。保留一个 major，重装：先删除所有 `blackboard*.ts` 插件文件，再用单一模式重装一次。
- **安装脚本拒绝（exit 2）**：按输出列出的路径清理另一 major，或确认后 `--force`。
- **怀疑数据问题**：运行 `bun test` 与 `bun run typecheck` 核对当前源码；具体通过数和真实宿主覆盖以对应版本的验收记录为准。
