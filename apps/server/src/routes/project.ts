import type { AppInstance } from '../types.js';
import {
  ProjectStatusResponseSchema,
  ProjectSummarySchema,
  type ProjectStatusResponse,
} from '@treediagram/contracts';
import { projectSummaryOf } from '@treediagram/core';
import { requireAdmin } from '../auth.js';
import { currentProject, type ServerContext } from '../context.js';

export function registerProjectRoutes(app: AppInstance, ctx: ServerContext): void {
  app.get(
    '/api/v1/project',
    {
      schema: { response: { 200: ProjectSummarySchema } },
      preHandler: async (request) => requireAdmin(request),
    },
    async () => projectSummaryOf(currentProject(ctx)),
  );

  // status 对 admin/consumer 始终可读（API_CONTRACT §3.3），供下游轮询闸门。
  app.get(
    '/api/v1/status',
    { schema: { response: { 200: ProjectStatusResponseSchema } } },
    async (): Promise<ProjectStatusResponse> => {
      const project = currentProject(ctx);
      const release = project.currentReleaseId
        ? ctx.db.repos.release.getById(project.currentReleaseId)
        : null;
      return {
        status: project.status,
        currentReleaseId: project.currentReleaseId,
        currentReleaseVersion: release?.version ?? null,
        blockedReason: project.blockedReason?.message ?? null,
      };
    },
  );
}
