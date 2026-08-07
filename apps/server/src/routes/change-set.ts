import type { AppInstance } from '../types.js';
import {
  BlockReviewItemRequestSchema,
  ChangeSetCurrentResponseSchema,
  CheckConsistencyResponseSchema,
  IdParamsSchema,
  PublishReleaseRequestSchema,
  ReleaseSchema,
  ResolveReviewItemRequestSchema,
  ReviewItemSchema,
  ReviewItemsResponseSchema,
  type BlockReviewItemRequest,
  type IdParams,
  type PublishReleaseRequest,
  type ResolveReviewItemRequest,
} from '@treediagram/contracts';
import { ChangeSetService, DomainError, ReleaseService, userAuthor } from '@treediagram/core';
import type { ChangeSet } from '@treediagram/contracts';
import { requireAdmin } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

/** 当前 live ChangeSet；不存在则 404（publish/adopt 等操作的前置）。 */
function requireLive(ctx: ServerContext, changeSets: ChangeSetService): ChangeSet {
  const live = changeSets.getLive(currentProject(ctx));
  if (!live) {
    throw new DomainError('NOT_FOUND', '当前没有 live ChangeSet');
  }
  return live;
}

export function registerChangeSetRoutes(app: AppInstance, ctx: ServerContext): void {
  const changeSets = new ChangeSetService({ db: ctx.db, clock: ctx.clock });
  const releases = new ReleaseService({ db: ctx.db, clock: ctx.clock });
  const admin = async (request: Parameters<typeof requireAdmin>[0]) => requireAdmin(request);

  app.get(
    '/api/v1/change-set/current',
    { schema: { response: { 200: ChangeSetCurrentResponseSchema } }, preHandler: admin },
    async () => changeSets.getCurrentView(currentProject(ctx)),
  );

  app.get(
    '/api/v1/change-set/review-items',
    { schema: { response: { 200: ReviewItemsResponseSchema } }, preHandler: admin },
    async () => changeSets.reviewItems(requireLive(ctx, changeSets).id),
  );

  app.post(
    '/api/v1/change-set/adopt',
    { schema: { response: { 200: ChangeSetCurrentResponseSchema } }, preHandler: admin },
    async () => {
      const changeSet = requireLive(ctx, changeSets);
      changeSets.adopt(changeSet.id, userAuthor);
      return changeSets.getCurrentView(currentProject(ctx));
    },
  );

  app.post(
    '/api/v1/change-set/abandon',
    { schema: { response: { 200: ChangeSetCurrentResponseSchema } }, preHandler: admin },
    async () => {
      const changeSet = requireLive(ctx, changeSets);
      changeSets.abandon(changeSet.id);
      return changeSets.getCurrentView(currentProject(ctx));
    },
  );

  app.post(
    '/api/v1/change-set/check',
    { schema: { response: { 200: CheckConsistencyResponseSchema } }, preHandler: admin },
    async () => changeSets.check(requireLive(ctx, changeSets).id),
  );

  app.post<{ Body: PublishReleaseRequest }>(
    '/api/v1/change-set/publish',
    {
      schema: { body: PublishReleaseRequestSchema, response: { 201: ReleaseSchema } },
      preHandler: admin,
    },
    async (request, reply) => {
      const project = currentProject(ctx);
      const changeSet = requireLive(ctx, changeSets);
      const release = releases.publish(project, changeSet.id, request.body.summary, userAuthor);
      return reply.code(201).send(release);
    },
  );

  app.post<{ Params: IdParams; Body: ResolveReviewItemRequest }>(
    '/api/v1/review-items/:id/resolve',
    {
      schema: {
        params: IdParamsSchema,
        body: ResolveReviewItemRequestSchema,
        response: { 200: ReviewItemSchema },
      },
      preHandler: admin,
    },
    async (request) =>
      changeSets.resolveReviewItem(
        request.params.id,
        request.body.verdict,
        request.body.rationale,
        userAuthor,
      ),
  );

  app.post<{ Params: IdParams; Body: BlockReviewItemRequest }>(
    '/api/v1/review-items/:id/block',
    {
      schema: {
        params: IdParamsSchema,
        body: BlockReviewItemRequestSchema,
        response: { 200: ReviewItemSchema },
      },
      preHandler: admin,
    },
    async (request) =>
      changeSets.blockReviewItem(request.params.id, request.body.rationale, userAuthor),
  );
}
