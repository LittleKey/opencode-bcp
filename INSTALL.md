# 安装指南

BCP 以单个 TypeScript 插件文件装入 opencode，无运行时依赖安装。前置要求与步骤如下；设计背景见 [README.md](README.md) 与 [DESIGN.md](DESIGN.md)。

## 前置要求

- [bun](https://bun.sh)（安装脚本用它构建产物）
- opencode，二选一：
  - **opencode 1.x**：安装 v1 产物（默认，生产验证完整）
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

日志出现 `decision` 事件即插件已接线。同时确认会话内可见四个工具：`board_put`、`board_get`、`board_index`、`board_aggregate`。

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

- **宿主不加载插件**：安装后必须重启 opencode；确认文件位于上表路径。
- **行为异常、疑似两个版本同时在跑**：跨配置根混装所致。保留一个 major，重装：先删除所有 `blackboard*.ts` 插件文件，再用单一模式重装一次。
- **安装脚本拒绝（exit 2）**：按输出列出的路径清理另一 major，或确认后 `--force`。
- **怀疑数据问题**：运行测试套件确认插件本身完好：`bun test`（224 pass / 0 fail）。
