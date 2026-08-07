import { Type, type Static } from '@sinclair/typebox';
import {
  AuthorKindSchema,
  EventTypeSchema,
  IdSchema,
  IsoTimestampSchema,
  LIMITS,
  Nullable,
} from './common.js';

export const ReleaseSchema = Type.Object(
  {
    id: IdSchema,
    projectId: IdSchema,
    version: Type.Integer({ minimum: 1 }),
    rootRevisionIds: Type.Array(IdSchema),
    nodeRevisionIds: Type.Array(IdSchema),
    relationRevisionIds: Type.Array(IdSchema),
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
    projectId: IdSchema,
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
  { release: ReleaseSchema },
  { additionalProperties: false },
);
export type ReleaseCurrentResponse = Static<typeof ReleaseCurrentResponseSchema>;
