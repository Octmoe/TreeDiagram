import type { AppInstance } from '../types.js';
import {
  CreateNodeRequestSchema,
  IdParamsSchema,
  NodeDetailSchema,
  NodeHistoryResponseSchema,
  NodeRelationsQuerySchema,
  NodeRelationsResponseSchema,
  NodeSchema,
  NodeViewQuerySchema,
  ReviseNodeRequestSchema,
  type CreateNodeRequest,
  type IdParams,
  type NodeRelationsQuery,
  type NodeViewQuery,
  type ReviseNodeRequest,
} from '@treediagram/contracts';
import { DomainError, NodeService, RelationService, userAuthor } from '@treediagram/core';
import type { NodeWriteFields } from '@treediagram/core';
import { assertReleaseReadGate, assertViewAllowed, requireAdmin } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

function writeFieldsOf(body: CreateNodeRequest | ReviseNodeRequest): NodeWriteFields {
  return {
    displayTitle: body.displayTitle,
    contentText: body.contentText,
    roles: body.roles,
    attributes: body.attributes,
    approvalState: body.approvalState,
    epistemicState: body.epistemicState,
  };
}

export function registerNodeRoutes(app: AppInstance, ctx: ServerContext): void {
  const nodes = new NodeService({ db: ctx.db, clock: ctx.clock });
  const relations = new RelationService({ db: ctx.db, clock: ctx.clock });

  app.post<{ Body: CreateNodeRequest }>(
    '/api/v1/nodes',
    {
      schema: { body: CreateNodeRequestSchema, response: { 201: NodeDetailSchema } },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request, reply) => {
      const detail = nodes.createCandidateNode(
        currentProject(ctx),
        request.body.nodeType,
        writeFieldsOf(request.body),
        userAuthor,
      );
      return reply.code(201).send(detail);
    },
  );

  app.get<{ Params: IdParams; Querystring: NodeViewQuery }>(
    '/api/v1/nodes/:id',
    {
      schema: {
        params: IdParamsSchema,
        querystring: NodeViewQuerySchema,
        response: { 200: NodeDetailSchema },
      },
    },
    async (request) => {
      const { view } = request.query;
      assertViewAllowed(request, view);
      if (view === 'release') assertReleaseReadGate(request, currentProject(ctx));
      return nodes.getNode(currentProject(ctx), request.params.id, view);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/nodes/:id/history',
    {
      schema: { params: IdParamsSchema, response: { 200: NodeHistoryResponseSchema } },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request) => nodes.getNodeHistory(currentProject(ctx), request.params.id),
  );

  app.get<{ Params: IdParams; Querystring: NodeRelationsQuery }>(
    '/api/v1/nodes/:id/relations',
    {
      schema: {
        params: IdParamsSchema,
        querystring: NodeRelationsQuerySchema,
        response: { 200: NodeRelationsResponseSchema },
      },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request) =>
      relations.getRelations(
        currentProject(ctx),
        request.params.id,
        request.query.direction ?? 'both',
        request.query.view,
      ),
  );

  app.post<{ Params: IdParams; Body: ReviseNodeRequest }>(
    '/api/v1/nodes/:id/revisions',
    {
      schema: {
        params: IdParamsSchema,
        body: ReviseNodeRequestSchema,
        response: { 201: NodeDetailSchema },
      },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request, reply) => {
      const detail = nodes.reviseCandidateNode(
        currentProject(ctx),
        request.params.id,
        request.body.baseRevisionId,
        writeFieldsOf(request.body),
        userAuthor,
      );
      return reply.code(201).send(detail);
    },
  );

  // 逻辑归档（API_CONTRACT §6.4：禁止 HTTP DELETE 物理删除）
  app.post<{ Params: IdParams }>(
    '/api/v1/nodes/:id/archive',
    {
      schema: { params: IdParamsSchema, response: { 200: NodeSchema } },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request) => {
      const project = currentProject(ctx);
      nodes.removeCandidateNode(project, request.params.id, userAuthor);
      const node = ctx.db.repos.node.getNodeById(request.params.id);
      if (!node) throw new DomainError('NOT_FOUND', '节点不存在', { nodeId: request.params.id });
      return node;
    },
  );
}
