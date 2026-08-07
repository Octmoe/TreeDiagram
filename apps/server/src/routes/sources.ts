import type { AppInstance } from '../types.js';
import {
  CreateSourceRequestSchema,
  IdParamsSchema,
  SourceAssetMetaSchema,
  SourceAssetSchema,
  type CreateSourceRequest,
  type IdParams,
} from '@treediagram/contracts';
import { Type } from '@sinclair/typebox';
import { DomainError, SourceService, userAuthor } from '@treediagram/core';
import { requireAdmin } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

/** V1 只接受纯文本与 Markdown（API_CONTRACT §6.2）。 */
const ALLOWED_MEDIA_TYPES = new Set(['text/plain', 'text/markdown']);

export function registerSourceRoutes(app: AppInstance, ctx: ServerContext): void {
  const sources = new SourceService(ctx.db, ctx.clock, ctx.config.maxSourceBytes);

  app.post<{ Body: CreateSourceRequest }>(
    '/api/v1/sources',
    {
      schema: {
        body: CreateSourceRequestSchema,
        response: { 201: SourceAssetSchema },
      },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request, reply) => {
      if (!ALLOWED_MEDIA_TYPES.has(request.body.mediaType)) {
        throw new DomainError('VALIDATION_FAILED', '只接受 text/plain 或 text/markdown', {
          mediaType: request.body.mediaType,
        });
      }
      const project = currentProject(ctx);
      const asset = sources.addSource(project.id, request.body, userAuthor);
      return reply.code(201).send(asset);
    },
  );

  app.get(
    '/api/v1/sources',
    {
      schema: { response: { 200: Type.Array(SourceAssetMetaSchema) } },
      preHandler: async (request) => requireAdmin(request),
    },
    async () => sources.listSources(currentProject(ctx).id),
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/sources/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: SourceAssetSchema },
      },
      preHandler: async (request) => requireAdmin(request),
    },
    async (request) => sources.getSource(request.params.id),
  );
}
