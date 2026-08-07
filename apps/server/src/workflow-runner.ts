import { createHash } from 'node:crypto';
import type { StartWorkflowRequest, WorkflowRun } from '@treediagram/contracts';
import {
  CoreWorkflowRunner,
  DomainError,
  FakeModelProvider,
  OpenAIProvider,
  type Clock,
  type DatabaseContext,
  type ModelProvider,
  type ProjectRecord,
} from '@treediagram/core';
import type { ServerConfig } from './config.js';

/**
 * 工作流执行器接口（M3 起由 CoreWorkflowRunner 驱动真实模型调用）。
 * 未配置任何 provider 时退回 unconfiguredWorkflowRunner：启动/恢复/取消一律 MODEL_NOT_CONFIGURED。
 */
export interface WorkflowRunner {
  start(project: ProjectRecord, input: StartWorkflowRequest): WorkflowRun | Promise<WorkflowRun>;
  resume(project: ProjectRecord, runId: string): WorkflowRun | Promise<WorkflowRun>;
  cancel(project: ProjectRecord, runId: string): WorkflowRun | Promise<WorkflowRun>;
}

export const unconfiguredWorkflowRunner: WorkflowRunner = {
  start(): never {
    throw new DomainError(
      'MODEL_NOT_CONFIGURED',
      '尚未配置模型提供方：请设置 OPENAI_API_KEY，或开发模式下设置 TREEDIAGRAM_MODEL_PROVIDER=fake',
    );
  },
  resume(): never {
    throw new DomainError(
      'MODEL_NOT_CONFIGURED',
      '尚未配置模型提供方：请设置 OPENAI_API_KEY，或开发模式下设置 TREEDIAGRAM_MODEL_PROVIDER=fake',
    );
  },
  cancel(): never {
    throw new DomainError('MODEL_NOT_CONFIGURED', '尚未配置模型提供方，Agent 工作流不可用');
  },
};

/**
 * 按配置组装执行器（§12.2/§15.1）：
 * - TREEDIAGRAM_MODEL_PROVIDER=fake → FakeModelProvider（开发/演示）；
 * - 否则有 OPENAI_API_KEY → OpenAIProvider；
 * - 都没有 → unconfiguredWorkflowRunner。
 * safetyIdentifier = sha256(workspaceId) 前 32 位十六进制字符。
 */
export function createWorkflowRunner(
  db: DatabaseContext,
  clock: Clock,
  config: ServerConfig,
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): { runner: WorkflowRunner; core: CoreWorkflowRunner | null; providerName: string | null } {
  const provider = selectProvider(config, env);
  if (!provider) {
    return { runner: unconfiguredWorkflowRunner, core: null, providerName: null };
  }
  const safetyIdentifier = createHash('sha256').update(workspaceId).digest('hex').slice(0, 32);
  const core = new CoreWorkflowRunner(
    { db, clock },
    { provider, model: config.model, safetyIdentifier },
  );
  return { runner: core, core, providerName: provider.providerName };
}

function selectProvider(config: ServerConfig, env: NodeJS.ProcessEnv): ModelProvider | null {
  if (config.modelProvider === 'fake') return FakeModelProvider.forDevelopment();
  const apiKey = env['OPENAI_API_KEY']?.trim();
  if (apiKey) return new OpenAIProvider(apiKey, config.modelTimeoutMs);
  return null;
}
