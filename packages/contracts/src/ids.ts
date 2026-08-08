// 带品牌的 ID 类型：编译期防止不同聚合 ID 混用（IMPLEMENTATION_DESIGN §3.2）。
// 实际生成使用 crypto.randomUUID()，位于 @treediagram/core。

declare const idBrand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [idBrand]: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type NodeRevisionId = Brand<string, 'NodeRevisionId'>;
export type RelationId = Brand<string, 'RelationId'>;
export type RelationRevisionId = Brand<string, 'RelationRevisionId'>;
export type ChangeSetId = Brand<string, 'ChangeSetId'>;
export type ReleaseId = Brand<string, 'ReleaseId'>;
export type SourceAssetId = Brand<string, 'SourceAssetId'>;
export type DelegationPolicyId = Brand<string, 'DelegationPolicyId'>;
export type WorkflowRunId = Brand<string, 'WorkflowRunId'>;
export type WorkflowMessageId = Brand<string, 'WorkflowMessageId'>;
export type WorkflowWaitId = Brand<string, 'WorkflowWaitId'>;
export type ReviewItemId = Brand<string, 'ReviewItemId'>;

/** 将受信来源（数据库行、已校验请求）的字符串标记为对应品牌 ID。 */
export function asId<T extends Brand<string, string>>(value: string): T {
  return value as T;
}
