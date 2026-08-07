import type { AppInstance } from '../types.js';
import {
  EventsQuerySchema,
  EventsResponseSchema,
  ReleaseCurrentResponseSchema,
  type EventsQuery,
} from '@treediagram/contracts';
import { QueryService, ReleaseService } from '@treediagram/core';
import { assertReleaseReadGate } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

export function registerReleaseRoutes(app: AppInstance, ctx: ServerContext): void {
  const releases = new ReleaseService({ db: ctx.db, clock: ctx.clock });
  const queries = new QueryService({ db: ctx.db, clock: ctx.clock });

  // 闸门见 API_CONTRACT §3.3：admin 始终可读，consumer 仅 consistent。
  app.get(
    '/api/v1/release/current',
    { schema: { response: { 200: ReleaseCurrentResponseSchema } } },
    async (request) => {
      const project = currentProject(ctx);
      assertReleaseReadGate(request, project);
      if (!project.currentReleaseId) return { release: null };
      return { release: releases.getCurrentRelease(project) };
    },
  );

  // events 对 admin/consumer 始终可读（增量同步，after 为单调事件 cursor）。
  app.get<{ Querystring: EventsQuery }>(
    '/api/v1/events',
    { schema: { querystring: EventsQuerySchema, response: { 200: EventsResponseSchema } } },
    async (request) =>
      queries.getEvents(currentProject(ctx), request.query.after ?? 0, request.query.limit ?? 100),
  );
}
