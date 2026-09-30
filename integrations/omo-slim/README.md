# OMO Slim 2.2.25 适配源码

本目录保存已部署适配的三个自有源码文件：`omo-patch.mjs`、`omo-delivery.mjs`、`omo-council.mjs`。当前部署不再手工复制：`~/.config/opencode/local-plugins/build.mjs` 在构建时从本目录同步这三个文件（`OPENCODE_BCP_SOURCE` 可覆盖源目录），因此本目录是唯一源，local-plugins 内为构建副本。v1.13 沿用 v1.12 的 OMO 终态与通知接线，BCP 桥内增加经授权的最终正文留存。上游 OMO bundle、用户配置和生成产物不提交到本仓库。

v1.20 新增两项行为，契约见 [编排集成契约](../../docs/orchestration-v1.20.md)：

- **Council 宿主原文装配**（`omo-council.mjs`，桥 `Symbol.for("opencode.bcp.council.v1")`）：Council 问题中的显式 `ses_*` token 与 `cou-N` 别名经宿主从已完成议员席位的终结消息读取原文，核验身份、席位、32 KiB 上限与摘要；全部席位读取与并发准入等待完成后统一做最终代次复查，变动席位整体排除且不带正文；无法解析的显式引用保留为排除条目。装配不改变 OMO 调度、工具隔离与评审判定归属。
- **交付引用回执**（`omo-delivery.mjs`，`REFERENCE_MIN_BYTES = 8192`）：作者终结答复精确等于单段完整终态 body 且宿主可验证字节、身份与原作者时，返回呈现可替换为 `<bcp_result_reference>` 检索回执；未知、更短、不匹配或多重包装一律保留原文。权限与输入复查发生在检查返回之前（`inspectDelivery` 内异步读取 `canReadResult` 并复查 `currentResult`），呈现替换另做版本 CAS。

与用户配置分开维护的 [公开来源策略片段](public-source-policy.md)记录 v1.17 验证所用的主角色交接规则，可合并到既有角色提示中；它不由安装脚本自动应用。

v1.14 修正原生 `task(task_id=...)` 在输出到达后登记新代次时的观察窗口：使用派发时间，防止将本轮终结消息排除为历史。前台输出最多重新进入原终态闸门两次；已有证据读取未结束时等待其既有完成信号，每次最多两秒，仍受调用身份、取消和执行代次约束。原生续接只确认已注入给同一父会话、角色及代次完全一致的终态，不顺带确认其他任务。不绕过闸门、不直接伪造完成状态、不增加模型重试。此行为及未知、取消、旧消息边界有确定性测试和真实原生续接验证。

- `omo-patch.mjs` 导出 `patchOmo(original)`，只接受 SHA-256 为 `1a8a7a69db029f1c0fea19c4c8ded674281a8e674bedf72b4c8380e0b6de6e1f` 的 OMO 2.2.25 `dist/index.js`；补丁锚点必须唯一。
- `omo-delivery.mjs` 提供宿主交付桥、独立元数据和原生通知附加函数，不调用模型或改变执行状态；v1.13 桥可以留存已完成的原文，v1.20 增加引用回执呈现。生成 bundle 放在同级 `dist/` 中，以匹配其相对导入。
- `omo-council.mjs` 提供 Council 宿主取证桥：按别名收集显式来源引用，逐席位读取并核验后装配 `<council_host_sources>` payload；所有失败均为带 reason 的排除条目，不编造正文。
- 构建还必须通过 OMO 自身 `package.json` 创建的 `createRequire` 解析 `zod`，并将 bundle 的 `from "zod"` 改为该解析结果的文件 URL，避免误用宿主 SDK 提升到顶层的旧版本。

运行部署继续使用已安装的本地插件包；从本仓库取出这三个文件不等于完成部署。当前构建与自检在 `~/.config/opencode/local-plugins/` 完成：`node build.mjs`（同步三个 helper 并构建）加 `node --test test/omo-council.test.mjs test/omo-delivery.test.mjs test/acp-export.test.mjs test/vibeguard.test.mjs`；完整构建脚本、依赖锁与历史测试归档见下。

历史归档（仅对应其标注版本，不描述当前行为）：v1.12 验证归档 `/tmp/opencode/bcp-final-20260927.tar.gz`（SHA-256 `9e6646726ebf2af2f1d17c0705cde0ed1e190eabaaabe291e6c3b7a9666cd93a`，内含当时的 8 项 OMO 适配测试），交付记录：

bb://c233777e-dafa-4e6a-b3df-8d8d09578292/3430e3ff-f2ca-4d18-a34a-7feb05b10ec7/e000026

13 项 OMO 测试及完整本地构建包、锁文件、源码与运行证据随 v1.14 封存于 `/tmp/opencode/bcp-v114-final-20260928.tar.gz`，该测试数量只对应 v1.14 时点。v1.20 时点的自动化检查为 local-plugins 构建、42 项 node --test 通过与 `install.sh`（run-4 记录；bun test / tsc 复用未变文件的 run-2 记录）；首审两项阻塞（Council 并发新鲜度、显式别名静默丢弃）经独立首轮复审 PASS 关闭（bb://c233777e-dafa-4e6a-b3df-8d8d09578292/84f0cb7d-933f-440f-bfd7-eac18ad82a9c/e000001，仅覆盖原阻塞与受影响边界）。完整限定验收见 [v1.20.0 验收](../../harness/acceptance/v1.20.0.md)。当前契约见 [编排集成契约](../../docs/orchestration-v1.20.md)；v1.14 归档覆盖见 [v1.14 验收](../../harness/acceptance/v1.14.0.md)及[契约](../../docs/final-capture-v1.14.md)。旧版接口见 [交付集成契约](../../docs/delivery-integration-v1.12.md)，历史覆盖见 [v1.12 验收](../../harness/acceptance/v1.12.0.md)与 [v1.13 验收](../../harness/acceptance/v1.13.0.md)。升级上游时须重新检查源码与路径，不删除哈希断言强行构建。
