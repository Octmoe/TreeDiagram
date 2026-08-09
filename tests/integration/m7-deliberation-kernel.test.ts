import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asId, type StartWorkflowRequest } from '@treediagram/contracts';
import { CoreWorkflowRunner, FakeModelProvider, modelError, userAuthor } from '@treediagram/core';
import { freshProject, makeTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function makeRunner(ws: TestWorkspace, provider: FakeModelProvider) {
  return new CoreWorkflowRunner(ws.ctx, {
    provider,
    model: 'test-model',
    safetyIdentifier: 'd'.repeat(32),
  });
}

function request(sourceId: string): StartWorkflowRequest {
  return {
    workflowType: 'initialize',
    targetNodeId: null,
    changeSetId: null,
    sourceAssetIds: [asId(sourceId)],
    focusInstruction: null,
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    workflowType: 'initialize',
    summary: '就绪评估',
    normalizedBrief: '构建供 AI agent 使用的软件架构程序化建模工具。',
    readiness: 'ready',
    issues: [],
    resolvedIssueIds: [],
    assumptions: [],
    warnings: [],
    ...overrides,
  };
}

function nodeAction(
  proposalRef: string,
  nodeType: 'goal' | 'topic' | 'claim' | 'question',
  overrides: { roles?: string[]; attributes?: unknown; epistemicState?: string | null } = {},
) {
  return {
    proposalRef,
    operation: 'create',
    logicalNodeId: null,
    baseRevisionId: null,
    nodeType,
    displayTitle: `节点 ${proposalRef}`,
    contentText: `内容 ${proposalRef}`,
    roles: overrides.roles ?? [],
    attributes:
      overrides.attributes ??
      (nodeType === 'goal'
        ? { priorityNote: null }
        : nodeType === 'question'
          ? { blocking: false }
          : null),
    approvalSuggestion: 'tentative',
    epistemicState: overrides.epistemicState ?? (nodeType === 'claim' ? 'assumed' : null),
    rationale: '测试',
  };
}

function contains(proposalRef: string, from: string, to: string) {
  return {
    proposalRef,
    operation: 'create',
    logicalRelationId: null,
    baseRelationRevisionId: null,
    relationType: 'contains',
    from: { refKind: 'proposal', ref: from },
    to: { refKind: 'proposal', ref: to },
    rationale: '结构包含',
    attributes: null,
    approvalSuggestion: 'tentative',
  };
}

function proposal(nodeActions: unknown[], relationActions: unknown[] = []) {
  return {
    schemaVersion: 1,
    workflowType: 'initialize',
    summary: '完整初始化投影',
    nodeActions,
    relationActions,
    questionsForUser: [],
    warnings: [],
    stopReason: 'completed',
  };
}

function addSource(ws: TestWorkspace) {
  return ws.services.sources.addSource(
    ws.project.id,
    {
      kind: 'text',
      originalName: 'start.txt',
      mediaType: 'text/plain',
      contentText: '一套给 AI agent 使用的程序化建模工具集',
    },
    userAuthor,
  );
}

function confirmRoots(ws: TestWorkspace): void {
  const project = freshProject(ws);
  const live = ws.services.changeSets.getLive(project)!;
  const roots = [
    ...ws.services.changeSets.buildViews(live).working.nodeRevisionByNodeId.values(),
  ].filter((revision) => revision.roles.includes('root'));
  for (const root of roots) {
    ws.services.nodes.reviseCandidateNode(
      project,
      root.nodeId,
      root.id,
      {
        displayTitle: root.displayTitle,
        contentText: root.contentText,
        roles: root.roles,
        attributes: root.attributes,
        approvalState: 'user_confirmed',
        epistemicState: root.epistemicState,
      },
      userAuthor,
    );
  }
}

describe('clarification-aware deliberation kernel', () => {
  it('先持久化语义 Issue，回答精确绑定后才生成提案，并显式等待 root 审批', async () => {
    const ws = makeTestWorkspace();
    const source = addSource(ws);
    const provider = FakeModelProvider.scripted([
      readiness({
        summary: '需要先确认建模领域。',
        normalizedBrief: '待确认具体建模领域。',
        readiness: 'needs_user',
        issues: [
          {
            issueId: null,
            issueKey: 'model-domain',
            kind: 'ambiguity',
            gate: 'before_proposal',
            question: '“程序化建模”具体指什么领域？',
            rationale: '领域会改变根部语义和节点类型。',
            answerType: 'free_text',
            options: [],
            relatedRefs: [],
          },
        ],
      }),
      proposal([nodeAction('root', 'goal', { roles: ['root'] })]),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), request(source.id));

    const waiting = await runner.waitForCompletion(run.id);
    expect(waiting.status).toBe('waiting_user');
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toEqual([]);
    const issue = ws.db.repos.workflowIssue.listByRun(run.id)[0]!;
    const wait = ws.db.repos.workflowInteraction.getOpenWait(run.id)!;
    expect(issue).toMatchObject({ issueKey: 'model-domain', status: 'open' });

    runner.respond(freshProject(ws), run.id, {
      waitId: wait.id,
      clientMessageId: asId(randomUUID()),
      message: '软件架构、程序结构与依赖关系建模。',
      answers: [],
      sourceAssetIds: [],
    });
    const awaitingApproval = await runner.waitForCompletion(run.id);
    expect(awaitingApproval).toMatchObject({
      status: 'waiting_user',
      currentStep: 'waiting_approval',
    });
    expect(ws.db.repos.workflowIssue.getById(issue.id)?.status).toBe('resolved');
    expect(ws.db.repos.workflowInteraction.listMessages(run.id)[1]?.answers).toEqual([
      { questionId: issue.id, answerText: '软件架构、程序结构与依赖关系建模。' },
    ]);

    confirmRoots(ws);
    runner.resume(freshProject(ws), run.id);
    expect((await runner.waitForCompletion(run.id)).status).toBe('succeeded');
  });

  it('retry 可幂等重放模型已声明 resolved 的 Issue ID', async () => {
    const ws = makeTestWorkspace();
    const source = addSource(ws);
    let readinessCalls = 0;
    let proposalCalls = 0;
    const provider = new FakeModelProvider(
      (call) => {
        if (call.outputSchemaName === 'WorkflowReadiness') {
          readinessCalls += 1;
          if (readinessCalls === 1) {
            return readiness({
              readiness: 'needs_user',
              issues: [
                {
                  issueId: null,
                  issueKey: 'integration-mode',
                  kind: 'decision',
                  gate: 'before_proposal',
                  question: '如何集成？',
                  rationale: '影响整体入口。',
                  answerType: 'free_text',
                  options: [],
                  relatedRefs: [],
                },
              ],
            });
          }
          const context = JSON.parse(call.input) as {
            data: { workflowIssues: Array<{ issueId: string }> };
          };
          return readiness({
            resolvedIssueIds: [context.data.workflowIssues[0]!.issueId],
          });
        }
        proposalCalls += 1;
        if (proposalCalls === 1) {
          throw modelError('MODEL_PROVIDER_FAILED', '提案阶段临时失败', { retryable: false });
        }
        return proposal([nodeAction('root', 'goal', { roles: ['root'] })]);
      },
      { autoReadiness: false },
    );
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), request(source.id));
    await runner.waitForCompletion(run.id);
    const wait = ws.db.repos.workflowInteraction.getOpenWait(run.id)!;
    runner.respond(freshProject(ws), run.id, {
      waitId: wait.id,
      clientMessageId: asId(randomUUID()),
      message: '通过 MCP。',
      answers: [],
      sourceAssetIds: [],
    });
    const failed = await runner.waitForCompletion(run.id);
    expect(failed.status).toBe('failed');
    expect(ws.db.repos.workflowIssue.listByRun(run.id)[0]?.status).toBe('resolved');

    // 模拟旧 checkpoint/恢复数据缺少 readiness，迫使 retry 再次评估并重放 resolvedIssueIds。
    ws.db.repos.workflowRun.update(
      run.id,
      { checkpoint: { ...failed.checkpoint, readiness: null } },
      ws.ctx.clock.now(),
    );
    runner.retry(freshProject(ws), run.id);
    const final = await runner.waitForCompletion(run.id);

    expect(final.currentStep).toBe('waiting_approval');
    expect(readinessCalls).toBe(3);
    expect(ws.db.repos.workflowIssue.listByRun(run.id)[0]?.status).toBe('resolved');
  });

  it('blocking Question action 在虚拟预检中转成 before_apply Issue，零领域写入', async () => {
    const ws = makeTestWorkspace();
    const source = addSource(ws);
    const provider = FakeModelProvider.scripted([
      proposal(
        [
          nodeAction('root', 'goal', { roles: ['root'] }),
          nodeAction('scope-question', 'question', { attributes: { blocking: true } }),
        ],
        [contains('root-question', 'root', 'scope-question')],
      ),
      proposal([nodeAction('root', 'goal', { roles: ['root'] })]),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), request(source.id));

    const waiting = await runner.waitForCompletion(run.id);
    expect(waiting.status).toBe('waiting_user');
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(0);
    const issue = ws.db.repos.workflowIssue
      .listByRun(run.id)
      .find((entry) => entry.gate === 'before_apply')!;
    expect(issue).toMatchObject({ kind: 'decision', status: 'open' });

    const wait = ws.db.repos.workflowInteraction.getOpenWait(run.id)!;
    runner.respond(freshProject(ws), run.id, {
      waitId: wait.id,
      clientMessageId: asId(randomUUID()),
      message: '范围限定为软件架构与程序依赖。',
      answers: [],
      sourceAssetIds: [],
    });
    const final = await runner.waitForCompletion(run.id);
    expect(final.currentStep).toBe('waiting_approval');
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(1);
  });

  it('多 contains 父节点不落库，自动修复为单次完整投影', async () => {
    const ws = makeTestWorkspace();
    const source = addSource(ws);
    const broken = proposal(
      [
        nodeAction('root', 'goal', { roles: ['root'] }),
        nodeAction('topic', 'topic'),
        nodeAction('goal', 'goal'),
      ],
      [
        contains('root-topic', 'root', 'topic'),
        contains('root-goal', 'root', 'goal'),
        contains('topic-goal', 'topic', 'goal'),
      ],
    );
    const repaired = proposal(
      [
        nodeAction('root', 'goal', { roles: ['root'] }),
        nodeAction('topic', 'topic'),
        nodeAction('claim', 'claim'),
      ],
      [contains('root-topic', 'root', 'topic'), contains('topic-claim', 'topic', 'claim')],
    );
    const provider = FakeModelProvider.scripted([broken, repaired]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), request(source.id));
    const final = await runner.waitForCompletion(run.id);

    expect(final.currentStep).toBe('waiting_approval');
    const stages = (final.checkpoint['modelCalls'] as Array<{ stage: string }>).map(
      (call) => call.stage,
    );
    expect(stages).toEqual(['initialize_readiness', 'initialize_project', 'initialize_repair_1']);
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(3);
    expect(ws.db.repos.relation.listRelationsByProject(ws.project.id)).toHaveLength(2);
    expect(ws.db.repos.workflowIssue.listByRun(run.id)).toEqual([
      expect.objectContaining({ kind: 'approval', gate: 'before_release', status: 'open' }),
    ]);
  });
});
