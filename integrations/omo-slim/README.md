# OMO Slim 摘要锁定构建（2.2.25 / 3.0.1 / 3.0.3）

macOS 普通上游安装的构建、隔离试装与限制见 [MACOS-TRIAL.md](MACOS-TRIAL.md)。现有个人 Linux 升级事务不是通用跨机器安装器。

## 3.0.3 已安装并通过重载验收（2026-10-09）

构建器现支持 `version: '3.0.3'` 的 index/server 两入口，保留旧版本构建行为。锁定的上游 index SHA-256 为 `160c7bfb22f1105fd88c558d1a0686c549864a3f7b0efca5586319d7c663ec27`，server 为 `e31460f6c754370020717d70f4e2ba88ba8003e67ed59cc91ca599279d509e40`。未知摘要与非唯一补丁锚点仍拒绝构建。

3.0.3 保留 26 项原补丁，适配 10 项，退役 4 项上游已吸收的 legacy-alias 回移，并为队列终态、只读结果和 retained-child 回执路径增加 5 项接线。新版消息映射的时间、来源、显式父消息和分页信息均保留；BCP 仅补充缺失的可验证输入关联。上游 Council 文本不变。两个入口只携带 `omo-delivery.mjs`，依赖与技能资源随完整目录搬迁。

技能生成按包版本选择精确摘要和覆盖。3.0.3 使用独立的 `deepwork` 覆盖；另外两个覆盖对应的上游文件未变。个人技能逐字节复制，文件模式随源保留；使用已提交的完整生成树作为个人源时，应先输出到另一目录再比较，避免不完整源覆盖既有技能。

当前证据：9 项新版补丁/搬迁测试、37 项既有补丁/构建/闭包/角色回归、17 项技能生成测试通过；个人 runtime 的 56 项测试通过，包含 49 个生成文件在安装、搬迁和回滚中的字节与模式检查。第二版 v1 候选另通过 11 项宿主元数据、58 项角色/权限/技能和 27 项 BCP 前台/后台/恢复检查，均使用隔离 OpenCode 1.18.33 和本地脚本提供方。首次实际调用暴露 retained-child 尾部标记阻止紧凑回执；第二版保持标记可被上游恢复解析器读取，同时只替换身份及字节严格匹配的原文。候选通过独立审查；生产事务经独立审查发现三个阻塞，修复后由实施方依据 3 项针对性回归和 16 项完整演练接受，未再次独立复审。获批的 3.0.3 生产文件已安装并核验。用户确认自行升级 OpenCode 并批准保留 1.18.35 后，在该精确二进制上重新完成 11+58+27 项隔离检查，随后生产进程的角色、权限、技能、安装与备份核验全部通过。新版本证据独立记录，历史清单和旧版失败报告保留。OpenChamber 安装未被本次升级修改。真实模型工作流、完整压缩恢复、外部 MCP 服务及 v2 宿主不在本次证据内。Node 25.6.1 的实际导入检查通过，但它不在本次 jsdom 30.1.2 声明的引擎范围内。

## 历史版本与验收记录

以下描述保留各版本当时的部署与验证范围；当前 3.0.3 状态与限制以上文为准。

本目录保存已部署适配的三个自有源码文件：`omo-patch.mjs`、`omo-delivery.mjs`、`omo-council.mjs`。当前部署不再手工复制：`~/.config/opencode/local-plugins/build.mjs` 在构建时从本目录同步这三个文件（`OPENCODE_BCP_SOURCE` 可覆盖源目录），因此本目录是唯一源，local-plugins 内为构建副本。v1.13 沿用 v1.12 的 OMO 终态与通知接线，BCP 桥内增加经授权的最终正文留存。上游 OMO bundle、用户配置和生成产物不提交到本仓库。

自 dual-host-major 升级起，本目录承载 OMO 3.0.1 的 v1 插件入口 `dist/index.js`、v2 服务器入口 `dist/server/index.js`、版本限定补丁及构建器 `build-omo.mjs`。两个入口均随整目录提供运行依赖和资源闭包，由 `omo-closure.mjs` 收集并锁定摘要。2026-10-02 的可搬迁包完成空 HOME 环境下 Node/Bun 加载、JSDOM、JSONC、技能和 companion 资源检查；实际 v1/v2 宿主上的作者—评审—返修闭环各通过 27 项检查，使用脚本响应、零真实模型调用。组件测试不构成语义质量或性能结论。完整 2.0.0 组合已通过发布复审并安装到 v1 生产配置，服务端 API 实际模型冒烟通过；现有 UI 未重启，详见 [2.0.0 验收](../../harness/acceptance/v2.0.0.md)。2.2.25 回滚的逐字节一致性仅指重建 bundle 与旧 `dist/omo.js` 一致，不包括独立复制的 helper。

v1.20 新增两项行为，契约见 [编排集成契约](../../docs/orchestration-v1.20.md)：

- **Council 宿主原文装配**（`omo-council.mjs`，桥 `Symbol.for("opencode.bcp.council.v1")`）：Council 问题中的显式 `ses_*` token 与 `cou-N` 别名经宿主从已完成议员席位的终结消息读取原文，核验身份、席位、32 KiB 上限与摘要；全部席位读取与并发准入等待完成后统一做最终代次复查，变动席位整体排除且不带正文；无法解析的显式引用保留为排除条目。装配不改变 OMO 调度、工具隔离与评审判定归属。
- **交付引用回执**（`omo-delivery.mjs`，`REFERENCE_MIN_BYTES = 8192`）：作者终结答复精确等于单段完整终态 body 且宿主可验证字节、身份与原作者时，返回呈现可替换为 `<bcp_result_reference>` 检索回执；未知、更短、不匹配或多重包装一律保留原文。权限与输入复查发生在检查返回之前（`inspectDelivery` 内异步读取 `canReadResult` 并复查 `currentResult`），呈现替换另做版本 CAS。

与用户配置分开维护的 [公开来源策略片段](public-source-policy.md)记录 v1.17 验证所用的主角色交接规则，可合并到既有角色提示中；它不由安装脚本自动应用。

v1.14 修正原生 `task(task_id=...)` 在输出到达后登记新代次时的观察窗口：使用派发时间，防止将本轮终结消息排除为历史。前台输出最多重新进入原终态闸门两次；已有证据读取未结束时等待其既有完成信号，每次最多两秒，仍受调用身份、取消和执行代次约束。原生续接只确认已注入给同一父会话、角色及代次完全一致的终态，不顺带确认其他任务。不绕过闸门、不直接伪造完成状态、不增加模型重试。此行为及未知、取消、旧消息边界有确定性测试和真实原生续接验证。

- `omo-patch.mjs` 导出 `patchOmo(original, {version, entry})`，按精确 SHA-256 自动识别受支持的上游源，未知内容一律抛错、绝不模糊打补丁；补丁锚点必须唯一。已锁定目标（`OMO_TARGETS`）：OMO 2.2.25 `dist/index.js` = `1a8a7a69db029f1c0fea19c4c8ded674281a8e674bedf72b4c8380e0b6de6e1f`；OMO 3.0.1 `dist/index.js` = `442740caaf18e89deb327ea7313d27462cc313e47f1a7e86aa73d32f4c9a80b1`；OMO 3.0.1 `dist/server/index.js` = `d0db4526a00e257dd5bbf7924a465cc095eec3fa39d5fca85ec8db9e973a989f`。
- `omo-delivery.mjs` 提供宿主交付桥、独立元数据和原生通知附加函数，不调用模型或改变执行状态；v1.13 桥可以留存已完成的原文，v1.20 增加引用回执呈现；其后增加对 v2 原生完成包装的严格识别——仅当完整 `<subagent sessionID=… state="completed">` 包装精确位于首尾、包装内会话与执行身份一致且 body 字节数与 SHA-256 匹配时，才逐字节保留包装、仅以回执替换被验证的 body；呈现为该包装形态但任一校验未通过时一律原样返回，不回落 v1 `task_result` 解析。生成 bundle 放在同级 `dist/` 中，以匹配其相对导入。
- `omo-council.mjs` 提供 Council 宿主取证桥：按别名收集显式来源引用，逐席位读取并核验后装配 `<council_host_sources>` payload；所有失败均为带 reason 的排除条目，不编造正文。该 helper 只随 2.2.25 回滚构建复制；3.0.1 构建不携带（上游 Council）。
- 2.2.25 回滚构建通过 OMO 自身 `package.json` 的 `createRequire` 解析 `zod`，沿用文件 URL 策略以复现旧 bundle。3.0.1 v1 将三个静态外部依赖改为相对 vendor 导入；JSONC 使用 ESM 入口，并对闭包内的无扩展名相对导入补全 `.js`。另外，两个入口均复制实际运行依赖的嵌套 `node_modules` 闭包，包含懒加载 `jsdom` 与必要资源，不能只搬迁单个 bundle。

## OMO 3.0.1 双入口补丁与构建器契约

按 2026-10-01 范围收敛，3.0.1 的 Council 行为跟随上游：补丁集不做 Council 议程原文拼接，也不注入 `finalizeCouncil`/`prepareCouncilPrompt`，上游 Council 议程与角色 prompt 在产物中逐字节保留。3.0.1 补丁集 = 33 个唯一锚点行为补丁（`PATCHES_3_0_1`，逐项 `id`/`purpose`/`anchor`/`replacement`，入口差异用 `V(index, server)` 变体表达），并把 delivery helper 导入前置。移植范围与 2.2.25 已部署行为逐项对应：派发时间窗与原生复用（`nativeCallStartedAt`/`registerLaunch`）、注入终态续接确认（`acknowledgeInjectedNativeResume`）、终态闸门重观察、读结算等待、verdict/分类器/提交来源栏结、清除/更新来源合并、前台/任务结果/证据/通知全路径引用回执（CAS 与代次围栏）、注入状态目录、合成注记与 revive 检视。v2 transcript 身份绑定由三个 shim 补丁承担：`shim-user-text-and-parentid` 把 v2 扁平消息形态规范化为终态分类器既有形态——user 输入是扁平 `text` 字段，映射为 transcript parts；assistant 原生无 `parentID`，宿主显式提供者优先保留。`shim-context-transcript-identity` 与 `shim-paged-transcript-identity` 在 transcript 读取路径（真实 v2 宿主上 `client.session.messages` 始终由 shim 提供，早期设想的 `client.message.list` 回退不可达，已删除）及 desc 分页重建升序后的分页路径上应用同一绑定：assistant 的 `parentID` 绑定最近前驱真实 user 输入，synthetic（idle→system）一律不充当输入身份。无真实输入源时该字段保持 undefined，下游归因维持既有 fail-closed 行为（无身份、不留存引用），不猜测 ID。2.2.25 回滚路径不受影响，仍保留 Council 拼接与 finalizeCouncil 接线以逐字节复现已部署集成。

`buildOmoIntegration({packageDir, sourceDir, outputDir, version, entry, dryRun})`（`build-omo.mjs`）校验包名、版本与上游摘要后打补丁。3.0.1 v1 将插件 SDK、JSONC ESM 与 zod 复制到 `vendor/**`，并改写为相对导入；JSONC 闭包内 8 处扩展名补全记录在 manifest。两个入口同时收集运行依赖，保留冲突版本的嵌套布局，复制技能、companion、schema、包元数据和 LICENSE；不复制整个缓存。manifest 记录各包依赖、每个文件摘要、资源及缺失的可选依赖。当前 Linux 包含 v1 的 41 个包、v2 的 42 个包，分别约 73.2/73.4 MB；其他平台的可选原生二进制不在该 Linux 产物中。`dryRun` 不写文件，闭包缺失或越界链接拒绝构建。

3.0.1 使用独立 `omo-delivery.mjs`，不复制私有 Council helper；两个入口的 33 项补丁保留上游 Council 原文。2.2.25 回滚继续使用旧构建策略，只保证 bundle 字节复现。测试包括 12 项补丁与交付测试、7 项闭包及搬迁测试；后者实际执行 Node/Bun 的 DOM、JSONC 和本地文件读取，而非仅检查导入文本。当前 jsdom 30.1.1 声明的 Node 版本范围不含本机 Node 25.6.1，虽然本机 Node/Bun 的上述检查通过，这不能作为该 Node 版本获上游支持的证明。

`test/omo-build.test.mjs`（12 项，`node --test`）锁定：未知版本/参数不符/上游被篡改一律拒绝；`patchOmo` 拒绝非锁定摘要源；v1/v2 两入口各自构建成功、语法通过，v1 同输入重建的代码产物逐字节一致；v1 产物外部依赖全部 vendor 为相对导入且在干净 cwd/HOME、无 node_modules 下被 node 与 bun 真实 import 加载（默认导出形态 `id = "oh-my-opencode-slim"`）；2.2.25 回滚构建与已部署 `dist/omo.js` 逐字节一致（仅限 bundle；随构建独立复制的 helper 摘要可独立变化，由 manifest 固化）；**stock 3.0.1 形态锁定**（两入口均无 BCP 注入标记，33 个保留修复锚点在 stock 中各自恰好出现一次，上游 Council 议程原文恰在一位）；打补丁产物包含全部保留修复、上游 Council 议程逐字节保留、无任何 Council 私有注入，且锚点替换次数与替换文本内嵌次数一致（无丢失、无重复）；构建器契约（manifest 锁定上游摘要、33 项补丁清单与 helper 摘要）；**v2 facade 身份链**（从打补丁 server 产物中逐字提取 shim 与终态分类器声明，用真实 v2 宿主消息形态驱动：user 扁平 text 进入 parts、assistant `parentID` 绑定最近真实 user 输入且宿主提供者优先、synthetic 不充当输入身份、同 child 第二轮绑各自输入、desc 分页路径同绑定、陈旧完成 fail-closed、孤儿 transcript 不猜测输入身份、畸形条目如实拒绝）；**v2 subagent 包装回执**（真实线上捕获 fixture 回放：包装界逐字节保留、仅替换通过字节+SHA-256 校验的 body，错误会话/非 completed 态/多余前后缀/重复闭界/嵌套/篡改 body 一律原样返回，已注记文本幂等不再处理）；**delivery helper 行为**（无宿主身份时桥请求不带 input/terminal 消息 ID——即桥 `no_terminal_identity` 判定的前置条件；带 `bcpOrigin` 时身份逐字段透传；桥超时/异常/超限各自降级；引用回执仅在字节、SHA-256、作者会话与消息 ID、输入 ID、bb:// ID 形态、≥8192 字节、completed 状态全部一致时替换原文，任何一项不符保留原文）。形态检查只证明补丁可安全套用且不重复套用：静态标记/锚点的缺失或存在**不是**上游运行期生命周期缺陷仍存在（或已被上游修复）的证据，运行行为结论只能来自验收 lane 的真实多代理 fixture。helper 行为反例（错身份、陈旧输入、终消息变更、结果不全、CAS/租约/代次围栏）由 local-plugins 部署侧的 `omo-council.test.mjs`/`omo-delivery.test.mjs`（34 项）覆盖。

### 提示与角色说明的保留方式（公开覆写分析结论）

现部署适配不修改任何工具 description；唯一被替换的说明文本是 Council 角色 prompt 的议程段。OMO 3.0.1 提供的公开覆写面（schema 校验）：`agents.<name>.prompt` 整体替换、preset `<agent>_append.md` 仅追加。追加无法等价复现原位替换（上游步骤 1–5 会残留并与 BCP 议程冲突，语义改变）；整体替换虽文本可行，但会把 prompt 从摘要锁定的构建中剥离——上游漂移时静默失效（fail-open）、绕过 hash+锚点校验，且给部署引入当前不存在的必需配置键。按「无法等价再保留源 hash+唯一锚点薄补丁」的既定边界，Council 议程拼接保留为版本限定薄补丁；其余角色 prompt 与工具说明全部原样流经（stock 文本在打补丁产物中不被触碰），`ensureCouncilCompactionException` 的合成强化后处理仍照常附加。此结论针对 2.2.25 已部署回滚路径；自 2026-10-01 范围收敛起，3.0.1 构建不再携带该拼接，Council 议程随上游原样发布。

以下为 2.2.25 的历史构建与自检方式：`~/.config/opencode/local-plugins/` 中的 `node build.mjs`（同步三个 helper 并构建）加 `node --test test/omo-council.test.mjs test/omo-delivery.test.mjs test/acp-export.test.mjs test/vibeguard.test.mjs`。从本仓库取出三个 helper 不等于完成部署；当前 3.0.1 组合使用上文的完整闭包及 dotfiles runtime 安装清单。历史构建脚本、依赖锁与测试归档见下。

历史归档（仅对应其标注版本，不描述当前行为；下列 `/tmp` 路径为机器本地文件，主机重启后已不存在、不可再读取，仅历史记述与 SHA-256 留存）：v1.12 验证归档 `/tmp/opencode/bcp-final-20260927.tar.gz`（SHA-256 `9e6646726ebf2af2f1d17c0705cde0ed1e190eabaaabe291e6c3b7a9666cd93a`，内含当时的 8 项 OMO 适配测试），交付记录：

bb://c233777e-dafa-4e6a-b3df-8d8d09578292/3430e3ff-f2ca-4d18-a34a-7feb05b10ec7/e000026

13 项 OMO 测试及完整本地构建包、锁文件、源码与运行证据随 v1.14 封存于 `/tmp/opencode/bcp-v114-final-20260928.tar.gz`，该测试数量只对应 v1.14 时点。v1.20 时点的自动化检查为 local-plugins 构建、42 项 node --test 通过与 `install.sh`（run-4 记录；bun test / tsc 复用未变文件的 run-2 记录）；首审两项阻塞（Council 并发新鲜度、显式别名静默丢弃）经独立首轮复审 PASS 关闭（bb://c233777e-dafa-4e6a-b3df-8d8d09578292/84f0cb7d-933f-440f-bfd7-eac18ad82a9c/e000001，仅覆盖原阻塞与受影响边界）。完整限定验收见 [v1.20.0 验收](../../harness/acceptance/v1.20.0.md)。当前契约见 [编排集成契约](../../docs/orchestration-v1.20.md)；v1.14 归档覆盖见 [v1.14 验收](../../harness/acceptance/v1.14.0.md)及[契约](../../docs/final-capture-v1.14.md)。旧版接口见 [交付集成契约](../../docs/delivery-integration-v1.12.md)，历史覆盖见 [v1.12 验收](../../harness/acceptance/v1.12.0.md)与 [v1.13 验收](../../harness/acceptance/v1.13.0.md)。升级上游时须重新检查源码与路径，不删除哈希断言强行构建。
