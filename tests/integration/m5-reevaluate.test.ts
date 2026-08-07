import { describe, expect, it } from 'vitest';
import { asId, type ReviewItem, type StartWorkflowRequest } from '@treediagram/contracts';
import { CoreWorkflowRunner, DomainError, FakeModelProvider, userAuthor } from '@treediagram/core';
import {
  freshProject,
  makeTestWorkspace,
  quickNode,
  type TestWorkspace,
} from '../helpers/workspace.js';

/**
 * M5 reevaluate 工作流集成测试（§13.5/§12.5/§9.3）：
 * 批次裁决（valid+迁移/revise/unknown）、覆盖校验、断点续跑、可用性。
 */

function makeRunner(ws: TestWorkspace, provider: FakeModelProvider): CoreWorkflowRunner {
  return new CoreWorkflowRunner(ws.ctx, {
    provider,
    model: 'test-model',
    safetyIdentifier: 'd'.repeat(32),
  });
}

interface Baseline {
  rootId: string;
  aId: string;
  bId: string;
}

/** Release 1 基线：root → A、root → B，A depends_on B。 */
function publishBaseline(ws: TestWorkspace): Baseline {
  const root = quickNode(ws, { roles: ['root'], title: '根命题' });
  const a = quickNode(ws, { title: '节点 A' }, root);
  const b = quickNode(ws, { title: '节点 B' }, root);
  ws.services.relations.createCandidateRelation(
    freshProject(ws),
    'depends_on',
    {
      fromNodeRevisionId: a.revision.id,
      toNodeRevisionId: b.revision.id,
      rationaleText: 'A 依赖 B',
      attributes: {},
      approvalState: 'user_confirmed',
    },
    userAuthor,
  );
  const changeSet = ws.services.changeSets.getLive(freshProject(ws))!;
  ws.services.changeSets.adopt(changeSet.id, userAuthor);
  const { items } = ws.services.changeSets.reviewItems(changeSet.id);
  for (const it of items) {
    if (it.status === 'pending') {
      ws.services.changeSets.resolveReviewItem(it.id, 'valid', '复核通过', userAuthor);
    }
  }
  ws.services.releases.publish(freshProject(ws), changeSet.id, 'Release 1', userAuthor);
  return { rootId: root.node.id, aId: a.node.id, bId: b.node.id };
}

function tipRevisionOf(ws: TestWorkspace, nodeId: string): string {
  const view = ws.services.changeSets.buildReleaseView(freshProject(ws));
  const revision = view.nodeRevisionByNodeId.get(asId(nodeId));
  if (!revision) throw new Error(`节点 ${nodeId} 无 tip`);
  return revision.id;
}

/** 用户修订 A → adopt → 产生 pending review items（两条关系端点失效）。 */
function adoptRevisionOfA(
  ws: TestWorkspace,
  base: Baseline,
): { oldARevisionId: string; newARevisionId: string } {
  const tip = tipRevisionOf(ws, base.aId);
  const revised = ws.services.nodes.reviseCandidateNode(
    freshProject(ws),
    base.aId,
    tip,
    {
      displayTitle: '节点 A（修订）',
      contentText: '修订后的内容',
      roles: [],
      attributes: {},
      approvalState: 'user_confirmed',
      epistemicState: null,
    },
    userAuthor,
  );
  const changeSet = ws.services.changeSets.getLive(freshProject(ws))!;
  ws.services.changeSets.adopt(changeSet.id, userAuthor);
  return { oldARevisionId: tip, newARevisionId: revised.revision.id };
}

const reevaluateRequest = (changeSetId: string | null): StartWorkflowRequest => ({
  workflowType: 'reevaluate',
  targetNodeId: null,
  changeSetId: asId(changeSetId ?? crypto.randomUUID()),
  sourceAssetIds: [],
  focusInstruction: null,
});

function pendingItems(ws: TestWorkspace, changeSetId: string): ReviewItem[] {
  return ws.db.repos.reviewItem.listByChangeSet(asId(changeSetId), ['pending']);
}

/**
 * 构造一批次结果：node item 一律 valid；relation item valid + 端点迁移
 * （oldARevisionId → newARevisionId，relationType 保持原类型）。
 * 从上下文动态取 reviewItemId 与 relationId。
 */
function allValidWithMigration(input: string, oldARevisionId: string, newARevisionId: string) {
  const ctx = JSON.parse(input) as {
    data: {
      items: Array<{
        reviewItemId: string;
        entityKind: string;
        entity: {
          relationId?: string;
          revisionId?: string;
          relationType?: string;
          fromRevisionId?: string;
          toRevisionId?: string;
        } | null;
      }>;
    };
  };
  const migrate = (ref: string | undefined) =>
    ref === oldARevisionId ? newARevisionId : (ref ?? oldARevisionId);
  const results: unknown[] = [];
  const relationActions: unknown[] = [];
  for (const item of ctx.data.items) {
    if (item.entityKind === 'relation_revision' && item.entity?.relationId) {
      const ref = `mig-${item.reviewItemId.slice(0, 8)}`;
      relationActions.push({
        proposalRef: ref,
        operation: 'revise',
        logicalRelationId: item.entity.relationId,
        baseRelationRevisionId: item.entity.revisionId,
        relationType: item.entity.relationType,
        from: { refKind: 'existing_revision', ref: migrate(item.entity.fromRevisionId) },
        to: { refKind: 'existing_revision', ref: migrate(item.entity.toRevisionId) },
        rationale: '端点迁移到新修订',
        attributes: {},
        approvalSuggestion: 'tentative',
      });
      results.push({
        reviewItemId: item.reviewItemId,
        verdict: 'valid',
        rationale: '关系仍成立，显式迁移端点',
        replacementProposalRef: null,
        relationMigrationProposalRefs: [ref],
      });
    } else {
      results.push({
        reviewItemId: item.reviewItemId,
        verdict: 'valid',
        rationale: '内容仍成立',
        replacementProposalRef: null,
        relationMigrationProposalRefs: [],
      });
    }
  }
  return {
    schemaVersion: 1,
    summary: '全部 valid 并迁移关系端点',
    results,
    nodeActions: [],
    relationActions,
    questionsForUser: [],
    stopReason: 'completed',
  };
}

describe('M5 reevaluate 工作流（§13.5）', () => {
  it('全 valid + 关系端点迁移 → ChangeSet ready → 可发布 Release 2', async () => {
    const ws = makeTestWorkspace();
    const base = publishBaseline(ws);
    const { oldARevisionId, newARevisionId } = adoptRevisionOfA(ws, base);
    const changeSet = ws.services.changeSets.getLive(freshProject(ws))!;
    expect(changeSet.status).toBe('reevaluating');
    const items = pendingItems(ws, changeSet.id);
    // A 节点 + 端点失效的 contains/depends_on 关系 + 受影响端点节点（闭包）
    expect(items.length).toBeGreaterThanOrEqual(3);

    const provider = new FakeModelProvider((req) =>
      allValidWithMigration(req.input, oldARevisionId, newARevisionId),
    );
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), reevaluateRequest(changeSet.id));
    const final = await runner.waitForCompletion(run.id);

    expect(final.status).toBe('succeeded');
    expect(final.changeSetId).toBe(changeSet.id);
    const summary = final.summary as { changeSetStatus: string; batchCount: number };
    expect(summary.changeSetStatus).toBe('ready');
    expect(summary.batchCount).toBe(1); // 3 项同批
    // 关系已显式迁移（不静默）：contains/depends_on 都有新修订指向新 A 修订
    const { items: resolved } = ws.services.changeSets.reviewItems(changeSet.id);
    expect(resolved.every((i) => i.status === 'resolved')).toBe(true);
    // publish Release 2（独立 service 操作）
    const release2 = ws.services.releases.publish(
      freshProject(ws),
      changeSet.id,
      'Release 2',
      userAuthor,
    );
    expect(release2.version).toBe(2);
    expect(release2.nodeRevisionIds).toContain(newARevisionId);
  });

  it('unknown → item blocked → run waiting_user；用户裁决后 resume → succeeded', async () => {
    const ws = makeTestWorkspace();
    const base = publishBaseline(ws);
    const { oldARevisionId, newARevisionId } = adoptRevisionOfA(ws, base);
    const changeSet = ws.services.changeSets.getLive(freshProject(ws))!;
    const provider = new FakeModelProvider((req) => {
      const result = allValidWithMigration(req.input, oldARevisionId, newARevisionId);
      // 节点 item（被修订的 A）无法判断 → unknown
      const entry = (result.results as Array<{ reviewItemId: string; verdict: string }>).find(
        (r) => {
          const ctx = JSON.parse(req.input) as {
            data: { items: Array<{ reviewItemId: string; entityKind: string }> };
          };
          return (
            ctx.data.items.find((i) => i.reviewItemId === r.reviewItemId)?.entityKind ===
            'node_revision'
          );
        },
      );
      // 只把一个节点 item 置 unknown（其余节点项保持 valid）
      if (entry) entry.verdict = 'unknown';
      return result;
    });
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), reevaluateRequest(changeSet.id));
    const waiting = await runner.waitForCompletion(run.id);
    expect(waiting.status).toBe('waiting_user');
    const counts = ws.db.repos.reviewItem.countsByChangeSet(changeSet.id);
    expect(counts.blocked).toBe(1);

    // 用户对 blocked item 给出裁决（blocked → resolved 需用户/授权 AI verdict）
    const { items } = ws.services.changeSets.reviewItems(changeSet.id);
    const blocked = items.find((i) => i.status === 'blocked')!;
    ws.services.changeSets.resolveReviewItem(blocked.id, 'valid', '用户确认仍成立', userAuthor);

    runner.resume(freshProject(ws), run.id);
    const final = await runner.waitForCompletion(run.id);
    expect(final.status).toBe('succeeded');
  });

  it('批次结果缺少裁决 → failed(MODEL_OUTPUT_INVALID)；resume 重新生成后成功', async () => {
    const ws = makeTestWorkspace();
    const base = publishBaseline(ws);
    const { oldARevisionId, newARevisionId } = adoptRevisionOfA(ws, base);
    const changeSet = ws.services.changeSets.getLive(freshProject(ws))!;
    let call = 0;
    const provider = new FakeModelProvider((req) => {
      call += 1;
      const result = allValidWithMigration(req.input, oldARevisionId, newARevisionId);
      if (call === 1) {
        // 第一次：丢掉一个裁决 → 覆盖校验失败
        (result.results as unknown[]).pop();
        result.relationActions = [];
      }
      return result;
    });
    const runner = makeRunner(ws, provider);
    const run = runner.start(freshProject(ws), reevaluateRequest(changeSet.id));
    const failed = await runner.waitForCompletion(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('MODEL_OUTPUT_INVALID');
    // 未写入任何候选（校验在 apply 之前）
    expect(
      ws.services.changeSets.reviewItems(changeSet.id).items.every((i) => i.status === 'pending'),
    ).toBe(true);

    runner.resume(freshProject(ws), run.id);
    const final = await runner.waitForCompletion(run.id);
    expect(final.status).toBe('succeeded');
    expect(call).toBe(2);
  });

  it('consistent 状态下不可用', () => {
    const ws = makeTestWorkspace();
    publishBaseline(ws); // consistent，无 live ChangeSet
    const runner = makeRunner(ws, FakeModelProvider.scripted([]));
    try {
      runner.start(freshProject(ws), reevaluateRequest(null));
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('WORKFLOW_NOT_AVAILABLE');
    }
  });
});
