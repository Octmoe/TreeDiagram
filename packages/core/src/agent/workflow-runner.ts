import { createHash, randomUUID } from 'node:crypto';
import type {
  ReviewItem,
  RespondWorkflowRequest,
  StartWorkflowRequest,
  WorkflowMessage,
  WorkflowRun,
  WorkflowType,
} from '@treediagram/contracts';
import { DesignProposalSchema, ReevaluationBatchResultSchema } from '@treediagram/contracts';
import { EPISTEMIC_NODE_TYPES } from '@treediagram/contracts';
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
import type {
  ModelProvider,
  ModelUsage,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from './model-provider.js';
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
  /** 管理员可见的模型调用轨迹；只保存脱敏、截断后的请求/响应预览。 */
  modelCalls?: ModelCallTrace[];
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
  /** 当前因澄清而暂停的模型阶段；回答后重跑同一阶段。 */
  awaitingStage?: string | null;
}

interface TracePreview {
  text: string;
  originalChars: number;
  truncated: boolean;
}

interface ModelCallTrace {
  id: string;
  stage: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  provider: string;
  model: string;
  reasoningEffort: StructuredGenerationRequest['reasoningEffort'];
  maxOutputTokens: number | null;
  outputSchemaName: string;
  startedAt: string;
  finishedAt: string | null;
  request: {
    instructions: TracePreview;
    input: TracePreview;
  };
  response: TracePreview | null;
  providerResponseId: string | null;
  usage: ModelUsage | null;
  error: { code: string; message: string } | null;
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

const TRACE_SECRET_KEY =
  /(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)/i;
const TRACE_CONTENT_KEY = /^(?:contentText|rationaleText|sourceText)$/i;
const TRACE_MAX_INSTRUCTIONS = 8_000;
const TRACE_MAX_INPUT = 12_000;
const TRACE_MAX_RESPONSE = 16_000;
const TRACE_MAX_CALLS = 50;
const MODEL_MAX_OUTPUT_TOKENS = 16_384;

function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]')
    .replace(
      /((?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    );
}

function sanitizeTraceValue(
  value: unknown,
  state: { truncated: boolean },
  key = '',
  depth = 0,
): unknown {
  if (TRACE_SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    const redacted = redactSecrets(value);
    const max = TRACE_CONTENT_KEY.test(key) ? 1_000 : 2_000;
    if (redacted.length <= max) return redacted;
    state.truncated = true;
    return `${redacted.slice(0, max)}… [已截断 ${redacted.length - max} 字符]`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 10) {
    state.truncated = true;
    return '[已截断：嵌套过深]';
  }
  if (Array.isArray(value)) {
    if (value.length > 50) state.truncated = true;
    return value.slice(0, 50).map((entry) => sanitizeTraceValue(entry, state, '', depth + 1));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) state.truncated = true;
  return Object.fromEntries(
    entries
      .slice(0, 100)
      .map(([entryKey, entry]) => [
        entryKey,
        sanitizeTraceValue(entry, state, entryKey, depth + 1),
      ]),
  );
}

function previewText(text: string, maxChars: number): TracePreview {
  const redacted = redactSecrets(text);
  return {
    text: redacted.slice(0, maxChars),
    originalChars: text.length,
    truncated: redacted.length > maxChars,
  };
}

function previewJson(value: unknown, maxChars: number): TracePreview {
  const state = { truncated: false };
  const sanitized = sanitizeTraceValue(value, state);
  const text = JSON.stringify(sanitized, null, 2) ?? String(sanitized);
  const clipped = text.length > maxChars;
  return {
    text: text.slice(0, maxChars),
    originalChars: JSON.stringify(value)?.length ?? String(value).length,
    truncated: state.truncated || clipped,
  };
}

function previewModelInput(input: string): TracePreview {
  try {
    return previewJson(JSON.parse(input), TRACE_MAX_INPUT);
  } catch {
    return previewText(input, TRACE_MAX_INPUT);
  }
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
      if (this.db.repos.workflowInteraction.getOpenWait(run.id)) {
        throw new DomainError(
          'WORKFLOW_NOT_RESUMABLE',
          '当前工作流正在等待用户回答，请使用 respond 接口提交消息',
          { runId: run.id },
        );
      }
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

  /** 失败恢复与用户回答恢复分离；retry 仅接受 failed。 */
  retry(project: ProjectRecord, runId: string): WorkflowRun {
    const run = this.requireRun(project, runId);
    if (run.status !== 'failed') {
      throw new DomainError('WORKFLOW_NOT_RESUMABLE', `状态 ${run.status} 不可重试`, {
        status: run.status,
      });
    }
    return this.resume(project, runId);
  }

  /**
   * 回答开放澄清并恢复同一模型阶段。消息与 waiting_user -> queued 在同一事务提交，
   * clientMessageId 保证网络重试不会重复触发模型或创建重复消息。
   */
  respond(project: ProjectRecord, runId: string, input: RespondWorkflowRequest): WorkflowRun {
    const existing = this.db.repos.workflowInteraction.getByClientMessageId(
      runId,
      input.clientMessageId,
    );
    if (existing) return this.requireRun(project, runId);

    const run = this.requireRun(project, runId);
    if (run.status !== 'waiting_user') {
      throw new DomainError('WORKFLOW_NOT_RESUMABLE', `状态 ${run.status} 不接受用户回答`, {
        status: run.status,
      });
    }
    const wait = this.db.repos.workflowInteraction.getOpenWait(run.id);
    if (!wait || wait.id !== input.waitId) {
      throw new DomainError('WORKFLOW_NOT_RESUMABLE', '回答对应的等待已失效', {
        requestedWaitId: input.waitId,
        openWaitId: wait?.id ?? null,
      });
    }
    const promptMessage = this.db.repos.workflowInteraction.getMessage(wait.messageId);
    if (!promptMessage) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', '开放等待对应的 Agent 消息缺失', {
        waitId: wait.id,
      });
    }
    const questionIds = new Set(promptMessage.questions.map((question) => question.id));
    const answerIds = new Set<string>();
    for (const answer of input.answers) {
      if (!questionIds.has(answer.questionId) || answerIds.has(answer.questionId)) {
        throw new DomainError('VALIDATION_FAILED', '回答包含未知或重复的问题 ID', {
          questionId: answer.questionId,
        });
      }
      answerIds.add(answer.questionId);
    }
    const sourceAssetIds = input.sourceAssetIds.map((id) => {
      const asset = this.db.repos.sourceAsset.getById(id);
      if (!asset || asset.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', '回答附件不存在', { sourceAssetId: id });
      }
      return asset.id;
    });
    const now = this.clock.now();
    this.db.transaction(() => {
      this.db.repos.workflowInteraction.appendUserResponse({
        runId: run.id,
        wait,
        clientMessageId: input.clientMessageId,
        contentText: input.message,
        answers: input.answers,
        sourceAssetIds,
        now,
      });
      this.db.repos.workflowRun.update(
        run.id,
        { status: 'queued', currentStep: 'queued', error: null, finishedAt: null },
        now,
      );
    });
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
    this.db.transaction(() => {
      this.db.repos.workflowInteraction.cancelOpenWaits(runId, now);
      this.db.repos.workflowRun.update(
        runId,
        { status: 'cancelled', currentStep: 'cancelled', finishedAt: now },
        now,
      );
    });
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
    if (this.executing.has(runId)) {
      // waiting_user 刚被观察到时，上一执行协程可能尚未跑到 finally。
      // 延后一拍重试，避免 respond 已把状态置 queued 却漏掉新的执行调度。
      setImmediate(() => this.kick(runId));
      return;
    }
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

  /**
   * 在 provider 调用前后持久化可观测轨迹。这里只记录最终结构化输出与经过
   * 脱敏/截断的请求预览；Responses API 的内部 reasoning 不在返回值中，也不记录。
   */
  private async generateWithTrace<T>(
    runId: string,
    checkpoint: RunCheckpoint,
    stage: string,
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult<T>> {
    const calls = (checkpoint.modelCalls ??= []);
    // 进程中断后 resume 会新建调用；把遗留 running 轨迹明确标成失败，避免看似仍在等待。
    for (const previous of calls) {
      if (previous.status === 'running') {
        previous.status = 'failed';
        previous.finishedAt = this.clock.now();
        previous.error = { code: 'PROCESS_INTERRUPTED', message: '模型调用被进程中断' };
      }
    }
    if (calls.length >= TRACE_MAX_CALLS) {
      calls.splice(0, calls.length - TRACE_MAX_CALLS + 1);
    }
    const trace: ModelCallTrace = {
      id: randomUUID(),
      stage,
      status: 'running',
      provider: this.config.provider.providerName,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      maxOutputTokens: request.maxOutputTokens ?? null,
      outputSchemaName: request.outputSchemaName,
      startedAt: this.clock.now(),
      finishedAt: null,
      request: {
        instructions: previewText(request.instructions, TRACE_MAX_INSTRUCTIONS),
        input: previewModelInput(request.input),
      },
      response: null,
      providerResponseId: null,
      usage: null,
      error: null,
    };
    calls.push(trace);
    this.patch(runId, {
      currentStep: `running/generate/${stage}`,
      checkpoint: checkpoint as unknown as Record<string, unknown>,
    });

    try {
      const result = await this.config.provider.generateStructured<T>(request);
      trace.status = 'succeeded';
      trace.finishedAt = this.clock.now();
      trace.response = previewJson(result.value, TRACE_MAX_RESPONSE);
      trace.providerResponseId = result.providerResponseId;
      trace.usage = result.usage;
      this.patch(runId, { checkpoint: checkpoint as unknown as Record<string, unknown> });
      return result;
    } catch (error) {
      trace.status = request.signal?.aborted ? 'cancelled' : 'failed';
      trace.finishedAt = this.clock.now();
      trace.error = {
        code: error instanceof DomainError ? error.code : 'MODEL_PROVIDER_FAILED',
        message: redactSecrets(error instanceof Error ? error.message : String(error)).slice(
          0,
          500,
        ),
      };
      this.patch(runId, { checkpoint: checkpoint as unknown as Record<string, unknown> });
      throw error;
    }
  }

  /**
   * 把模型的澄清请求持久化为真正的对话等待。询问回合不保存为可应用 proposal，
   * 回答后由同一阶段基于原始上下文 + 完整对话重新生成。
   */
  private pauseForClarification(
    runId: WorkflowRunId,
    checkpoint: RunCheckpoint,
    stage: string,
    rawResult: unknown,
  ): boolean {
    const result = rawResult as {
      summary: string;
      stopReason: string;
      questionsForUser: Array<{
        question: string;
        blocking: boolean;
        relatedProposalRefs: string[];
      }>;
    };
    const needsUser = result.questionsForUser.length > 0 || result.stopReason !== 'completed';
    if (!needsUser) return false;
    const questions =
      result.questionsForUser.length > 0
        ? result.questionsForUser
        : [
            {
              question: '当前信息不足以继续，请补充本任务的目标、边界或关键约束。',
              blocking: true,
              relatedProposalRefs: [],
            },
          ];
    checkpoint.awaitingStage = stage;
    const now = this.clock.now();
    const interaction = this.db.transaction(() => {
      const created = this.db.repos.workflowInteraction.createAgentWait(
        runId,
        result.summary,
        questions,
        now,
      );
      this.db.repos.workflowRun.update(
        runId,
        {
          status: 'waiting_user',
          currentStep: 'waiting_user',
          checkpoint: checkpoint as unknown as Record<string, unknown>,
          summary: {
            summary: result.summary,
            stopReason: result.stopReason,
            waitId: created.wait.id,
            questionsForUser: created.message.questions,
          },
          finishedAt: null,
        },
        now,
      );
      return created;
    });
    return interaction.wait.status === 'open';
  }

  /** 对话是 data 下的不可信任务输入，不依赖 provider 会话，进程重启后可完整重放。 */
  private attachConversation(
    runId: WorkflowRunId,
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    const messages = this.db.repos.workflowInteraction.listMessages(runId);
    if (messages.length === 0) return context;
    const conversation = messages.map((message: WorkflowMessage) => ({
      messageId: message.id,
      sequence: message.sequence,
      role: message.role,
      contentText: message.contentText,
      questions: message.questions,
      answers: message.answers,
      attachments: message.sourceAssetIds.map((sourceAssetId) => {
        const asset = this.db.repos.sourceAsset.getById(sourceAssetId);
        if (!asset) {
          throw new DomainError('CORRUPT_PERSISTED_DATA', '对话附件对应的 source 缺失', {
            sourceAssetId,
          });
        }
        return {
          sourceAssetId: asset.id,
          kind: asset.kind,
          originalName: asset.originalName,
          contentText: asset.contentText,
        };
      }),
    }));
    return {
      ...context,
      data: {
        ...((context['data'] as Record<string, unknown> | undefined) ?? {}),
        workflowConversation: conversation,
      },
    };
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
      context = this.attachConversation(run.id, context);
      checkpoint.awaitingStage = null;
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
          let firstProposal = checkpoint.proposals?.[0];
          if (!firstProposal) {
            const first = await this.generateWithTrace(runId, checkpoint, 'initialize_extract', {
              model: this.config.model,
              instructions: INITIALIZE_EXTRACT_INSTRUCTIONS,
              input: JSON.stringify(context),
              outputSchemaName: 'DesignProposal',
              outputSchema: DesignProposalSchema,
              maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
              reasoningEffort: 'low',
              safetyIdentifier: this.config.safetyIdentifier,
              signal: controller.signal,
            });
            this.assertNotCancelled(runId);
            assertProposalWorkflowType('initialize', first.value);
            checkpoint.providerResponseId = first.providerResponseId;
            checkpoint.usage = addModelUsage(null, first.usage);
            if (this.pauseForClarification(run.id, checkpoint, 'initialize_extract', first.value)) {
              return;
            }
            firstProposal = first.value;
            checkpoint.proposals = [firstProposal];
            checkpoint.steps.push('generate_extract');
            run = this.patch(runId, {
              checkpoint: checkpoint as unknown as Record<string, unknown>,
              providerResponseId: first.providerResponseId,
              usage: checkpoint.usage,
            });
          } else {
            assertProposalWorkflowType('initialize', firstProposal);
          }

          // 第二步输入附带第一步提案的 proposalRef 摘要，使 root 步可用 refKind="proposal" 关联
          const priorStep = summarizeProposalRefs(firstProposal);
          let secondProposal = checkpoint.proposals?.[1];
          if (!secondProposal) {
            const second = await this.generateWithTrace(runId, checkpoint, 'initialize_root', {
              model: this.config.model,
              instructions: INITIALIZE_ROOT_INSTRUCTIONS,
              input: JSON.stringify({
                ...context,
                data: { ...(context['data'] as object), priorStep },
              }),
              outputSchemaName: 'DesignProposal',
              outputSchema: DesignProposalSchema,
              maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
              reasoningEffort: 'low',
              safetyIdentifier: this.config.safetyIdentifier,
              signal: controller.signal,
            });
            this.assertNotCancelled(runId);
            assertProposalWorkflowType('initialize', second.value);
            checkpoint.providerResponseId = second.providerResponseId;
            checkpoint.usage = addModelUsage(checkpoint.usage, second.usage);
            if (this.pauseForClarification(run.id, checkpoint, 'initialize_root', second.value)) {
              return;
            }
            secondProposal = second.value;
            checkpoint.proposals = [firstProposal, secondProposal];
            checkpoint.steps.push('generate_root');
          } else {
            assertProposalWorkflowType('initialize', secondProposal);
          }
          // 合并两步提案（root 步在前，保证 root 节点先建）
          checkpoint.proposal = mergeProposals([secondProposal, firstProposal]);
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
          const result = await this.generateWithTrace(runId, checkpoint, run.workflowType, {
            model: this.config.model,
            instructions,
            input: JSON.stringify(context),
            outputSchemaName: 'DesignProposal',
            outputSchema: DesignProposalSchema,
            maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
            reasoningEffort,
            safetyIdentifier: this.config.safetyIdentifier,
            signal: controller.signal,
          });
          checkpoint.providerResponseId = result.providerResponseId;
          checkpoint.usage = result.usage as unknown as Record<string, unknown>;
          if (this.pauseForClarification(run.id, checkpoint, run.workflowType, result.value)) {
            return;
          }
          checkpoint.proposal = result.value;
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
        let context = buildReevaluationContext(
          changeSet.id,
          roots,
          batch.map((item) => this.reevaluationItemView(item)),
        );
        context = this.attachConversation(run.id, context);
        checkpoint.awaitingStage = null;
        checkpoint.contextHash = sha256Hex(JSON.stringify(context));
        const batchNumber = (checkpoint.batches?.length ?? 0) + 1;
        const generated = await this.generateWithTrace(
          runId,
          checkpoint,
          `reevaluate_batch_${batchNumber}`,
          {
            model: this.config.model,
            instructions: REEVALUATE_INSTRUCTIONS,
            input: JSON.stringify(context),
            outputSchemaName: 'ReevaluationBatchResult',
            outputSchema: ReevaluationBatchResultSchema,
            maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
            reasoningEffort: 'medium',
            safetyIdentifier: this.config.safetyIdentifier,
            signal: controller.signal,
          },
        );
        this.assertNotCancelled(runId);
        this.validateBatchResult(batch, generated.value);
        checkpoint.providerResponseId = generated.providerResponseId;
        checkpoint.usage = generated.usage as unknown as Record<string, unknown>;
        if (
          this.pauseForClarification(
            run.id,
            checkpoint,
            `reevaluate_batch_${batchNumber}`,
            generated.value,
          )
        ) {
          return;
        }
        batchState = { itemIds: batchIds, result: generated.value, applied: null };
        checkpoint.pendingBatch = batchState;
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
        const applied = this.db.transaction(() => {
          // 与主路径一致：先做防御性归一（epistemicState 仅 epistemic 类型适用）
          sanitizeProposal(run.workflowType, synthetic);
          return this.applier.apply(
            project,
            run,
            synthetic,
            // 迁移/替代修订本身是复核决议（§9.3），不得再触发 §4.6 影响登记
            { effectivePolicy: null, skipImpactRegistration: true },
            author,
          );
        });
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

function addModelUsage(
  current: Record<string, unknown> | null,
  next: ModelUsage,
): Record<string, unknown> {
  const value = (key: keyof ModelUsage): number => {
    const existing = current?.[key];
    return typeof existing === 'number' && Number.isFinite(existing) ? existing : 0;
  };
  return {
    inputTokens: value('inputTokens') + next.inputTokens,
    outputTokens: value('outputTokens') + next.outputTokens,
    totalTokens: value('totalTokens') + next.totalTokens,
  };
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
 *
 * 所有工作流通用：epistemicState 仅 claim/constraint/risk 适用（§4.2）。模型偶发
 * 给其他类型输出 epistemic 值时归一为 null 并记 warning，而非让整个 run 以
 * VALIDATION_FAILED 失败——与 approvalSuggestion 降级同属对不可信模型输出的防御性归一。
 */
function sanitizeProposal(workflowType: WorkflowType, rawProposal: unknown): void {
  const proposal = rawProposal as {
    workflowType: string;
    nodeActions: Array<{
      operation: string;
      approvalSuggestion: string;
      roles: string[];
      nodeType: string;
      epistemicState: string | null;
    }>;
    relationActions: Array<{ operation: string; approvalSuggestion: string }>;
    warnings: string[];
  };
  if (workflowType !== 'reevaluate') {
    assertProposalWorkflowType(workflowType, proposal);
  }
  let normalizedEpistemic = 0;
  for (const action of proposal.nodeActions) {
    if (
      action.epistemicState !== null &&
      !(EPISTEMIC_NODE_TYPES as readonly string[]).includes(action.nodeType)
    ) {
      action.epistemicState = null;
      normalizedEpistemic += 1;
    }
  }
  if (normalizedEpistemic > 0) {
    proposal.warnings.push(
      `${normalizedEpistemic} 个非 epistemic 类型节点的 epistemicState 已归一为 null（§4.2 仅 claim/constraint/risk 适用）`,
    );
  }
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

function assertProposalWorkflowType(expected: WorkflowType, rawProposal: unknown): void {
  const actual = (rawProposal as { workflowType?: unknown }).workflowType;
  if (actual !== expected) {
    throw new DomainError('MODEL_OUTPUT_INVALID', '模型输出 workflowType 与当前运行不一致', {
      expected,
      actual,
    });
  }
}
