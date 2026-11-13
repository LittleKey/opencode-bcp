# AUTO_CAPTURE 条件性 system 注入决策

**状态**：2026-10-28 设计评估 PASS；本文件只记录决策说明与验证边界，不是部署授权，也不重开已关闭的 gate。本决策不改变生产逻辑、常量文案和 SDK 依赖。

## 结论

`AUTO_CAPTURE_INSTRUCTION` 是插件提供的静态回复格式规则，继续由 v2 context hook 写入本次请求的 `system` 数组。保留当前条件注入：不迁移到 `messages`，不新增 instruction entry，也不改为无条件常驻 `system`。

## 当前实现与门控

- 注入点在 context hook：`src/adapters/v2/index.ts:869-873`。
- 精确门控：`autoCapture && confirmed !== null`。
  - `autoCapture` 默认开启；`false` 时回退手动 `board_put` 契约（`src/adapters/v2/index.ts:192-198`）。
  - `confirmed` 由 `confirmedCandidate` 返回：最后一条 `user` 消息必须有 ID，且该 ID 属于本次已观测候选或当前已确认输入；仅历史中存在旧用户输入不构成关联（`src/adapters/v2/index.ts:151-177`）。
  - 该逻辑在 `registerScopeContext` 成功返回后执行；会话身份不可登记时不进入注入路径（`src/adapters/v2/index.ts:837-843`）。
- 写入方式：仅当 `input.system` 是数组、且没有文本完全等于 `AUTO_CAPTURE_INSTRUCTION` 的项时，追加 `{ type: "text", text: AUTO_CAPTURE_INSTRUCTION }`；`system` 不可用则跳过，已有相同文本不重复追加（`src/adapters/v2/index.ts:869-873`）。
- 文案与 golden：`src/constants.ts:41-42`；本轮不改。
- 当前 draft 每次 context 重新评估；新请求重建 `system` 后重新判断，不做“会话只注入一次”缓存。

## 与 nudge 门控的区别

AUTO 的上述门控只决定本次请求是否追加格式规则。nudge 的 verified 注入另用 `boundary.provable && requestVerified`（`src/adapters/v2/index.ts:856-859, 893`），并走既有预算与保守失效事务。二者不得混写：AUTO 不消耗、取消或替代 nudge 预算，也不改变其请求边界判断。

## 固定文本与边界

- 规则文本固定，但存在性随请求类别变化；不宣称 `system` 前缀恒定，也不声称缓存命中率提高。
- 格式提示不授予留存权限，也不证明留存成功。`no-store`、作者身份、当前输入关联、完成状态和发布权限仍由 capture 路径核验（`src/capture.ts:68-99`）。
- 缺少已准入输入关联的后台 synthetic 续步不承诺自动留存覆盖；无 ID 的尾部 user 消息（包括 synthetic 续步）不能充当确认输入（`src/adapters/v2/index.ts:151-177`）。
- 子代理正文、评审意见和记录内容不得提升为 `system`。
- 本决策不引入 instruction entry、持久指令状态或新的消息槽位；不改变用户持久历史、子代理回执、来源交接、工具描述及 V1 行为。

## 备选为什么未采用

- **迁移到请求 messages 副本**：放入 user 消息会降低格式规则优先级；修改较早业务输入槽位也不等于在请求末尾追加，未必形成稳定完整前缀；新造尾部消息还会引入请求边界与角色语义问题。
- **instruction entry**：它是持久受信指令，不是请求局部替代，会引入新的持久生命周期；且在 context hook 内写入新 entry 不能保证本请求读取时已包含它。还会引入撤销、卸载、旧会话、实例归属和首次生效时机问题。
- **无条件常驻 system**：会扩大到未确认输入、synthetic 等请求，改变格式义务的适用范围；它不会自动突破 capture 权限检查，但不是当前需要的扩大。
- **升级宿主 2.2**：2.2 只新增 facade，不是新的 hook；2.1.4 的 instruction preparation 在 request hook 之前，context hook 内 `put` 不能保证本请求已包含新规则。当前 2.1.4 无需升级。

## 证据与验证范围

- 决策原文：`bb://08f43290-4450-4bb9-9773-5d7efbe15e82/175b5d3e-02b1-4e65-9f83-8767d92ba52c/e000001`（oracle，2026-10-28；PASS）。
- 代码导航：
  - `src/adapters/v2/index.ts:151-177` — `confirmedCandidate` 的当前输入关联规则。
  - `src/adapters/v2/index.ts:837-873` — context hook、会话登记、AUTO 门控与 `system` 写入。
  - `src/adapters/v2/index.ts:893` — nudge 的 `boundary.provable && requestVerified` 门控。
  - `src/constants.ts:41-42` — `AUTO_CAPTURE_INSTRUCTION` 文案。
  - `src/capture.ts:68-99` — 留存前的完成、no-store、当前输入与授权核验。
- 本文件只覆盖文档 / fixture 口径：未验证 live/provider wire、真实模型遵循率、宿主实际事件顺序或缓存命中率；没有部署、升级或运行时变更。定向回归属于实施侧验证，本文件不声明测试已通过。
- 旧文档和旧评审文字保留其历史含义；本文件不把未落地的迁移写成已实现。
