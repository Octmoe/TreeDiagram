import { describe, expect, it } from 'vitest';
import { asId, type StartWorkflowRequest, type WorkflowRun } from '@treediagram/contracts';
import { CoreWorkflowRunner, OpenAIProvider, userAuthor } from '@treediagram/core';
import {
  freshProject,
  makeTestWorkspace,
  quickNode,
  type TestWorkspace,
} from '../helpers/workspace.js';

/**
 * 真实模型完整生命周期冒烟：
 * Release 1 基线 → Derive(waiting_user/resume) → Grill → Unbox → Adopt →
 * Re-evaluate → Release 2；另验证真实在途请求 cancel。
 *
 * 内容断言只检查协议与领域结果，不绑定模型措辞，降低随机输出导致的脆弱性。
 */

const apiKey = process.env['OPENAI_API_KEY'];
const baseUrl = process.env['OPENAI_BASE_URL'];
const model = process.env['TREEDIAGRAM_MODEL'] ?? 'gpt-5.6-terra';
const MODEL_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 900_000;

function makeRunner(ws: TestWorkspace): CoreWorkflowRunner {
  return new CoreWorkflowRunner(ws.ctx, {
    provider: new OpenAIProvider(apiKey!, MODEL_TIMEOUT_MS, baseUrl),
    model,
    safetyIdentifier: 'd'.repeat(32),
  });
}

function request(
  workflowType: StartWorkflowRequest['workflowType'],
  options: {
    targetNodeId?: string | undefined;
    changeSetId?: string | undefined;
    focusInstruction?: string | undefined;
  } = {},
): StartWorkflowRequest {
  return {
    workflowType,
    targetNodeId: options.targetNodeId ? asId(options.targetNodeId) : null,
    changeSetId: options.changeSetId ? asId(options.changeSetId) : null,
    sourceAssetIds: [],
    focusInstruction: options.focusInstruction ?? null,
  };
}

function publishBaseline(ws: TestWorkspace) {
  const root = quickNode(ws, {
    nodeType: 'goal',
    roles: ['root'],
    approvalState: 'user_confirmed',
    epistemicState: null,
    title: '提供可靠的本地优先设计建模能力',
    content: '帮助单人设计者维护可审计、可发布的设计状态。',
  });
  const target = quickNode(
    ws,
    {
      nodeType: 'claim',
      approvalState: 'user_confirmed',
      epistemicState: 'assumed',
      title: '工作流必须可恢复',
      content: 'Agent 工作流应支持等待、恢复与取消。',
    },
    root,
  );
  const changeSet = ws.services.changeSets.getLive(freshProject(ws))!;
  ws.services.changeSets.adopt(changeSet.id, userAuthor);
  for (const item of ws.services.changeSets.reviewItems(changeSet.id).items) {
    if (item.status === 'pending') {
      ws.services.changeSets.resolveReviewItem(item.id, 'valid', '真实模型测试基线', userAuthor);
    }
  }
  expect(ws.services.changeSets.require(changeSet.id).status).toBe('ready');
  const release = ws.services.releases.publish(
    freshProject(ws),
    changeSet.id,
    '真实模型测试 Release 1',
    userAuthor,
  );
  expect(release.version).toBe(1);
  expect(freshProject(ws).status).toBe('consistent');
  return { root, target, release };
}

async function finishRun(
  runner: CoreWorkflowRunner,
  ws: TestWorkspace,
  run: WorkflowRun,
): Promise<WorkflowRun> {
  let final = await runner.waitForCompletion(run.id, RUN_TIMEOUT_MS);
  expect(final.error, JSON.stringify(final.error)).toBeNull();
  if (final.status === 'waiting_user') {
    final = runner.resume(freshProject(ws), run.id);
  }
  expect(final.status, JSON.stringify(final.error)).toBe('succeeded');
  return final;
}

describe.skipIf(!apiKey)('真实模型全功能生命周期', () => {
  it('Derive waiting/resume → Grill → Unbox → Adopt → Re-evaluate → Publish', async () => {
    const ws = makeTestWorkspace('real-model-full-lifecycle');
    const { root, target, release: release1 } = publishBaseline(ws);
    const runner = makeRunner(ws);

    const derive = runner.start(
      freshProject(ws),
      request('derive', {
        targetNodeId: target.node.id,
        focusInstruction:
          '仅生成一个 attributes.blocking=false 的 Question 候选，并在 questionsForUser 中提出一个 blocking=true 的用户确认问题；stopReason=needs_user。不要生成重要 Decision 或 blocking 设计实体。',
      }),
    );
    const deriveWaiting = await runner.waitForCompletion(derive.id, RUN_TIMEOUT_MS);
    expect(deriveWaiting.error, JSON.stringify(deriveWaiting.error)).toBeNull();
    expect(deriveWaiting.status).toBe('waiting_user');
    const deriveFinal = runner.resume(freshProject(ws), derive.id);
    expect(deriveFinal.status).toBe('succeeded');

    const grill = runner.start(
      freshProject(ws),
      request('grill', {
        targetNodeId: root.node.id,
        focusInstruction:
          '做最小非阻塞审查：最多生成两个 tentative 候选；Question.attributes.blocking=false，contradicts.attributes.blocking=false；不要生成重要 Decision。',
      }),
    );
    await finishRun(runner, ws, grill);

    const unbox = runner.start(
      freshProject(ws),
      request('unbox', {
        focusInstruction:
          '提出一个不改变 root 的平行边界方案，保持 tentative；relationActions 只使用 contains 挂在指定 unbox 容器下，不生成其他关系。',
      }),
    );
    await finishRun(runner, ws, unbox);

    const live = ws.services.changeSets.getLive(freshProject(ws));
    expect(live).not.toBeNull();
    const beforeAdopt = ws.services.changeSets.buildViews(live!);
    expect(beforeAdopt.working.nodeById.size).toBeGreaterThan(2);
    expect(
      [...beforeAdopt.working.nodeRevisionByNodeId.values()].some((revision) =>
        revision.roles.includes('unbox_exploration'),
      ),
    ).toBe(true);

    ws.services.changeSets.adopt(live!.id, userAuthor);
    const reevaluate = runner.start(
      freshProject(ws),
      request('reevaluate', { changeSetId: live!.id }),
    );
    await finishRun(runner, ws, reevaluate);

    const ready = ws.services.changeSets.require(live!.id);
    expect(
      ready.status,
      JSON.stringify(ws.services.changeSets.check(live!.id).issues, null, 2),
    ).toBe('ready');
    const release2 = ws.services.releases.publish(
      freshProject(ws),
      live!.id,
      '真实模型测试 Release 2',
      userAuthor,
    );
    expect(release2.version).toBe(2);
    expect(freshProject(ws).status).toBe('consistent');
    expect(ws.db.repos.release.getById(release1.id)).not.toBeNull();
    expect(
      ws.services.queries
        .getEvents(freshProject(ws), 0, 200)
        .events.filter((event) => event.eventType === 'release.published'),
    ).toHaveLength(2);
  }, 1_800_000);

  it('真实在途模型请求可 cancel，终态不会被 provider 回调覆盖', async () => {
    const ws = makeTestWorkspace('real-model-cancel');
    const { target } = publishBaseline(ws);
    const runner = makeRunner(ws);
    const run = runner.start(
      freshProject(ws),
      request('derive', {
        targetNodeId: target.node.id,
        focusInstruction: '详细分析该分支并提出恢复策略候选。',
      }),
    );

    const deadline = Date.now() + 30_000;
    for (;;) {
      const current = ws.db.repos.workflowRun.getById(run.id)!;
      if (current.currentStep.startsWith('running/generate/')) break;
      if (Date.now() > deadline) throw new Error(`等待 generate 超时：${current.currentStep}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelled = runner.cancel(freshProject(ws), run.id);
    expect(cancelled.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ws.db.repos.workflowRun.getById(run.id)?.status).toBe('cancelled');
  }, 120_000);
});
