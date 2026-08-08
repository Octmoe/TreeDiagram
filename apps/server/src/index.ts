import { existsSync } from 'node:fs';
import { systemClock, WorkspaceService } from '@treediagram/core';
import { buildServer } from './app.js';
import { loadServerConfig } from './config.js';
import type { ServerContext } from './context.js';
import { defaultWebDistDir } from './static.js';
import { createWorkflowRunner } from './workflow-runner.js';

/**
 * 服务入口：打开工作区 → 组装服务 → 仅监听 127.0.0.1（§19）。
 * 启动日志打印 workspace path / port / project state / provider；绝不打印 token 或 API key（§15.1）。
 */
async function main(): Promise<void> {
  const config = loadServerConfig();
  const clock = systemClock;
  const workspace = new WorkspaceService(clock).openWorkspace(config.workspaceDir);

  const { runner, core, providerName } = createWorkflowRunner(
    workspace.db,
    clock,
    config,
    workspace.meta.workspaceId,
  );

  const ctx: ServerContext = {
    db: workspace.db,
    clock,
    config,
    workflowRunner: runner,
  };
  const app = buildServer(ctx);

  const project = workspace.db.repos.project.requireSingleton();
  // 重启恢复：上次进程遗留的 queued/running run 标记为 failed(PROCESS_INTERRUPTED)（§4.6）。
  if (core) {
    const recovered = core.recoverInterrupted(project);
    if (recovered > 0) {
      app.log.info({ recovered }, '已将中断的 WorkflowRun 标记为 failed(PROCESS_INTERRUPTED)');
    }
  }

  app.log.info(
    {
      workspace: workspace.dir,
      port: config.port,
      projectStatus: project.status,
      schemaVersion: workspace.meta.schemaVersion,
      staticUi: existsSync(defaultWebDistDir()),
      modelProvider: providerName ?? 'unconfigured',
      model: providerName ? config.model : null,
      modelBaseUrl: providerName === 'openai' ? (config.modelBaseUrl ?? 'official') : null,
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
