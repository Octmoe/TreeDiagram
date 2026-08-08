import { TypeCompiler } from '@sinclair/typebox/compiler';
import type {
  ModelProvider,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from './model-provider.js';
import { modelError } from './model-provider.js';

/**
 * FakeModelProvider：确定性、无网络。两种用法：
 * 1. script：测试按调用次序编排返回值（或抛错），验证工作流状态机/断点恢复；
 * 2. 默认 handler：开发/e2e 环境生成最小合法输出（M3 起 UI 可端到端走通 Agent 路径）。
 */

export type FakeResponder = (
  request: StructuredGenerationRequest,
  callIndex: number,
) => unknown | Promise<unknown>;

export interface FakeCall {
  outputSchemaName: string;
  instructions: string;
  input: string;
  model: string;
  reasoningEffort: string;
}

export class FakeModelProvider implements ModelProvider {
  readonly providerName = 'fake';
  readonly calls: FakeCall[] = [];
  private responder: FakeResponder;

  constructor(responder: FakeResponder) {
    this.responder = responder;
  }

  /** 测试编排：依次返回 values；耗尽后抛 MODEL_PROVIDER_FAILED。 */
  static scripted(values: Array<unknown>): FakeModelProvider {
    return new FakeModelProvider((_req, i) => {
      if (i >= values.length) {
        throw modelError('MODEL_PROVIDER_FAILED', 'fake script 已耗尽', { retryable: false });
      }
      const v = values[i];
      if (v instanceof Error) throw v;
      return v;
    });
  }

  /** 默认开发响应：按 outputSchemaName 生成最小合法结构。 */
  static forDevelopment(): FakeModelProvider {
    return new FakeModelProvider((req) => defaultFakeValue(req.outputSchemaName, req.input));
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult<T>> {
    if (request.signal?.aborted) {
      throw modelError('MODEL_PROVIDER_FAILED', '工作流已取消', {
        retryable: false,
        cancelled: true,
      });
    }
    const callIndex = this.calls.length;
    this.calls.push({
      outputSchemaName: request.outputSchemaName,
      instructions: request.instructions,
      input: request.input,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    });
    const value = await this.responder(request, callIndex);
    const checker = TypeCompiler.Compile(request.outputSchema);
    if (!checker.Check(value)) {
      const first = [...checker.Errors(value)][0];
      throw modelError('MODEL_OUTPUT_INVALID', 'fake 输出未通过 schema 校验', {
        path: first?.path,
        message: first?.message,
      });
    }
    return {
      value: value as T,
      providerResponseId: `fake-${callIndex}`,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

function defaultFakeValue(schemaName: string, input: string): unknown {
  if (schemaName === 'DesignProposal') {
    const context = parseContext(input);
    const workflowType =
      context.task === 'derive' || context.task === 'grill' || context.task === 'unbox'
        ? context.task
        : 'initialize';
    const priorNodeRefs = readPriorNodeRefs(context.data);
    const isInitializeRoot = workflowType === 'initialize' && priorNodeRefs.length > 0;
    const shouldClarify =
      context.data['focusInstruction'] === '__fake_clarify__' &&
      !hasUserConversationMessage(context.data);
    if (shouldClarify) {
      return {
        schemaVersion: 1,
        workflowType,
        summary: 'FakeModelProvider 请求用户澄清，用于离线验证多轮对话。',
        nodeActions: [],
        relationActions: [],
        questionsForUser: [
          {
            question: '请确认这个分支期望解决的具体问题。',
            blocking: true,
            relatedProposalRefs: [],
          },
        ],
        warnings: [],
        stopReason: 'needs_user',
      };
    }
    const nodeRef = isInitializeRoot ? 'root1' : 'n1';
    const relationActions: unknown[] = [];
    if (isInitializeRoot) {
      relationActions.push(
        fakeContainsAction(
          'r1',
          { refKind: 'proposal', ref: nodeRef },
          { refKind: 'proposal', ref: priorNodeRefs[0]! },
        ),
      );
    } else {
      const parentRevisionId =
        workflowType === 'derive'
          ? readRevisionId(context.data, 'target')
          : workflowType === 'unbox'
            ? readRevisionId(context.data, 'container')
            : null;
      if (parentRevisionId) {
        relationActions.push(
          fakeContainsAction(
            'r1',
            { refKind: 'existing_revision', ref: parentRevisionId },
            { refKind: 'proposal', ref: nodeRef },
          ),
        );
      }
    }
    return {
      schemaVersion: 1,
      workflowType,
      summary: 'fake provider 生成的最小提案',
      nodeActions: [
        {
          proposalRef: nodeRef,
          operation: 'create',
          logicalNodeId: null,
          baseRevisionId: null,
          nodeType: 'claim',
          displayTitle: isInitializeRoot ? 'fake 根命题' : 'fake 候选命题',
          contentText: '由 FakeModelProvider 生成，用于离线开发。',
          roles: isInitializeRoot ? ['root'] : [],
          attributes: null,
          approvalSuggestion: 'tentative',
          epistemicState: 'assumed',
          rationale: 'fake provider 占位提案',
        },
      ],
      relationActions,
      questionsForUser: [],
      warnings: ['当前使用 FakeModelProvider，输出不具设计价值'],
      stopReason: 'completed',
    };
  }
  if (schemaName === 'ReevaluationBatchResult') {
    // 开发默认：对上下文中的每个批次 item 一律 valid 裁决
    const parsed = JSON.parse(input) as {
      data?: { items?: Array<{ reviewItemId: string }> };
    };
    const items = parsed.data?.items ?? [];
    if (items.length === 0) {
      throw modelError('MODEL_PROVIDER_FAILED', 'fake reevaluate 上下文缺少批次 items', {
        retryable: false,
      });
    }
    return {
      schemaVersion: 1,
      summary: 'fake provider：全部 item 裁决 valid',
      results: items.map((item) => ({
        reviewItemId: item.reviewItemId,
        verdict: 'valid',
        rationale: 'FakeModelProvider 默认复核通过',
        replacementProposalRef: null,
        relationMigrationProposalRefs: [],
      })),
      nodeActions: [],
      relationActions: [],
      questionsForUser: [],
      stopReason: 'completed',
    };
  }
  throw modelError('MODEL_PROVIDER_FAILED', `未知 fake schema: ${schemaName}`, {
    retryable: false,
  });
}

interface FakeContext {
  task: string | null;
  data: Record<string, unknown>;
}

function parseContext(input: string): FakeContext {
  try {
    const parsed = JSON.parse(input) as { task?: unknown; data?: unknown };
    return {
      task: typeof parsed.task === 'string' ? parsed.task : null,
      data:
        parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
          ? (parsed.data as Record<string, unknown>)
          : {},
    };
  } catch {
    return { task: null, data: {} };
  }
}

function readPriorNodeRefs(data: Record<string, unknown>): string[] {
  const prior = data['priorStep'];
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return [];
  const refs = (prior as Record<string, unknown>)['nodeRefs'];
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const ref = (entry as Record<string, unknown>)['proposalRef'];
    return typeof ref === 'string' && ref.length > 0 ? [ref] : [];
  });
}

function readRevisionId(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const revisionId = (value as Record<string, unknown>)['revisionId'];
  return typeof revisionId === 'string' && revisionId.length > 0 ? revisionId : null;
}

function hasUserConversationMessage(data: Record<string, unknown>): boolean {
  const conversation = data['workflowConversation'];
  return (
    Array.isArray(conversation) &&
    conversation.some(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>)['role'] === 'user',
    )
  );
}

function fakeContainsAction(ref: string, from: unknown, to: unknown): unknown {
  return {
    proposalRef: ref,
    operation: 'create',
    logicalRelationId: null,
    baseRelationRevisionId: null,
    relationType: 'contains',
    from,
    to,
    rationale: 'fake provider 建立最小层级关系',
    attributes: null,
    approvalSuggestion: 'tentative',
  };
}
