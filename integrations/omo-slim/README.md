# OMO Slim 2.2.25 适配源码

本目录保存已部署适配的两个自有源码文件，与 `~/.config/opencode/local-plugins/` 中同名文件逐字节一致。v1.13 沿用 v1.12 的 OMO 终态与通知接线，BCP 桥内增加经授权的最终正文留存。上游 OMO bundle、用户配置和生成产物不提交到本仓库。

与用户配置分开维护的 [公开来源策略片段](public-source-policy.md)记录 v1.17 验证所用的主角色交接规则，可合并到既有角色提示中；它不由安装脚本自动应用。

v1.14 修正原生 `task(task_id=...)` 在输出到达后登记新代次时的观察窗口：使用派发时间，防止将本轮终结消息排除为历史。前台输出最多重新进入原终态闸门两次；已有证据读取未结束时等待其既有完成信号，每次最多两秒，仍受调用身份、取消和执行代次约束。原生续接只确认已注入给同一父会话、角色及代次完全一致的终态，不顺带确认其他任务。不绕过闸门、不直接伪造完成状态、不增加模型重试。此行为及未知、取消、旧消息边界有确定性测试和真实原生续接验证。

- `omo-patch.mjs` 导出 `patchOmo(original)`，只接受 SHA-256 为 `1a8a7a69db029f1c0fea19c4c8ded674281a8e674bedf72b4c8380e0b6de6e1f` 的 OMO 2.2.25 `dist/index.js`；补丁锚点必须唯一。
- `omo-delivery.mjs` 提供宿主交付桥、独立元数据和原生通知附加函数，不调用模型或改变执行状态；v1.13 桥可以留存已完成的原文。生成 bundle 放在同级 `dist/` 中，以匹配其相对导入。
- 构建还必须通过 OMO 自身 `package.json` 创建的 `createRequire` 解析 `zod`，并将 bundle 的 `from "zod"` 改为该解析结果的文件 URL，避免误用宿主 SDK 提升到顶层的旧版本。

运行部署继续使用已安装的本地插件包；从本仓库取出这两个文件不等于完成部署。完整构建脚本、依赖锁、8 项 OMO 适配测试及其他插件回归测试保存在 v1.12 验证归档 `/tmp/opencode/bcp-final-20260927.tar.gz`，SHA-256 为 `9e6646726ebf2af2f1d17c0705cde0ed1e190eabaaabe291e6c3b7a9666cd93a`，以及交付记录：

bb://c233777e-dafa-4e6a-b3df-8d8d09578292/3430e3ff-f2ca-4d18-a34a-7feb05b10ec7/e000026

当前 13 项 OMO 测试及完整本地构建包、锁文件、源码与运行证据随 v1.14 封存于 `/tmp/opencode/bcp-v114-final-20260928.tar.gz`。当前覆盖见 [v1.14 验收](../../harness/acceptance/v1.14.0.md)及[契约](../../docs/final-capture-v1.14.md)。旧版接口见 [交付集成契约](../../docs/delivery-integration-v1.12.md)，历史覆盖见 [v1.12 验收](../../harness/acceptance/v1.12.0.md)与 [v1.13 验收](../../harness/acceptance/v1.13.0.md)。升级上游时须重新检查源码与路径，不删除哈希断言强行构建。
