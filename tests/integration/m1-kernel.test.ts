import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ChangeSetService,
  CoreWorkflowRunner,
  DatabaseContext,
  DomainError,
  FakeModelProvider,
  NodeService,
  QueryService,
  RelationService,
  ReleaseService,
  WorkspaceService,
  createManualClock,
  newId,
  systemClock,
  userAuthor,
  type ProjectRecord,
} from '@treediagram/core';
import type {
  ChangeSetId,
  NodeId,
  NodeRevisionId,
  RelationId,
  WorkflowRun,
} from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { applySeed, loadSeed } from '../../scripts/seed-lib.js';
import { freshProject, makeTestWorkspace, quickNode } from '../helpers/workspace.js';

const fixtureDir = fileURLToPath(new URL('../fixtures', import.meta.url));

describe('M1 数据库集成（§16.2）', () => {
  it('migration 从空库成功', () => {
    const ws = makeTestWorkspace();
    const row = ws.db.repos.project.requireSingleton();
    expect(row.name).toBe('test-project');
    expect(ws.db.schemaVersion()).toBe(3);
    const events = ws.db.repos.event.list(ws.project.id, 0, 10);
    expect(events).toEqual([]);
  });

  it('foreign key 生效', () => {
    const ws = makeTestWorkspace();
    expect(() =>
      ws.db.repos.node.insertRevision({
        id: newId<NodeRevisionId>(),
        nodeId: newId<NodeId>(),
        createdInChangeSetId: newId<ChangeSetId>(),
        revisionNumber: 1,
        displayTitle: 'x',
        contentText: 'x',
        roles: [],
        attributes: {},
        approvalState: 'draft',
        epistemicState: null,
        authorization: null,
        supersedesRevisionId: null,
        authorKind: 'user',
        authorRef: null,
        createdAt: ws.clock.now(),
      }),
    ).toThrow();
  });

  it('workflow issue 持久化稳定 ID、回答绑定与决议生命周期', () => {
    const ws = makeTestWorkspace();
    const now = ws.clock.now();
    const runId = newId<import('@treediagram/contracts').WorkflowRunId>();
    ws.db.repos.workflowRun.insert({
      id: runId,
      projectId: ws.project.id,
      changeSetId: null,
      workflowType: 'initialize',
      targetNodeId: null,
      status: 'running',
      currentStep: 'running/assess',
      input: {},
      checkpoint: {},
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
    });

    const issue = ws.db.repos.workflowIssue.upsert(
      runId,
      {
        issueKey: 'model-domain',
        stage: 'initialize_readiness',
        kind: 'ambiguity',
        gate: 'before_proposal',
        questionText: '具体建模领域是什么？',
        rationaleText: '领域决定核心类型与验收方式。',
        answerType: 'free_text',
        options: [],
        relatedRefs: [],
      },
      now,
    );
    const same = ws.db.repos.workflowIssue.upsert(
      runId,
      {
        issueId: issue.id,
        issueKey: issue.issueKey,
        stage: issue.stage,
        kind: issue.kind,
        gate: issue.gate,
        questionText: '具体建模领域及对象是什么？',
        rationaleText: issue.rationaleText,
        answerType: issue.answerType,
        options: [],
        relatedRefs: [],
      },
      now,
    );
    expect(same.id).toBe(issue.id);
    expect(same.questionText).toContain('及对象');

    const wait = ws.db.repos.workflowInteraction.createAgentWait(
      runId,
      '需要澄清',
      [{ id: issue.id, question: same.questionText, blocking: true, relatedProposalRefs: [] }],
      now,
    );
    ws.db.repos.workflowIssue.bindOpeningMessage([issue.id], wait.message.id, now);
    const answer = ws.db.repos.workflowInteraction.appendUserResponse({
      runId,
      wait: wait.wait,
      clientMessageId: randomUUID(),
      contentText: '软件架构与程序结构。',
      answers: [{ questionId: issue.id, answerText: '软件架构与程序结构。' }],
      sourceAssetIds: [],
      now,
    });
    ws.db.repos.workflowIssue.markAnswered([issue.id], answer.id, now);
    expect(ws.db.repos.workflowIssue.getById(issue.id)).toMatchObject({
      status: 'answered',
      openedByMessageId: wait.message.id,
      answeredByMessageId: answer.id,
    });

    ws.db.repos.workflowIssue.resolve(
      [issue.id],
      { kind: 'user_answer', messageId: answer.id },
      now,
    );
    expect(ws.db.repos.workflowIssue.getById(issue.id)).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'user_answer', messageId: answer.id },
    });
  });

  it('one live ChangeSet partial unique index 生效', () => {
    const ws = makeTestWorkspace();
    const now = ws.clock.now();
    const mk = () => ({
      id: newId<ChangeSetId>(),
      projectId: ws.project.id,
      baseReleaseId: null,
      status: 'open' as const,
      title: '',
      description: '',
      adoptedAt: null,
      publishedReleaseId: null,
      createdAt: now,
      updatedAt: now,
    });
    ws.db.repos.changeSet.insert(mk());
    expect(() => ws.db.repos.changeSet.insert(mk())).toThrow();
  });

  it('transaction 失败完全回滚', () => {
    const ws = makeTestWorkspace();
    const nodeId = newId<NodeId>();
    expect(() =>
      ws.db.transaction(() => {
        ws.db.repos.node.insertNode({
          id: nodeId,
          projectId: ws.project.id,
          nodeType: 'claim',
          authorKind: 'user',
          authorRef: null,
          createdAt: ws.clock.now(),
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(ws.db.repos.node.getNodeById(nodeId)).toBeNull();
  });
});

describe('M1 工作区重开恢复', () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('reopen 后开放 ChangeSet 与候选 head 可恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'treediagram-m1-'));
    tmpDirs.push(dir);
    const workspaceService = new WorkspaceService(systemClock);
    workspaceService.initWorkspace(dir, 'reopen-test');

    const first = workspaceService.openWorkspace(dir);
    const ctx = { db: first.db, clock: systemClock };
    const nodes = new NodeService(ctx);
    const project = first.db.repos.project.requireSingleton();
    const detail = nodes.createCandidateNode(
      project,
      'claim',
      {
        displayTitle: '重开恢复候选',
        contentText: 'candidate',
        roles: [],
        attributes: {},
        approvalState: 'draft',
        epistemicState: null,
      },
      userAuthor,
    );
    const changeSetId = first.db.repos.changeSet.getLiveByProject(project.id)?.id;
    first.db.close();

    const second = workspaceService.openWorkspace(dir);
    try {
      const project2 = second.db.repos.project.requireSingleton();
      const live = second.db.repos.changeSet.getLiveByProject(project2.id);
      expect(live?.id).toBe(changeSetId);
      expect(live?.status).toBe('open');
      const heads = second.db.repos.changeSet.listNodeHeads(changeSetId as string);
      expect(heads.length).toBe(1);
      expect(heads[0]?.nodeRevisionId).toBe(detail.revision.id);
    } finally {
      second.db.close();
    }
  });

  it('reopen 后未完成 WorkflowRun 恢复：PROCESS_INTERRUPTED 标记 + resume 完成（§16.1）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'treediagram-m1-'));
    tmpDirs.push(dir);
    const workspaceService = new WorkspaceService(systemClock);
    workspaceService.initWorkspace(dir, 'reopen-run-test');

    // 第一段进程：建立候选与遗留 running run（模拟进程中断）
    const first = workspaceService.openWorkspace(dir);
    const firstCtx = { db: first.db, clock: systemClock };
    const project = first.db.repos.project.requireSingleton();
    const target = new NodeService(firstCtx).createCandidateNode(
      project,
      'claim',
      {
        displayTitle: '恢复目标节点',
        contentText: 'candidate',
        roles: [],
        attributes: {},
        approvalState: 'draft',
        epistemicState: null,
      },
      userAuthor,
    );
    first.db.repos.project.updateStatus(project.id, 'consistent', null, systemClock.now());
    const now = systemClock.now();
    const interrupted: WorkflowRun = {
      id: asId(randomUUID()),
      projectId: project.id,
      changeSetId: null,
      workflowType: 'derive',
      targetNodeId: target.node.id,
      status: 'running',
      currentStep: 'running/generate',
      input: {
        workflowType: 'derive',
        targetNodeId: target.node.id,
        changeSetId: null,
        sourceAssetIds: [],
        focusInstruction: null,
      },
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
    first.db.repos.workflowRun.insert(interrupted);
    first.db.close();

    // 第二段进程（重启）：恢复遗留 run 并 resume 完成
    const second = workspaceService.openWorkspace(dir);
    try {
      const secondCtx = { db: second.db, clock: systemClock };
      const project2 = second.db.repos.project.requireSingleton();
      const provider = FakeModelProvider.scripted([
        {
          schemaVersion: 1,
          workflowType: 'derive',
          summary: '恢复后生成',
          nodeActions: [
            {
              proposalRef: 'c1',
              operation: 'create',
              logicalNodeId: null,
              baseRevisionId: null,
              nodeType: 'claim',
              displayTitle: '恢复子节点',
              contentText: 'resume 后写入',
              roles: [],
              attributes: null,
              approvalSuggestion: 'tentative',
              epistemicState: null,
              rationale: '测试 rationale',
            },
          ],
          relationActions: [],
          questionsForUser: [],
          warnings: [],
          stopReason: 'completed',
        },
      ]);
      const runner = new CoreWorkflowRunner(secondCtx, {
        provider,
        model: 'test-model',
        safetyIdentifier: 'f'.repeat(32),
      });
      expect(runner.recoverInterrupted(project2)).toBe(1);
      const recovered = second.db.repos.workflowRun.getById(interrupted.id);
      expect(recovered?.status).toBe('failed');
      expect(recovered?.error?.code).toBe('PROCESS_INTERRUPTED');

      runner.resume(project2, interrupted.id);
      const final = await runner.waitForCompletion(interrupted.id);
      expect(final.status).toBe('succeeded');
      expect(provider.calls).toHaveLength(1);
      // 恢复不依赖供应商会话：本地 checkpoint + 持久化候选共同驱动（关键不变量 12）
      const live = second.db.repos.changeSet.getLiveByProject(project2.id);
      expect(live?.status).toBe('open');
      const heads = second.db.repos.changeSet.listNodeHeads(live!.id as string);
      expect(heads.length).toBe(2);
    } finally {
      second.db.close();
    }
  });

  it('waiting_user 对话跨进程重开后仍可回答并恢复同一阶段', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'treediagram-conversation-reopen-'));
    tmpDirs.push(dir);
    const workspaceService = new WorkspaceService(systemClock);
    workspaceService.initWorkspace(dir, 'conversation-reopen');

    const first = workspaceService.openWorkspace(dir);
    const firstProject = first.db.repos.project.requireSingleton();
    const target = new NodeService({ db: first.db, clock: systemClock }).createCandidateNode(
      firstProject,
      'claim',
      {
        displayTitle: '对话恢复目标',
        contentText: '目标',
        roles: [],
        attributes: {},
        approvalState: 'draft',
        epistemicState: 'assumed',
      },
      userAuthor,
    );
    first.db.repos.project.updateStatus(firstProject.id, 'consistent', null, systemClock.now());
    const firstProvider = FakeModelProvider.scripted([
      {
        schemaVersion: 1,
        workflowType: 'derive',
        summary: '需要用户补充边界',
        nodeActions: [],
        relationActions: [],
        questionsForUser: [{ question: '允许联网吗？', blocking: true, relatedProposalRefs: [] }],
        warnings: [],
        stopReason: 'needs_user',
      },
    ]);
    const firstRunner = new CoreWorkflowRunner(
      { db: first.db, clock: systemClock },
      { provider: firstProvider, model: 'test-model', safetyIdentifier: 'a'.repeat(32) },
    );
    const started = firstRunner.start(first.db.repos.project.requireSingleton(), {
      workflowType: 'derive',
      targetNodeId: target.node.id,
      changeSetId: null,
      sourceAssetIds: [],
      focusInstruction: null,
    });
    expect((await firstRunner.waitForCompletion(started.id)).status).toBe('waiting_user');
    const waitId = first.db.repos.workflowInteraction.getOpenWait(started.id)!.id;
    first.db.close();

    const second = workspaceService.openWorkspace(dir);
    try {
      const secondProvider = FakeModelProvider.scripted([
        {
          schemaVersion: 1,
          workflowType: 'derive',
          summary: '已根据回答完成',
          nodeActions: [
            {
              proposalRef: 'c1',
              operation: 'create',
              logicalNodeId: null,
              baseRevisionId: null,
              nodeType: 'claim',
              displayTitle: '离线约束下的方案',
              contentText: '不联网',
              roles: [],
              attributes: null,
              approvalSuggestion: 'tentative',
              epistemicState: 'assumed',
              rationale: '来自用户回答',
            },
          ],
          relationActions: [],
          questionsForUser: [],
          warnings: [],
          stopReason: 'completed',
        },
      ]);
      const secondRunner = new CoreWorkflowRunner(
        { db: second.db, clock: systemClock },
        { provider: secondProvider, model: 'test-model', safetyIdentifier: 'b'.repeat(32) },
      );
      const project = second.db.repos.project.requireSingleton();
      expect(second.db.repos.workflowInteraction.listMessages(started.id)).toHaveLength(1);
      secondRunner.respond(project, started.id, {
        waitId,
        clientMessageId: asId(randomUUID()),
        message: '不允许联网，所有能力必须本地运行。',
        answers: [],
        sourceAssetIds: [],
      });
      const final = await secondRunner.waitForCompletion(started.id);
      expect(final.status).toBe('succeeded');
      expect(secondProvider.calls[0]!.input).toContain('不允许联网');
      expect(second.db.repos.workflowInteraction.listMessages(started.id)).toHaveLength(2);
    } finally {
      second.db.close();
    }
  });
});

describe('M1 seeded fixture: Release 1 -> candidate -> Release 2', () => {
  it('完整生命周期', () => {
    const ws = makeTestWorkspace('seeded');
    const { seed, sourceText } = loadSeed(fixtureDir);
    const seedResult = applySeed(
      { db: ws.db, clock: ws.clock, maxSourceBytes: 2 * 1024 * 1024 },
      ws.project,
      seed,
      sourceText,
    );
    expect(seedResult.releaseVersion).toBe(1);

    const project1 = freshProject(ws);
    expect(project1.status).toBe('consistent');

    // Release 1 可读
    const tree1 = ws.services.queries.getTree(project1, 'release', null, 10);
    expect(tree1.nodes.length).toBe(seed.nodes.length);

    const release1 = ws.services.releases.getCurrentRelease(project1);
    const release1NodeIds = [...release1.nodeRevisionIds];

    // 用户直接编辑已确认根命题：只创建候选修订，Release 1 不变
    const rootKey = 'root-goal';
    const rootNodeId = seedResult.nodeIdsByKey.get(rootKey);
    expect(rootNodeId).toBeDefined();
    const rootDetail = ws.services.nodes.getNode(project1, rootNodeId as string, 'release');
    const candidate = ws.services.nodes.reviseCandidateNode(
      project1,
      rootNodeId as string,
      rootDetail.revision.id,
      {
        displayTitle: rootDetail.revision.displayTitle,
        contentText: '修订后的根命题：强调可审计的操作记录。',
        roles: ['root'],
        attributes: { priorityNote: '首要产品目标' },
        approvalState: 'user_confirmed',
        epistemicState: null,
      },
      userAuthor,
    );
    expect(candidate.revision.supersedesRevisionId).toBe(rootDetail.revision.id);

    // Release 1 仍然不变（下游不受影响）
    const releaseAfterCandidate = ws.services.releases.getCurrentRelease(freshProject(ws));
    expect(releaseAfterCandidate.version).toBe(1);
    expect(releaseAfterCandidate.nodeRevisionIds).toEqual(release1NodeIds);

    // adopt：root change 触发全树复核
    const changeSet = ws.services.changeSets.getLive(freshProject(ws));
    expect(changeSet).toBeDefined();
    const adoptResult = ws.services.changeSets.adopt((changeSet as { id: string }).id, userAuthor);
    expect(adoptResult.impact.rootChange).toBe(true);
    // root change：全部活动节点修订 + 全部活动关系修订（contains 边 + 语义关系）
    const containsCount = seed.nodes.filter((n) => n.parent !== null).length;
    expect(adoptResult.reviewItemsCreated).toBe(
      seed.nodes.length + containsCount + seed.relations.length,
    );
    expect(freshProject(ws).status).toBe('blocked');

    // 直接阻塞：root 修订后，原 contains 边端点指向被替代修订（禁止静默迁移）。
    // 用户必须显式迁移这些关系（V1_SPEC §10.5：为仍成立的关系创建显式迁移修订）。
    const staleRevisions = ws.db.repos.relation.listRevisionsTouchingNodeRevisions([
      rootDetail.revision.id,
    ]);
    const staleContains = staleRevisions.filter(
      (r) => r.fromNodeRevisionId === rootDetail.revision.id,
    );
    expect(staleContains.length).toBeGreaterThan(0);
    for (const revision of staleContains) {
      ws.services.relations.reviseCandidateRelation(
        freshProject(ws),
        revision.relationId,
        revision.id,
        {
          fromNodeRevisionId: candidate.revision.id,
          toNodeRevisionId: revision.toNodeRevisionId,
          rationaleText: revision.rationaleText,
          attributes: {},
          approvalState: 'user_confirmed',
        },
        userAuthor,
      );
    }

    // 事件：design.invalidated + reevaluation.started
    const eventsAfterAdopt = ws.services.queries.getEvents(freshProject(ws), 0, 1000).events;
    expect(eventsAfterAdopt.some((e) => e.eventType === 'design.invalidated')).toBe(true);
    expect(eventsAfterAdopt.some((e) => e.eventType === 'reevaluation.started')).toBe(true);

    // 全部复核 valid → ChangeSet 自动 ready（§4 状态表）→ publish Release 2
    const { items } = ws.services.changeSets.reviewItems((changeSet as { id: string }).id);
    for (const item of items) {
      if (item.status === 'pending') {
        ws.services.changeSets.resolveReviewItem(item.id, 'valid', '复核通过', userAuthor);
      }
    }
    expect(ws.services.changeSets.require((changeSet as { id: string }).id).status).toBe('ready');
    const release2 = ws.services.releases.publish(
      freshProject(ws),
      (changeSet as { id: string }).id,
      'Release 2：根命题修订',
      userAuthor,
    );
    expect(release2.version).toBe(2);
    expect(release2.nodeRevisionIds).toContain(candidate.revision.id);
    expect(release2.nodeRevisionIds).not.toContain(rootDetail.revision.id);

    // Release 1 manifest 未被改写
    const release1After = ws.db.repos.release.getById(release1.id);
    expect(release1After?.nodeRevisionIds).toEqual(release1NodeIds);

    // 历史修订保留
    const history = ws.services.nodes.getNodeHistory(freshProject(ws), rootNodeId as string);
    expect(history.revisions.length).toBe(2);

    // 事件 cursor 单调递增，release.published v2 可查
    const allEvents = ws.services.queries.getEvents(freshProject(ws), 0, 1000).events;
    const cursors = allEvents.map((e) => e.cursor);
    expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
    const published = allEvents.filter((e) => e.eventType === 'release.published');
    expect(published.length).toBe(2);

    expect(freshProject(ws).status).toBe('consistent');
  });

  it('带阻塞矛盾的 ChangeSet 不能发布', () => {
    const ws = makeTestWorkspace('blocked-publish');
    const { seed, sourceText } = loadSeed(fixtureDir);
    applySeed(
      { db: ws.db, clock: ws.clock, maxSourceBytes: 2 * 1024 * 1024 },
      ws.project,
      seed,
      sourceText,
    );
    const project = freshProject(ws);
    const tree = ws.services.queries.getTree(project, 'release', null, 10);
    const claimA = tree.nodes.find((n) => n.node.nodeType === 'claim');
    const claimB = tree.nodes.find(
      (n) => n.node.nodeType === 'claim' && n.node.id !== claimA?.node.id,
    );
    expect(claimA && claimB).toBeTruthy();
    if (!claimA || !claimB) return;

    ws.services.relations.createCandidateRelation(
      project,
      'contradicts',
      {
        fromNodeRevisionId: claimA.revision.id,
        toNodeRevisionId: claimB.revision.id,
        rationaleText: '构造的 blocking 矛盾',
        attributes: { blocking: true },
        approvalState: 'user_confirmed',
      },
      userAuthor,
    );
    const changeSet = ws.services.changeSets.getLive(freshProject(ws)) as { id: string };
    const adoptResult = ws.services.changeSets.adopt(changeSet.id, userAuthor);
    expect(adoptResult.projectBlocked).toBe(true);
    expect(freshProject(ws).status).toBe('blocked');

    const { items } = ws.services.changeSets.reviewItems(changeSet.id);
    for (const item of items) {
      if (item.status === 'pending') {
        ws.services.changeSets.resolveReviewItem(item.id, 'valid', 'ok', userAuthor);
      }
    }
    // 矛盾仍在：markReady 必须拒绝
    expect(() => ws.services.changeSets.markReady(changeSet.id)).toThrowError(
      expect.objectContaining({ code: 'DESIGN_INCONSISTENT' }),
    );
    // publish 路径同样被拒绝（无 ready 状态）
    expect(() =>
      ws.services.releases.publish(freshProject(ws), changeSet.id, 'x', userAuthor),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));

    // abandon 恢复 consistent 并写 design.restored
    ws.services.changeSets.abandon(changeSet.id);
    expect(freshProject(ws).status).toBe('consistent');
    const events = ws.services.queries.getEvents(freshProject(ws), 0, 1000).events;
    expect(events.some((e) => e.eventType === 'design.restored')).toBe(true);
    // 失败路径没有产生新 Release 或 release.published 事件
    expect(events.filter((e) => e.eventType === 'release.published').length).toBe(1);
  });
});

describe('M1 规模测试（§16.2/§18）', () => {
  it('5,000 nodes / 20,000 relations 可构造和查询', { timeout: 300000 }, () => {
    const clock = createManualClock('2026-01-01T00:00:00.000Z');
    const db = new DatabaseContext(':memory:', clock);
    const project: ProjectRecord = {
      id: newId(),
      name: 'scale',
      status: 'initializing',
      currentReleaseId: null,
      adminTokenSha256: 'a',
      consumerTokenSha256: 'c',
      blockedReason: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };
    db.repos.project.insert(project);

    const NODE_COUNT = 5000;
    const RELATION_COUNT = 20000;
    const changeSetId = newId<ChangeSetId>();
    const now = clock.now();

    db.transaction(() => {
      db.repos.changeSet.insert({
        id: changeSetId,
        projectId: project.id,
        baseReleaseId: null,
        status: 'open',
        title: 'scale',
        description: '',
        adoptedAt: null,
        publishedReleaseId: null,
        createdAt: now,
        updatedAt: now,
      });

      const nodeIds: NodeId[] = [];
      const revisionIds: NodeRevisionId[] = [];
      for (let i = 0; i < NODE_COUNT; i++) {
        const nodeId = newId<NodeId>();
        const revisionId = newId<NodeRevisionId>();
        nodeIds.push(nodeId);
        revisionIds.push(revisionId);
        const nodeType = i === 0 ? 'topic' : 'claim';
        db.repos.node.insertNode({
          id: nodeId,
          projectId: project.id,
          nodeType,
          authorKind: 'user',
          authorRef: null,
          createdAt: now,
        });
        db.repos.node.insertRevision({
          id: revisionId,
          nodeId,
          createdInChangeSetId: changeSetId,
          revisionNumber: 1,
          displayTitle: `scale node ${i} ${i % 97 === 0 ? ' searchable-token' : ''}`,
          contentText: `content for node ${i}`,
          roles: i === 1 ? ['root'] : [],
          attributes: {},
          approvalState: 'user_confirmed',
          epistemicState: null,
          authorization: null,
          supersedesRevisionId: null,
          authorKind: 'user',
          authorRef: null,
          createdAt: now,
        });
        db.repos.changeSet.upsertNodeHead(changeSetId, {
          nodeId,
          nodeRevisionId: revisionId,
          action: 'upsert',
        });
      }

      // contains 树：每个节点挂到 (i-1)/10 父节点，形成 10 叉树
      let relationCount = 0;
      const insertRelation = (
        type: 'contains' | 'depends_on',
        fromRev: NodeRevisionId,
        toRev: NodeRevisionId,
      ) => {
        const relationId = newId<RelationId>();
        const revisionId = newId<NodeRevisionId>();
        db.repos.relation.insertRelation({
          id: relationId,
          projectId: project.id,
          relationType: type,
          authorKind: 'user',
          authorRef: null,
          createdAt: now,
        });
        db.repos.relation.insertRevision({
          id: revisionId as never,
          relationId,
          createdInChangeSetId: changeSetId,
          revisionNumber: 1,
          fromNodeRevisionId: fromRev,
          toNodeRevisionId: toRev,
          rationaleText: 'scale',
          attributes: {},
          approvalState: 'user_confirmed',
          authorization: null,
          supersedesRelationRevisionId: null,
          authorKind: 'user',
          authorRef: null,
          createdAt: now,
        });
        db.repos.changeSet.upsertRelationHead(changeSetId, {
          relationId,
          relationRevisionId: revisionId as never,
          action: 'upsert',
        });
        relationCount += 1;
      };

      for (let i = 1; i < NODE_COUNT; i++) {
        const parentIdx = Math.floor((i - 1) / 10);
        insertRelation(
          'contains',
          revisionIds[parentIdx] as NodeRevisionId,
          revisionIds[i] as NodeRevisionId,
        );
      }
      let i = 0;
      while (relationCount < RELATION_COUNT) {
        const from = (i * 7) % NODE_COUNT;
        const to = (i * 13 + 1) % NODE_COUNT;
        if (from !== to) {
          insertRelation(
            'depends_on',
            revisionIds[from] as NodeRevisionId,
            revisionIds[to] as NodeRevisionId,
          );
        }
        i += 1;
      }
    });

    const ctx = { db, clock };
    const changeSets = new ChangeSetService(ctx);
    const queries = new QueryService(ctx);
    const changeSet = db.repos.changeSet.getById(changeSetId);
    if (!changeSet) throw new Error('changeSet missing');

    // WorkingSet 构造
    const t0 = Date.now();
    const { working } = changeSets.buildViews(changeSet);
    expect(working.nodeRevisionByNodeId.size).toBe(NODE_COUNT);
    expect(working.relationRevisionByRelationId.size).toBe(RELATION_COUNT);
    const wsBuildMs = Date.now() - t0;

    // 树展开（depth 1 顶层）不加载整个图
    const t1 = Date.now();
    const tree = queries.getTree(db.repos.project.requireSingleton(), 'working', null, 1);
    expect(tree.nodes.length).toBeGreaterThan(0);
    const treeMs = Date.now() - t1;

    // FTS 文本搜索
    const t2 = Date.now();
    const result = queries.queryNodes(db.repos.project.requireSingleton(), 'working', {
      type: null,
      role: null,
      approval: null,
      epistemic: null,
      text: 'searchable-token',
      limit: 50,
      cursor: null,
    });
    expect(result.nodes.length).toBeGreaterThan(0);
    const searchMs = Date.now() - t2;

    console.log(
      `scale: WorkingSet ${wsBuildMs}ms, tree ${treeMs}ms, fts ${searchMs}ms (${NODE_COUNT}n/${RELATION_COUNT}r)`,
    );
    expect(wsBuildMs).toBeLessThan(30000);
    expect(treeMs).toBeLessThan(10000);
    expect(searchMs).toBeLessThan(10000);
  });
});
