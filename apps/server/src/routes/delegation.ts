import type { AppInstance } from '../types.js';
import {
  DelegationPolicySchema,
  DelegationResolutionSchema,
  IdParamsSchema,
  SetDelegationRequestSchema,
  type IdParams,
  type SetDelegationRequest,
} from '@treediagram/contracts';
import { DelegationService, userAuthor } from '@treediagram/core';
import { requireAdmin, sendNoContent } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

export function registerDelegationRoutes(app: AppInstance, ctx: ServerContext): void {
  const delegations = new DelegationService({ db: ctx.db, clock: ctx.clock });
  const admin = async (request: Parameters<typeof requireAdmin>[0]) => requireAdmin(request);

  app.get<{ Params: IdParams }>(
    '/api/v1/nodes/:id/delegation',
    {
      schema: { params: IdParamsSchema, response: { 200: DelegationResolutionSchema } },
      preHandler: admin,
    },
    async (request) => delegations.getResolution(currentProject(ctx), request.params.id),
  );

  app.put<{ Params: IdParams; Body: SetDelegationRequest }>(
    '/api/v1/nodes/:id/delegation',
    {
      schema: {
        params: IdParamsSchema,
        body: SetDelegationRequestSchema,
        response: { 200: DelegationPolicySchema },
      },
      preHandler: admin,
    },
    async (request) =>
      delegations.setPolicy(currentProject(ctx), request.params.id, request.body.mode, userAuthor),
  );

  // 仅撤销策略，不删除历史记录（API_CONTRACT §6.6）
  app.delete<{ Params: IdParams }>(
    '/api/v1/nodes/:id/delegation',
    { schema: { params: IdParamsSchema }, preHandler: admin },
    async (request, reply) => {
      delegations.revokePolicy(currentProject(ctx), request.params.id, userAuthor);
      return sendNoContent(reply);
    },
  );
}
