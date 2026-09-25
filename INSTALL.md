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
