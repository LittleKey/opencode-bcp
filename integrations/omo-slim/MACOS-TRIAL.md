# macOS：OMO 3.0.3 构建与隔离试装

适用对象：已有普通上游 OpenCode/OMO 安装，准备测试本仓库的 OMO 3.0.3 补丁。本文先在独立目录构建和启动，不要求另一台 Linux 机器的个人 dotfiles、provider 配置或安装记录。

## 可行性与证据边界

可以从源码在 macOS 构建对应架构的产物并隔离试装。当前通过的实际宿主行为证据来自 Linux OpenCode 1.18.33/1.18.35；**尚未在 macOS 实机完成升级、回滚或行为验收**。

不能直接使用原个人升级事务：它读取本机绝对路径、已有 `.oprofile/active.json`、备份与受管文件基线。普通上游安装不具备这些输入。个人 `oprofile verify` 和验收脚本的数据库检查依赖 Linux `/proc`，macOS 上不能将其跳过后仍报告通过。

Linux 产物中的 `@ast-grep/cli` 依赖闭包包含平台原生程序。必须在目标 Mac 重新安装依赖和构建；同平台搬迁测试不代表跨操作系统搬迁。Apple Silicon 使用原生 arm64 Node/Bun，Intel 使用 x64，避免混用 Rosetta 依赖。

## 1. 准备与构建测试

检出包含本次提交的 `opencode-bcp` 分支，在仓库根目录执行。需要 Node、npm 和 Bun；推荐使用满足完整依赖引擎要求的 Node 26.4 或更新版本及 Bun 1.3 或更新版本。Linux 曾使用 Node 25.6.1 成功导入，但该版本不在 jsdom 30.1.2 声明的支持范围内。

```bash
export BCP_REPO="$(pwd -P)"
export TRIAL="$(mktemp -d "${TMPDIR:-/tmp}/omo303-mac.XXXXXX")"
export BUN_BIN="$(command -v bun)"
export OC_BIN="$(command -v opencode)"
node --version
"$BUN_BIN" --version
"$OC_BIN" --version

npm install --prefix "$TRIAL/upstream" --save-exact --ignore-scripts --no-audit --no-fund oh-my-opencode-slim@3.0.3
export OMO_303_PACKAGE="$TRIAL/upstream/node_modules/oh-my-opencode-slim"
node --test --test-concurrency=1 integrations/omo-slim/test/omo-3.0.3.test.mjs
```

使用 mise 等版本管理器时，`OC_BIN` 和 `BUN_BIN` 必须设为真实可执行文件的绝对路径，不能使用依赖原 HOME 的 shim。建议 OpenCode 固定为 1.18.35，以对齐现有 v1 证据；不是本次 v2 升级流程。先确认 `BUN_BIN` 非空，再运行测试。

测试检查两个入口的精确上游摘要、结果身份关联、retained-child 恢复标记、搬迁后的 Node/Bun 导入、实际 JSDOM 加载，以及目标平台原生 ast-grep 程序是否存在并可执行。指定的 Bun 不存在会直接失败。其他历史版本测试需要另外准备它们的固定包及旧验收夹具，不应将新版本九项测试称为全部回归。

上述命令固定 OMO 发布包版本；其传递依赖首次仍由 npm 解析。保留生成的 `$TRIAL/upstream/package-lock.json`，以后用 `npm ci --prefix "$TRIAL/upstream" --ignore-scripts` 复现该 Mac 的依赖图。不要把一次新解析当作原 Linux 依赖闭包的逐字节复现。

## 2. 生成完整 v1 插件目录

```bash
node --input-type=module <<'NODE'
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {BCP_REPO, TRIAL, OMO_303_PACKAGE} = process.env;
const sourceDir = join(BCP_REPO, 'integrations/omo-slim');
const {buildOmoIntegration} = await import(pathToFileURL(join(sourceDir, 'build-omo.mjs')).href);
const outputDir = join(TRIAL, 'artifact/index');
const {manifest} = await buildOmoIntegration({
  packageDir: OMO_303_PACKAGE, sourceDir, outputDir, version: '3.0.3', entry: 'index',
});
mkdirSync(join(TRIAL, 'artifact'), {recursive: true});
writeFileSync(join(TRIAL, 'artifact/index.js'), 'export {default} from "./index/dist/index.js";\n', {flag: 'wx'});
console.log(JSON.stringify({version: manifest.version, entry: outputDir, upstream: manifest.upstream}, null, 2));
NODE
```

保留整个 `artifact/`，不能只复制 `dist/index.js`：相对 helper、vendor、技能资源和原生依赖都在目录内。正式使用时将其放在持久目录；这里的临时目录仅供试装。

## 3. 创建独立配置

```bash
node --input-type=module <<'NODE'
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.env.TRIAL;
const config = join(root, 'home/.config/opencode');
for (const name of ['home', 'data', 'state', 'cache', 'project']) mkdirSync(join(root, name), {recursive: true});
mkdirSync(config, {recursive: true});
writeFileSync(join(config, 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  plugin: [pathToFileURL(join(root, 'artifact/index.js')).href],
}, null, 2), {flag: 'wx', mode: 0o600});
console.log(config);
NODE
```

该配置只加载构建出的 OMO，不包含个人模型、MCP、BCP 或压缩插件。第一次先检查能否启动和注册角色；之后再将目标机器需要的模型和 OMO 设置迁入这个隔离配置。不要同时加入 npm 的 `oh-my-opencode-slim` 声明，也不要把第二份入口放进自动发现的 `plugin/`、`plugins/` 或项目 `.opencode/` 目录；本地插件和 npm 插件可能分别加载。

## 4. 启动和目标机验证

在新终端设置相同的 `TRIAL`、`OC_BIN` 和实际 Node/Bun 路径，然后在空项目中启动。`PATH` 中的 Node 也必须能在新 HOME 下直接执行。

```bash
cd "$TRIAL/project"
env -i HOME="$TRIAL/home" \
  XDG_CONFIG_HOME="$TRIAL/home/.config" \
  XDG_DATA_HOME="$TRIAL/data" XDG_STATE_HOME="$TRIAL/state" \
  XDG_CACHE_HOME="$TRIAL/cache" OPENCODE_DB="$TRIAL/data/opencode.db" \
  OPENCODE_CONFIG_DIR="$TRIAL/home/.config/opencode" \
  OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true PATH="$PATH" \
  "$OC_BIN" serve --hostname 127.0.0.1 --port 18835
```

选择空闲端口；保留实际启动日志。v1 的 `OPENCODE_CONFIG_DIR` 会叠加 HOME 配置，因此必须同时使用独立 HOME，并从没有项目配置的目录启动。`env -i` 避免继承现有 OpenCode/BCP 覆盖变量。

在另一终端检查 `/global/health`、`/config`、`/agent`、`/skill`，记录宿主版本、插件入口、模型与权限。macOS 可用 `lsof -p <实际宿主PID>` 检查数据库路径，发现子进程时也检查其打开文件；这只是目标机文件描述符观察，不等同于现有 Linux 自动验收器。需要的 provider 登录和配置应在这个 HOME 下完成。

构建/启动成功之后仍需验证：只读角色写入被拒绝、可写角色正向成功、技能正文正确，且没有双重 OMO 加载。普通上游配置不会自动获得个人 profile 中的权限投影、别名设置和技能安装，不能凭插件成功导入就视为这些检查通过。

若还要测试 BCP：本仓库 `scripts/install.sh` 用到了 Bash 关联数组、`sha256sum` 和 GNU `sort -V`，macOS 默认 Bash/BSD 工具不满足要求。需准备 Bash 4+ 与 GNU coreutils，确保其命令在 PATH 前方，再按仓库 BCP 安装文档把 BCP 安装到上述隔离配置，并验证前台/后台/恢复结果身份；没有安装 BCP 的 OMO 单插件测试不覆盖这些功能。不要在本步骤复制 Linux 的个人 profile 或交易记录。

## 5. 原地升级的前置结果

只有目标 Mac 完成上述验证后，才能为现有上游安装制定原地切换：记录当前插件声明及自动发现入口、备份配置和旧插件、替换为持久目录中的单一新入口、重启并复查，失败时恢复同一组备份。当前仓库没有针对这台普通上游 Mac 安装的已验收事务；本文不把 Linux 的 19 项安装/回滚检查推广为 macOS 升级保证。
