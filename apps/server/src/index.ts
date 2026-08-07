import { systemClock, WorkspaceService } from '@treediagram/core';
import { buildServer } from './app.js';
import { loadServerConfig } from './config.js';
import type { ServerContext } from './context.js';
import { unconfiguredWorkflowRunner } from './workflow-runner.js';

/**
 * 服务入口：打开工作区 → 组装服务 → 仅监听 127.0.0.1（§19）。
 * 启动日志打印 workspace path / port / project state；绝不打印 token（§15.1）。
 */
async function main(): Promise<void> {
  const config = loadServerConfig();
  const clock = systemClock;
  const workspace = new WorkspaceService(clock).openWorkspace(config.workspaceDir);

  const ctx: ServerContext = {
    db: workspace.db,
    clock,
    config,
    workflowRunner: unconfiguredWorkflowRunner,
  };
  const app = buildServer(ctx);

  const project = workspace.db.repos.project.requireSingleton();
  app.log.info(
    {
      workspace: workspace.dir,
      port: config.port,
      projectStatus: project.status,
      schemaVersion: workspace.meta.schemaVersion,
    },
    'TreeDiagram server 启动',
  );

  await app.listen({ host: config.host, port: config.port });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, '收到退出信号，关闭服务');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('TreeDiagram server 启动失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
