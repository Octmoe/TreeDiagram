import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../types.js';
import {
  QueryNodesQuerySchema,
  TreeQuerySchema,
  TreeResponseSchema,
  QueryNodesResponseSchema,
  type QueryNodesQuery,
  type TreeQuery,
} from '@treediagram/contracts';
import { QueryService } from '@treediagram/core';
import { assertReleaseReadGate, assertViewAllowed } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

/** release 视图的 consumer 闸门 + working 视图的 scope 限制（API_CONTRACT §2.2/§3.3）。 */
function gateView(request: FastifyRequest, ctx: ServerContext, view: string): void {
  assertViewAllowed(request, view);
  if (view === 'release') {
    assertReleaseReadGate(request, currentProject(ctx));
  }
}

export function registerTreeRoutes(app: AppInstance, ctx: ServerContext): void {
  const queries = new QueryService({ db: ctx.db, clock: ctx.clock });

  app.get<{ Querystring: TreeQuery }>(
    '/api/v1/tree',
    { schema: { querystring: TreeQuerySchema, response: { 200: TreeResponseSchema } } },
    async (request) => {
      const { view, parentNodeId, depth } = request.query;
      gateView(request, ctx, view);
      return queries.getTree(currentProject(ctx), view, parentNodeId ?? null, depth ?? 1);
    },
  );

  app.get<{ Querystring: QueryNodesQuery }>(
    '/api/v1/query',
    { schema: { querystring: QueryNodesQuerySchema, response: { 200: QueryNodesResponseSchema } } },
    async (request) => {
      const q = request.query;
      gateView(request, ctx, q.view);
      return queries.queryNodes(currentProject(ctx), q.view, {
        type: q.type ?? null,
        role: q.role ?? null,
        approval: q.approval ?? null,
        epistemic: q.epistemic ?? null,
        text: q.text ?? null,
        limit: q.limit ?? 50,
        cursor: q.cursor ?? null,
      });
    },
  );
}
