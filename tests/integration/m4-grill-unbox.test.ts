import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asId, type StartWorkflowRequest } from '@treediagram/contracts';
import {
  CoreWorkflowRunner,
  DomainError,
  FakeModelProvider,
  GRILL_INSTRUCTIONS,
  UNBOX_INSTRUCTIONS,
  userAuthor,
} from '@treediagram/core';
import {
  freshProject,
  makeTestWorkspace,
  quickNode,
  type TestWorkspace,
} from '../helpers/workspace.js';

/**
 * 发布隔离基线：root 命题 + 托管子树根（无外部语义关系），adopt → 复核 valid → Release 1。
 * 返回 scope 节点（ai_managed 作用域根）。
 */
function publishBaseline(ws: TestWorkspace) {
  const root = quickNode(ws, { roles: ['root'], title: '根命题' });
  const scope = quickNode(ws, { title: '托管子树根' }, root);
  const changeSet = ws.services.changeSets.getLive(freshProject(ws))!;
  ws.services.changeSets.adopt(changeSet.id, userAuthor);
  const { items } = ws.services.changeSets.reviewItems(changeSet.id);
  for (const item of items) {
    if (item.status === 'pending') {
      ws.services.changeSets.resolveReviewItem(item.id, 'valid', '复核通过', userAuthor);
    }
  }
  ws.services.releases.publish(freshProject(ws), changeSet.id, 'Release 1：基线', userAuthor);
  return { root, scope };
}

/** Release 视图中某节点的当前 tip 修订 id。 */
function tipRevisionOf(ws: TestWorkspace, nodeId: string): string {
  const view = ws.services.changeSets.buildReleaseView(freshProject(ws));
  const revision = view.nodeRevisionByNodeId.get(asId(nodeId));
  if (!revision) throw new Error(`节点 ${nodeId} 不在 Release 视图中`);
  return revision.id;
}

/**
 * M4 集成测试（IMPLEMENTATION_DESIGN §13.3/§13.4/§10）：
 * grill 对抗性审查、unbox 边界探索、Evidence 候选、ai_managed 自动 adopt 与越界保护。
 */

function makeRunner(ws: TestWorkspace, provider: FakeModelProvider): CoreWorkflowRunner {
  return new CoreWorkflowRunner(ws.ctx, {
    provider,
    model: 'test-model',
    safetyIdentifier: 'c'.repeat(32),
  });
}

const TYPE_ATTRIBUTES: Record<string, Record<string, unknown> | null> = {
  claim: null,
  topic: null,
  question: { blocking: false },
  risk: { impactNote: null },
  constraint: { strength: 'hard' },
  evidence: {
    evidenceKind: 'thought_experiment',
    sourceAssetId: null,
    method: '逻辑推演',
    premises: ['假设用户只有单人使用'],
    limitations: ['未经过真实环境验证'],
  },
};

function nodeAction(
  ref: string,
  overrides: {
    operation?: 'create' | 'revise';
    logicalNodeId?: string | null;
    baseRevisionId?: string | null;
    nodeType?: keyof typeof TYPE_ATTRIBUTES;
    roles?: string[];
    approvalSuggestion?: string;
  } = {},
) {
  const nodeType = overrides.nodeType ?? 'claim';
  return {
    proposalRef: ref,
    operation: overrides.operation ?? 'create',
    logicalNodeId: overrides.logicalNodeId ?? null,
    baseRevisionId: overrides.baseRevisionId ?? null,
    nodeType,
    displayTitle: `节点 ${ref}`,
    contentText: `内容 ${ref}`,
    roles: overrides.roles ?? [],
    attributes: TYPE_ATTRIBUTES[nodeType],
    approvalSuggestion: overrides.approvalSuggestion ?? 'tentative',
    epistemicState: nodeType === 'claim' ? 'assumed' : null,
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
    workflowType: 'grill',
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

const start = (workflowType: StartWorkflowRequest['workflowType'], targetNodeId: string | null) =>
  ({
    workflowType,
    targetNodeId: asId(targetNodeId ?? crypto.randomUUID()),
    changeSetId: null,
    sourceAssetIds: [],
    focusInstruction: null,
  }) as StartWorkflowRequest;

describe('M4 grill 工作流（§13.3）', () => {
  it('生成审查候选；revise 强制 draft；high reasoning', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const target = quickNode(ws, { title: '被审查分支' });
    const child = quickNode(ws, { title: '既有子节点' }, target);
    const provider = FakeModelProvider.scripted([
      proposal(
        [
          nodeAction('q1', { nodeType: 'question' }),
          nodeAction('e1', { nodeType: 'evidence' }),
          // 模型试图 tentative revise 已确认节点 → 必须被强制 draft
          nodeAction('rev1', {
            operation: 'revise',
            logicalNodeId: child.node.id,
            baseRevisionId: child.revision.id,
            approvalSuggestion: 'tentative',
          }),
        ],
        [
          containsAction(
            'r1',
            { refKind: 'existing_revision', ref: target.revision.id },
            { refKind: 'proposal', ref: 'q1' },
          ),
        ],
      ),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), start('grill', target.node.id));
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.instructions).toBe(GRILL_INSTRUCTIONS);
    expect(provider.calls[0]!.reasoningEffort).toBe('high');
    // 上下文含目标与子树内容
    expect(provider.calls[0]!.input).toContain('被审查分支');
    expect(provider.calls[0]!.input).toContain('既有子节点');
    // revise 被强制 draft
    const summary = final.summary as { warnings: string[]; applied: { nodeRevisionIds: string[] } };
    expect(summary.warnings.some((w) => w.includes('强制降级为 draft'))).toBe(true);
    const revisions = summary.applied.nodeRevisionIds.map((id) =>
      ws.db.repos.node.getRevisionById(id)!,
    );
    const reviseRevision = revisions.find((r) => r.nodeId === child.node.id);
    expect(reviseRevision?.approvalState).toBe('draft');
    // Evidence 候选按 thought_experiment 规则落库（前提/局限完整）
    const evidenceRevision = revisions.find((r) => {
      const node = ws.db.repos.node.getNodeById(r.nodeId);
      return node?.nodeType === 'evidence';
    });
    expect(evidenceRevision).toBeDefined();
    const attrs = evidenceRevision!.attributes as { evidenceKind: string; premises: string[] };
    expect(attrs.evidenceKind).toBe('thought_experiment');
    expect(attrs.premises.length).toBeGreaterThan(0);
  });

  it('grill 在 initializing 状态不可用', () => {
    const ws = makeTestWorkspace(); // 默认 initializing
    const runner = makeRunner(ws, FakeModelProvider.scripted([]));
    const target = quickNode(ws);
    try {
      runner.start(freshProject(ws), start('grill', target.node.id));
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('WORKFLOW_NOT_AVAILABLE');
    }
  });
});

describe('M4 unbox 工作流（§13.4）', () => {
  it('创建 unbox_exploration 容器；输出挂容器下；root 角色被剥离；不自动 adopt', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const root = quickNode(ws, { nodeType: 'goal', roles: ['root'], title: '根目标' });
    quickNode(ws, { nodeType: 'constraint', title: '非根约束' }, root);
    // 动态 responder：从上下文中取容器 revisionId 挂载点
    const provider = new FakeModelProvider((req) => {
      const ctx = JSON.parse(req.input) as {
        data: { container: { revisionId: string }; constraints: unknown[] };
      };
      expect(ctx.data.constraints.length).toBe(1); // 非 root 约束进入上下文
      return proposal(
        [
          nodeAction('alt1', { roles: ['root'], approvalSuggestion: 'ai_confirmed' }),
          nodeAction('alt2'),
        ],
        [
          containsAction(
            'r1',
            { refKind: 'existing_revision', ref: ctx.data.container.revisionId },
            { refKind: 'proposal', ref: 'alt1' },
          ),
        ],
        { workflowType: 'unbox' },
      );
    });
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), {
      workflowType: 'unbox',
      targetNodeId: null,
      changeSetId: null,
      sourceAssetIds: [],
      focusInstruction: '如果没有单机约束会怎样',
    });
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(provider.calls[0]!.instructions).toBe(UNBOX_INSTRUCTIONS);
    expect(provider.calls[0]!.reasoningEffort).toBe('high');
    // 容器候选已创建
    const allNodes = ws.db.repos.node.listNodesByProject(ws.project.id);
    const containerNode = allNodes.find((n) =>
      ws.db.repos.node.listRevisionsByNode(n.id)[0]?.roles.includes('unbox_exploration'),
    );
    expect(containerNode).toBeDefined();
    const containerRevision = ws.db.repos.node.listRevisionsByNode(containerNode!.id)[0]!;
    expect(containerRevision.approvalState).toBe('draft');
    // 模型输出的 root 角色被剥离；ai_confirmed 被降级（无 policy）
    const summary = final.summary as {
      warnings: string[];
      applied: { nodeRevisionIds: string[] };
      autoAdopted: boolean;
    };
    expect(summary.warnings.some((w) => w.includes('root 角色'))).toBe(true);
    expect(summary.autoAdopted).toBe(false);
    const appliedRevisions = summary.applied.nodeRevisionIds.map((id) =>
      ws.db.repos.node.getRevisionById(id)!,
    );
    for (const revision of appliedRevisions) {
      expect(revision.roles).not.toContain('root');
      expect(['draft', 'tentative']).toContain(revision.approvalState);
    }
    // unbox 绝不自动 adopt：ChangeSet 仍 open，project 仍 consistent
    expect(ws.services.changeSets.getLive(freshProject(ws))?.status).toBe('open');
    expect(freshProject(ws).status).toBe('consistent');
  });

  it('需要澄清时不提前创建探索容器，回答后与最终提案原子写入', async () => {
    const ws = makeTestWorkspace();
    setConsistent(ws);
    const root = quickNode(ws, { nodeType: 'goal', roles: ['root'], title: '根目标' });
    quickNode(ws, { nodeType: 'constraint', title: '非根约束' }, root);
    let call = 0;
    const provider = new FakeModelProvider((req) => {
      call += 1;
      if (call === 1) {
        return proposal([], [], {
          workflowType: 'unbox',
          summary: '需要确认可放宽的边界',
          questionsForUser: [
            { question: '允许放宽单机约束吗？', blocking: true, relatedProposalRefs: [] },
          ],
          stopReason: 'needs_user',
        });
      }
      const context = JSON.parse(req.input) as { data: { container: { revisionId: string } } };
      return proposal(
        [nodeAction('alt1')],
        [
          containsAction(
            'r1',
            { refKind: 'existing_revision', ref: context.data.container.revisionId },
            { refKind: 'proposal', ref: 'alt1' },
          ),
        ],
        { workflowType: 'unbox' },
      );
    });
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), {
      workflowType: 'unbox',
      targetNodeId: null,
      changeSetId: null,
      sourceAssetIds: [],
      focusInstruction: null,
    });
    const waiting = await runner.waitForCompletion(run.id);
    expect(waiting.status).toBe('waiting_user');
    expect(
      ws.db.repos.node
        .listNodesByProject(ws.project.id)
        .some((node) =>
          ws.db.repos.node.listRevisionsByNode(node.id)[0]?.roles.includes('unbox_exploration'),
        ),
    ).toBe(false);

    const wait = ws.db.repos.workflowInteraction.getOpenWait(run.id)!;
    runner.respond(freshProject(ws), run.id, {
      waitId: wait.id,
      clientMessageId: asId(randomUUID()),
      message: '允许，但必须保留离线回退路径。',
      answers: [],
      sourceAssetIds: [],
    });
    const final = await runner.waitForCompletion(run.id);
    expect(final.status).toBe('succeeded');
    expect(provider.calls[1]!.input).toContain('保留离线回退路径');
    const container = ws.db.repos.node
      .listNodesByProject(ws.project.id)
      .find((node) =>
        ws.db.repos.node.listRevisionsByNode(node.id)[0]?.roles.includes('unbox_exploration'),
      );
    expect(container).toBeDefined();
  });

  it('unbox 在 initializing 状态不可用', () => {
    const ws = makeTestWorkspace();
    const runner = makeRunner(ws, FakeModelProvider.scripted([]));
    try {
      runner.start(freshProject(ws), {
        workflowType: 'unbox',
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

describe('M4 ai_managed 自动 adopt（§10）', () => {
  it('影响闭包在托管子树内：derive 完成后自动 adopt', async () => {
    const ws = makeTestWorkspace();
    const { scope } = publishBaseline(ws); // Release 1 已发布，project=consistent
    const scopeTip = tipRevisionOf(ws, scope.node.id);
    ws.services.delegations.setPolicy(freshProject(ws), scope.node.id, 'ai_managed', userAuthor);
    const provider = FakeModelProvider.scripted([
      proposal(
        [nodeAction('auto1', { approvalSuggestion: 'ai_confirmed' })],
        [
          containsAction(
            'r1',
            { refKind: 'existing_revision', ref: scopeTip },
            { refKind: 'proposal', ref: 'auto1' },
          ),
        ],
        { workflowType: 'derive' },
      ),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), start('derive', scope.node.id));
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    const summary = final.summary as {
      autoAdopted: boolean;
      autoAdoptBlocked: string | null;
      applied: { nodeRevisionIds: string[] };
    };
    expect(summary.autoAdopted).toBe(true);
    expect(summary.autoAdoptBlocked).toBeNull();
    // ai_confirmed 保留并绑定授权
    const revision = ws.db.repos.node.getRevisionById(summary.applied.nodeRevisionIds[0]!)!;
    expect(revision.approvalState).toBe('ai_confirmed');
    expect(revision.authorization).not.toBeNull();
    // adopt 生效：project 进入 reevaluating，live ChangeSet 进入 reevaluating
    expect(freshProject(ws).status).toBe('reevaluating');
    expect(ws.services.changeSets.getLive(freshProject(ws))?.status).toBe('reevaluating');
  });

  it('影响闭包越出托管子树：转 waiting_user 请求用户', async () => {
    const ws = makeTestWorkspace();
    const { root, scope } = publishBaseline(ws);
    const outsiderTip = tipRevisionOf(ws, root.node.id); // 托管子树外（scope 的父）
    ws.services.delegations.setPolicy(freshProject(ws), scope.node.id, 'ai_managed', userAuthor);
    const provider = FakeModelProvider.scripted([
      proposal(
        [nodeAction('escape1')],
        [
          // 挂到作用域外节点下 → 影响闭包越界
          containsAction(
            'r1',
            { refKind: 'existing_revision', ref: outsiderTip },
            { refKind: 'proposal', ref: 'escape1' },
          ),
        ],
        { workflowType: 'derive' },
      ),
    ]);
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), start('derive', scope.node.id));
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('waiting_user');
    const summary = final.summary as { autoAdopted: boolean; autoAdoptBlocked: string | null };
    expect(summary.autoAdopted).toBe(false);
    expect(summary.autoAdoptBlocked).toContain('越出托管子树');
    // 候选保留在 open ChangeSet 等待用户裁决；project 未进入 reevaluating
    expect(ws.services.changeSets.getLive(freshProject(ws))?.status).toBe('open');
    expect(freshProject(ws).status).toBe('consistent');
  });
});
