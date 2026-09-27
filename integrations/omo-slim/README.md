# OMO Slim 2.2.25 适配源码

本目录保存 v1.12 已部署适配的两个自有源码文件，与 `~/.config/opencode/local-plugins/` 中同名文件逐字节一致。上游 OMO bundle、用户配置和生成产物不提交到本仓库。

- `omo-patch.mjs` 导出 `patchOmo(original)`，只接受 SHA-256 为 `1a8a7a69db029f1c0fea19c4c8ded674281a8e674bedf72b4c8380e0b6de6e1f` 的 OMO 2.2.25 `dist/index.js`；补丁锚点必须唯一。
- `omo-delivery.mjs` 提供只读宿主桥、独立元数据和原生通知附加函数。生成 bundle 放在同级 `dist/` 中，以匹配其相对导入。
- 构建还必须通过 OMO 自身 `package.json` 创建的 `createRequire` 解析 `zod`，并将 bundle 的 `from "zod"` 改为该解析结果的文件 URL，避免误用宿主 SDK 提升到顶层的旧版本。

运行部署继续使用已安装的本地插件包；从本仓库取出这两个文件不等于完成部署。完整构建脚本、依赖锁、8 项 OMO 适配测试及其他插件回归测试保存在 v1.12 验证归档 `/tmp/opencode/bcp-final-20260927.tar.gz`，SHA-256 为 `9e6646726ebf2af2f1d17c0705cde0ed1e190eabaaabe291e6c3b7a9666cd93a`，以及交付记录：

bb://c233777e-dafa-4e6a-b3df-8d8d09578292/3430e3ff-f2ca-4d18-a34a-7feb05b10ec7/e000026

接口与边界见 [交付集成契约](../../docs/delivery-integration-v1.12.md)，实际覆盖见 [验收记录](../../harness/acceptance/v1.12.0.md)。升级上游时须重新检查源码与路径，不删除哈希断言强行构建。
