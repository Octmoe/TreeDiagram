import { describe, expect, it } from 'vitest';
import { asId, type StartWorkflowRequest } from '@treediagram/contracts';
import {
  CoreWorkflowRunner,
  DERIVE_INSTRUCTIONS,
  FakeModelProvider,
  GRILL_INSTRUCTIONS,
  INITIALIZE_INSTRUCTIONS,
  REEVALUATE_INSTRUCTIONS,
  UNBOX_INSTRUCTIONS,
  userAuthor,
} from '@treediagram/core';
import { freshProject, makeTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * M5 贯穿验收（V1_SPEC §15）：dogfooding 项目「给 AI Agent 使用的程序化建模工具集」。
 * 单个用例按 11 步走完：Initialize → 用户确认根部发布 Release 1 → Derive → Grill →
 * ai_managed 局部决策 → Unbox → 用户修订已确认根 → adopt 触发 design.invalidated →
 * Re-evaluate 全树复核并迁移关系 → 发布 Release 2 → 事件 cursor + Decision 查询。
 * 全程通过服务/工作流 API 完成，不直接编辑数据库（§16.1）。
 */

const LIMIT = { limit: 100, cursor: null } as const;
const NO_FILTER = { type: null, role: null, approval: null, epistemic: null, text: null };

function makeRunner(ws: TestWorkspace, provider: FakeModelProvider): CoreWorkflowRunner {
  return new CoreWorkflowRunner(ws.ctx, {
    provider,
    model: 'test-model',
    safetyIdentifier: 'e'.repeat(32),
  });
}

const request = (partial: Partial<StartWorkflowRequest>): StartWorkflowRequest =>
  ({
    workflowType: 'derive',
    targetNodeId: null,
    changeSetId: null,
    sourceAssetIds: [],
    focusInstruction: null,
    ...partial,
  }) as StartWorkflowRequest;

// ---- 模型提案构造 ----

function nodeAction(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    proposalRef: ref,
    operation: 'create',
    logicalNodeId: null,
    baseRevisionId: null,
    nodeType: 'claim',
    displayTitle: `节点 ${ref}`,
    contentText: `内容 ${ref}`,
    roles: [],
    attributes: null,
    approvalSuggestion: 'tentative',
    epistemicState: null,
    rationale: '测试 rationale',
    ...overrides,
  };
}

function relationAction(ref: string, relationType: string, from: unknown, to: unknown, extra = {}) {
  return {
    proposalRef: ref,
    operation: 'create',
    logicalRelationId: null,
    baseRelationRevisionId: null,
    relationType,
    from,
    to,
    rationale: `${relationType} rationale`,
    attributes: null,
    approvalSuggestion: 'tentative',
    ...extra,
  };
}

const proposalRef = (ref: string) => ({ refKind: 'proposal', ref });
const existingRef = (revisionId: string) => ({ refKind: 'existing_revision', ref: revisionId });

function proposal(workflowType: string, nodeActions: unknown[], relationActions: unknown[]) {
  return {
    schemaVersion: 1,
    workflowType,
    summary: '验收提案',
    nodeActions,
    relationActions,
    questionsForUser: [],
    warnings: [],
    stopReason: 'completed',
  };
}

interface CtxNode {
  nodeId: string;
  revisionId: string;
  nodeType: string;
  displayTitle: string;
  roles: string[];
}

/** reevaluate 响应：全部 valid；端点引用 oldRootRevisionId 的关系显式迁移到 newRootRevisionId。 */
function reevaluationResponse(input: string, oldRootRevisionId: string, newRootRevisionId: string) {
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
    ref === oldRootRevisionId ? newRootRevisionId : (ref ?? oldRootRevisionId);
  const results: unknown[] = [];
  const relationActions: unknown[] = [];
  for (const item of ctx.data.items) {
    if (item.entityKind === 'relation_revision' && item.entity?.relationId) {
      const stale =
        item.entity.fromRevisionId === oldRootRevisionId ||
        item.entity.toRevisionId === oldRootRevisionId;
      if (stale) {
        const ref = `mig-${item.reviewItemId.slice(0, 8)}`;
        relationActions.push({
          proposalRef: ref,
          operation: 'revise',
          logicalRelationId: item.entity.relationId,
          baseRelationRevisionId: item.entity.revisionId,
          relationType: item.entity.relationType,
          from: existingRef(migrate(item.entity.fromRevisionId)),
          to: existingRef(migrate(item.entity.toRevisionId)),
          rationale: '端点显式迁移到根新修订',
          attributes: item.entity.relationType === 'contradicts' ? { blocking: false } : null,
          approvalSuggestion: 'tentative',
        });
        results.push({
          reviewItemId: item.reviewItemId,
          verdict: 'valid',
          rationale: '关系仍成立，显式迁移端点',
          replacementProposalRef: null,
          relationMigrationProposalRefs: [ref],
        });
        continue;
      }
    }
    results.push({
      reviewItemId: item.reviewItemId,
      verdict: 'valid',
      rationale: '内容仍成立',
      replacementProposalRef: null,
      relationMigrationProposalRefs: [],
    });
  }
  return {
    schemaVersion: 1,
    summary: '全树复核：全部 valid，失效端点已显式迁移',
    results,
    nodeActions: [],
    relationActions,
    questionsForUser: [],
    stopReason: 'completed',
  };
}

describe('M5 贯穿验收（V1_SPEC §15）', () => {
  it('11 步 dogfooding 场景从头到尾完成', async () => {
    const ws = makeTestWorkspace('dogfooding');

    // ---- 步骤 1：用户粘贴混合初始描述 ----
    const source = ws.services.sources.addSource(
      ws.project.id,
      {
        kind: 'markdown',
        originalName: 'vision.md',
        mediaType: 'text/markdown',
        contentText:
          '目标：给 AI Agent 用的程序化建模工具集。偏好 TypeScript 与本地单机。' +
          '方案细节：不可变修订、显式关系、Release 快照。',
      },
      userAuthor,
    );

    // ---- 模型分派器：按 instructions 路由到各阶段响应 ----
    const state = { oldRootRevisionId: '', newRootRevisionId: '' };
    const provider = new FakeModelProvider((req) => {
      const ctx = JSON.parse(req.input) as {
        data: {
          target?: CtxNode | null;
          subtree?: CtxNode[];
          container?: { revisionId: string };
        };
      };
      switch (req.instructions) {
        case INITIALIZE_INSTRUCTIONS:
          // 步骤 2：就绪后一次投影 root、Assumption 与序列化分支
          return proposal(
            'initialize',
            [
              nodeAction('root', {
                nodeType: 'goal',
                displayTitle: '为 AI Agent 提供程序化建模工具集',
                contentText: '根部目标命题（待用户确认）。',
                roles: ['root'],
                attributes: { priorityNote: null },
              }),
              nodeAction('asm', {
                displayTitle: '假设：使用 TypeScript 并本地单机运行',
                contentText: '用户偏好但未确认的技术细节，保留为 Assumption。',
                epistemicState: 'assumed',
              }),
              nodeAction('branch', {
                nodeType: 'topic',
                displayTitle: '序列化细节分支',
                contentText: '承载序列化格式的局部决策。',
              }),
            ],
            [
              relationAction('c-asm', 'contains', proposalRef('root'), proposalRef('asm')),
              relationAction('c-branch', 'contains', proposalRef('root'), proposalRef('branch')),
            ],
          );
        case DERIVE_INSTRUCTIONS: {
          const target = ctx.data.target!;
          if (target.displayTitle === '序列化细节分支') {
            // 步骤 6：托管分支内的局部决策（ai_confirmed）
            return proposal(
              'derive',
              [
                nodeAction('d2', {
                  nodeType: 'decision',
                  displayTitle: '局部决策：序列化采用不可变修订追加格式',
                  contentText: '在托管分支内由 Agent 完成的局部决策。',
                  attributes: {
                    importance: 'simple',
                    noAlternativeFound: false,
                    alternativeSearchNote: null,
                  },
                  approvalSuggestion: 'ai_confirmed',
                }),
              ],
              [
                relationAction(
                  'c-d2',
                  'contains',
                  existingRef(target.revisionId),
                  proposalRef('d2'),
                  { approvalSuggestion: 'ai_confirmed' },
                ),
              ],
            );
          }
          // 步骤 4：两个 Option + 一个重要 Decision + 证据
          return proposal(
            'derive',
            [
              nodeAction('q1', {
                nodeType: 'question',
                displayTitle: '模型表示方式：文档树还是属性图？',
                contentText: '决定内核模型表示方式。',
                attributes: { blocking: false },
              }),
              nodeAction('optA', { nodeType: 'option', displayTitle: '文档树' }),
              nodeAction('optB', { nodeType: 'option', displayTitle: '属性图' }),
              nodeAction('d1', {
                nodeType: 'decision',
                displayTitle: '选择模型表示方式',
                contentText: '重要决策：选择文档树作为内核表示。',
                attributes: {
                  importance: 'important',
                  noAlternativeFound: false,
                  alternativeSearchNote: null,
                },
              }),
              nodeAction('e1', {
                nodeType: 'evidence',
                displayTitle: '单机建模经验推演',
                contentText: '单人场景下文档树的冲突面更小。',
                attributes: {
                  evidenceKind: 'thought_experiment',
                  sourceAssetId: null,
                  method: '逻辑推演',
                  premises: ['单用户本地工作区'],
                  limitations: ['未经过真实环境验证'],
                },
              }),
            ],
            [
              relationAction('c-q1', 'contains', existingRef(target.revisionId), proposalRef('q1')),
              relationAction(
                'c-oa',
                'contains',
                existingRef(target.revisionId),
                proposalRef('optA'),
              ),
              relationAction(
                'c-ob',
                'contains',
                existingRef(target.revisionId),
                proposalRef('optB'),
              ),
              relationAction('c-d1', 'contains', existingRef(target.revisionId), proposalRef('d1')),
              relationAction('c-e1', 'contains', proposalRef('d1'), proposalRef('e1')),
              relationAction('a-q1', 'addresses', proposalRef('d1'), proposalRef('q1')),
              relationAction('s-oa', 'selects', proposalRef('d1'), proposalRef('optA')),
              relationAction('r-ob', 'rejects', proposalRef('d1'), proposalRef('optB')),
            ],
          );
        }
        case GRILL_INSTRUCTIONS: {
          // 步骤 5：证据不足点 + 遗漏风险 + 跨分支张力
          const subtree = ctx.data.subtree ?? [];
          const optA = subtree.find((n) => n.displayTitle === '文档树')!;
          const optB = subtree.find((n) => n.displayTitle === '属性图')!;
          const rootRev = ctx.data.target!.revisionId;
          return proposal(
            'grill',
            [
              nodeAction('q2', {
                nodeType: 'question',
                displayTitle: '证据不足：文档树方案缺少并发冲突证据',
                contentText: '需要真实多会话写入数据支撑。',
                attributes: { blocking: false },
              }),
              nodeAction('r1', {
                nodeType: 'risk',
                displayTitle: '遗漏风险：万级节点下树渲染性能未验证',
                contentText: '大规模工作区的交互性能未知。',
                attributes: { impactNote: null },
              }),
            ],
            [
              relationAction('c-q2', 'contains', existingRef(rootRev), proposalRef('q2')),
              relationAction('c-r1', 'contains', existingRef(rootRev), proposalRef('r1')),
              relationAction(
                'x-ab',
                'contradicts',
                existingRef(optA.revisionId),
                existingRef(optB.revisionId),
                {
                  attributes: { blocking: false },
                },
              ),
            ],
          );
        }
        case UNBOX_INSTRUCTIONS:
          // 步骤 7：不同系统边界的替代方向
          return proposal(
            'unbox',
            [
              nodeAction('alt1', {
                displayTitle: '替代方向：云端多租户 SaaS 建模服务',
                contentText: '跳出单机约束的平行候选。',
                epistemicState: 'assumed',
              }),
            ],
            [
              relationAction(
                'c-alt1',
                'contains',
                existingRef(ctx.data.container!.revisionId),
                proposalRef('alt1'),
              ),
            ],
          );
        case REEVALUATE_INSTRUCTIONS:
          // 步骤 10：全树复核，失效端点显式迁移
          return reevaluationResponse(req.input, state.oldRootRevisionId, state.newRootRevisionId);
        default:
          throw new Error(`未预期的模型调用: ${req.outputSchemaName}`);
      }
    });
    const runner = makeRunner(ws, provider);

    // ---- 步骤 2：Initialize ----
    const initRun = runner.start(
      freshProject(ws),
      request({ workflowType: 'initialize', sourceAssetIds: [source.id] }),
    );
    expect((await runner.waitForCompletion(initRun.id)).currentStep).toBe('waiting_approval');

    // 根部候选与 Assumption 已落库（tentative / assumed）
    const workingNodes = () =>
      ws.services.queries.queryNodes(freshProject(ws), 'working', { ...NO_FILTER, ...LIMIT }).nodes;
    const rootDetail = () => workingNodes().find((d) => d.revision.roles.includes('root'))!;
    const branchDetail = () =>
      workingNodes().find((d) => d.revision.displayTitle === '序列化细节分支')!;
    expect(rootDetail().revision.approvalState).toBe('tentative');
    expect(workingNodes().find((d) => d.revision.epistemicState === 'assumed')).toBeDefined();

    // ---- 步骤 3：用户确认根部 → adopt → Re-evaluate 显式迁移 → 发布 Release 1 ----
    const root = rootDetail();
    const confirmedRoot = ws.services.nodes.reviseCandidateNode(
      freshProject(ws),
      root.node.id,
      root.revision.id,
      {
        displayTitle: root.revision.displayTitle,
        contentText: '确认：为 AI Agent 提供程序化建模工具集。',
        roles: ['root'],
        attributes: { priorityNote: null },
        approvalState: 'user_confirmed',
        epistemicState: null,
      },
      userAuthor,
    );
    // 根修订使 contains 端点失效：必须经 reevaluate 显式迁移（禁止静默迁移）
    state.oldRootRevisionId = root.revision.id;
    state.newRootRevisionId = confirmedRoot.revision.id;
    runner.resume(freshProject(ws), initRun.id);
    expect((await runner.waitForCompletion(initRun.id)).status).toBe('succeeded');
    const cs1 = ws.services.changeSets.getLive(freshProject(ws))!;
    ws.services.changeSets.adopt(cs1.id, userAuthor);
    const reevalRun1 = runner.start(
      freshProject(ws),
      request({ workflowType: 'reevaluate', changeSetId: asId(cs1.id) }),
    );
    expect((await runner.waitForCompletion(reevalRun1.id)).status).toBe('succeeded');
    const release1 = ws.services.releases.publish(
      freshProject(ws),
      cs1.id,
      'Release 1',
      userAuthor,
    );
    expect(release1.version).toBe(1);
    expect(freshProject(ws).status).toBe('consistent');

    // ---- 步骤 4：Derive 生成 2 Option + 1 重要 Decision ----
    const deriveRun = runner.start(
      freshProject(ws),
      request({ workflowType: 'derive', targetNodeId: asId(root.node.id) }),
    );
    expect((await runner.waitForCompletion(deriveRun.id)).status).toBe('succeeded');
    const titles = () => workingNodes().map((d) => d.revision.displayTitle);
    expect(titles()).toEqual(expect.arrayContaining(['文档树', '属性图', '选择模型表示方式']));

    // ---- 步骤 5：Grill 找出证据不足点、遗漏风险、跨分支张力 ----
    const grillRun = runner.start(
      freshProject(ws),
      request({ workflowType: 'grill', targetNodeId: asId(root.node.id) }),
    );
    expect((await runner.waitForCompletion(grillRun.id)).status).toBe('succeeded');
    expect(titles()).toEqual(
      expect.arrayContaining([
        '证据不足：文档树方案缺少并发冲突证据',
        '遗漏风险：万级节点下树渲染性能未验证',
      ]),
    );
    const workingView = () => ws.services.queries.resolveView(freshProject(ws), 'working');
    expect(
      [...workingView().relationById.values()].some((r) => r.relationType === 'contradicts'),
    ).toBe(true);

    // ---- 步骤 6：序列化分支设 ai_managed，Agent 完成局部决策 ----
    const policy = ws.services.delegations.setPolicy(
      freshProject(ws),
      branchDetail().node.id,
      'ai_managed',
      userAuthor,
    );
    const localRun = runner.start(
      freshProject(ws),
      request({ workflowType: 'derive', targetNodeId: asId(branchDetail().node.id) }),
    );
    const localFinal = await runner.waitForCompletion(localRun.id);
    // 工作区中尚有步骤 4/5 的未复核候选（在托管子树外），自动 adopt 被闸门拦下；
    // 局部决策本身已按授权以 ai_confirmed 落库，等待用户统一 adopt（步骤 9）。
    expect(localFinal.status).toBe('waiting_user');
    const localSummary = localFinal.summary as {
      autoAdopted: boolean;
      autoAdoptBlocked: string | null;
      applied: { nodeRevisionIds: string[] };
    };
    expect(localSummary.autoAdopted).toBe(false);
    expect(localSummary.autoAdoptBlocked).toContain('越出托管子树');
    const d2Revision = ws.db.repos.node.getRevisionById(localSummary.applied.nodeRevisionIds[0]!)!;
    expect(d2Revision.approvalState).toBe('ai_confirmed');
    expect(d2Revision.authorization?.policyId).toBe(policy.id);
    expect(freshProject(ws).status).toBe('consistent');
    // 用户知晓自动 adopt 被拦后选择手动接管：取消等待中的 run（候选保留，步骤 9 统一 adopt）
    runner.cancel(freshProject(ws), localRun.id);

    // ---- 步骤 7：Unbox 生成不同系统边界的替代方向 ----
    const unboxRun = runner.start(
      freshProject(ws),
      request({
        workflowType: 'unbox',
        focusInstruction: '如果运行环境从单机变为云端多租户会怎样',
      }),
    );
    expect((await runner.waitForCompletion(unboxRun.id)).status).toBe('succeeded');
    expect(workingNodes().some((d) => d.revision.roles.includes('unbox_exploration'))).toBe(true);
    expect(titles()).toContain('替代方向：云端多租户 SaaS 建模服务');

    // ---- 步骤 8：用户直接编辑已确认根命题；Release 1 仍可读 ----
    const rootTipR1 = rootDetail().revision; // Release 1 中的根修订
    const revised = ws.services.nodes.reviseCandidateNode(
      freshProject(ws),
      root.node.id,
      rootTipR1.id,
      {
        displayTitle: '为 AI Agent 提供程序化建模工具集（v2）',
        contentText: '用户直接修订已确认根命题。',
        roles: ['root'],
        attributes: { priorityNote: null },
        approvalState: 'user_confirmed',
        epistemicState: null,
      },
      userAuthor,
    );
    state.oldRootRevisionId = rootTipR1.id;
    state.newRootRevisionId = revised.revision.id;
    // Release 视图仍是旧根修订；历史修订不被覆盖
    const releaseView = ws.services.queries.resolveView(freshProject(ws), 'release');
    expect(releaseView.nodeRevisionByNodeId.get(asId(root.node.id))?.id).toBe(rootTipR1.id);
    expect(ws.db.repos.node.listRevisionsByNode(asId(root.node.id)).length).toBeGreaterThanOrEqual(
      3,
    );
    const release1Manifest = ws.db.repos.release.getById(release1.id)!;
    expect(release1Manifest.nodeRevisionIds).toContain(rootTipR1.id);

    // ---- 步骤 9：用户 adopt → design.invalidated + 全树复核集合，下游读取被闸门拒绝 ----
    const cs2 = ws.services.changeSets.getLive(freshProject(ws))!;
    const adoptResult = ws.services.changeSets.adopt(cs2.id, userAuthor);
    expect(adoptResult.impact.rootChange).toBe(true);
    // 423 DESIGN_NOT_CONSISTENT 闸门（server 层 m2 已覆盖）；
    // 端点失效构成直接阻塞时 project 进入 blocked，reevaluate 消化后恢复
    expect(['reevaluating', 'blocked']).toContain(freshProject(ws).status);
    const eventsAfterAdopt = ws.services.queries.getEvents(freshProject(ws), 0, 100).events;
    const invalidated = eventsAfterAdopt.find((e) => e.eventType === 'design.invalidated');
    expect(invalidated?.payload['baseReleaseId']).toBe(release1.id);
    // 根部变化触发全树复核集合：所有活动节点/关系都有复核项
    const reviewItems = ws.services.changeSets.reviewItems(cs2.id).items;
    const activeCounts = {
      nodes: workingView().nodeById.size,
      relations: workingView().relationById.size,
    };
    expect(reviewItems.length).toBeGreaterThanOrEqual(activeCounts.nodes + activeCounts.relations);

    // ---- 步骤 10：Re-evaluate 全树复核、显式迁移关系 → 发布 Release 2 ----
    const reevalRun = runner.start(
      freshProject(ws),
      request({ workflowType: 'reevaluate', changeSetId: asId(cs2.id) }),
    );
    const reevalFinal = await runner.waitForCompletion(reevalRun.id);
    expect(reevalFinal.status).toBe('succeeded');
    expect(ws.services.changeSets.require(cs2.id).status).toBe('ready');
    // 关系未静默迁移：contains 关系产生了指向新根修订的新关系修订
    const migrated = [...workingView().relationRevisionByRelationId.values()].filter(
      (r) => r.fromNodeRevisionId === state.newRootRevisionId,
    );
    expect(migrated.length).toBeGreaterThan(0);
    const release2 = ws.services.releases.publish(
      freshProject(ws),
      cs2.id,
      'Release 2',
      userAuthor,
    );
    expect(release2.version).toBe(2);
    expect(freshProject(ws).status).toBe('consistent');
    // Release 1 manifest 与其修订仍然完整可读（不物理删除历史）
    expect(ws.db.repos.release.getById(release1.id)?.nodeRevisionIds).toContain(rootTipR1.id);
    expect(ws.db.repos.node.getRevisionById(rootTipR1.id)).toBeDefined();

    // ---- 步骤 11：事件 cursor 轮询 + Decision 全维度查询 ----
    const allEvents = ws.services.queries.getEvents(freshProject(ws), 0, 200);
    const published2 = allEvents.events.find(
      (e) => e.eventType === 'release.published' && e.payload['version'] === 2,
    );
    expect(published2?.payload['releaseId']).toBe(release2.id);
    // 增量轮询：从最新 cursor 之后无新事件
    const incremental = ws.services.queries.getEvents(freshProject(ws), allEvents.nextCursor, 100);
    expect(incremental.events).toHaveLength(0);

    // Decision 查询：问题、选项、理由、证据、根部路径、确认主体
    const releaseWs = ws.services.queries.resolveView(freshProject(ws), 'release');
    const decisions = ws.services.queries.queryNodes(freshProject(ws), 'release', {
      ...NO_FILTER,
      type: 'decision',
      ...LIMIT,
    }).nodes;
    expect(decisions.map((d) => d.revision.displayTitle)).toEqual(
      expect.arrayContaining(['选择模型表示方式', '局部决策：序列化采用不可变修订追加格式']),
    );
    const d1 = decisions.find((d) => d.revision.displayTitle === '选择模型表示方式')!;
    expect(d1.revision.attributes).toMatchObject({ importance: 'important' });

    const { outgoing } = ws.services.relations.getRelations(
      freshProject(ws),
      d1.node.id,
      'out',
      'release',
    );
    const nodeOfRevision = (revisionId: string) => {
      for (const [nodeId, revision] of releaseWs.nodeRevisionByNodeId) {
        if (revision.id === revisionId) return releaseWs.nodeById.get(nodeId);
      }
      return undefined;
    };
    const byType = (type: string) => outgoing.filter((r) => r.relation.relationType === type);
    // 问题
    const question = byType('addresses').map((r) => nodeOfRevision(r.revision.toNodeRevisionId))[0];
    expect(question?.nodeType).toBe('question');
    // 选项（selects + rejects 各一）
    const optionTargets = [...byType('selects'), ...byType('rejects')].map(
      (r) => ws.db.repos.node.getRevisionById(r.revision.toNodeRevisionId)?.displayTitle,
    );
    expect(optionTargets).toEqual(expect.arrayContaining(['文档树', '属性图']));
    // 理由
    expect(byType('selects')[0]?.revision.rationaleText.length).toBeGreaterThan(0);
    // 证据（挂在 Decision 下的 Evidence 子节点）
    const evidenceChild = byType('contains')
      .map((r) => nodeOfRevision(r.revision.toNodeRevisionId))
      .find((n) => n?.nodeType === 'evidence');
    expect(evidenceChild).toBeDefined();
    // 根部路径：沿 contains 父链向上直到 root 角色节点
    const path: string[] = [d1.node.id];
    let cursorRevisionId: string = d1.revision.id;
    for (;;) {
      const parentEdge = [...releaseWs.relationRevisionByRelationId.values()].find(
        (r) =>
          releaseWs.relationById.get(r.relationId)?.relationType === 'contains' &&
          r.toNodeRevisionId === cursorRevisionId,
      );
      if (!parentEdge) break;
      const parentNode = nodeOfRevision(parentEdge.fromNodeRevisionId);
      if (!parentNode) break;
      path.push(parentNode.id);
      const parentRevision = releaseWs.nodeRevisionByNodeId.get(parentNode.id)!;
      if (parentRevision.roles.includes('root')) break;
      cursorRevisionId = parentRevision.id;
    }
    expect(path[path.length - 1]).toBe(root.node.id);
    // 确认主体：用户确认的根部 + AI 托管确认的局部决策
    expect(releaseWs.nodeRevisionByNodeId.get(asId(root.node.id))?.approvalState).toBe(
      'user_confirmed',
    );
    const d2 = decisions.find((d) => d.revision.displayTitle.includes('局部决策'))!;
    expect(d2.revision.approvalState).toBe('ai_confirmed');
    expect(d2.revision.authorKind).toBe('agent');
    expect(d2.revision.authorization?.policyId).toBe(policy.id);
  });
});
