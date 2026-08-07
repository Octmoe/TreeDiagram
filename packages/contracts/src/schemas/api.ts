import { Type, type Static, type TSchema } from '@sinclair/typebox';
import {
  ApprovalStateSchema,
  EpistemicStateSchema,
  IdSchema,
  LIMITS,
  NodeTypeSchema,
  Nullable,
} from './common.js';
import { NodeDetailSchema, NodeRevisionSchema, NodeSchema } from './node.js';
import { RelationDetailSchema } from './relation.js';

// ---- 通用响应信封（IMPLEMENTATION_DESIGN §11.1） ----

export const ErrorResponseSchema = Type.Object({
  error: Type.Object(
    {
      code: Type.String(),
      message: Type.String(),
      details: Type.Record(Type.String(), Type.Unknown()),
      requestId: Type.String(),
    },
    { additionalProperties: false },
  ),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

/** 成功信封：{ data: T, meta: { requestId } }。仅用于服务端序列化参考。 */
export function successEnvelope(data: unknown, requestId: string) {
  return { data, meta: { requestId } };
}

export const HealthResponseSchema = Type.Object(
  {
    ok: Type.Boolean(),
    version: Type.String(),
  },
  { additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

// ---- 查询视图 ----

export const VIEW_MODES = ['release', 'working'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
export const ViewModeSchema = Type.Union([Type.Literal('release'), Type.Literal('working')]);

export const TreeQuerySchema = Type.Object(
  {
    view: ViewModeSchema,
    parentNodeId: Nullable(IdSchema),
    depth: Type.Integer({ minimum: 1, maximum: 10, default: 1 }),
  },
  { additionalProperties: false },
);
export type TreeQuery = Static<typeof TreeQuerySchema>;

export const TreeResponseSchema = Type.Object(
  {
    view: ViewModeSchema,
    nodes: Type.Array(NodeDetailSchema),
    relations: Type.Array(RelationDetailSchema),
  },
  { additionalProperties: false },
);
export type TreeResponse = Static<typeof TreeResponseSchema>;

export const QueryNodesQuerySchema = Type.Object(
  {
    view: ViewModeSchema,
    type: Nullable(NodeTypeSchema),
    role: Nullable(Type.String({ minLength: 1, maxLength: LIMITS.role })),
    approval: Nullable(ApprovalStateSchema),
    epistemic: Nullable(EpistemicStateSchema),
    text: Nullable(Type.String({ minLength: 1, maxLength: 500 })),
    limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
    cursor: Nullable(Type.String()),
  },
  { additionalProperties: false },
);
export type QueryNodesQuery = Static<typeof QueryNodesQuerySchema>;

export const QueryNodesResponseSchema = Type.Object(
  {
    nodes: Type.Array(NodeDetailSchema),
    nextCursor: Nullable(Type.String()),
  },
  { additionalProperties: false },
);
export type QueryNodesResponse = Static<typeof QueryNodesResponseSchema>;

export const NodeRelationsQuerySchema = Type.Object(
  {
    direction: Type.Union([Type.Literal('in'), Type.Literal('out'), Type.Literal('both')], {
      default: 'both',
    }),
    view: ViewModeSchema,
  },
  { additionalProperties: false },
);
export type NodeRelationsQuery = Static<typeof NodeRelationsQuerySchema>;

export const NodeRelationsResponseSchema = Type.Object(
  {
    incoming: Type.Array(RelationDetailSchema),
    outgoing: Type.Array(RelationDetailSchema),
  },
  { additionalProperties: false },
);
export type NodeRelationsResponse = Static<typeof NodeRelationsResponseSchema>;

export const NodeHistoryResponseSchema = Type.Object(
  {
    node: NodeSchema,
    revisions: Type.Array(NodeRevisionSchema),
  },
  { additionalProperties: false },
);
export type NodeHistoryResponse = Static<typeof NodeHistoryResponseSchema>;

export const NodeViewQuerySchema = Type.Object(
  { view: ViewModeSchema },
  { additionalProperties: false },
);
export type NodeViewQuery = Static<typeof NodeViewQuerySchema>;

export const EventsQuerySchema = Type.Object(
  {
    after: Type.Integer({ minimum: 0, default: 0 }),
    limit: Type.Integer({ minimum: 1, maximum: 1000, default: 100 }),
  },
  { additionalProperties: false },
);
export type EventsQuery = Static<typeof EventsQuerySchema>;

export const IdParamsSchema = Type.Object(
  { id: IdSchema },
  { additionalProperties: false },
);
export type IdParams = Static<typeof IdParamsSchema>;
