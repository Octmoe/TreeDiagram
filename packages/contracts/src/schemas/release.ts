import { Type, type Static } from '@sinclair/typebox';
import {
  AuthorKindSchema,
  EventTypeSchema,
  IdSchema,
  IsoTimestampSchema,
  NodeRevisionIdSchema,
  ProjectIdSchema,
  RelationRevisionIdSchema,
  ReleaseIdSchema,
  LIMITS,
  Nullable,
} from './common.js';

export const ReleaseSchema = Type.Object(
  {
    id: ReleaseIdSchema,
    projectId: ProjectIdSchema,
    version: Type.Integer({ minimum: 1 }),
    rootRevisionIds: Type.Array(NodeRevisionIdSchema),
    nodeRevisionIds: Type.Array(NodeRevisionIdSchema),
    relationRevisionIds: Type.Array(RelationRevisionIdSchema),
    summary: Type.String({ maxLength: LIMITS.summary }),
    authorKind: AuthorKindSchema,
    authorRef: Nullable(Type.String({ maxLength: LIMITS.authorRef })),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type Release = Static<typeof ReleaseSchema>;

export const EventSchema = Type.Object(
  {
    cursor: Type.Integer({ minimum: 1 }),
    projectId: ProjectIdSchema,
    eventType: EventTypeSchema,
    payload: Type.Record(Type.String(), Type.Unknown()),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type EventRecord = Static<typeof EventSchema>;

export const EventsResponseSchema = Type.Object(
  {
    events: Type.Array(EventSchema),
    nextCursor: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type EventsResponse = Static<typeof EventsResponseSchema>;

export const ReleaseCurrentResponseSchema = Type.Object(
  { release: Nullable(ReleaseSchema) },
  { additionalProperties: false },
);
export type ReleaseCurrentResponse = Static<typeof ReleaseCurrentResponseSchema>;
