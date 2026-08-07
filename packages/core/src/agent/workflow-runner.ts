import { createHash } from 'node:crypto';
import type {
  ReviewItem,
  StartWorkflowRequest,
  WorkflowRun,
  WorkflowType,
} from '@treediagram/contracts';
import { DesignProposalSchema, ReevaluationBatchResultSchema } from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import { resolveDelegation } from '../domain/delegation-resolver.js';
import { checkConsistency } from '../domain/consistency-checker.js';
import type { WorkingSet } from '../domain/working-set.js';
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
  buildReevaluationContext,
  buildUnboxContext,
  type ReevaluationItemView,
} from './context-builder.js';
import { orderReviewItemsByDependency } from './batch-order.js';
import { ProposalApplier } from './proposal-applier.js';
import {
  DERIVE_INSTRUCTIONS,
  GRILL_INSTRUCTIONS,
  INITIALIZE_EXTRACT_INSTRUCTIONS,
  INITIALIZE_ROOT_INSTRUCTIONS,
  REEVALUATE_INSTRUCTIONS,
  UNBOX_INSTRUCTIONS,
} from './prompts/index.js';

/**
 * 工作流执行器（IMPLEMENTATION_DESIGN §13）：
 * queued → running/load_context → generate → validate_output → apply_proposal
 *   → waiting_user | succeeded | failed。
 * 每步事务更新 checkpoint；resume 幂等（proposal 已应用则不重复创建）。
 * initialize/derive（M3）、grill/unbox（M4）、reevaluate（M5，批次循环独立路径）。
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
  /** reevaluate：进行中的批次（崩溃恢复幂等：result 已生成则不重新生成，applied 则不重复应用）。 */
  pendingBatch?: {
    itemIds: string[];
    result: unknown;
    applied: { nodeRevisionIds: string[]; relationRevisionIds: string[] } | null;
  } | null;
  /** reevaluate：已完成批次记录。 */
  batches?: Array<{
    itemIds: string[];
    applied: { nodeRevisionIds: string[]; relationRevisionIds: string[] } | null;
  }>;
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
      if (project.status !== 'reevaluating' && project.status !== 'blocked') {
        throw new DomainError(
          'WORKFLOW_NOT_AVAILABLE',
          'reevaluate 需要 reevaluating/blocked 状态（存在已 adopt 的 ChangeSet）',
          { status: project.status },
        );
      }
      return;
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
    if (this.db.repos.workflowRun.hasActiveRun(project.id, run.id)) {
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

      if (run.workflowType === 'reevaluate') {
        // §13.5：批次复核走独立执行路径（共享 cancel/失败收尾逻辑）。
        await this.executeReevaluate(run, runId, project, author, checkpoint, controller);
        return;
      }

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

  // ---- Reevaluate（§13.5）----

  /**
   * 批次复核循环：pending review items 按 depends_on SCC 逆依赖序分批（≤20），
   * 每批 generate → validate → apply 动作 → 逐项裁决，checkpoint 保证中断幂等。
   */
  private async executeReevaluate(
    run: WorkflowRun,
    runId: string,
    project: ProjectRecord,
    author: Author,
    checkpoint: RunCheckpoint,
    controller: AbortController,
  ): Promise<void> {
    const input = run.input as unknown as StartWorkflowRequest;
    const changeSet = this.changeSets.getLive(project);
    // ready 仅出现在 resume 路径：用户裁决完最后一批 blocked 后 afterReviewProgress
    // 已将 ChangeSet 置 ready；此时无 pending 项，批次循环直接退出并走 finish。
    if (!changeSet || (changeSet.status !== 'reevaluating' && changeSet.status !== 'ready')) {
      throw new DomainError(
        'WORKFLOW_NOT_AVAILABLE',
        'reevaluate 需要 reevaluating 状态的 live ChangeSet',
        { changeSetStatus: changeSet?.status ?? null },
      );
    }
    if (input.changeSetId && input.changeSetId !== changeSet.id) {
      throw new DomainError('VALIDATION_FAILED', 'changeSetId 与 live ChangeSet 不一致', {
        requested: input.changeSetId,
        live: changeSet.id,
      });
    }
    const patchCheckpoint = (currentStep?: string) => {
      run = this.patch(runId, {
        ...(currentStep ? { currentStep } : {}),
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
    };
    run = this.patch(runId, { changeSetId: changeSet.id });
    checkpoint.steps.push('load_context');
    patchCheckpoint('running/generate');

    const blockingQuestions: unknown[] = [];
    let lastStopReason = 'completed';
    for (;;) {
      this.assertNotCancelled(runId);
      const pending = this.db.repos.reviewItem.listByChangeSet(changeSet.id, ['pending']);
      if (pending.length === 0) break;
      const { working } = this.changeSets.buildViews(changeSet);
      const batch = orderReviewItemsByDependency(pending, working).slice(0, 20);
      const batchIds = batch.map((i) => i.id);

      let batchState = checkpoint.pendingBatch ?? null;
      if (!batchState || !sameIds(batchState.itemIds, batchIds)) {
        const roots: ReturnType<typeof this.reevaluationRoots> = this.reevaluationRoots(working);
        const context = buildReevaluationContext(
          changeSet.id,
          roots,
          batch.map((item) => this.reevaluationItemView(item)),
        );
        checkpoint.contextHash = sha256Hex(JSON.stringify(context));
        const generated = await this.config.provider.generateStructured({
          model: this.config.model,
          instructions: REEVALUATE_INSTRUCTIONS,
          input: JSON.stringify(context),
          outputSchemaName: 'ReevaluationBatchResult',
          outputSchema: ReevaluationBatchResultSchema,
          reasoningEffort: 'medium',
          safetyIdentifier: this.config.safetyIdentifier,
          signal: controller.signal,
        });
        this.assertNotCancelled(runId);
        this.validateBatchResult(batch, generated.value);
        batchState = { itemIds: batchIds, result: generated.value, applied: null };
        checkpoint.pendingBatch = batchState;
        checkpoint.providerResponseId = generated.providerResponseId;
        checkpoint.usage = generated.usage as unknown as Record<string, unknown>;
        checkpoint.steps.push('generate_batch');
        patchCheckpoint('running/apply_proposal');
      }

      const result = batchState.result as BatchResultShape;
      if (!batchState.applied) {
        // 批次附带的修订/迁移动作复用 ProposalApplier 原子写入
        const synthetic = {
          schemaVersion: 1,
          workflowType: 'derive',
          summary: result.summary,
          nodeActions: result.nodeActions,
          relationActions: result.relationActions,
          questionsForUser: result.questionsForUser,
          warnings: [],
          stopReason: result.stopReason,
        };
        const applied = this.db.transaction(() =>
          this.applier.apply(
            project,
            run,
            synthetic,
            // 迁移/替代修订本身是复核决议（§9.3），不得再触发 §4.6 影响登记
            { effectivePolicy: null, skipImpactRegistration: true },
            author,
          ),
        );
        batchState.applied = {
          nodeRevisionIds: applied.appliedNodeRevisionIds,
          relationRevisionIds: applied.appliedRelationRevisionIds,
        };
        checkpoint.pendingBatch = batchState;
        patchCheckpoint();
      }

      // 逐项裁决（幂等：已非 pending 的 item 跳过，§9.4 resolved 不回退）
      for (const entry of result.results) {
        const item = this.db.repos.reviewItem.getById(entry.reviewItemId);
        if (!item || item.status !== 'pending') continue;
        if (entry.verdict === 'unknown') {
          this.changeSets.blockReviewItem(item.id, entry.rationale, author);
        } else {
          this.changeSets.resolveReviewItem(item.id, entry.verdict, entry.rationale, author);
        }
      }
      checkpoint.batches = [
        ...(checkpoint.batches ?? []),
        { itemIds: batchState.itemIds, applied: batchState.applied },
      ];
      checkpoint.pendingBatch = null;
      checkpoint.steps.push('apply_batch');
      patchCheckpoint('running/generate');

      blockingQuestions.push(...result.questionsForUser.filter((q) => q.blocking));
      lastStopReason = result.stopReason;
      if (result.questionsForUser.some((q) => q.blocking) || result.stopReason === 'needs_user') {
        break;
      }
    }

    // ---- finish：ready → succeeded；否则 waiting_user（用户处理 blocked/checker 阻塞）----
    const counts = this.db.repos.reviewItem.countsByChangeSet(changeSet.id);
    const freshChangeSet = this.changeSets.require(changeSet.id);
    const waitingReason =
      blockingQuestions.length > 0
        ? 'blocking_question'
        : lastStopReason === 'needs_user'
          ? 'needs_user'
          : counts.pending > 0 || counts.blocked > 0
            ? 'review_items_remain'
            : freshChangeSet.status !== 'ready'
              ? 'checker_blocking'
              : null;
    let blockingIssues: unknown[] = [];
    if (waitingReason === 'checker_blocking') {
      const { working } = this.changeSets.buildViews(freshChangeSet);
      blockingIssues = checkConsistency({
        workingSet: working,
        reviewCounts: { pending: counts.pending, blocked: counts.blocked },
        policies: this.db.repos.delegation.listActiveByProject(project.id),
      }).filter((issue) => issue.severity === 'blocking');
    }
    const finalStatus = waitingReason === null ? 'succeeded' : 'waiting_user';
    const now = this.clock.now();
    this.db.repos.workflowRun.update(
      runId,
      {
        status: finalStatus,
        currentStep: finalStatus,
        summary: {
          changeSetId: changeSet.id,
          batchCount: (checkpoint.batches ?? []).length,
          batches: checkpoint.batches ?? [],
          remaining: { pending: counts.pending, blocked: counts.blocked },
          changeSetStatus: freshChangeSet.status,
          waitingReason,
          blockingIssues,
          questionsForUser: blockingQuestions,
        },
        finishedAt: finalStatus === 'succeeded' ? now : null,
      },
      now,
    );
  }

  private reevaluationRoots(working: WorkingSet) {
    const roots = [];
    for (const [nodeId] of working.nodeById) {
      const revision = working.nodeRevisionByNodeId.get(nodeId);
      const node = working.nodeById.get(nodeId);
      if (node && revision?.roles.includes('root')) {
        roots.push({
          nodeId: node.id as string,
          revisionId: revision.id as string,
          nodeType: node.nodeType as string,
          displayTitle: revision.displayTitle,
          contentText: revision.contentText,
          roles: revision.roles,
          approvalState: revision.approvalState as string,
          epistemicState: revision.epistemicState as string | null,
          attributes: revision.attributes as Record<string, unknown>,
        });
      }
    }
    return roots;
  }

  /** 批次 item 的不可信视图（含被替代修订内容；裁决需要看到原文）。 */
  private reevaluationItemView(item: ReviewItem): ReevaluationItemView {
    let entity: Record<string, unknown> | null = null;
    if (item.entityKind === 'node_revision' && item.entityRevisionId) {
      const revision = this.db.repos.node.getRevisionById(item.entityRevisionId);
      if (revision) {
        entity = {
          nodeId: revision.nodeId,
          revisionId: revision.id,
          displayTitle: revision.displayTitle,
          contentText: revision.contentText,
          roles: revision.roles,
          approvalState: revision.approvalState,
          epistemicState: revision.epistemicState,
          attributes: revision.attributes,
        };
      }
    } else if (item.entityKind === 'relation_revision' && item.entityRevisionId) {
      const revision = this.db.repos.relation.getRevisionById(item.entityRevisionId);
      if (revision) {
        const relation = this.db.repos.relation.getRelationById(revision.relationId);
        const from = this.db.repos.node.getRevisionById(revision.fromNodeRevisionId);
        const to = this.db.repos.node.getRevisionById(revision.toNodeRevisionId);
        entity = {
          relationId: revision.relationId,
          revisionId: revision.id,
          relationType: relation?.relationType ?? null,
          fromRevisionId: revision.fromNodeRevisionId,
          toRevisionId: revision.toNodeRevisionId,
          fromTitle: from?.displayTitle ?? null,
          toTitle: to?.displayTitle ?? null,
          rationaleText: revision.rationaleText,
          approvalState: revision.approvalState,
        };
      }
    }
    return {
      reviewItemId: item.id,
      entityKind: item.entityKind,
      reasonCode: item.reasonCode,
      entity,
    };
  }

  /** 批次结果校验（§12.5/§13.5）：覆盖完整、裁决与替代/迁移动作一致。 */
  private validateBatchResult(batch: ReviewItem[], raw: unknown): void {
    const result = raw as BatchResultShape;
    const invalid = (message: string, details: Record<string, unknown> = {}): never =>
      this.failModelOutput(message, details);
    const batchIds = new Set<string>(batch.map((i) => i.id as string));
    const seen = new Set<string>();
    for (const entry of result.results) {
      if (!batchIds.has(entry.reviewItemId)) {
        invalid('结果引用了批次外 review item', { reviewItemId: entry.reviewItemId });
      }
      if (seen.has(entry.reviewItemId)) {
        invalid('review item 裁决重复', { reviewItemId: entry.reviewItemId });
      }
      seen.add(entry.reviewItemId);
    }
    for (const id of batchIds) {
      if (!seen.has(id)) invalid('批次 item 缺少裁决', { reviewItemId: id });
    }

    const nodeActionByRef = new Map(result.nodeActions.map((a) => [a.proposalRef, a]));
    const relationActionByRef = new Map(result.relationActions.map((a) => [a.proposalRef, a]));
    for (const entry of result.results) {
      const item = batch.find((i) => i.id === entry.reviewItemId)!;
      this.validateBatchEntry(item, entry, nodeActionByRef, relationActionByRef);
    }
  }

  private validateBatchEntry(
    item: ReviewItem,
    entry: BatchResultShape['results'][number],
    nodeActionByRef: Map<string, BatchNodeAction>,
    relationActionByRef: Map<string, BatchRelationAction>,
  ): void {
    const invalid = (message: string, details: Record<string, unknown> = {}): never =>
      this.failModelOutput(message, details);
    const replacement = () => {
      if (!entry.replacementProposalRef) {
        invalid(`${entry.verdict} 裁决缺少 replacementProposalRef`, {
          reviewItemId: entry.reviewItemId,
        });
      }
      return (
        nodeActionByRef.get(entry.replacementProposalRef!) ??
        relationActionByRef.get(entry.replacementProposalRef!)
      );
    };
    switch (entry.verdict) {
      case 'valid': {
        // valid 只解决 review item；端点变更的关系必须另有 relation revision（§13.5）
        if (item.entityKind === 'relation_revision' && item.entityRevisionId) {
          const revision = this.db.repos.relation.getRevisionById(item.entityRevisionId);
          if (revision && this.relationEndpointsStale(revision)) {
            const migrated = entry.relationMigrationProposalRefs.some((ref) => {
              const action = relationActionByRef.get(ref);
              return (
                action?.operation === 'revise' && action.logicalRelationId === revision.relationId
              );
            });
            if (!migrated) {
              invalid('valid 的关系端点已变化，必须另有 relation revision', {
                reviewItemId: entry.reviewItemId,
              });
            }
          }
        }
        return;
      }
      case 'revise': {
        const action = replacement();
        if (item.entityKind === 'node_revision') {
          const nodeId = item.entityRevisionId
            ? this.db.repos.node.getRevisionById(item.entityRevisionId)?.nodeId
            : null;
          if (
            !action ||
            !('logicalNodeId' in action) ||
            action.operation !== 'revise' ||
            action.logicalNodeId !== nodeId
          ) {
            invalid('revise 裁决必须提供对原节点的 revise 动作', {
              reviewItemId: entry.reviewItemId,
            });
          }
        } else {
          const relationId = item.entityRevisionId
            ? this.db.repos.relation.getRevisionById(item.entityRevisionId)?.relationId
            : null;
          if (
            !action ||
            !('logicalRelationId' in action) ||
            action.operation !== 'revise' ||
            action.logicalRelationId !== relationId
          ) {
            invalid('revise 裁决必须提供对原关系的 revise 动作', {
              reviewItemId: entry.reviewItemId,
            });
          }
        }
        return;
      }
      case 'refute': {
        if (item.entityKind !== 'node_revision') {
          invalid('refute 仅适用于节点', { reviewItemId: entry.reviewItemId });
        }
        const action = replacement();
        if (
          !action ||
          !('epistemicState' in action) ||
          action.operation !== 'revise' ||
          action.epistemicState !== 'refuted'
        ) {
          invalid('refute 裁决必须提供 epistemicState=refuted 的 revise 动作', {
            reviewItemId: entry.reviewItemId,
          });
        }
        return;
      }
      case 'supersede': {
        if (item.entityKind !== 'node_revision') {
          invalid('supersede 仅适用于节点', { reviewItemId: entry.reviewItemId });
        }
        const action = replacement();
        if (!action || !('nodeType' in action) || action.operation !== 'create') {
          invalid('supersede 裁决必须提供替代新节点（create）', {
            reviewItemId: entry.reviewItemId,
          });
        }
        const linked = entry.relationMigrationProposalRefs.some((ref) => {
          const relation = relationActionByRef.get(ref);
          return (
            relation?.operation === 'create' &&
            relation.relationType === 'supersedes' &&
            relation.from.refKind === 'proposal' &&
            relation.from.ref === entry.replacementProposalRef &&
            relation.to.refKind === 'existing_revision' &&
            relation.to.ref === item.entityRevisionId
          );
        });
        if (!linked) {
          invalid('supersede 必须提供新节点 supersedes 旧修订的关系（新 -> 旧）', {
            reviewItemId: entry.reviewItemId,
          });
        }
        return;
      }
      case 'unknown':
        return;
    }
  }

  /** 关系端点是否指向已被替代/移除的节点修订。 */
  private relationEndpointsStale(revision: {
    fromNodeRevisionId: string;
    toNodeRevisionId: string;
  }): boolean {
    const project = this.db.repos.project.requireSingleton();
    const working = this.currentWorkingSet(project);
    const staleSide = (nodeRevisionId: string): boolean => {
      const nodeRevision = this.db.repos.node.getRevisionById(nodeRevisionId);
      if (!nodeRevision) return true;
      const tip = working.nodeRevisionByNodeId.get(nodeRevision.nodeId);
      return !tip || tip.id !== nodeRevisionId;
    };
    return staleSide(revision.fromNodeRevisionId) || staleSide(revision.toNodeRevisionId);
  }

  private failModelOutput(message: string, details: Record<string, unknown>): never {
    throw new DomainError('MODEL_OUTPUT_INVALID', message, details);
  }
}

class RunCancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelledError';
  }
}

// ---- Reevaluate 批次结果形状（schema 已在 provider 侧校验，这里只做语义引用检查）----

interface BatchNodeAction {
  proposalRef: string;
  operation: 'create' | 'revise';
  logicalNodeId: string | null;
  nodeType: string;
  epistemicState: string | null;
}

interface BatchRelationAction {
  proposalRef: string;
  operation: 'create' | 'revise';
  logicalRelationId: string | null;
  relationType: string;
  from: { refKind: 'existing_revision' | 'proposal'; ref: string };
  to: { refKind: 'existing_revision' | 'proposal'; ref: string };
}

interface BatchResultShape {
  summary: string;
  results: Array<{
    reviewItemId: string;
    verdict: 'valid' | 'revise' | 'refute' | 'supersede' | 'unknown';
    rationale: string;
    replacementProposalRef: string | null;
    relationMigrationProposalRefs: string[];
  }>;
  nodeActions: BatchNodeAction[];
  relationActions: BatchRelationAction[];
  questionsForUser: Array<{ question: string; blocking: boolean; relatedProposalRefs: string[] }>;
  stopReason: string;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
