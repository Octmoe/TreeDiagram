import type { AppInstance } from '../types.js';
import { Type } from '@sinclair/typebox';
import {
  IdParamsSchema,
  Nullable,
  RespondWorkflowRequestSchema,
  StartWorkflowRequestSchema,
  WorkflowConversationSchema,
  WorkflowListQuerySchema,
  WorkflowRunSchema,
  type IdParams,
  type StartWorkflowRequest,
  type RespondWorkflowRequest,
  type WorkflowListQuery,
} from '@treediagram/contracts';
import { DomainError } from '@treediagram/core';
import { requireAdmin } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

const WorkflowListResponseSchema = Type.Object(
  {
    runs: Type.Array(WorkflowRunSchema),
    nextCursor: Nullable(Type.String()),
  },
  { additionalProperties: false },
);

export function registerWorkflowRoutes(app: AppInstance, ctx: ServerContext): void {
  const admin = async (request: Parameters<typeof requireAdmin>[0]) => requireAdmin(request);

  app.post<{ Body: StartWorkflowRequest }>(
    '/api/v1/workflows',
    {
      schema: { body: StartWorkflowRequestSchema, response: { 202: WorkflowRunSchema } },
      preHandler: admin,
    },
    async (request, reply) => {
      const project = currentProject(ctx);
      if (ctx.db.repos.workflowRun.hasActiveRun(project.id)) {
        throw new DomainError('WORKFLOW_ALREADY_RUNNING', '已有进行中的 WorkflowRun');
      }
      const run = await ctx.workflowRunner.start(project, request.body);
      return reply.code(202).send(run);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/workflows/:id',
    {
      schema: { params: IdParamsSchema, response: { 200: WorkflowRunSchema } },
      preHandler: admin,
    },
    async (request) => {
      const run = ctx.db.repos.workflowRun.getById(request.params.id);
      if (!run || run.projectId !== currentProject(ctx).id) {
        throw new DomainError('NOT_FOUND', 'WorkflowRun 不存在', { id: request.params.id });
      }
      return run;
    },
  );

  app.post<{ Params: IdParams }>(
    '/api/v1/workflows/:id/resume',
    {
      schema: { params: IdParamsSchema, response: { 202: WorkflowRunSchema } },
      preHandler: admin,
    },
    async (request, reply) => {
      const project = currentProject(ctx);
      const run = ctx.db.repos.workflowRun.getById(request.params.id);
      if (!run || run.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', 'WorkflowRun 不存在', { id: request.params.id });
      }
      if (run.status !== 'failed' && run.status !== 'waiting_user') {
        throw new DomainError('WORKFLOW_NOT_RESUMABLE', `状态 ${run.status} 不可恢复`, {
          status: run.status,
        });
      }
      const resumed = await ctx.workflowRunner.resume(project, run.id);
      return reply.code(202).send(resumed);
    },
  );

  app.post<{ Params: IdParams }>(
    '/api/v1/workflows/:id/retry',
    {
      schema: { params: IdParamsSchema, response: { 202: WorkflowRunSchema } },
      preHandler: admin,
    },
    async (request, reply) => {
      const project = currentProject(ctx);
      const retried = await ctx.workflowRunner.retry(project, request.params.id);
      return reply.code(202).send(retried);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/workflows/:id/messages',
    {
      schema: { params: IdParamsSchema, response: { 200: WorkflowConversationSchema } },
      preHandler: admin,
    },
    async (request) => {
      const project = currentProject(ctx);
      const run = ctx.db.repos.workflowRun.getById(request.params.id);
      if (!run || run.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', 'WorkflowRun 不存在', { id: request.params.id });
      }
      return {
        messages: ctx.db.repos.workflowInteraction.listMessages(run.id),
        openWait: ctx.db.repos.workflowInteraction.getOpenWait(run.id),
      };
    },
  );

  app.post<{ Params: IdParams; Body: RespondWorkflowRequest }>(
    '/api/v1/workflows/:id/respond',
    {
      schema: {
        params: IdParamsSchema,
        body: RespondWorkflowRequestSchema,
        response: { 202: WorkflowRunSchema },
      },
      preHandler: admin,
    },
    async (request, reply) => {
      const project = currentProject(ctx);
      const resumed = await ctx.workflowRunner.respond(project, request.params.id, request.body);
      return reply.code(202).send(resumed);
    },
  );

  app.post<{ Params: IdParams }>(
    '/api/v1/workflows/:id/cancel',
    {
      schema: { params: IdParamsSchema, response: { 200: WorkflowRunSchema } },
      preHandler: admin,
    },
    async (request) => {
      const project = currentProject(ctx);
      const run = ctx.db.repos.workflowRun.getById(request.params.id);
      if (!run || run.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', 'WorkflowRun 不存在', { id: request.params.id });
      }
      return ctx.workflowRunner.cancel(project, run.id);
    },
  );

  app.get<{ Querystring: WorkflowListQuery }>(
    '/api/v1/workflows',
    {
      schema: {
        querystring: WorkflowListQuerySchema,
        response: { 200: WorkflowListResponseSchema },
      },
      preHandler: admin,
    },
    async (request) => {
      const limit = request.query.limit ?? 50;
      const cursor = request.query.cursor ?? null;
      const runs = ctx.db.repos.workflowRun.listByProject(currentProject(ctx).id, limit, cursor);
      const nextCursor = runs.length === limit ? (runs[runs.length - 1]?.createdAt ?? null) : null;
      return { runs, nextCursor };
    },
  );
}
