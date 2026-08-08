import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asId, type StartWorkflowRequest, type WorkflowRun } from '@treediagram/contracts';
import {
  CoreWorkflowRunner,
  DomainError,
  FakeModelProvider,
  INITIALIZE_EXTRACT_INSTRUCTIONS,
  INITIALIZE_ROOT_INSTRUCTIONS,
  modelError,
  type ModelProvider,
  userAuthor,
} from '@treediagram/core';
import {
  freshProject,
  makeTestWorkspace,
  quickNode,
  type TestWorkspace,
} from '../helpers/workspace.js';

/**
 * M3 工作流集成测试（IMPLEMENTATION_DESIGN §13）：
 * initialize/derive 全链路（FakeModelProvider 编排）、失败分类、cancel、
 * 断点 resume 幂等、进程中断恢复、可用性规则。
 */

function makeRunner(ws: TestWorkspace, provider: ModelProvider): CoreWorkflowRunner {
  return new CoreWorkflowRunner(ws.ctx, {
    provider,
    model: 'test-model',
    safetyIdentifier: 'a'.repeat(32),
  });
}

function nodeAction(
  ref: string,
  overrides: { roles?: string[]; approvalSuggestion?: string } = {},
) {
  return {
    proposalRef: ref,
    operation: 'create',
    logicalNodeId: null,
    baseRevisionId: null,
    nodeType: 'claim',
    displayTitle: `节点 ${ref}`,
    contentText: `内容 ${ref}`,
    roles: overrides.roles ?? [],
    attributes: null,
    approvalSuggestion: overrides.approvalSuggestion ?? 'tentative',
    epistemicState: 'assumed',
    rationale: '测试 rationale',
  };
}

function containsAction(ref: string, from: unknown, to: unknown) {
  return {
    proposalRef: ref,
    operation: 'create',
    logicalRelationId: null,
    baseRelationRevisionId: null,
    relationType: 'contains',
    from,
    to,
    rationale: '测试 rationale',
    attributes: null,
    approvalSuggestion: 'tentative',
  };
}

function proposal(nodeActions: unknown[], relationActions: unknown[], overrides = {}) {
  return {
    schemaVersion: 1,
    workflowType: 'derive',
    summary: '测试提案',
    nodeActions,
    relationActions,
    questionsForUser: [],
    warnings: [],
    stopReason: 'completed',
    ...overrides,
  };
}

function setConsistent(ws: TestWorkspace): void {
  ws.db.repos.project.updateStatus(ws.project.id, 'consistent', null, ws.clock.now());
}

const deriveRequest = (targetNodeId: string): StartWorkflowRequest => ({
  workflowType: 'derive',
  targetNodeId: asId(targetNodeId),
  changeSetId: null,
  sourceAssetIds: [],
  focusInstruction: null,
});

describe('M3 initialize 工作流（§13.1）', () => {
  it('两步生成 → 合并提案 → 应用 → succeeded', async () => {
    const ws = makeTestWorkspace();
    const source = ws.services.sources.addSource(
      ws.project.id,
      {
        kind: 'markdown',
        originalName: 'input.md',
        mediaType: 'text/markdown',
        contentText: '设计输入原文',
      },
      userAuthor,
    );
    const provider = FakeModelProvider.scripted([
      // 第一步：提取非 root 候选
      proposal([nodeAction('c1')], [], { workflowType: 'initialize' }),
      // 第二步：root 候选与矛盾（合并时 root 在前）
      proposal(
        [nodeAction('root1', { roles: ['root'] })],
        [
          containsAction(
            'r1',
            { refKind: 'proposal', ref: 'root1' },
            { refKind: 'proposal', ref: 'c1' },
          ),
        ],
        { workflowType: 'initialize' },
      ),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), {
      workflowType: 'initialize',
      targetNodeId: null,
      changeSetId: null,
      sourceAssetIds: [source.id],
      focusInstruction: null,
    });
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(final.changeSetId).not.toBeNull();
    expect(final.providerResponseId).toBe('fake-1');
    // 两次生成：extract → root，指令不同
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.instructions).toBe(INITIALIZE_EXTRACT_INSTRUCTIONS);
    expect(provider.calls[1]!.instructions).toBe(INITIALIZE_ROOT_INSTRUCTIONS);
    expect(provider.calls[0]!.input).toContain('设计输入原文');
    // checkpoint 步骤完整
    const steps = (final.checkpoint as { steps: string[] }).steps;
    expect(steps).toEqual(
      expect.arrayContaining([
        'load_context',
        'generate_extract',
        'generate_root',
        'validate_output',
        'apply_proposal',
      ]),
    );
    // 节点与关系真实落库
    const nodes = ws.db.repos.node.listNodesByProject(ws.project.id);
    expect(nodes).toHaveLength(2);
    const relations = ws.db.repos.relation.listRelationsByProject(ws.project.id);
    expect(relations).toHaveLength(1);
    // 摘要不泄露指令，含提案统计
    const summary = final.summary as { nodeActionCount: number; relationActionCount: number };
    expect(summary.nodeActionCount).toBe(2);
    expect(summary.relationActionCount).toBe(1);
  });

  it('模糊 source 在 extract 阶段先对话澄清，回答后才生成并一次应用完整提案', async () => {
    const ws = makeTestWorkspace();
    const source = ws.services.sources.addSource(
      ws.project.id,
      {
        kind: 'text',
        originalName: '开始点.txt',
        mediaType: 'text/plain',
        contentText: '一套给 ai agent 使用的程序化建模工具集',
      },
      userAuthor,
    );
    const provider = FakeModelProvider.scripted([
      proposal([nodeAction('guess')], [], {
        workflowType: 'initialize',
        summary: '需要先确认建模领域。',
        questionsForUser: [
          {
            question: '建模对象与使用形态是什么？',
            blocking: true,
            relatedProposalRefs: ['guess'],
          },
        ],
        stopReason: 'insufficient_context',
      }),
      proposal([nodeAction('c1')], [], { workflowType: 'initialize' }),
      proposal(
        [nodeAction('root1', { roles: ['root'] })],
        [
          containsAction(
            'root-rel1',
            { refKind: 'proposal', ref: 'root1' },
            { refKind: 'proposal', ref: 'c1' },
          ),
        ],
        { workflowType: 'initialize' },
      ),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), {
      workflowType: 'initialize',
      targetNodeId: null,
      changeSetId: null,
      sourceAssetIds: [source.id],
      focusInstruction: null,
    });

    const waiting = await runner.waitForCompletion(run.id);
    expect(waiting.status).toBe('waiting_user');
    expect(provider.calls).toHaveLength(1);
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(0);
    const openWait = ws.db.repos.workflowInteraction.getOpenWait(run.id)!;
    const clientMessageId = asId(randomUUID());
    const response = {
      waitId: openWait.id,
      clientMessageId,
      message: '面向软件架构图，通过本地 TypeScript API 供 agent 创建和修改模型。',
      answers: [],
      sourceAssetIds: [],
    };
    runner.respond(freshProject(ws), run.id, response);
    // 同一 clientMessageId 的网络重试幂等，不创建第二条消息或第二次恢复。
    runner.respond(freshProject(ws), run.id, response);
    expect(() =>
      runner.respond(freshProject(ws), run.id, {
        ...response,
        message: '复用幂等键但篡改正文',
      }),
    ).toThrowError(/clientMessageId/);
    expect(() =>
      runner.respond(freshProject(ws), run.id, {
        ...response,
        clientMessageId: asId(randomUUID()),
      }),
    ).toThrowError(/不接受用户回答/);

    const final = await runner.waitForCompletion(run.id);
    expect(final.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]!.instructions).toBe(INITIALIZE_EXTRACT_INSTRUCTIONS);
    expect(provider.calls[1]!.input).toContain('面向软件架构图');
    expect(provider.calls[2]!.instructions).toBe(INITIALIZE_ROOT_INSTRUCTIONS);
    expect(ws.db.repos.workflowInteraction.listMessages(run.id)).toHaveLength(2);
    expect(ws.db.repos.workflowInteraction.getOpenWait(run.id)).toBeNull();
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(2);
    expect(ws.db.repos.relation.listRelationsByProject(ws.project.id)).toHaveLength(1);
  });

  it('开发 FakeProvider 可完成两阶段 initialize，并产出 root 与 contains', async () => {
    const ws = makeTestWorkspace();
    const source = ws.services.sources.addSource(
      ws.project.id,
      {
        kind: 'text',
        originalName: 'fake-input.txt',
        mediaType: 'text/plain',
        contentText: '离线开发模式输入',
      },
      userAuthor,
    );
    const provider = FakeModelProvider.forDevelopment();
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), {
      workflowType: 'initialize',
      targetNodeId: null,
      changeSetId: null,
      sourceAssetIds: [source.id],
      focusInstruction: null,
    });

    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(2);
    const revisions = ws.db.repos.node
      .listNodesByProject(ws.project.id)
      .flatMap((node) => ws.db.repos.node.listRevisionsByNode(node.id));
    expect(revisions.some((revision) => revision?.roles.includes('root'))).toBe(true);
    expect(ws.db.repos.relation.listRelationsByProject(ws.project.id)).toHaveLength(1);
  });

  it('root 阶段失败后 resume 复用已持久化的 extract 提案，不重复调用第一阶段', async () => {
    const ws = makeTestWorkspace();
    const source = ws.services.sources.addSource(
      ws.project.id,
      {
        kind: 'text',
        originalName: 'resume.txt',
        mediaType: 'text/plain',
        contentText: '用于验证两阶段断点恢复',
      },
      userAuthor,
    );
    const provider = FakeModelProvider.scripted([
      proposal([nodeAction('c1')], [], { workflowType: 'initialize' }),
      modelError('MODEL_PROVIDER_FAILED', 'root 阶段临时失败', { retryable: false }),
      proposal(
        [nodeAction('root1', { roles: ['root'] })],
        [
          containsAction(
            'r1',
            { refKind: 'proposal', ref: 'root1' },
            { refKind: 'proposal', ref: 'c1' },
          ),
        ],
        { workflowType: 'initialize' },
      ),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), {
      workflowType: 'initialize',
      targetNodeId: null,
      changeSetId: null,
      sourceAssetIds: [source.id],
      focusInstruction: null,
    });
    const failed = await runner.waitForCompletion(run.id);
    expect(failed.status).toBe('failed');
    expect(provider.calls).toHaveLength(2);
    expect(
      (failed.checkpoint['modelCalls'] as Array<{ stage: string; status: string }>).map(
        ({ stage, status }) => ({ stage, status }),
      ),
    ).toEqual([
      { stage: 'initialize_extract', status: 'succeeded' },
      { stage: 'initialize_root', status: 'failed' },
    ]);

    runner.resume(freshProject(ws), run.id);
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[2]!.instructions).toBe(INITIALIZE_ROOT_INSTRUCTIONS);
    expect(provider.calls[2]!.input).toContain('"proposalRef":"c1"');
    expect(
      (final.checkpoint['modelCalls'] as Array<{ stage: string; status: string }>).map(
        ({ stage, status }) => ({ stage, status }),
      ),
    ).toEqual([
      { stage: 'initialize_extract', status: 'succeeded' },
      { stage: 'initialize_root', status: 'failed' },
      { stage: 'initialize_root', status: 'succeeded' },
    ]);
  });

  it('两阶段 initialize 汇总两次 provider token 用量', async () => {
    const ws = makeTestWorkspace();
    const source = ws.services.sources.addSource(
      ws.project.id,
      {
        kind: 'text',
        originalName: 'usage.txt',
        mediaType: 'text/plain',
        contentText: '用量汇总测试',
      },
      userAuthor,
    );
    const values = [
      proposal([nodeAction('c1')], [], { workflowType: 'initialize' }),
      proposal([nodeAction('root1', { roles: ['root'] })], [], {
        workflowType: 'initialize',
      }),
    ];
    let callIndex = 0;
    const provider: ModelProvider = {
      providerName: 'usage-test',
      async generateStructured<T>() {
        const index = callIndex++;
        const usage =
          index === 0
            ? { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
            : { inputTokens: 20, outputTokens: 3, totalTokens: 23 };
        return {
          value: values[index] as T,
          providerResponseId: `usage-${index}`,
          usage,
        };
      },
    };
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), {
      workflowType: 'initialize',
      targetNodeId: null,
      changeSetId: null,
      sourceAssetIds: [source.id],
      focusInstruction: null,
    });

    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(final.usage).toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
    expect((final.checkpoint as { usage: unknown }).usage).toEqual(final.usage);
  });
});

describe('M3 derive 工作流（§13.2）', () => {
  it('provider 等待期间持久化脱敏调用轨迹，完成后补齐响应与用量', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const secret = 'supersecretvalue123456';
    const target = quickNode(ws, {
      title: '轨迹测试目标',
      content: `apiKey=${secret} ${'长上下文'.repeat(400)}`,
    });
    let releaseProvider!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: ModelProvider = {
      providerName: 'trace-test',
      async generateStructured<T>() {
        await gate;
        return {
          value: proposal([nodeAction('trace-child')], []) as T,
          providerResponseId: 'trace-response-1',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      },
    };
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), deriveRequest(target.node.id));

    let running: WorkflowRun | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      running = ws.db.repos.workflowRun.getById(run.id);
      if (running?.currentStep === 'running/generate/derive') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(running?.currentStep).toBe('running/generate/derive');
    const inFlightCalls = (running?.checkpoint['modelCalls'] ?? []) as Array<{
      stage: string;
      status: string;
      request: { input: { text: string; truncated: boolean } };
    }>;
    expect(inFlightCalls).toHaveLength(1);
    expect(inFlightCalls[0]).toMatchObject({ stage: 'derive', status: 'running' });
    expect(inFlightCalls[0]!.request.input.text).toContain('[REDACTED]');
    expect(inFlightCalls[0]!.request.input.text).not.toContain(secret);
    expect(inFlightCalls[0]!.request.input.truncated).toBe(true);

    releaseProvider();
    const final = await runner.waitForCompletion(run.id);
    const completedCalls = final.checkpoint['modelCalls'] as Array<{
      status: string;
      providerResponseId: string;
      usage: Record<string, unknown>;
      response: { text: string };
    }>;
    expect(completedCalls[0]).toMatchObject({
      status: 'succeeded',
      providerResponseId: 'trace-response-1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(completedCalls[0]!.response.text).toContain('trace-child');
  });

  it('单次生成 → 应用 → succeeded；上下文含目标节点', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws, { title: '父命题' });
    const provider = FakeModelProvider.scripted([
      proposal(
        [nodeAction('child1')],
        [
          containsAction(
            'r1',
            { refKind: 'existing_revision', ref: target.revision.id },
            { refKind: 'proposal', ref: 'child1' },
          ),
        ],
      ),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), deriveRequest(target.node.id));
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.input).toContain('父命题');
    const nodes = ws.db.repos.node.listNodesByProject(ws.project.id);
    expect(nodes).toHaveLength(2);
  });

  it('blocking 问题 → 不应用提案并持久等待；用户回答后重跑同一阶段', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws);
    const provider = FakeModelProvider.scripted([
      proposal([nodeAction('c1')], [], {
        questionsForUser: [
          { question: '这个分支要继续吗？', blocking: true, relatedProposalRefs: ['c1'] },
        ],
      }),
      proposal([nodeAction('c2')], []),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), deriveRequest(target.node.id));
    const waiting = await runner.waitForCompletion(run.id);
    expect(waiting.status).toBe('waiting_user');
    expect(waiting.finishedAt).toBeNull();
    // 询问回合没有把基于模糊输入的 c1 写入 ChangeSet。
    expect(ws.db.repos.node.listNodesByProject(ws.project.id).length).toBe(1);
    const conversation = ws.db.repos.workflowInteraction.listMessages(run.id);
    const wait = ws.db.repos.workflowInteraction.getOpenWait(run.id)!;
    expect(conversation).toHaveLength(1);
    expect(conversation[0]?.questions[0]?.question).toBe('这个分支要继续吗？');
    expect(() => runner.resume(freshProject(ws), run.id)).toThrowError(/respond/);

    runner.respond(freshProject(ws), run.id, {
      waitId: wait.id,
      clientMessageId: asId(randomUUID()),
      message: '继续，但只设计本地离线分支。',
      answers: [],
      sourceAssetIds: [],
    });
    const resumed = await runner.waitForCompletion(run.id);
    expect(resumed.status).toBe('succeeded');
    expect(resumed.finishedAt).not.toBeNull();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.input).toContain('继续，但只设计本地离线分支');
    expect(ws.db.repos.node.listNodesByProject(ws.project.id).length).toBe(2);
  });

  it('模型输出不合法 → failed(MODEL_OUTPUT_INVALID)', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws);
    const provider = FakeModelProvider.scripted([{ not: 'a proposal' }]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), deriveRequest(target.node.id));
    const final = await runner.waitForCompletion(run.id);
    expect(final.status).toBe('failed');
    expect(final.error?.code).toBe('MODEL_OUTPUT_INVALID');
  });

  it('模型输出 workflowType 与实际运行不一致 → failed(MODEL_OUTPUT_INVALID)', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws);
    const provider = FakeModelProvider.scripted([
      proposal([nodeAction('c1')], [], { workflowType: 'grill' }),
    ]);
    const runner = makeRunner(ws, provider);

    const run = runner.start(freshProject(ws), deriveRequest(target.node.id));
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('failed');
    expect(final.error?.code).toBe('MODEL_OUTPUT_INVALID');
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(1);
  });

  it('apply 失败后 resume 幂等：不重新生成、不重复建节点', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws);
    const dangling = proposal(
      [nodeAction('c1')],
      [
        containsAction(
          'r1',
          { refKind: 'proposal', ref: 'missing' },
          { refKind: 'proposal', ref: 'c1' },
        ),
      ],
    );
    const provider = FakeModelProvider.scripted([dangling]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), deriveRequest(target.node.id));
    const failed = await runner.waitForCompletion(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('MODEL_OUTPUT_INVALID');
    // apply 事务回滚：只有初始 target 节点
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(1);

    const resumed = runner.resume(freshProject(ws), run.id);
    expect(resumed.status).toBe('queued');
    const failedAgain = await runner.waitForCompletion(run.id);
    expect(failedAgain.status).toBe('failed');
    // 未再次调用模型（checkpoint 已有 proposal）
    expect(provider.calls).toHaveLength(1);
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(1);
  });

  it('cancel 中断在途模型请求，终态保持 cancelled', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws);
    const hangingProvider = new FakeModelProvider(
      (req) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener('abort', () =>
            reject(modelError('MODEL_PROVIDER_FAILED', '请求被 abort', { retryable: false })),
          );
        }),
    );
    const runner = makeRunner(ws, hangingProvider);
    const run = runner.start(freshProject(ws), deriveRequest(target.node.id));
    // 等待请求真正发给 provider，确保取消轨迹可观测。
    for (let i = 0; i < 100; i += 1) {
      const current = ws.db.repos.workflowRun.getById(run.id);
      if (current?.currentStep === 'running/generate/derive') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const cancelled = runner.cancel(freshProject(ws), run.id);
    expect(cancelled.status).toBe('cancelled');
    // abort 导致的 provider 错误不得覆盖 cancelled 终态
    await new Promise((r) => setTimeout(r, 100));
    const after = ws.db.repos.workflowRun.getById(run.id);
    expect(after?.status).toBe('cancelled');
    expect(
      (after?.checkpoint['modelCalls'] as Array<{ status: string; error: { code: string } }>)[0],
    ).toMatchObject({ status: 'cancelled', error: { code: 'MODEL_PROVIDER_FAILED' } });
  });

  it('进程中断恢复：遗留 running run 标记 failed(PROCESS_INTERRUPTED) 并可 resume', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws);
    const now = ws.clock.now();
    const interrupted: WorkflowRun = {
      id: asId(randomUUID()),
      projectId: ws.project.id,
      changeSetId: null,
      workflowType: 'derive',
      targetNodeId: target.node.id,
      status: 'running',
      currentStep: 'running/generate',
      input: deriveRequest(target.node.id) as unknown as Record<string, unknown>,
      checkpoint: {
        steps: ['load_context'],
        contextHash: null,
        proposal: null,
        proposals: [],
        providerResponseId: null,
        usage: null,
        applied: null,
      },
      summary: null,
      error: null,
      provider: 'fake',
      model: 'test-model',
      providerResponseId: null,
      usage: null,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    ws.db.repos.workflowRun.insert(interrupted);

    const provider = FakeModelProvider.scripted([proposal([nodeAction('c1')], [])]);
    const runner = makeRunner(ws, provider);
    expect(runner.recoverInterrupted(freshProject(ws))).toBe(1);
    const recovered = ws.db.repos.workflowRun.getById(interrupted.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error?.code).toBe('PROCESS_INTERRUPTED');

    // resume 后完整重跑（checkpoint 无 proposal）
    runner.resume(freshProject(ws), interrupted.id);
    const final = await runner.waitForCompletion(interrupted.id);
    expect(final.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('M3 可用性规则（§13）', () => {
  it('initialize 仅可在 initializing 状态启动', () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const runner = makeRunner(ws, FakeModelProvider.scripted([]));
    expect(() =>
      runner.start(freshProject(ws), {
        workflowType: 'initialize',
        targetNodeId: null,
        changeSetId: null,
        sourceAssetIds: [],
        focusInstruction: null,
      }),
    ).toThrowError(DomainError);
  });

  it('derive 需要 consistent 状态', () => {
    const ws = makeTestWorkspace(); // 默认 initializing
    const target = quickNode(ws);
    const runner = makeRunner(ws, FakeModelProvider.scripted([]));
    try {
      runner.start(freshProject(ws), deriveRequest(target.node.id));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('WORKFLOW_NOT_AVAILABLE');
    }
  });

  it('reevaluate 在 M5 前不可用（grill/unbox 自 M4 起可用）', () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const runner = makeRunner(ws, FakeModelProvider.scripted([]));
    try {
      runner.start(freshProject(ws), {
        workflowType: 'reevaluate',
        targetNodeId: null,
        changeSetId: null,
        sourceAssetIds: [],
        focusInstruction: null,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('WORKFLOW_NOT_AVAILABLE');
    }
  });
});
