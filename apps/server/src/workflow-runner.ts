import type { StartWorkflowRequest, WorkflowRun } from '@treediagram/contracts';
import { DomainError, type ProjectRecord } from '@treediagram/core';

/**
 * 工作流执行器接口（M3 实现 OpenAI 驱动的真实执行器；M4/M5 扩展工作流种类）。
 * M2 仅注册“未配置模型”的空执行器：启动/恢复一律 MODEL_NOT_CONFIGURED，
 * 路由层与取消逻辑已经就绪。
 */
export interface WorkflowRunner {
  start(project: ProjectRecord, input: StartWorkflowRequest): WorkflowRun | Promise<WorkflowRun>;
  resume(project: ProjectRecord, runId: string): WorkflowRun | Promise<WorkflowRun>;
}

export const unconfiguredWorkflowRunner: WorkflowRunner = {
  start(): never {
    throw new DomainError(
      'MODEL_NOT_CONFIGURED',
      '尚未配置模型提供方，Agent 工作流不可用（M3 交付）',
    );
  },
  resume(): never {
    throw new DomainError(
      'MODEL_NOT_CONFIGURED',
      '尚未配置模型提供方，Agent 工作流不可用（M3 交付）',
    );
  },
};
