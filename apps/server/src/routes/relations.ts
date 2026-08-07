import type { AppInstance } from '../types.js';
import {
  CreateRelationRequestSchema,
  IdParamsSchema,
  RelationDetailSchema,
  RelationSchema,
  ReviseRelationRequestSchema,
  type CreateRelationRequest,
  type IdParams,
  type ReviseRelationRequest,
} from '@treediagram/contracts';
import { DomainError, RelationService, userAuthor } from '@treediagram/core';
import type { RelationWriteFields } from '@treediagram/core';
import { requireAdmin } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

function writeFieldsOf(body: CreateRelationRequest | ReviseRelationRequest): RelationWriteFields {
  return {
    fromNodeRevisionId: body.fromNodeRevisionId,
    toNodeRevisionId: body.toNodeRevisionId,
    rationaleText: body.rationaleText,
    attributes: body.attributes,
    approvalState: body.approvalState,
  };
}

export function registerRelationRoutes(app: AppInstance, ctx: ServerContext): void {
  const relations = new RelationService({ db: ctx.db, clock: ctx.clock });

  app.post<{ Body: CreateRelationRequest }>(
    '/api/v1/relations',
    {
      schema: { body: CreateRelationRequestSchema, response: { 201: RelationDetailSchema } },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request, reply) => {
      const detail = relations.createCandidateRelation(
        currentProject(ctx),
        request.body.relationType,
        writeFieldsOf(request.body),
        userAuthor,
      );
      return reply.code(201).send(detail);
    },
  );

  app.post<{ Params: IdParams; Body: ReviseRelationRequest }>(
    '/api/v1/relations/:id/revisions',
    {
      schema: {
        params: IdParamsSchema,
        body: ReviseRelationRequestSchema,
        response: { 201: RelationDetailSchema },
      },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request, reply) => {
      const detail = relations.reviseCandidateRelation(
        currentProject(ctx),
        request.params.id,
        request.body.baseRelationRevisionId,
        writeFieldsOf(request.body),
        userAuthor,
      );
      return reply.code(201).send(detail);
    },
  );

  app.post<{ Params: IdParams }>(
    '/api/v1/relations/:id/archive',
    {
      schema: { params: IdParamsSchema, response: { 200: RelationSchema } },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request) => {
      const project = currentProject(ctx);
      relations.removeCandidateRelation(project, request.params.id, userAuthor);
      const relation = ctx.db.repos.relation.getRelationById(request.params.id);
      if (!relation) {
        throw new DomainError('NOT_FOUND', '关系不存在', { relationId: request.params.id });
      }
      return relation;
    },
  );
}
