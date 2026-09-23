// DESIGN §14.3 / §8：board.aggregate 属 M1 第二步（目录真实膨胀后另立计划）。
// 本文件仅保留类型与说明：不注册工具、不实现聚合机制。
export type AggregateInput = {
  member_ids: string[]
  description: string
  navigation_body: string
}

export const AGGREGATE_DEFERRED =
  "board.aggregate 属 DESIGN §14.3 第二步：待 M1 live 且目录真实膨胀后另立计划；本文件仅保留类型与说明，不注册工具、不实现机制。"
