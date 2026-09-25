// v1 shim：实现已迁至 src/adapters/v1/index.ts（DESIGN §16.2 双 adapter 布局）。
// 保留原模块路径，既有测试与 dist 构建入口零改动。
export { BlackboardPlugin, default } from "./adapters/v1"
