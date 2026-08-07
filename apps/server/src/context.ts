import type { Clock, DatabaseContext, ProjectRecord } from '@treediagram/core';
import type { ServerConfig } from './config.js';
import type { WorkflowRunner } from './workflow-runner.js';

/** 请求级共享上下文。 */
export interface ServerContext {
  db: DatabaseContext;
  clock: Clock;
  config: ServerConfig;
  workflowRunner: WorkflowRunner;
}

/** project 单行随时可能变化，任何请求都必须读取最新值。 */
export function currentProject(ctx: ServerContext): ProjectRecord {
  return ctx.db.repos.project.requireSingleton();
}
