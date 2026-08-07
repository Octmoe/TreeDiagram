import { createHash } from 'node:crypto';
import type { StartWorkflowRequest, WorkflowRun, WorkflowType } from '@treediagram/contracts';
import { DesignProposalSchema } from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import { resolveDelegation } from '../domain/delegation-resolver.js';
import { newId } from '../ids.js';
import type { ServiceContext, Author } from '../services/types.js';
import { ChangeSetService } from '../services/change-set-service.js';
import { NodeService } from '../services/node-service.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import type { WorkflowRunId } from '@treediagram/contracts';
import type { ModelProvider } from './model-provider.js';
import {
  buildDeriveContext,
  buildGrillContext,
  buildInitializeContext,
  buildUnboxContext,
} from './context-builder.js';
import { ProposalApplier } from './proposal-applier.js';
import {
  DERIVE_INSTRUCTIONS,
  GRILL_INSTRUCTIONS,
  INITIALIZE_EXTRACT_INSTRUCTIONS,
  INITIALIZE_ROOT_INSTRUCTIONS,
  UNBOX_INSTRUCTIONS,
} from './prompts/index.js';

/**
 * 工作流执行器（IMPLEMENTATION_DESIGN §13）：
 * queued → running/load_context → generate → validate_output → apply_proposal
 *   → waiting_user | succeeded | failed。
 * 每步事务更新 checkpoint；resume 幂等（proposal 已应用则不重复创建）。
 * M3 支持 initialize/derive；grill/unbox/reevaluate 在 M4/M5 接入。
 */

export interface WorkflowRunnerConfig {
  provider: ModelProvider;
  model: string;
  /** sha256(workspaceId) 的前 32 个十六进制字符（§12.2）。 */
  safetyIdentifier: string;
}

interface RunCheckpoint {
  steps: string[];
  contextHash: string | null;
  proposal: unknown | null;
  proposals?: unknown[]; // initialize 两步提案
  /** unbox 容器候选修订（幂等：resume 不重复创建）。 */
  containerRevisionId?: string | null;
  providerResponseId: string | null;
  usage: Record<string, unknown> | null;
  applied: { nodeRevisionIds: string[]; relationRevisionIds: string[] } | null;
  /** ai_managed 自动 adopt 结果（§10）。 */
  autoAdopted?: boolean;
}

const EMPTY_CHECKPOINT: RunCheckpoint = {
  steps: [],
  contextHash: null,
  proposal: null,
  providerResponseId: null,
  usage: null,
  applied: null,
};

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function checkpointOf(run: WorkflowRun): RunCheckpoint {
  return { ...EMPTY_CHECKPOINT, ...(run.checkpoint as Partial<RunCheckpoint>) };
}

export class CoreWorkflowRunner {
  private readonly changeSets: ChangeSetService;
  private readonly applier: ProposalApplier;
  private readonly nodes: NodeService;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly executing = new Set<string>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly config: WorkflowRunnerConfig,
  ) {
    this.changeSets = new ChangeSetService(ctx);
    this.applier = new ProposalApplier(ctx);
    this.nodes = new NodeService(ctx);
  }

  private get db() {
    return this.ctx.db;
  }

  private get clock() {
    return this.ctx.clock;
  }

  /** 重启恢复（§4.6）：遗留 queued/running 标记为 failed(PROCESS_INTERRUPTED)，可 resume。 */
  recoverInterrupted(project: ProjectRecord): number {
    const interrupted = this.db.repos.workflowRun.listInterrupted(project.id);
    const now = this.clock.now();
    for (const run of interrupted) {
      this.db.repos.workflowRun.update(
        run.id,
        {
          status: 'failed',
          error: {
            code: 'PROCESS_INTERRUPTED',
            message: '进程中断，可 resume 继续',
            step: run.currentStep,
          },
          finishedAt: now,
        },
        now,
      );
    }
    return interrupted.length;
  }

  private assertAvailable(project: ProjectRecord, workflowType: WorkflowType): void {
    if (workflowType === 'reevaluate') {
      throw new DomainError('WORKFLOW_NOT_AVAILABLE', 'reevaluate 工作流在 M5 提供', {
        workflowType,
      });
    }
    if (workflowType === 'initialize' && project.status !== 'initializing') {
      throw new DomainError('WORKFLOW_NOT_AVAILABLE', 'initialize 仅可在 initializing 状态启动', {
        status: project.status,
      });
    }
    if (
      (workflowType === 'derive' || workflowType === 'grill' || workflowType === 'unbox') &&
      project.status !== 'consistent'
    ) {
      throw new DomainError('WORKFLOW_NOT_AVAILABLE', `${workflowType} 需要 consistent 状态`, {
        status: project.status,
      });
    }
  }

  start(project: ProjectRecord, input: StartWorkflowRequest): WorkflowRun {
    this.assertAvailable(project, input.workflowType);
    const run = this.db.transaction(() => {
      if (this.db.repos.workflowRun.hasActiveRun(project.id)) {
        throw new DomainError('WORKFLOW_ALREADY_RUNNING', '已有进行中的 WorkflowRun');
      }
      const now = this.clock.now();
      const row: WorkflowRun = {
        id: newId<WorkflowRunId>(),
        projectId: project.id,
        changeSetId: null,
        workflowType: input.workflowType,
        targetNodeId: input.targetNodeId,
        status: 'queued',
        currentStep: 'queued',
        input: input as unknown as Record<string, unknown>,
        checkpoint: { ...EMPTY_CHECKPOINT },
        summary: null,
        error: null,
        provider: this.config.provider.providerName,
        model: this.config.model,
        providerResponseId: null,
        usage: null,
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
      };
      this.db.repos.workflowRun.insert(row);
      return row;
    });
    this.kick(run.id);
    return run;
  }

  resume(project: ProjectRecord, runId: string): WorkflowRun {
    const run = this.requireRun(project, runId);
    if (run.status !== 'failed' && run.status !== 'waiting_user') {
      throw new DomainError('WORKFLOW_NOT_RESUMABLE', `状态 ${run.status} 不可恢复`, {
        status: run.status,
      });
    }
    const checkpoint = checkpointOf(run);
    if (run.status === 'waiting_user') {
      // 用户已阅读问题并选择继续；proposal 已应用，直接收尾。
      if (checkpoint.applied) {
        const now = this.clock.now();
        this.db.repos.workflowRun.update(
          run.id,
          { status: 'succeeded', currentStep: 'succeeded', finishedAt: now },
          now,
        );
        return this.requireRun(project, runId);
      }
      // 未应用则按失败路径继续执行
    }
    if (this.db.repos.workflowRun.hasActiveRun(project.id)) {
      throw new DomainError('WORKFLOW_ALREADY_RUNNING', '已有进行中的 WorkflowRun');
    }
    const now = this.clock.now();
    this.db.repos.workflowRun.update(
      run.id,
      { status: 'queued', currentStep: 'queued', error: null, finishedAt: null },
      now,
    );
    this.kick(run.id);
    return this.requireRun(project, runId);
  }

  /** 取消：abort 在途请求；已成功写入 ChangeSet 的提案不回滚（§14.5）。 */
  cancel(project: ProjectRecord, runId: string): WorkflowRun {
    const run = this.requireRun(project, runId);
    if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting_user') {
      throw new DomainError('INVALID_STATE_TRANSITION', `状态 ${run.status} 不可取消`, {
        status: run.status,
      });
    }
    this.abortControllers.get(runId)?.abort();
    const now = this.clock.now();
    this.db.repos.workflowRun.update(
      runId,
      { status: 'cancelled', currentStep: 'cancelled', finishedAt: now },
      now,
    );
    return this.requireRun(project, runId);
  }

  /** 测试/脚本辅助：等待 run 到达终态。 */
  async waitForCompletion(runId: string, timeoutMs = 60_000): Promise<WorkflowRun> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = this.db.repos.workflowRun.getById(runId);
      if (!run) throw new DomainError('NOT_FOUND', 'WorkflowRun 不存在', { runId });
      if (!['queued', 'running'].includes(run.status)) return run;
      if (Date.now() > deadline) {
        throw new Error(`等待 WorkflowRun 完成超时（当前 ${run.status}/${run.currentStep}）`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private requireRun(project: ProjectRecord, runId: string): WorkflowRun {
    const run = this.db.repos.workflowRun.getById(runId);
    if (!run || run.projectId !== project.id) {
      throw new DomainError('NOT_FOUND', 'WorkflowRun 不存在', { runId });
    }
    return run;
  }

  private kick(runId: string): void {
    if (this.executing.has(runId)) return;
    this.executing.add(runId);
    setImmediate(() => {
      void this.execute(runId).finally(() => {
        this.executing.delete(runId);
        this.abortControllers.delete(runId);
      });
    });
  }

  private patch(
    runId: string,
    patch: Parameters<typeof this.db.repos.workflowRun.update>[1],
  ): WorkflowRun {
    const now = this.clock.now();
    this.db.repos.workflowRun.update(runId, patch, now);
    const run = this.db.repos.workflowRun.getById(runId);
    if (!run) throw new DomainError('CORRUPT_PERSISTED_DATA', 'WorkflowRun 更新后缺失');
    return run;
  }

  /** 取消检查：步骤之间调用；已取消时抛出（中断执行）。 */
  private assertNotCancelled(runId: string): WorkflowRun {
    const run = this.db.repos.workflowRun.getById(runId);
    if (!run) throw new DomainError('CORRUPT_PERSISTED_DATA', 'WorkflowRun 缺失');
    if (run.status === 'cancelled') {
      throw new RunCancelledError();
    }
    return run;
  }

  private async execute(runId: string): Promise<void> {
    const startedAt = this.clock.now();
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    let run = this.assertNotCancelled(runId);
    if (run.status === 'queued') {
      run = this.patch(runId, {
        status: 'running',
        currentStep: 'running/load_context',
        startedAt: run.startedAt ?? startedAt,
      });
    }
    try {
      const project = this.db.repos.project.requireSingleton();
      const author: Author = { kind: 'agent', ref: this.config.model };
      const checkpoint = checkpointOf(run);

      // ---- load_context ----
      let context: Record<string, unknown>;
      if (run.workflowType === 'initialize') {
        const input = run.input as unknown as StartWorkflowRequest;
        const sources = input.sourceAssetIds.map((id) => {
          const asset = this.db.repos.sourceAsset.getById(id);
          if (!asset) throw new DomainError('NOT_FOUND', 'source 不存在', { sourceAssetId: id });
          return asset;
        });
        context = buildInitializeContext(sources);
      } else if (run.workflowType === 'unbox') {
        // §13.4：先确定性地创建 unbox_exploration 容器候选（幂等），再构建边界探索上下文。
        if (!checkpoint.containerRevisionId) {
          const container = this.nodes.createCandidateNode(
            project,
            'topic',
            {
              displayTitle: `Unbox 探索 ${startedAt}`,
              contentText: '由 Unbox 工作流创建的默认容器，承载跳出当前约束的平行候选。',
              roles: ['unbox_exploration'],
              attributes: {},
              approvalState: 'draft',
              epistemicState: null,
            },
            author,
          );
          checkpoint.containerRevisionId = container.revision.id;
        }
        const containerRevision = this.db.repos.node.getRevisionById(
          checkpoint.containerRevisionId,
        );
        if (!containerRevision) {
          throw new DomainError('CORRUPT_PERSISTED_DATA', 'unbox 容器修订缺失', {
            revisionId: checkpoint.containerRevisionId,
          });
        }
        context = buildUnboxContext(
          this.currentWorkingSet(project),
          { nodeId: containerRevision.nodeId, revisionId: containerRevision.id },
          (run.input['focusInstruction'] as string | null) ?? null,
        );
      } else {
        const targetNodeId = run.targetNodeId;
        if (!targetNodeId) {
          throw new DomainError('VALIDATION_FAILED', `${run.workflowType} 需要 targetNodeId`);
        }
        const ws = this.currentWorkingSet(project);
        const focusInstruction = (run.input['focusInstruction'] as string | null) ?? null;
        context =
          run.workflowType === 'grill'
            ? buildGrillContext(ws, targetNodeId, focusInstruction)
            : buildDeriveContext(ws, targetNodeId, focusInstruction);
      }
      checkpoint.contextHash = sha256Hex(JSON.stringify(context));
      checkpoint.steps.push('load_context');
      run = this.patch(runId, {
        currentStep: 'running/generate',
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
      this.assertNotCancelled(runId);

      // ---- generate（幂等：checkpoint 已有 proposal 则跳过）----
      const agentAuthor = author;
      if (!checkpoint.proposal) {
        if (run.workflowType === 'initialize') {
          // §13.1：第一步提取非 root 候选，第二步 root 候选与矛盾
          const first = await this.config.provider.generateStructured({
            model: this.config.model,
            instructions: INITIALIZE_EXTRACT_INSTRUCTIONS,
            input: JSON.stringify(context),
            outputSchemaName: 'DesignProposal',
            outputSchema: DesignProposalSchema,
            reasoningEffort: 'medium',
            safetyIdentifier: this.config.safetyIdentifier,
            signal: controller.signal,
          });
          this.assertNotCancelled(runId);
          checkpoint.proposals = [first.value];
          checkpoint.providerResponseId = first.providerResponseId;
          checkpoint.usage = first.usage as unknown as Record<string, unknown>;
          checkpoint.steps.push('generate_extract');
          run = this.patch(runId, {
            checkpoint: checkpoint as unknown as Record<string, unknown>,
            providerResponseId: first.providerResponseId,
            usage: first.usage as unknown as Record<string, unknown>,
          });

          // 第二步输入附带第一步提案的 proposalRef 摘要，使 root 步可用 refKind="proposal" 关联
          const priorStep = summarizeProposalRefs(first.value);
          const second = await this.config.provider.generateStructured({
            model: this.config.model,
            instructions: INITIALIZE_ROOT_INSTRUCTIONS,
            input: JSON.stringify({
              ...context,
              data: { ...(context['data'] as object), priorStep },
            }),
            outputSchemaName: 'DesignProposal',
            outputSchema: DesignProposalSchema,
            reasoningEffort: 'medium',
            safetyIdentifier: this.config.safetyIdentifier,
            signal: controller.signal,
          });
          checkpoint.proposals.push(second.value);
          checkpoint.providerResponseId = second.providerResponseId;
          checkpoint.steps.push('generate_root');
          // 合并两步提案（root 步在前，保证 root 节点先建）
          checkpoint.proposal = mergeProposals([second.value, first.value]);
        } else {
          // derive/grill/unbox 单次生成；grill/unbox 用 high reasoning（§12.2 默认推理档）
          const instructions =
            run.workflowType === 'grill'
              ? GRILL_INSTRUCTIONS
              : run.workflowType === 'unbox'
                ? UNBOX_INSTRUCTIONS
                : DERIVE_INSTRUCTIONS;
          const reasoningEffort =
            run.workflowType === 'grill' || run.workflowType === 'unbox' ? 'high' : 'medium';
          const result = await this.config.provider.generateStructured({
            model: this.config.model,
            instructions,
            input: JSON.stringify(context),
            outputSchemaName: 'DesignProposal',
            outputSchema: DesignProposalSchema,
            reasoningEffort,
            safetyIdentifier: this.config.safetyIdentifier,
            signal: controller.signal,
          });
          checkpoint.proposal = result.value;
          checkpoint.providerResponseId = result.providerResponseId;
          checkpoint.usage = result.usage as unknown as Record<string, unknown>;
        }
        checkpoint.steps.push('generate');
        run = this.patch(runId, {
          currentStep: 'running/validate_output',
          checkpoint: checkpoint as unknown as Record<string, unknown>,
          providerResponseId: checkpoint.providerResponseId,
          usage: checkpoint.usage,
        });
      } else {
        run = this.patch(runId, { currentStep: 'running/validate_output' });
      }
      this.assertNotCancelled(runId);

      // ---- validate_output（schema 校验在 provider 内已完成，此处复核）----
      const proposal = checkpoint.proposal as {
        nodeActions: unknown[];
        relationActions: unknown[];
        questionsForUser: Array<{ blocking: boolean }>;
        warnings: string[];
        summary: string;
        stopReason: string;
      };
      checkpoint.steps.push('validate_output');
      run = this.patch(runId, {
        currentStep: 'running/apply_proposal',
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
      this.assertNotCancelled(runId);

      // ---- apply_proposal（幂等：已应用则跳过）----
      let autoAdoptBlocked: string | null = null;
      const effectivePolicy = this.resolveEffectivePolicy(run);
      if (!checkpoint.applied) {
        sanitizeProposal(run.workflowType, checkpoint.proposal);
        const result = this.db.transaction(() =>
          this.applier.apply(project, run, checkpoint.proposal, { effectivePolicy }, agentAuthor),
        );
        checkpoint.applied = {
          nodeRevisionIds: result.appliedNodeRevisionIds,
          relationRevisionIds: result.appliedRelationRevisionIds,
        };
        checkpoint.steps.push('apply_proposal');
        const changeSet = this.changeSets.getLive(this.db.repos.project.requireSingleton());
        run = this.patch(runId, {
          checkpoint: checkpoint as unknown as Record<string, unknown>,
          changeSetId: changeSet?.id ?? null,
        });

        // ---- ai_managed 自动 adopt（§10）：越界/含 root 变更时转 waiting_user ----
        if (
          effectivePolicy &&
          changeSet &&
          (run.workflowType === 'derive' || run.workflowType === 'grill')
        ) {
          try {
            this.changeSets.adopt(changeSet.id, agentAuthor, {
              workflowRunId: run.id,
              policyId: effectivePolicy.id,
            });
            checkpoint.autoAdopted = true;
          } catch (error) {
            if (error instanceof DomainError && error.code === 'AI_SCOPE_VIOLATION') {
              autoAdoptBlocked = error.message;
            } else {
              throw error;
            }
          }
          run = this.patch(runId, {
            checkpoint: checkpoint as unknown as Record<string, unknown>,
          });
        }
      } else {
        checkpoint.steps.push('apply_proposal');
      }

      // ---- finish ----
      const hasBlockingQuestion = proposal.questionsForUser.some((q) => q.blocking);
      const finalStatus =
        hasBlockingQuestion || proposal.stopReason === 'needs_user' || autoAdoptBlocked !== null
          ? 'waiting_user'
          : 'succeeded';
      const now = this.clock.now();
      this.db.repos.workflowRun.update(
        runId,
        {
          status: finalStatus,
          currentStep: finalStatus,
          summary: {
            summary: proposal.summary,
            stopReason: proposal.stopReason,
            questionsForUser: proposal.questionsForUser,
            warnings: proposal.warnings,
            nodeActionCount: proposal.nodeActions.length,
            relationActionCount: proposal.relationActions.length,
            applied: checkpoint.applied,
            autoAdopted: checkpoint.autoAdopted === true,
            autoAdoptBlocked,
          },
          finishedAt: finalStatus === 'succeeded' ? now : null,
        },
        now,
      );
    } catch (error) {
      if (error instanceof RunCancelledError) return; // cancel 路由已写终态
      // cancel  abort 在途请求导致的错误不得覆盖 cancelled 终态（§14.5）
      const latest = this.db.repos.workflowRun.getById(runId);
      if (latest?.status === 'cancelled') return;
      const now = this.clock.now();
      const code = error instanceof DomainError ? error.code : 'MODEL_PROVIDER_FAILED';
      this.db.repos.workflowRun.update(
        runId,
        {
          status: 'failed',
          currentStep: 'failed',
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof DomainError ? error.details : {}),
          },
          finishedAt: now,
        },
        now,
      );
    }
  }

  /** 当前工作视图：有 live ChangeSet 用 working view，否则用 current Release 视图。 */
  private currentWorkingSet(project: ProjectRecord) {
    const live = this.changeSets.getLive(project);
    return live
      ? this.changeSets.buildViews(live).working
      : this.changeSets.buildReleaseView(project);
  }

  /** ai_confirmed 授权来源：derive 目标节点的有效托管策略（§10/§12.4）。 */
  private resolveEffectivePolicy(run: WorkflowRun) {
    if (!run.targetNodeId) return null;
    const active = this.db.repos.delegation.listActiveByProject(run.projectId);
    const project = this.db.repos.project.requireSingleton();
    const result = resolveDelegation(run.targetNodeId, this.currentWorkingSet(project), active);
    if (result.mode !== 'ai_managed' || !result.policyId) return null;
    return this.db.repos.delegation.getById(result.policyId);
  }
}

class RunCancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelledError';
  }
}

/** initialize：合并两步提案为单个 DesignProposal。 */
function mergeProposals(proposals: unknown[]): unknown {
  const [first, ...rest] = proposals as Array<{
    nodeActions: unknown[];
    relationActions: unknown[];
    questionsForUser: unknown[];
    warnings: string[];
    summary: string;
    stopReason: string;
    workflowType: string;
  }>;
  if (!first) {
    throw new DomainError('MODEL_OUTPUT_INVALID', 'initialize 工作流未产生任何提案');
  }
  const merged = {
    schemaVersion: 1,
    workflowType: first.workflowType,
    summary: first.summary,
    nodeActions: [...first.nodeActions],
    relationActions: [...first.relationActions],
    questionsForUser: [...first.questionsForUser],
    warnings: [...first.warnings],
    stopReason: first.stopReason,
  };
  for (const p of rest) {
    merged.nodeActions.push(...p.nodeActions);
    merged.relationActions.push(...p.relationActions);
    merged.questionsForUser.push(...p.questionsForUser);
    merged.warnings.push(...p.warnings);
    if (merged.stopReason === 'completed') merged.stopReason = p.stopReason;
  }
  return merged;
}

/** initialize 第二步输入摘要：第一步提案的 proposalRef → 标题/类型，供 refKind="proposal" 引用。 */
function summarizeProposalRefs(proposal: unknown): unknown {
  const p = proposal as {
    nodeActions?: Array<{ proposalRef: string; nodeType: string; displayTitle: string }>;
  };
  return {
    nodeRefs: (p.nodeActions ?? []).map((a) => ({
      proposalRef: a.proposalRef,
      nodeType: a.nodeType,
      displayTitle: a.displayTitle,
    })),
  };
}

/**
 * 工作流特定提案修正（§13.3/§13.4）：
 * - grill：revise 一律强制 draft（不得直接 revise 已确认节点，由用户后续裁决）；
 * - unbox：剥离 root 角色（探索不触碰 root），全部输出仅 draft/tentative（由 applier 降级保证）。
 * 直接原地修改 checkpoint 中的 proposal，使持久化的 checkpoint 反映真实应用内容。
 */
function sanitizeProposal(workflowType: WorkflowType, rawProposal: unknown): void {
  const proposal = rawProposal as {
    nodeActions: Array<{ operation: string; approvalSuggestion: string; roles: string[] }>;
    relationActions: Array<{ operation: string; approvalSuggestion: string }>;
    warnings: string[];
  };
  if (workflowType === 'grill') {
    let forced = 0;
    for (const action of [...proposal.nodeActions, ...proposal.relationActions]) {
      if (action.operation === 'revise' && action.approvalSuggestion !== 'draft') {
        action.approvalSuggestion = 'draft';
        forced += 1;
      }
    }
    if (forced > 0) {
      proposal.warnings.push(`grill：${forced} 个 revise 操作已强制降级为 draft（§13.3）`);
    }
  }
  if (workflowType === 'unbox') {
    for (const action of proposal.nodeActions) {
      const idx = action.roles.indexOf('root');
      if (idx >= 0) {
        action.roles.splice(idx, 1);
        proposal.warnings.push('unbox：已剥离模型输出的 root 角色（§13.4 探索不触碰 root）');
      }
    }
  }
}
